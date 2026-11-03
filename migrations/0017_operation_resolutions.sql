CREATE TABLE tasks_operation_resolutions (
  operation_id TEXT NOT NULL REFERENCES tasks_operations(id),
  item_key TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts_connections(id),
  response_hash TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(operation_id,item_key)
) STRICT;
CREATE INDEX tasks_resolution_account ON tasks_operation_resolutions(account_id,operation_id);
