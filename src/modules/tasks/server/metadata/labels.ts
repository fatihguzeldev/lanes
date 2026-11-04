import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import { assertLocalWritable, localWriteGuard } from '../../../accounts/server/connections/access';
import { LabelInputSchema, LabelSchema } from '../../contracts/task';
import type { Label } from '../../contracts/task';
import { LabelPatchSchema } from '../../contracts/metadata-commands';
import { normalizeLabelName } from '../../model/task';
import type { LabelRow } from './records';
import type { MetadataContext } from './context';
import { id, revision, contextSchema, parse, bounded } from './validation';
import type { MetadataPersistence } from './persistence';

function label(row: LabelRow): Label {
  return LabelSchema.parse({
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    color: row.color,
    revision: row.revision,
  });
}

export class TaskLabelService {
  constructor(
    private readonly db: D1Database,
    private readonly persistence: MetadataPersistence,
  ) {}

  async activeLabel(
    accountId: string,
    labelId: string,
    expectedRevision?: number,
  ): Promise<LabelRow> {
    const row = await this.persistence.first<LabelRow>(
      this.db
        .prepare('SELECT * FROM tasks_labels WHERE account_id=? AND id=?')
        .bind(accountId, labelId),
    );
    if (!row) throw new AppError('not_found', 'this label is no longer available', 404);
    if (expectedRevision !== undefined && row.revision !== expectedRevision)
      throw new AppError('conflict', 'this label changed; refresh before reapplying the edit', 409);
    return row;
  }

  async assertLabelNotDeleting(accountId: string, labelId: string): Promise<void> {
    if (
      await this.persistence.first(
        this.db
          .prepare(
            "SELECT 1 FROM tasks_label_deletions WHERE account_id=? AND label_id=? AND state='pending'",
          )
          .bind(accountId, labelId),
      )
    ) {
      throw new AppError(
        'conflict',
        'this label is being deleted; its remaining associations are still visible',
        409,
      );
    }
  }

  private async assertLabelNameFree(
    accountId: string,
    nameKey: string,
    excludingId: string | null,
  ): Promise<void> {
    if (
      await this.persistence.first(
        this.db
          .prepare(
            'SELECT 1 FROM tasks_labels WHERE account_id=? AND name_key=? AND (? IS NULL OR id<>?)',
          )
          .bind(accountId, nameKey, excludingId, excludingId),
      )
    ) {
      throw new AppError('conflict', 'an account label already uses this name', 409, false, {
        name: 'choose a different label name',
      });
    }
  }

  async validateLabels(accountId: string, labelIds: string[]): Promise<void> {
    if (!labelIds.length) return;
    const rows = await this.persistence.rows<{ id: string; deleting: number }>(
      this.db
        .prepare(
          `SELECT label.id,EXISTS (SELECT 1 FROM tasks_label_deletions job WHERE job.account_id=label.account_id AND job.label_id=label.id AND job.state='pending') AS deleting
      FROM tasks_labels label WHERE label.account_id=? AND label.id IN (SELECT value FROM json_each(?))`,
        )
        .bind(accountId, JSON.stringify(labelIds)),
    );
    if (rows.length !== labelIds.length)
      throw new AppError(
        'validation_failed',
        'choose existing labels from this account',
        422,
        false,
        { labelIds: 'one or more labels are missing or belong to another account' },
      );
    if (rows.some((row) => row.deleting === 1))
      throw new AppError('conflict', 'a selected label is being deleted', 409);
  }

  labelsGuard(accountId: string, labelIds: string[]): D1PreparedStatement {
    return this.persistence.guard(
      `NOT EXISTS (SELECT 1 FROM json_each(?) selected LEFT JOIN tasks_labels label ON label.account_id=? AND label.id=selected.value
      WHERE label.id IS NULL OR EXISTS (SELECT 1 FROM tasks_label_deletions job WHERE job.account_id=label.account_id AND job.label_id=label.id AND job.state='pending'))`,
      [JSON.stringify(labelIds), accountId],
    );
  }

  async createLabel(
    accountId: string,
    input: unknown,
    rawContext: MetadataContext,
    admittedId: string = crypto.randomUUID(),
  ): Promise<Label> {
    parse(id, accountId);
    parse(id, admittedId);
    parse(contextSchema, rawContext);
    const value = parse(LabelInputSchema, input);
    value.name = value.name.normalize('NFC');
    const nameKey = normalizeLabelName(value.name);
    const explain = async () => {
      await assertLocalWritable(this.db, accountId);
      await this.assertLabelNameFree(accountId, nameKey, null);
    };
    await explain();
    await this.persistence.commit(
      [
        localWriteGuard(this.db, accountId),
        this.persistence.guard(
          'NOT EXISTS (SELECT 1 FROM tasks_labels WHERE account_id=? AND name_key=?)',
          [accountId, nameKey],
        ),
        this.db
          .prepare('INSERT INTO tasks_labels(id,account_id,name,name_key,color) VALUES (?,?,?,?,?)')
          .bind(admittedId, accountId, value.name, nameKey, value.color),
      ],
      explain,
    );
    return label(await this.activeLabel(accountId, admittedId));
  }

  async updateLabel(
    accountId: string,
    labelId: string,
    input: unknown,
    expectedRevision: number,
    rawContext: MetadataContext,
  ): Promise<Label> {
    parse(id, accountId);
    parse(id, labelId);
    parse(revision, expectedRevision);
    parse(contextSchema, rawContext);
    const patch = parse(LabelPatchSchema, input);
    if (patch.name !== undefined) patch.name = patch.name.normalize('NFC');
    const explain = async () => {
      await assertLocalWritable(this.db, accountId);
      const row = await this.activeLabel(accountId, labelId, expectedRevision);
      await this.assertLabelNotDeleting(accountId, labelId);
      await this.assertLabelNameFree(
        accountId,
        normalizeLabelName(patch.name ?? row.name),
        labelId,
      );
      return row;
    };
    const row = await explain(),
      name = patch.name ?? row.name,
      nameKey = normalizeLabelName(name);
    await this.persistence.commit(
      [
        localWriteGuard(this.db, accountId),
        this.persistence.guard(
          `EXISTS (SELECT 1 FROM tasks_labels WHERE account_id=? AND id=? AND revision=?) AND NOT EXISTS (SELECT 1 FROM tasks_label_deletions WHERE account_id=? AND label_id=? AND state='pending') AND NOT EXISTS (SELECT 1 FROM tasks_labels WHERE account_id=? AND name_key=? AND id<>?)`,
          [accountId, labelId, expectedRevision, accountId, labelId, accountId, nameKey, labelId],
        ),
        this.db
          .prepare(
            'UPDATE tasks_labels SET name=?,name_key=?,color=?,revision=revision+1 WHERE account_id=? AND id=?',
          )
          .bind(name, nameKey, patch.color ?? row.color, accountId, labelId),
      ],
      async () => {
        await explain();
      },
    );
    return label(await this.activeLabel(accountId, labelId));
  }

  /** Resolve reusable label definitions in a confirmed create receipt. The caller
   * places these writes before initial task metadata and owns its journal claim fence. */
  async prepareResolveLabelDefinitions(
    accountId: string,
    input: unknown,
    rawContext: MetadataContext,
  ): Promise<{
    writes: D1PreparedStatement[];
    labelIds: string[];
    colorConflicts: { name: string; requestedColor: string; keptColor: string }[];
  }> {
    parse(id, accountId);
    const context = parse(contextSchema, rawContext),
      definitions = parse(z.array(LabelInputSchema).max(20), input);
    bounded(definitions);
    const normalized = definitions.map((value) => ({
      ...value,
      name: value.name.normalize('NFC'),
      key: normalizeLabelName(value.name),
    }));
    if (new Set(normalized.map((value) => value.key)).size !== normalized.length)
      throw new AppError('validation_failed', 'use each normalized label name once', 422);
    const known = await this.persistence.rows<LabelRow & { deleting: number }>(
      this.db
        .prepare(
          "SELECT label.*,EXISTS (SELECT 1 FROM tasks_label_deletions job WHERE job.account_id=label.account_id AND job.label_id=label.id AND job.state='pending') AS deleting FROM tasks_labels label WHERE label.account_id=? AND label.name_key IN (SELECT value FROM json_each(?))",
        )
        .bind(accountId, JSON.stringify(normalized.map((value) => value.key))),
    );
    const selected = [];
    const colorConflicts: { name: string; requestedColor: string; keptColor: string }[] = [];
    for (const definition of normalized) {
      const existing = known.find((value) => value.name_key === definition.key);
      if (existing) {
        if (existing.deleting)
          throw new AppError('conflict', 'a reusable label is being deleted', 409);
        if (existing.color !== definition.color)
          colorConflicts.push({
            name: existing.name,
            requestedColor: definition.color,
            keptColor: existing.color,
          });
        selected.push({
          ...definition,
          id: existing.id,
          existing: true,
          revision: existing.revision,
        });
      } else {
        const bytes = new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(
              JSON.stringify([accountId, context.operationId, context.stepKey, definition.key]),
            ),
          ),
        );
        selected.push({
          ...definition,
          id:
            'label-' +
            Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
              .join('')
              .slice(0, 32),
          existing: false,
          revision: 0,
        });
      }
    }
    if (!selected.length) return { writes: [], labelIds: [], colorConflicts: [] };
    const encoded = JSON.stringify(selected);
    const writes = [
      this.persistence.guard(
        `NOT EXISTS (SELECT 1 FROM json_each(?) definition LEFT JOIN tasks_labels label ON label.account_id=? AND label.name_key=json_extract(definition.value,'$.key') WHERE (json_extract(definition.value,'$.existing')=1 AND (label.id IS NULL OR label.id<>json_extract(definition.value,'$.id') OR label.revision<>json_extract(definition.value,'$.revision'))) OR (json_extract(definition.value,'$.existing')=0 AND label.id IS NOT NULL) OR EXISTS (SELECT 1 FROM tasks_label_deletions job WHERE job.account_id=? AND job.label_id=label.id AND job.state='pending'))`,
        [encoded, accountId, accountId],
      ),
      this.db
        .prepare(
          `INSERT INTO tasks_labels(id,account_id,name,name_key,color) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.name'),json_extract(value,'$.key'),json_extract(value,'$.color') FROM json_each(?) WHERE json_extract(value,'$.existing')=0`,
        )
        .bind(accountId, encoded),
    ];
    return { writes, labelIds: selected.map((value) => value.id), colorConflicts };
  }
}
