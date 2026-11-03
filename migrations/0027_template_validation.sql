CREATE TABLE tasks_template_validation (
 snapshot_id TEXT PRIMARY KEY REFERENCES tasks_template_snapshots(id),
 account_id TEXT NOT NULL REFERENCES accounts_connections(id),
 stage TEXT NOT NULL CHECK(stage IN ('building','checking','ready','invalid')),
 next_position INTEGER NOT NULL DEFAULT 0, checked_tasks INTEGER NOT NULL DEFAULT 0,
 total_tasks INTEGER NOT NULL CHECK(total_tasks BETWEEN 0 AND 2000), revision INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE tasks_template_graph_nodes (
 snapshot_id TEXT NOT NULL REFERENCES tasks_template_snapshots(id),node_key TEXT NOT NULL,
 remaining INTEGER NOT NULL CHECK(remaining BETWEEN 0 AND 50),processed INTEGER NOT NULL DEFAULT 0 CHECK(processed IN (0,1,2)),
 PRIMARY KEY(snapshot_id,node_key)
) STRICT;
CREATE INDEX tasks_template_graph_zero ON tasks_template_graph_nodes(snapshot_id,node_key) WHERE processed=0 AND remaining=0;
CREATE INDEX tasks_template_graph_outgoing ON tasks_template_graph_nodes(snapshot_id,node_key) WHERE processed=1;
CREATE TABLE tasks_template_graph_edges (
 snapshot_id TEXT NOT NULL REFERENCES tasks_template_snapshots(id),source_key TEXT NOT NULL,target_key TEXT NOT NULL,
 PRIMARY KEY(snapshot_id,source_key,target_key)
) STRICT;
CREATE INDEX tasks_template_graph_target ON tasks_template_graph_edges(snapshot_id,target_key,source_key);
