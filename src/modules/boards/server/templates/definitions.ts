import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import type { Page } from '../../../../shared/contracts/http';
import { assertLocalWritable, localWriteGuard } from '../../../accounts/server/connections/access';

import { ResourceIdSchema } from '../../../../shared/contracts/identity';
import { readActiveLists } from '../../../tasks/server/queries/lists';
import {
  ListSnapshotStore,
  type SnapshotSourceList,
  type TemplateContext,
} from '../../../tasks/server/templates/lists';
import {
  SnapshotOptionsSchema,
  TemplateMetadataPatchSchema,
  TemplatePageOptionsSchema,
  type TemplatePageOptions,
} from '../../../tasks/contracts/template';
import { TemplateDocumentStore } from '../../../tasks/server/templates/documents';
import { boardTemplateGallery } from '../../model/template-gallery';
import { TemplateNameSchema, TemplateDescriptionSchema } from '../../../tasks/contracts/template';
import type { MetadataContext } from '../../../tasks/server/metadata/context';
import {
  BoardTemplateAppearanceSchema,
  BoardTemplateSummarySchema,
  CreateBoardTemplateSchema,
  type BoardTemplateSummary,
} from '../../contracts/template';
const id = ResourceIdSchema.max(1024),
  revision = z.number().int().nonnegative().safe();
const coverage = { complete: true, lastSyncedAt: null, stale: false } as const;
function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new AppError('validation_failed', 'check the board template fields', 422);
  return result.data;
}
function guard(db: D1Database, condition: string, bindings: unknown[]): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO boards_write_guards(valid) SELECT 0 WHERE NOT (${condition})`)
    .bind(...bindings);
}
export async function readTemplateListAppearance(
  db: D1Database,
  accountId: string,
  listId: string,
): Promise<{
  color: string;
  guardWrites: D1PreparedStatement[];
  verifySource(): Promise<void>;
}> {
  const row = await db
    .prepare(
      'SELECT color,revision,board_id FROM boards_memberships WHERE account_id=? AND list_id=?',
    )
    .bind(accountId, listId)
    .first<{
      color: string;
      revision: number;
      board_id: string;
    }>();
  if (!row)
    throw new AppError('not_found', 'this source list has no retained board placement', 404);
  return {
    color: row.color,
    guardWrites: [
      guard(
        db,
        'EXISTS (SELECT 1 FROM boards_memberships WHERE account_id=? AND list_id=? AND revision=? AND board_id=?)',
        [accountId, listId, row.revision, row.board_id],
      ),
    ],
    verifySource: async () => {
      if (
        !(await db
          .prepare(
            'SELECT 1 FROM boards_memberships WHERE account_id=? AND list_id=? AND revision=? AND board_id=?',
          )
          .bind(accountId, listId, row.revision, row.board_id)
          .first())
      )
        throw new AppError('conflict', 'the source list appearance changed during capture', 409);
    },
  };
}
interface Header {
  id: string;
  account_id: string;
  name: string;
  description: string;
  revision: number;
  content_revision: number;
  created_at: number;
  updated_at: number;
  snapshot_id: string;
  appearance_json: string;
}
export interface BoardTemplateOptions {
  snapshots: ListSnapshotStore;
  commitWrites(writes: D1PreparedStatement[]): Promise<unknown>;
  onDeleteWrites?(accountId: string, templateId: string): D1PreparedStatement[];
}
/** Board appearance and ordered membership stay with boards; reusable task content stays with tasks. */
export class BoardTemplateService {
  constructor(
    private readonly db: D1Database,
    private readonly options: BoardTemplateOptions,
  ) {}
  async source(
    accountId: string,
    boardId: string,
    expectedRevision: number,
  ): Promise<{
    lists: SnapshotSourceList[];
    appearance: z.infer<typeof BoardTemplateAppearanceSchema>;
    guardWrites: D1PreparedStatement[];
    verifySource(): Promise<void>;
  }> {
    parse(id, accountId);
    parse(id, boardId);
    parse(revision, expectedRevision);
    const board = await this.db
      .prepare(
        'SELECT title,emoji,color,background_url,revision FROM boards_boards WHERE account_id=? AND id=?',
      )
      .bind(accountId, boardId)
      .first<{
        title: string;
        emoji: string | null;
        color: string;
        background_url: string | null;
        revision: number;
      }>();
    if (!board) throw new AppError('not_found', 'this source board is no longer available', 404);
    if (board.revision !== expectedRevision)
      throw new AppError('conflict', 'the source board changed; refresh its snapshot preview', 409);
    const members = (
      await this.db
        .prepare(
          'SELECT list_id,color,position,revision FROM boards_memberships WHERE account_id=? AND board_id=? ORDER BY position,list_id LIMIT 101',
        )
        .bind(accountId, boardId)
        .all<{
          list_id: string;
          color: string;
          position: number;
          revision: number;
        }>()
    ).results;
    if (members.length > 100)
      throw new AppError(
        'validation_failed',
        'one board template captures at most 100 lists; choose a smaller source',
        422,
      );
    const taskLists = await readActiveLists(
      this.db,
      accountId,
      members.map((value) => value.list_id),
    );
    if (taskLists.length !== members.length)
      throw new AppError('conflict', 'refresh the source board before capturing its lists', 409);
    const checkpoint = JSON.stringify(members);
    const verifySource = async () => {
      const current = await this.db
        .prepare('SELECT revision FROM boards_boards WHERE account_id=? AND id=?')
        .bind(accountId, boardId)
        .first<{
          revision: number;
        }>();
      const currentMembers = (
        await this.db
          .prepare(
            'SELECT list_id,color,position,revision FROM boards_memberships WHERE account_id=? AND board_id=? ORDER BY position,list_id LIMIT 101',
          )
          .bind(accountId, boardId)
          .all<{
            list_id: string;
            color: string;
            position: number;
            revision: number;
          }>()
      ).results;
      if (current?.revision !== expectedRevision || JSON.stringify(currentMembers) !== checkpoint)
        throw new AppError(
          'conflict',
          'the source board or its list placement changed during capture',
          409,
        );
    };
    return {
      verifySource,
      appearance: BoardTemplateAppearanceSchema.parse({
        title: board.title,
        emoji: board.emoji,
        color: board.color,
        backgroundUrl: board.background_url,
      }),
      lists: members.map((member, position) => ({
        sourceListId: member.list_id,
        color: member.color,
        position,
        revision: taskLists.find((list) => list.id === member.list_id)!.revision,
      })),
      guardWrites: [
        guard(
          this.db,
          'EXISTS (SELECT 1 FROM boards_boards WHERE account_id=? AND id=? AND revision=?)',
          [accountId, boardId, expectedRevision],
        ),
        guard(
          this.db,
          `(SELECT COUNT(*) FROM boards_memberships WHERE account_id=? AND board_id=?)=? AND NOT EXISTS (SELECT 1 FROM json_each(?) expected LEFT JOIN boards_memberships member ON member.account_id=? AND member.list_id=json_extract(expected.value,'$.list_id') WHERE member.list_id IS NULL OR member.board_id<>? OR member.revision<>json_extract(expected.value,'$.revision') OR member.position<>json_extract(expected.value,'$.position'))`,
          [accountId, boardId, members.length, checkpoint, accountId, boardId],
        ),
      ],
    };
  }
  private async header(accountId: string, templateId: string, version?: number): Promise<Header> {
    parse(id, accountId);
    parse(id, templateId);
    const row = await this.db
      .prepare(
        'SELECT template.*,version.snapshot_id,version.appearance_json FROM boards_templates template JOIN boards_template_versions version ON version.template_id=template.id AND version.version=COALESCE(?,template.content_revision) WHERE template.account_id=? AND template.id=? AND template.deleted_at IS NULL',
      )
      .bind(version ?? null, accountId, templateId)
      .first<Header>();
    if (!row)
      throw new AppError('not_found', 'this personal board template is no longer available', 404);
    return row;
  }
  private async model(row: Header, version = row.content_revision): Promise<BoardTemplateSummary> {
    return BoardTemplateSummarySchema.parse({
      id: row.id,
      accountId: row.account_id,
      kind: 'board',
      name: row.name,
      description: row.description,
      revision: row.revision,
      contentRevision: version,
      snapshot: await this.options.snapshots.get(row.account_id, row.snapshot_id),
      appearance: JSON.parse(row.appearance_json),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    });
  }
  async get(accountId: string, templateId: string): Promise<BoardTemplateSummary> {
    return this.model(await this.header(accountId, templateId));
  }
  async getVersion(
    accountId: string,
    templateId: string,
    version: number,
  ): Promise<BoardTemplateSummary> {
    parse(z.number().int().positive(), version);
    return this.model(await this.header(accountId, templateId, version), version);
  }
  private async writable(
    accountId: string,
    templateId: string,
    expectedRevision: number,
  ): Promise<Header> {
    await assertLocalWritable(this.db, accountId);
    const row = await this.header(accountId, templateId);
    if (row.revision !== expectedRevision)
      throw new AppError(
        'conflict',
        'this board template changed; refresh before reapplying the edit',
        409,
      );
    return row;
  }
  versionGuardWrite(
    accountId: string,
    templateId: string,
    version: number,
    snapshotId: string,
  ): D1PreparedStatement {
    return guard(
      this.db,
      'EXISTS (SELECT 1 FROM boards_templates template JOIN boards_template_versions version ON version.template_id=template.id AND version.version=? WHERE template.account_id=? AND template.id=? AND template.deleted_at IS NULL AND version.snapshot_id=?)',
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
      'EXISTS (SELECT 1 FROM boards_templates WHERE account_id=? AND id=? AND revision=? AND deleted_at IS NULL)',
      [accountId, templateId, expectedRevision],
    );
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
        'the board template and its operation receipt could not be saved',
        503,
        true,
      );
    }
  }
  async previewSource(accountId: string, input: unknown, context: TemplateContext) {
    const value = parse(
        SnapshotOptionsSchema.extend({ boardId: id, boardRevision: revision }).strict(),
        input,
      ),
      source = await this.source(accountId, value.boardId, value.boardRevision),
      capture = await this.options.snapshots.prepareCapture(accountId, source.lists, {
        ...value,
        saveDay: context.saveDay,
        zone: context.zone,
        recordedAt: context.recordedAt,
        guardWrites: source.guardWrites,
      });
    const { id: _id, createdAt: _createdAt, ...snapshot } = capture.snapshot;
    return { snapshot, appearance: source.appearance };
  }
  async createFromSnapshot(
    accountId: string,
    snapshotId: string,
    input: unknown,
    context: MetadataContext,
    admittedTemplateId: string = crypto.randomUUID(),
  ): Promise<BoardTemplateSummary> {
    await assertLocalWritable(this.db, accountId);
    const value = parse(
      z
        .object({
          name: TemplateNameSchema,
          description: TemplateDescriptionSchema.default(''),
          appearance: BoardTemplateAppearanceSchema,
        })
        .strict(),
      input,
    );
    await this.options.snapshots.get(accountId, snapshotId);
    parse(id, admittedTemplateId);
    await this.commit(
      [
        localWriteGuard(this.db, accountId),
        this.db
          .prepare(
            'INSERT INTO boards_templates(id,account_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?)',
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
            'INSERT INTO boards_template_versions(template_id,version,snapshot_id,appearance_json) VALUES (?,1,?,?)',
          )
          .bind(admittedTemplateId, snapshotId, JSON.stringify(value.appearance)),
        this.options.snapshots.pinWrite(
          accountId,
          snapshotId,
          `board-version:${admittedTemplateId}:1`,
        ),
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
    appearanceInput?: unknown,
  ): Promise<BoardTemplateSummary> {
    const row = await this.writable(accountId, templateId, expectedRevision);
    await this.options.snapshots.get(accountId, snapshotId);
    const appearance = parse(
      BoardTemplateAppearanceSchema,
      appearanceInput ?? JSON.parse(row.appearance_json),
    );
    await this.commit(
      [
        localWriteGuard(this.db, accountId),
        this.cas(accountId, templateId, expectedRevision),
        this.db
          .prepare(
            'INSERT INTO boards_template_versions(template_id,version,snapshot_id,appearance_json) VALUES (?,?,?,?)',
          )
          .bind(templateId, row.content_revision + 1, snapshotId, JSON.stringify(appearance)),
        this.options.snapshots.pinWrite(
          accountId,
          snapshotId,
          `board-version:${templateId}:${row.content_revision + 1}`,
        ),
        this.db
          .prepare(
            'UPDATE boards_templates SET content_revision=content_revision+1,revision=revision+1,updated_at=? WHERE account_id=? AND id=?',
          )
          .bind(Date.parse(context.recordedAt), accountId, templateId),
        this.options.snapshots.releasePinWrite(accountId, snapshotId, `document:${snapshotId}`),
      ],
      () => this.writable(accountId, templateId, expectedRevision),
    );
    return this.get(accountId, templateId);
  }
  gallery() {
    return boardTemplateGallery;
  }
  async saveGallery(
    accountId: string,
    galleryId: string,
    context: TemplateContext,
    admitted: {
      templateId?: string;
      snapshotId?: string;
    } = {},
  ): Promise<BoardTemplateSummary> {
    await assertLocalWritable(this.db, accountId);
    const entry = boardTemplateGallery.find((value) => value.id === galleryId);
    if (!entry) throw new AppError('not_found', 'this bundled board starter is not available', 404);
    const templateId = parse(id, admitted.templateId ?? crypto.randomUUID()),
      documents = new TemplateDocumentStore(this.db, this.options),
      prepared = documents.prepareSmall(
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
            'INSERT INTO boards_templates(id,account_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?)',
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
            'INSERT INTO boards_template_versions(template_id,version,snapshot_id,appearance_json) VALUES (?,1,?,?)',
          )
          .bind(templateId, prepared.snapshotId, JSON.stringify(entry.appearance)),
        this.options.snapshots.pinWrite(
          accountId,
          prepared.snapshotId,
          `board-version:${templateId}:1`,
        ),
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
  ): Promise<BoardTemplateSummary> {
    const value = parse(CreateBoardTemplateSchema, input);
    await assertLocalWritable(this.db, accountId);
    const templateId = parse(id, admitted.templateId ?? crypto.randomUUID()),
      source = await this.source(accountId, value.boardId, value.boardRevision);
    const capture = await this.options.snapshots.prepareCapture(accountId, source.lists, {
      ...value,
      guardWrites: source.guardWrites,
      saveDay: context.saveDay,
      zone: context.zone,
      recordedAt: context.recordedAt,
      ...(admitted.snapshotId ? { snapshotId: admitted.snapshotId } : {}),
    });
    await this.commit(
      [
        ...capture.writes,
        this.db
          .prepare(
            'INSERT INTO boards_templates(id,account_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?)',
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
            'INSERT INTO boards_template_versions(template_id,version,snapshot_id,appearance_json) VALUES (?,1,?,?)',
          )
          .bind(templateId, capture.snapshot.id, JSON.stringify(source.appearance)),
        this.options.snapshots.pinWrite(
          accountId,
          capture.snapshot.id,
          `board-version:${templateId}:1`,
        ),
      ],
      async () => {
        await assertLocalWritable(this.db, accountId);
        await source.verifySource();
        await capture.verifySource();
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
  ): Promise<BoardTemplateSummary> {
    const value = parse(
        SnapshotOptionsSchema.extend({ boardId: id, boardRevision: revision }).strict(),
        input,
      ),
      row = await this.writable(accountId, templateId, expectedRevision),
      source = await this.source(accountId, value.boardId, value.boardRevision);
    const capture = await this.options.snapshots.prepareCapture(accountId, source.lists, {
      ...value,
      guardWrites: source.guardWrites,
      saveDay: context.saveDay,
      zone: context.zone,
      recordedAt: context.recordedAt,
      ...(admittedSnapshotId ? { snapshotId: admittedSnapshotId } : {}),
    });
    await this.commit(
      [
        this.cas(accountId, templateId, expectedRevision),
        ...capture.writes,
        this.db
          .prepare(
            'INSERT INTO boards_template_versions(template_id,version,snapshot_id,appearance_json) VALUES (?,?,?,?)',
          )
          .bind(
            templateId,
            row.content_revision + 1,
            capture.snapshot.id,
            JSON.stringify(source.appearance),
          ),
        this.options.snapshots.pinWrite(
          accountId,
          capture.snapshot.id,
          `board-version:${templateId}:${row.content_revision + 1}`,
        ),
        this.db
          .prepare(
            'UPDATE boards_templates SET revision=revision+1,content_revision=content_revision+1,updated_at=? WHERE account_id=? AND id=?',
          )
          .bind(Date.parse(context.recordedAt), accountId, templateId),
      ],
      async () => {
        await this.writable(accountId, templateId, expectedRevision);
        await source.verifySource();
        await capture.verifySource();
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
  ): Promise<BoardTemplateSummary> {
    const value = parse(TemplateMetadataPatchSchema, input),
      row = await this.writable(accountId, templateId, expectedRevision);
    await this.commit(
      [
        localWriteGuard(this.db, accountId),
        this.cas(accountId, templateId, expectedRevision),
        this.db
          .prepare(
            'UPDATE boards_templates SET name=?,description=?,revision=revision+1,updated_at=? WHERE account_id=? AND id=?',
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
            'UPDATE boards_templates SET deleted_at=?,updated_at=?,revision=revision+1 WHERE account_id=? AND id=?',
          )
          .bind(
            Date.parse(context.recordedAt),
            Date.parse(context.recordedAt),
            accountId,
            templateId,
          ),
        this.options.snapshots.releasePinsByOwnerPrefixWrite(
          accountId,
          `board-version:${templateId}:`,
        ),
        this.db
          .prepare('DELETE FROM boards_template_versions WHERE template_id=?')
          .bind(templateId),
        ...(this.options.onDeleteWrites?.(accountId, templateId) ?? []),
      ],
      () => this.writable(accountId, templateId, expectedRevision),
    );
  }
  async list(
    accountId: string,
    input: TemplatePageOptions = {},
  ): Promise<Page<BoardTemplateSummary>> {
    parse(id, accountId);
    const options = parse(TemplatePageOptionsSchema, input);
    let after: {
      accountId: string;
      updatedAt: number;
      id: string;
    } | null = null;
    if (options.cursor) {
      try {
        after = z
          .object({ accountId: id, updatedAt: z.number().int(), id })
          .strict()
          .parse(JSON.parse(atob(options.cursor)));
        if (after.accountId !== accountId) throw new Error();
      } catch {
        throw new AppError(
          'validation_failed',
          'this board template cursor belongs to another account',
          422,
        );
      }
    }
    const rows = (
      await this.db
        .prepare(
          `SELECT template.*,version.snapshot_id,version.appearance_json FROM boards_templates template JOIN boards_template_versions version ON version.template_id=template.id AND version.version=template.content_revision WHERE template.account_id=? AND template.deleted_at IS NULL ${after ? 'AND (template.updated_at,template.id)<(?,?)' : ''} ORDER BY template.updated_at DESC,template.id DESC LIMIT ?`,
        )
        .bind(accountId, ...(after ? [after.updatedAt, after.id] : []), options.limit + 1)
        .all<Header>()
    ).results;
    const selected = rows.slice(0, options.limit),
      snapshots = await this.options.snapshots.getMany(
        accountId,
        selected.map((row) => row.snapshot_id),
      ),
      last = selected.at(-1);
    return {
      items: selected.map((row) =>
        BoardTemplateSummarySchema.parse({
          id: row.id,
          accountId,
          kind: 'board',
          name: row.name,
          description: row.description,
          revision: row.revision,
          contentRevision: row.content_revision,
          snapshot: snapshots.find((value) => value.id === row.snapshot_id),
          appearance: JSON.parse(row.appearance_json),
          createdAt: new Date(row.created_at).toISOString(),
          updatedAt: new Date(row.updated_at).toISOString(),
        }),
      ),
      nextCursor:
        rows.length > options.limit && last
          ? btoa(JSON.stringify({ accountId, updatedAt: last.updated_at, id: last.id }))
          : null,
      coverage,
    };
  }
}
