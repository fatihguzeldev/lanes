ALTER TABLE tasks_lists ADD COLUMN order_recovery_attempted INTEGER NOT NULL DEFAULT 0
  CHECK(order_recovery_attempted IN (0,1));
ALTER TABLE tasks_sync_checks ADD COLUMN order_recovery INTEGER NOT NULL DEFAULT 0
  CHECK(order_recovery IN (0,1));
