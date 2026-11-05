ALTER TABLE tasks_sync_list_work ADD COLUMN page_json TEXT
  CHECK(page_json IS NULL OR (json_valid(page_json) AND length(CAST(page_json AS BLOB))<=1500000));
ALTER TABLE tasks_sync_list_work ADD COLUMN page_offset INTEGER NOT NULL DEFAULT 0
  CHECK(page_offset BETWEEN 0 AND 25);
ALTER TABLE tasks_sync_list_work ADD COLUMN page_projection_revision INTEGER
  CHECK(page_projection_revision IS NULL OR page_projection_revision>=0);
