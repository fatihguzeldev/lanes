-- An owner can stop applying an issued intent without inventing its provider outcome.
CREATE TABLE tasks_operation_stops (
  operation_id TEXT NOT NULL REFERENCES tasks_operations(id),
  item_key TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts_connections(id),
  expected_claim_id TEXT,
  response_hash TEXT,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  decision TEXT NOT NULL CHECK(decision='keep_provider_current'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(operation_id,item_key),
  UNIQUE(operation_id),
  FOREIGN KEY(operation_id,item_key) REFERENCES tasks_operation_steps(operation_id,item_key)
) STRICT;
CREATE INDEX tasks_stop_account ON tasks_operation_stops(account_id,operation_id);
