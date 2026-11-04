import type { D1Database } from '@cloudflare/workers-types';
import { z } from 'zod';
import { AppError } from '../../../../shared/contracts/errors';
import type { Page } from '../../../../shared/contracts/http';
import { ResourceIdSchema } from '../../../../shared/contracts/identity';
import { LabelQuerySchema, type LabelQueryInput } from '../../contracts/query';
import { LabelInputSchema, LabelSchema, type Label } from '../../contracts/task';
import { normalizeTaskSearchText } from '../../model/task';
import { decodeCursor, encodeCursor, fingerprint, parse, readIdsSchema } from './pagination';
import { readProjectionFirst, readProjectionRows } from './read';
interface LabelRow {
  id: string;
  account_id: string;
  name: string;
  name_key: string;
  color: string;
  revision: number;
}
function mapLabel(row: LabelRow): Label {
  try {
    return LabelSchema.parse({
      id: row.id,
      accountId: row.account_id,
      name: row.name,
      color: row.color,
      revision: row.revision,
    });
  } catch {
    throw new AppError('storage_unavailable', 'stored label data could not be read safely', 503);
  }
}

export class LabelQueries {
  constructor(private readonly db: D1Database) {}

  async readLabelsByIds(accountId: string, ids: readonly string[]): Promise<Label[]> {
    parse(ResourceIdSchema.max(1_024), accountId);
    const selected = [...new Set(parse(readIdsSchema, ids))];
    if (!selected.length) return [];
    const rows = await readProjectionRows<LabelRow>(
      this.db
        .prepare(
          'SELECT * FROM tasks_labels WHERE account_id=? AND id IN(SELECT value FROM json_each(?))',
        )
        .bind(accountId, JSON.stringify(selected)),
    );
    const byId = new Map(rows.map((row) => [row.id, mapLabel(row)]));
    const labels = selected.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    if (new TextEncoder().encode(JSON.stringify(labels)).byteLength > 64 * 1024)
      throw new AppError('validation_failed', 'read fewer label identities at a time', 422);
    return labels;
  }

  async readLabelsByNames(accountId: string, names: readonly string[]): Promise<Label[]> {
    parse(ResourceIdSchema.max(1_024), accountId);
    const selected = parse(z.array(LabelInputSchema.shape.name).max(100), names).map((name) =>
      normalizeTaskSearchText(name.trim()),
    );
    if (new Set(selected).size !== selected.length)
      throw new AppError('validation_failed', 'use each normalized label name once', 422);
    if (!selected.length) return [];
    const rows = await readProjectionRows<LabelRow>(
      this.db
        .prepare(
          'SELECT * FROM tasks_labels WHERE account_id=? AND name_key IN(SELECT value FROM json_each(?)) ORDER BY name_key,id',
        )
        .bind(accountId, JSON.stringify(selected)),
    );
    const labels = rows.map(mapLabel);
    if (new TextEncoder().encode(JSON.stringify(labels)).byteLength > 64 * 1024)
      throw new AppError('validation_failed', 'read fewer label names at a time', 422);
    return labels;
  }

  async readLabels(accountId: string, input: LabelQueryInput = {}): Promise<Page<Label>> {
    parse(ResourceIdSchema.max(1_024), accountId);
    const query = parse(LabelQuerySchema, input);
    const search = normalizeTaskSearchText(query.query).trim();
    const queryHash = await fingerprint({ accountId, query: search });
    const cursor = decodeCursor(query.cursor, 'labels-v1', accountId, queryHash);
    let anchor: LabelRow | null = null;
    if (cursor) {
      anchor = await readProjectionFirst<LabelRow>(
        this.db
          .prepare(
            'SELECT * FROM tasks_labels WHERE account_id=? AND id=? AND revision=? AND instr(name_key,?)>0',
          )
          .bind(accountId, cursor.id, cursor.revision, search),
      );
      if (!anchor)
        throw new AppError('conflict', 'the label page changed; refresh this selection', 409);
    }
    const rows = await readProjectionRows<LabelRow>(
      this.db
        .prepare(
          `SELECT * FROM tasks_labels WHERE account_id=? AND instr(name_key,?)>0 ${anchor ? 'AND (name_key,id)>(?,?)' : ''} ORDER BY name_key,id LIMIT ?`,
        )
        .bind(accountId, search, ...(anchor ? [anchor.name_key, anchor.id] : []), query.limit + 1),
    );
    const selected = rows.slice(0, query.limit);
    const last = selected[selected.length - 1];
    return {
      items: selected.map(mapLabel),
      nextCursor:
        last && rows.length > query.limit
          ? encodeCursor({
              kind: 'labels-v1',
              accountId,
              fingerprint: queryHash,
              id: last.id,
              revision: last.revision,
            })
          : null,
      coverage: { complete: true, lastSyncedAt: null, stale: false },
    };
  }
}
