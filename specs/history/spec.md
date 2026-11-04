# history

history explains recorded task changes and lets the owner inspect completed work. it is an activity record with a retention window, not full document versioning or a database backup.

## ownership and dependencies

history owns event storage, retention, pagination, and event queries. task commands submit confirmed outcomes. sync submits observed external transitions. boards provides presentation context and never fabricates events from a browser action.

history cannot mutate tasks, perform recurrence, or restore deleted resources. account scope is mandatory on every event and query. follow [sync](../sync/spec.md) for confirmed/uncertain outcomes and [portability](../portability/spec.md) for exports.

## recorded changes

| event                                           | recorded detail                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| task created                                    | task, list, source operation, and creation context                       |
| completed or reopened                           | state transition and provider completion time when available             |
| moved                                           | old/new list or parent; distinguish cross-list movement from reparenting |
| deleted                                         | task/list context and confirmed deletion                                 |
| scheduled day set, changed, or removed          | previous and resulting day                                               |
| scheduled time or repeat rule changed           | lanes-owned change summary                                               |
| labels, priority, star, or dependencies changed | changed metadata and relevant references                                 |

do not record every manual sibling-position adjustment as an activity event. a list move between boards changes how its list history is reached, not the historical identity of every task.

title and notes edits are not recorded as revisions. preserve the minimal title snapshot needed to understand an existing event, without storing note bodies or pretending the record can restore an earlier task. source references and event schemas may evolve with explicit versioning.

there are no assignment, collaborator, reminder, or notification events because those features are outside scope. task creation from import, transfer, template, duplication, or repetition has its origin attached; it is not attributed to a fictitious collaborator.

the scoped event list and 90-day window use [tasksboard history](https://support.tasksboard.com/collaboration/activity-log/) as a reference. the additional lanes metadata events explain local behavior that google cannot report.

## event identity and timing

each event has a stable id, connected account, task identity, list identity, event kind, origin, observed/recorded time, and the relevant before/after summary. store only the snapshots needed for that event. include the operation or provider-version observation used for deduplication.

| origin                     | time claim                                                                 |
| -------------------------- | -------------------------------------------------------------------------- |
| owner action through lanes | confirmed operation time; provider completion time may be shown separately |
| scheduled lanes work       | confirmed operation time and schedule/run reference                        |
| observed in google         | discovery time, with provider update/completion time if available          |

label external records as observed. do not infer which google app, person, or intermediate sequence produced a state. google does not expose an audit trail through tasks. three unseen edits may appear as one observed difference.

first sync establishes a baseline without a fabricated backfill. an old completion timestamp can be used in completed-task browsing, but it does not prove lanes recorded that completion event at the time.

deduplicate operation events by operation/step and observed transitions by resource version and change kind. a retry, refresh, pagination replay, or history repair must not append the same event twice.

## browsing

provide board activity, optional list filtering, and a task's own history. sort newest first with stable event-id tie breaking, group by day in the account zone, and paginate within the retention window. show an empty state distinct from loading and failure.

open history from the relevant board or task menu. board-wide completed-task browsing is also a board action; neither view needs a permanent sidebar or footer entry.

board activity follows the lists currently on that board. moving a list carries access to its history. historical entries retain their old list/title context rather than being rewritten when names change. deleted-list events remain available through account activity until retention expires; board deletion does not erase them.

task history uses stable lanes identity and survives an in-app cross-list move. a deleted task can have a read-only history entry without being an active editable task. never offer a save action that recreates it accidentally.

## completed work

completed-task browsing queries task state, not the activity log. show current completed tasks from the selected board's lists, grouped into today, yesterday, this week, and earlier without overlapping groups. include completion time, parent context, and list.

allow text search over task, parent, and list names, list filtering, and a seven-day summary by day and list. use the account zone and configured week start. count current completed tasks once, including subtasks; label the counting rule. reopening removes a task from these counts.

return pagination and provider coverage. hidden completed tasks must be requested deliberately. if older completed content has not been loaded, say so instead of showing a supposedly complete total. deleted tasks remain events where recorded, but are no longer current completed tasks.

the seven-day summary is not a permanent productivity score. tasks completed and then reopened between syncs may be unknowable. no reminders, emailed reports, or notification permissions are required.

## retention and removal

retain events for 90 days from recorded/observed time. queries exclude expired events immediately; delete their storage in bounded cleanup slices. do not prune google completed tasks when pruning history.

disconnecting an account preserves its recorded events until normal expiry. explicitly removing its retained local data deletes its history after confirmation. deleting a board, template, list, or task does not prematurely erase already recorded events.

history is private task data. exports omit credentials and include the selected retention window only. a portable metadata restore preserves original event ids and timestamps, deduplicates them, and does not restart their 90-day lifetime.

## failures

do not record an optimistic click, rejected command, or uncertain provider outcome as success. where google accepted a mutation but event persistence failed, retain repair intent and repair idempotently. show pending operation recovery separately from ordinary history.

a history query failure does not make task data disappear. a missing event is not proof the underlying action never happened. quota exhaustion can prevent further recording; report the limitation without discarding existing records to manufacture an apparently complete log.

## acceptance

- `history-01`: confirmed supported transitions append one event; rejected and uncertain requests do not append success events.
- `history-02`: refreshing or retrying an operation does not duplicate activity.
- `history-03`: first sync has no fabricated historical events; external changes use discovery time and known provider timestamps honestly.
- `history-04`: board/list/task queries preserve account scope, historical snapshots, stable ordering, and pagination.
- `history-05`: list movement carries accessible history and board deletion leaves account-level access to retained events.
- `history-06`: title/note edits do not create a revision store or a restore claim.
- `history-07`: completed-task groups, counts, and seven-day summaries handle reopening, subtasks, hidden tasks, and incomplete coverage consistently.
- `history-08`: the 90-day boundary uses original event time; metadata restore does not reset retention.
- `history-09`: interrupted event persistence is repaired once, and retention cleanup never deletes provider tasks.
