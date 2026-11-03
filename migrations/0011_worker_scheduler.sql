CREATE TABLE worker_scheduler (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  turn INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO worker_scheduler(singleton) VALUES(1);
