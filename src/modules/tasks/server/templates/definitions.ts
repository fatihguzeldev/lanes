import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import type { Page } from '../../../../shared/contracts/http';
import { assertLocalWritable, localWriteGuard } from '../../../accounts/server/connections/access';
import {
  CreateListTemplateSchema,
  ListTemplateSummarySchema,
  SnapshotOptionsSchema,
  TemplateDescriptionSchema,
  TemplateMetadataPatchSchema,
  TemplateNameSchema,
  TemplatePageOptionsSchema,
  type ListTemplateSummary,
  type SnapshotSummary,
  type TemplatePageOptions,
} from '../../contracts/template';
import { listTemplateGallery } from '../../model/template-gallery';
import type { MetadataContext } from '../metadata/context';
import type { ListTemplateOptions, TemplateContext } from './context';
import { TemplateDocumentStore } from './documents';
import { cursor, readCursor } from './pagination';
import { guard } from './persistence';
import { id, parse, revision } from './validation';

interface HeaderRow {
  id: string;
  account_id: string;
  name: string;
  description: string;
  revision: number;
  content_revision: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  snapshot_id: string;
}

const localCoverage = { complete: true, lastSyncedAt: null, stale: false } as const;

export class ListTemplateService {
  constructor(
    private readonly db: D1Database,
    private readonly options: ListTemplateOptions,
  ) {}
  private async header(
    accountId: string,
    templateId: string,
    contentRevision?: number,
    includeDeleted = false,
  ): Promise<HeaderRow> {
    parse(id, accountId);
    parse(id, templateId);
    const row = await this.db
      .prepare(
        `SELECT template.*,version.snapshot_id FROM tasks_list_templates template JOIN tasks_list_template_versions version ON version.template_id=template.id AND version.version=COALESCE(?,template.content_revision) WHERE template.account_id=? AND template.id=? ${includeDeleted ? '' : 'AND template.deleted_at IS NULL'}`,
      )
      .bind(contentRevision ?? null, accountId, templateId)
      .first<HeaderRow>();
    if (!row)
      throw new AppError('not_found', 'this personal list template is no longer available', 404);
    return row;
  }
  private async model(
    row: HeaderRow,
    version = row.content_revision,
  ): Promise<ListTemplateSummary> {
    return ListTemplateSummarySchema.parse({
      id: row.id,
      accountId: row.account_id,
      kind: 'list',
      name: row.name,
      description: row.description,
      revision: row.revision,
      contentRevision: version,
      snapshot: await this.options.snapshots.get(row.account_id, row.snapshot_id),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    });
  }
  async get(accountId: string, templateId: string): Promise<ListTemplateSummary> {
    return this.model(await this.header(accountId, templateId));
  }
  async getVersion(
    accountId: string,
    templateId: string,
    version: number,
  ): Promise<ListTemplateSummary> {
    parse(z.number().int().positive(), version);
    return this.model(await this.header(accountId, templateId, version), version);
  }
  versionGuardWrite(
    accountId: string,
    templateId: string,
    version: number,
    snapshotId: string,
  ): D1PreparedStatement {
    return guard(
      this.db,
      'EXISTS (SELECT 1 FROM tasks_list_templates template JOIN tasks_list_template_versions version ON version.template_id=template.id AND version.version=? WHERE template.account_id=? AND template.id=? AND template.deleted_at IS NULL AND version.snapshot_id=?)',
      [version, accountId, templateId, snapshotId],
    );
  }
  private cas(
    accountId: string,
    templateId: string,
    expectedRevision: number,
  ): D1PreparedStatement {
    return guard(
      this.db,
      'EXISTS (SELECT 1 FROM tasks_list_templates WHERE account_id=? AND id=? AND revision=? AND deleted_at IS NULL)',
      [accountId, templateId, expectedRevision],
    );
  }
  private async writable(
    accountId: string,
    templateId: string,
    expectedRevision: number,
  ): Promise<HeaderRow> {
    await assertLocalWritable(this.db, accountId);
    const row = await this.header(accountId, templateId);
    if (row.revision !== expectedRevision)
      throw new AppError(
        'conflict',
        'this template changed; refresh before reapplying the edit',
        409,
      );
    return row;
  }
  private async commit(
    writes: D1PreparedStatement[],
    explain: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await this.options.commitWrites(writes);
    } catch (error) {
      if (error instanceof AppError) throw error;
      await explain();
      throw new AppError(
        'storage_unavailable',
        'the template and its operation receipt could not be saved',
        503,
        true,
      );
    }
  }
  async previewSource(
    accountId: string,
    input: unknown,
    context: TemplateContext,
  ): Promise<Omit<SnapshotSummary, 'id' | 'createdAt'>> {
    const value = parse(
        SnapshotOptionsSchema.extend({ listId: id, listRevision: revision }).strict(),
        input,
      ),
      appearance = await this.options.sourceListAppearance(accountId, value.listId);
    const capture = await this.options.snapshots.prepareCapture(
      accountId,
      [
        {
          sourceListId: value.listId,
          revision: value.listRevision,
          color: appearance.color,
          position: 0,
        },
      ],
      {
        ...value,
        saveDay: context.saveDay,
        zone: context.zone,
        recordedAt: context.recordedAt,
        guardWrites: appearance.guardWrites,
      },
    );
    const { id: _id, createdAt: _createdAt, ...preview } = capture.snapshot;
    return preview;
  }
  async createFromSnapshot(
    accountId: string,
    snapshotId: string,
    input: unknown,
    context: MetadataContext,
    admittedTemplateId: string = crypto.randomUUID(),
  ): Promise<ListTemplateSummary> {
    await assertLocalWritable(this.db, accountId);
    const value = parse(
        z
          .object({ name: TemplateNameSchema, description: TemplateDescriptionSchema.default('') })
          .strict(),
        input,
      ),
      snapshot = await this.options.snapshots.get(accountId, snapshotId);
    parse(id, admittedTemplateId);
    if (snapshot.listCount !== 1)
      throw new AppError(
        'validation_failed',
        'a personal list template must contain exactly one list',
        422,
      );
    await this.commit(
      [
        localWriteGuard(this.db, accountId),
        this.db
          .prepare(
            'INSERT INTO tasks_list_templates(id,account_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?)',
          )
          .bind(
            admittedTemplateId,
            accountId,
            value.name,
            value.description,
            Date.parse(context.recordedAt),
            Date.parse(context.recordedAt),
          ),
        this.db
          .prepare(
            'INSERT INTO tasks_list_template_versions(template_id,version,snapshot_id) VALUES (?,1,?)',
          )
          .bind(admittedTemplateId, snapshotId),
        this.options.snapshots.releasePinWrite(accountId, snapshotId, `document:${snapshotId}`),
      ],
      () => assertLocalWritable(this.db, accountId),
    );
    return this.get(accountId, admittedTemplateId);
  }
  async replaceFromSnapshot(
    accountId: string,
    templateId: string,
    snapshotId: string,
    expectedRevision: number,
    context: MetadataContext,
  ): Promise<ListTemplateSummary> {
    const row = await this.writable(accountId, templateId, expectedRevision),
      snapshot = await this.options.snapshots.get(accountId, snapshotId);
    if (snapshot.listCount !== 1)
      throw new AppError(
        'validation_failed',
        'a personal list template must contain exactly one list',
        422,
      );
    await this.commit(
      [
        localWriteGuard(this.db, accountId),
        this.cas(accountId, templateId, expectedRevision),
        this.db
          .prepare(
            'INSERT INTO tasks_list_template_versions(template_id,version,snapshot_id) VALUES (?,?,?)',
          )
          .bind(templateId, row.content_revision + 1, snapshotId),
        this.db
          .prepare(
            'UPDATE tasks_list_templates SET content_revision=content_revision+1,revision=revision+1,updated_at=? WHERE account_id=? AND id=?',
          )
          .bind(Date.parse(context.recordedAt), accountId, templateId),
        this.options.snapshots.releasePinWrite(accountId, snapshotId, `document:${snapshotId}`),
      ],
      () => this.writable(accountId, templateId, expectedRevision),
    );
    return this.get(accountId, templateId);
  }
  gallery() {
    return listTemplateGallery;
  }
  async saveGallery(
    accountId: string,
    galleryId: string,
    context: TemplateContext,
    admitted: {
      templateId?: string;
      snapshotId?: string;
    } = {},
  ): Promise<ListTemplateSummary> {
    await assertLocalWritable(this.db, accountId);
    const entry = listTemplateGallery.find((value) => value.id === galleryId);
    if (!entry) throw new AppError('not_found', 'this bundled list starter is not available', 404);
    const templateId = parse(id, admitted.templateId ?? crypto.randomUUID()),
      documents = new TemplateDocumentStore(this.db, this.options);
    const prepared = documents.prepareSmall(
      accountId,
      {
        ...entry.document,
        header: { ...entry.document.header, saveDay: context.saveDay, zone: context.zone },
      },
      context,
      admitted.snapshotId,
    );
    await this.commit(
      [
        ...prepared.writes,
        this.db
          .prepare(
            'INSERT INTO tasks_list_templates(id,account_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?)',
          )
          .bind(
            templateId,
            accountId,
            entry.name,
            entry.description,
            Date.parse(context.recordedAt),
            Date.parse(context.recordedAt),
          ),
        this.db
          .prepare(
            'INSERT INTO tasks_list_template_versions(template_id,version,snapshot_id) VALUES (?,1,?)',
          )
          .bind(templateId, prepared.snapshotId),
      ],
      () => assertLocalWritable(this.db, accountId),
    );
    return this.get(accountId, templateId);
  }
  async create(
    accountId: string,
    input: unknown,
    context: TemplateContext,
    admitted: {
      templateId?: string;
      snapshotId?: string;
    } = {},
  ): Promise<ListTemplateSummary> {
    const value = parse(CreateListTemplateSchema, input);
    await assertLocalWritable(this.db, accountId);
    const templateId = parse(id, admitted.templateId ?? crypto.randomUUID());
    const appearance = await this.options.sourceListAppearance(accountId, value.listId);
    const captured = await this.options.snapshots.prepareCapture(
      accountId,
      [
        {
          sourceListId: value.listId,
          revision: value.listRevision,
          color: appearance.color,
          position: 0,
        },
      ],
      {
        ...value,
        guardWrites: appearance.guardWrites,
        saveDay: context.saveDay,
        zone: context.zone,
        recordedAt: context.recordedAt,
        ...(admitted.snapshotId ? { snapshotId: admitted.snapshotId } : {}),
      },
    );
    await this.commit(
      [
        ...captured.writes,
        this.db
          .prepare(
            'INSERT INTO tasks_list_templates(id,account_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?)',
          )
          .bind(
            templateId,
            accountId,
            value.name,
            value.description,
            Date.parse(context.recordedAt),
            Date.parse(context.recordedAt),
          ),
        this.db
          .prepare(
            'INSERT INTO tasks_list_template_versions(template_id,version,snapshot_id) VALUES (?,1,?)',
          )
          .bind(templateId, captured.snapshot.id),
      ],
      async () => {
        await assertLocalWritable(this.db, accountId);
        await captured.verifySource();
        await appearance.verifySource?.();
      },
    );
    return this.get(accountId, templateId);
  }
  async replace(
    accountId: string,
    templateId: string,
    input: unknown,
    expectedRevision: number,
    context: TemplateContext,
    admittedSnapshotId?: string,
  ): Promise<ListTemplateSummary> {
    const value = parse(
        SnapshotOptionsSchema.extend({ listId: id, listRevision: revision }).strict(),
        input,
      ),
      row = await this.writable(accountId, templateId, expectedRevision);
    const appearance = await this.options.sourceListAppearance(accountId, value.listId);
    const captured = await this.options.snapshots.prepareCapture(
      accountId,
      [
        {
          sourceListId: value.listId,
          revision: value.listRevision,
          color: appearance.color,
          position: 0,
        },
      ],
      {
        ...value,
        guardWrites: appearance.guardWrites,
        saveDay: context.saveDay,
        zone: context.zone,
        recordedAt: context.recordedAt,
        ...(admittedSnapshotId ? { snapshotId: admittedSnapshotId } : {}),
      },
    );
    await this.commit(
      [
        this.cas(accountId, templateId, expectedRevision),
        ...captured.writes,
        this.db
          .prepare(
            'INSERT INTO tasks_list_template_versions(template_id,version,snapshot_id) VALUES (?,?,?)',
          )
          .bind(templateId, row.content_revision + 1, captured.snapshot.id),
        this.db
          .prepare(
            'UPDATE tasks_list_templates SET content_revision=content_revision+1,revision=revision+1,updated_at=? WHERE account_id=? AND id=?',
          )
          .bind(Date.parse(context.recordedAt), accountId, templateId),
      ],
      async () => {
        await this.writable(accountId, templateId, expectedRevision);
        await captured.verifySource();
        await appearance.verifySource?.();
      },
    );
    return this.get(accountId, templateId);
  }
  async update(
    accountId: string,
    templateId: string,
    input: unknown,
    expectedRevision: number,
    context: TemplateContext,
  ): Promise<ListTemplateSummary> {
    const value = parse(TemplateMetadataPatchSchema, input),
      row = await this.writable(accountId, templateId, expectedRevision);
    await this.commit(
      [
        localWriteGuard(this.db, accountId),
        this.cas(accountId, templateId, expectedRevision),
        this.db
          .prepare(
            'UPDATE tasks_list_templates SET name=?,description=?,revision=revision+1,updated_at=? WHERE account_id=? AND id=?',
          )
          .bind(
            value.name ?? row.name,
            value.description ?? row.description,
            Date.parse(context.recordedAt),
            accountId,
            templateId,
          ),
      ],
      () => this.writable(accountId, templateId, expectedRevision),
    );
    return this.get(accountId, templateId);
  }
  async delete(
    accountId: string,
    templateId: string,
    expectedRevision: number,
    context: TemplateContext,
  ): Promise<void> {
    await this.writable(accountId, templateId, expectedRevision);
    await this.commit(
      [
        localWriteGuard(this.db, accountId),
        this.cas(accountId, templateId, expectedRevision),
        this.db
          .prepare(
            'UPDATE tasks_list_templates SET deleted_at=?,revision=revision+1,updated_at=? WHERE account_id=? AND id=?',
          )
          .bind(
            Date.parse(context.recordedAt),
            Date.parse(context.recordedAt),
            accountId,
            templateId,
          ),
        this.db
          .prepare('DELETE FROM tasks_list_template_versions WHERE template_id=?')
          .bind(templateId),
        ...(this.options.onDeleteWrites?.(accountId, templateId) ?? []),
      ],
      () => this.writable(accountId, templateId, expectedRevision),
    );
  }
  async list(
    accountId: string,
    input: TemplatePageOptions = {},
  ): Promise<Page<ListTemplateSummary>> {
    parse(id, accountId);
    const options = parse(TemplatePageOptionsSchema, input),
      scope = { accountId, kind: 'personal-list-templates' };
    const after = options.cursor ? readCursor(options.cursor, scope) : null;
    const rows = (
      await this.db
        .prepare(
          `SELECT template.*,version.snapshot_id FROM tasks_list_templates template JOIN tasks_list_template_versions version ON version.template_id=template.id AND version.version=template.content_revision WHERE template.account_id=? AND template.deleted_at IS NULL ${after ? 'AND (template.updated_at,template.id)<(?,?)' : ''} ORDER BY template.updated_at DESC,template.id DESC LIMIT ?`,
        )
        .bind(accountId, ...(after ? [after.updatedAt, after.id] : []), options.limit + 1)
        .all<HeaderRow>()
    ).results;
    const selected = rows.slice(0, options.limit),
      snapshots = await this.options.snapshots.getMany(
        accountId,
        selected.map((row) => row.snapshot_id),
      );
    const items = selected.map((row) =>
      ListTemplateSummarySchema.parse({
        id: row.id,
        accountId,
        kind: 'list',
        name: row.name,
        description: row.description,
        revision: row.revision,
        contentRevision: row.content_revision,
        snapshot: snapshots.find((snapshot) => snapshot.id === row.snapshot_id),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      }),
    );
    const last = selected.at(-1);
    return {
      items,
      nextCursor:
        rows.length > options.limit && last
          ? cursor({ ...scope, position: 0, updatedAt: last.updated_at, id: last.id })
          : null,
      coverage: localCoverage,
    };
  }
}
