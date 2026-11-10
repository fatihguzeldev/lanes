import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { TaskList } from '../../contracts/task';
import { normalizeTaskSearchText } from '../../model/task';
import type { GoogleTaskListDTO } from '../provider/google-tasks';
import { projectionListFields, type ProjectionListRow } from '../projection/store';

interface ListObservationOptions {
  now(): number;
  id(): string;
  placementWrites?(list: TaskList, defaultStatusChanged: boolean): D1PreparedStatement[];
}

function listModel(row: ProjectionListRow): TaskList {
  return {
    id: row.id,
    accountId: row.account_id,
    providerId: row.provider_id,
    providerEtag: row.provider_etag,
    title: row.title,
    isDefault: row.is_default === 1,
    revision: row.revision,
  };
}
/** Prepare provider list changes, placement contributions and their necessary task reads together. */
export class ListObservations {
  constructor(
    private readonly db: D1Database,
    private readonly options: ListObservationOptions,
  ) {}

  async prepare(
    accountId: string,
    dto: GoogleTaskListDTO,
    scanId: string | null,
    isDefault?: boolean,
  ): Promise<{ writes: D1PreparedStatement[]; changed: boolean }> {
    const old = await this.db
      .prepare(
        `SELECT ${projectionListFields},provider_missing_at FROM tasks_lists WHERE account_id=? AND provider_id=?`,
      )
      .bind(accountId, dto.id)
      .first<ProjectionListRow & { provider_missing_at: number | null }>();
    const row: ProjectionListRow = old ?? {
      id: this.options.id(),
      account_id: accountId,
      provider_id: dto.id,
      provider_etag: null,
      title: '',
      is_default: 0,
      revision: 0,
      projection_revision: 0,
      tasks_complete_at: null,
      completed_complete_at: null,
      last_full_sync_at: null,
      sync_watermark: null,
      sync_cursor: null,
      deleted_at: null,
    };
    const defaultChanged = isDefault !== undefined && Boolean(row.is_default) !== isDefault;
    const changed =
      !old ||
      old.provider_etag !== (dto.etag ?? null) ||
      old.title !== (dto.title ?? '') ||
      defaultChanged ||
      old.provider_missing_at !== null ||
      old.deleted_at !== null;
    const mapped = {
      ...listModel(row),
      title: dto.title ?? '',
      providerEtag: dto.etag ?? null,
      isDefault: isDefault ?? Boolean(row.is_default),
      revision: row.revision + Number(changed),
    };
    const writes: D1PreparedStatement[] = [];
    if (isDefault)
      writes.push(
        this.db
          .prepare(
            'UPDATE tasks_lists SET is_default=0,revision=revision+1,projection_revision=projection_revision+1 WHERE account_id=? AND id<>? AND is_default=1',
          )
          .bind(accountId, row.id),
      );
    writes.push(
      this.db
        .prepare(
          `INSERT INTO tasks_lists(id,account_id,provider_id,provider_etag,title,title_key,is_default,revision,last_seen_scan,last_synced_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id,provider_id) DO UPDATE SET provider_etag=excluded.provider_etag,title=excluded.title,title_key=excluded.title_key,is_default=excluded.is_default,revision=excluded.revision,projection_revision=tasks_lists.projection_revision+?,last_seen_scan=COALESCE(excluded.last_seen_scan,tasks_lists.last_seen_scan),provider_missing_at=NULL,deleted_at=NULL`,
        )
        .bind(
          row.id,
          accountId,
          dto.id,
          dto.etag ?? null,
          dto.title ?? '',
          normalizeTaskSearchText(dto.title ?? ''),
          Number(mapped.isDefault),
          mapped.revision,
          scanId,
          this.options.now(),
          Number(changed),
        ),
    );
    if (!old || old.deleted_at !== null || defaultChanged)
      writes.push(...(this.options.placementWrites?.(mapped, defaultChanged) ?? []));
    if (
      !old ||
      changed ||
      old.tasks_complete_at === null ||
      old.completed_complete_at === null ||
      old.sync_cursor !== null
    )
      writes.push(
        this.db
          .prepare(
            'INSERT INTO tasks_sync_list_work(account_id,list_id,next_at) VALUES (?,?,?) ON CONFLICT(account_id,list_id) DO NOTHING',
          )
          .bind(accountId, row.id, this.options.now()),
      );
    return { writes, changed };
  }
}
