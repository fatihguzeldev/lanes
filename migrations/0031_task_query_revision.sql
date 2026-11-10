ALTER TABLE tasks_lists ADD COLUMN query_revision INTEGER NOT NULL DEFAULT 0;

-- Page cursors follow semantic task/query changes, not scan bookkeeping.
CREATE TRIGGER tasks_query_task_insert AFTER INSERT ON tasks_tasks BEGIN
  UPDATE tasks_lists SET query_revision=query_revision+1
  WHERE account_id=NEW.account_id AND (id=NEW.list_id OR id IN (
    SELECT task.list_id FROM tasks_dependencies edge
    JOIN tasks_tasks task ON task.account_id=edge.account_id AND task.id=edge.task_id
    WHERE edge.account_id=NEW.account_id AND edge.blocker_id=NEW.id
  ));
END;

CREATE TRIGGER tasks_query_task_update AFTER UPDATE ON tasks_tasks
WHEN OLD.revision IS NOT NEW.revision OR OLD.list_id IS NOT NEW.list_id
  OR OLD.priority IS NOT NEW.priority OR OLD.starred IS NOT NEW.starred BEGIN
  UPDATE tasks_lists SET query_revision=query_revision+1
  WHERE account_id=NEW.account_id AND id IN (OLD.list_id,NEW.list_id);
  UPDATE tasks_lists SET query_revision=query_revision+1
  WHERE account_id=NEW.account_id
    AND (OLD.completed IS NOT NEW.completed OR OLD.deleted_at IS NOT NEW.deleted_at
      OR OLD.provider_missing_at IS NOT NEW.provider_missing_at)
    AND id IN (
      SELECT task.list_id FROM tasks_dependencies edge
      JOIN tasks_tasks task ON task.account_id=edge.account_id AND task.id=edge.task_id
      WHERE edge.account_id=NEW.account_id AND edge.blocker_id=NEW.id
    );
END;

CREATE TRIGGER tasks_query_task_delete AFTER DELETE ON tasks_tasks BEGIN
  UPDATE tasks_lists SET query_revision=query_revision+1
  WHERE account_id=OLD.account_id AND (id=OLD.list_id OR id IN (
    SELECT task.list_id FROM tasks_dependencies edge
    JOIN tasks_tasks task ON task.account_id=edge.account_id AND task.id=edge.task_id
    WHERE edge.account_id=OLD.account_id AND edge.blocker_id=OLD.id
  ));
END;

CREATE TRIGGER tasks_query_list_update AFTER UPDATE OF title_key,deleted_at ON tasks_lists
WHEN OLD.title_key IS NOT NEW.title_key OR OLD.deleted_at IS NOT NEW.deleted_at BEGIN
  UPDATE tasks_lists SET query_revision=query_revision+1
  WHERE account_id=NEW.account_id AND id=NEW.id;
END;

CREATE TRIGGER tasks_query_label_update AFTER UPDATE OF name_key ON tasks_labels
WHEN OLD.name_key IS NOT NEW.name_key BEGIN
  UPDATE tasks_lists SET query_revision=query_revision+1
  WHERE account_id=NEW.account_id AND id IN (
    SELECT task.list_id FROM tasks_task_labels label
    JOIN tasks_tasks task ON task.account_id=label.account_id AND task.id=label.task_id
    WHERE label.account_id=NEW.account_id AND label.label_id=NEW.id
  );
END;

CREATE TRIGGER tasks_query_label_attach AFTER INSERT ON tasks_task_labels BEGIN
  UPDATE tasks_lists SET query_revision=query_revision+1
  WHERE account_id=NEW.account_id AND id=(
    SELECT list_id FROM tasks_tasks WHERE account_id=NEW.account_id AND id=NEW.task_id
  );
END;

CREATE TRIGGER tasks_query_label_detach AFTER DELETE ON tasks_task_labels BEGIN
  UPDATE tasks_lists SET query_revision=query_revision+1
  WHERE account_id=OLD.account_id AND id=(
    SELECT list_id FROM tasks_tasks WHERE account_id=OLD.account_id AND id=OLD.task_id
  );
END;

CREATE TRIGGER tasks_query_dependency_insert AFTER INSERT ON tasks_dependencies BEGIN
  UPDATE tasks_lists SET query_revision=query_revision+1
  WHERE account_id=NEW.account_id AND id=(
    SELECT list_id FROM tasks_tasks WHERE account_id=NEW.account_id AND id=NEW.task_id
  );
END;

CREATE TRIGGER tasks_query_dependency_delete AFTER DELETE ON tasks_dependencies BEGIN
  UPDATE tasks_lists SET query_revision=query_revision+1
  WHERE account_id=OLD.account_id AND id=(
    SELECT list_id FROM tasks_tasks WHERE account_id=OLD.account_id AND id=OLD.task_id
  );
END;
