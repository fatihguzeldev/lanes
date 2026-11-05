import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { GoogleTaskDTO } from '../provider/google-tasks';

interface OrdinaryTaskRow {
  provider_id: string;
  provider_etag: string | null;
  provider_updated_at: string | null;
  provider_position: string | null;
  provider_hidden: number;
  title: string;
  notes: string;
  completed: number;
  completed_at: string | null;
  scheduled_day: string | null;
  scheduled_time: string | null;
  time_zone: string | null;
}

/** Complex observations still use projection reconciliation, including checklist captures. */
export async function unchangedTaskPageWrites(
  db: D1Database,
  accountId: string,
  listId: string,
  records: GoogleTaskDTO[],
  scanId: string,
): Promise<D1PreparedStatement[] | null> {
  if (records.some((task) => task.deleted || task.parent || task.assignmentInfo)) return null;
  const ids = JSON.stringify(records.map((task) => task.id));
  const rows = (
    await db
      .prepare(
        `SELECT provider_id,provider_etag,provider_updated_at,provider_position,provider_hidden,
    title,notes,completed,completed_at,scheduled_day,scheduled_time,time_zone FROM tasks_tasks t
    WHERE account_id=? AND list_id=? AND provider_id IN(SELECT value FROM json_each(?))
    AND deleted_at IS NULL AND provider_missing_at IS NULL AND unsupported_hierarchy=0
    AND parent_id IS NULL AND provider_parent_id IS NULL AND repeat_rule_json IS NULL
    AND json_extract(capabilities_json,'$.canEdit')=1
    AND json_extract(capabilities_json,'$.canEditNotes')=1
    AND json_extract(capabilities_json,'$.canMove')=1
    AND json_extract(capabilities_json,'$.canDelete')=1
    AND json_extract(capabilities_json,'$.canHaveChildren')=1
    AND json_extract(capabilities_json,'$.canNest')=1
    AND json_extract(capabilities_json,'$.assignmentSource') IS NULL
    AND json_extract(capabilities_json,'$.sourceUrl') IS NULL
    AND json_extract(capabilities_json,'$.restriction') IS NULL
    AND NOT EXISTS(SELECT 1 FROM tasks_tasks child WHERE child.account_id=t.account_id
      AND child.list_id=t.list_id AND child.provider_parent_id=t.provider_id AND child.deleted_at IS NULL)`,
      )
      .bind(accountId, listId, ids)
      .all<OrdinaryTaskRow>()
  ).results;
  if (rows.length !== records.length) return null;
  const byId = new Map(rows.map((row) => [row.provider_id, row]));
  if (
    !records.every((task) => {
      const old = byId.get(task.id);
      const day = task.due?.slice(0, 10) ?? null;
      return (
        old &&
        old.provider_etag === (task.etag ?? null) &&
        old.provider_updated_at === (task.updated ?? null) &&
        old.provider_position === (task.position ?? null) &&
        old.provider_hidden === Number(task.hidden ?? false) &&
        old.title === (task.title ?? '') &&
        old.notes === (task.notes ?? '') &&
        old.completed === Number(task.status === 'completed') &&
        old.completed_at === (task.completed ?? null) &&
        old.scheduled_day === day &&
        (day !== null || (old.scheduled_time === null && old.time_zone === null))
      );
    })
  )
    return null;
  return [
    db
      .prepare(
        'UPDATE tasks_tasks SET last_seen_scan=? WHERE account_id=? AND list_id=? AND provider_id IN(SELECT value FROM json_each(?))',
      )
      .bind(scanId, accountId, listId, ids),
  ];
}
