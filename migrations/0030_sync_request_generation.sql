ALTER TABLE tasks_sync_jobs ADD COLUMN request_revision INTEGER NOT NULL DEFAULT 0;

INSERT INTO tasks_sync_jobs(account_id,next_at,requested_at,default_pending,inventory_pending,fairness_order)
SELECT pending.account_id,MIN(pending.next_at),MIN(pending.next_at),0,0,
  (SELECT turn FROM tasks_sync_fairness WHERE singleton=1)
FROM (
  SELECT account_id,next_at FROM tasks_sync_list_work
  UNION ALL
  SELECT account_id,next_at FROM tasks_sync_checks
) pending
GROUP BY pending.account_id
ON CONFLICT(account_id) DO NOTHING;
