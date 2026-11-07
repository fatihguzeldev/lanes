# templates

a template is a saved snapshot of a list or board. using it creates new work without modifying the source.

## ownership and dependencies

list snapshots belong to the task owner; board snapshots belong to boards. a separate template service is not required. accounts scopes them, planning supplies date arithmetic, and [sync](../sync/spec.md) supplies durable execution.

application calls the existing list, task, and board commands. it must satisfy [list quota](../lists/spec.md#list-quota), task validation, dependency rules, and [portability recovery](../portability/spec.md#execution-and-recovery).

## saving a snapshot

save a list or board with a name of 1–128 nonblank characters and an optional description of at most 2,000 characters. duplicate names are allowed. show the source and included counts before saving.

exclude completed tasks by default. an explicit include option saves them too, but every task starts open when the template is used. subtasks of an included parent retain their hierarchy. an open child under a completed parent brings its parent as open context; do not silently discard it when completed tasks are excluded.

keep task titles, plain notes, sibling order, labels, priorities, stars, local times, and lanes repeat rules. capture list titles/colors and, for a board template, list order and board appearance. do not copy history, credentials, sessions, task provider ids as new identities, or source occurrence identities.

dependencies inside the captured set use template-local references. omit references outside it and show that loss before saving. dependencies are remapped only after the corresponding new tasks exist.

dates have two modes:

| mode           | stored value and application                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| relative dates | signed calendar-day offset from the save day in the account zone; add it to the chosen application day |
| no dates       | omit scheduled days, times, and active repeat rules from created tasks                                 |

negative offsets are valid and visible in preview. they may create tasks scheduled before the application day; do not silently clamp them. keeping times requires relative dates. repeat rules become independent series anchored to the resulting day, with occurrence counts reset. a snapshot may retain its repeat preset, but application without dates cannot attach an active rule without an anchor; show that omission in preview.

a snapshot never follows later source edits. deleting its source list or board does not delete the template. saving a replacement snapshot is an explicit action with its own preview.

## browser submission

validating a name, description, schedule, or prepared snapshot completes the editing interaction immediately. close its editor after capturing the command and its operation identity. keep accepted commands in the account workspace when the templates view closes or the owner switches accounts; do not keep a form open or disable unrelated controls while saving.

show metadata and schedule edits immediately. retain the preview until a confirmed read replaces it. process later edits to the same resource in order, advancing only from confirmed predecessors. if an earlier change fails, preserve later drafts without sending them against an assumed revision.

a failed save removes its preview and exposes its receipt and captured draft. restore editable fields only after a definite rejection; an ambiguous create keeps its original identity and requires inspection before another create. source preview, application admission, and bulk run progress keep their existing review steps.

## applying a template

support these actions:

- add a list template, or the lists from a board template, to an existing board in the same account.
- create a new board from a board template.
- choose a new board name, optional list-name prefix, application day, and whether to use relative dates.

preview list and task counts, resulting dates, omitted external dependencies, and required list slots. names that collide with existing lists create distinct lists; never merge or overwrite based on title.

create new identities for boards, lists, tasks, and repeat series. remap parent references and internal dependencies. all tasks start open and no history from the source is presented as history of the copy. record confirmed creations with their template operation origin.

capture one immutable template revision for the operation. renaming, replacing, or deleting the template while a run is in progress must not change already admitted input. a partial run remains resumable from that captured input.

## management and gallery

personal templates belong to one connected account. allow preview, rename, description editing, replacement from a new source snapshot, and deletion. replacement shows the differences in counts and date mode before confirmation. there is no implied live connection back to the source.

a small bundled gallery can provide list and board starters. gallery entries are ordinary declarative template data, work without a remote service, and can be saved as personal copies. no premium gates, ai generation, shared marketplace, or downloadable executable template code.

deleting a template pauses its schedules and removes the reusable snapshot once unfinished runs retain their required input. already created boards/lists/tasks remain unchanged. template deletion is not a cleanup operation for previous runs.

## recurring checklists

schedule a personal template to add lists to a chosen existing board. support weekly repetition on one chosen weekday and monthly repetition on a day from 1 through 28. store the schedule's zone explicitly and show its next eligible run.

each run uses its local scheduled day as the application day for relative offsets. it creates new lists; it does not reset or delete the previous checklist. a board template schedule adds its lists to the selected board rather than creating a new board every week.

aim to start an eligible run within the hour after local midnight while authorization and free-plan capacity are available. this is an operating target, not an exact-time delivery promise. daylight-saving rules follow [planning](../planning/spec.md#dates-times-and-zones).

claim each run durably with a unique schedule/local-day key and capture its input revision as data. editing the schedule cannot readmit a day already claimed under an older revision. overlapping ticks and server restarts cannot admit the same slot twice. a resumed partial run keeps its original slot and input revision.

when downtime or paused authorization spans several runs, create only the latest eligible missed checklist by default. do not generate every missed week or month automatically. mark older missed slots skipped, show the catch-up choice before resuming a paused schedule, and allow the owner to skip catch-up entirely. never move a partial run to another slot; resolve it first.

changing the weekday, day, zone, template revision, or destination changes future slots. already admitted work is unchanged. reject overlapping edits through a schedule revision and calculate the next slot from the confirmed new settings.

if a captured run loses its destination, preserve confirmed output and pause unsent work. resolve or explicitly cancel that run before choosing a destination for future slots. a new manual copy is a separate action whose preview identifies existing output and the risk of creating another copy; never silently restart the whole checklist.

## pauses and failures

| cause                                 | behavior                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------- |
| expired or disconnected account       | retain schedule; require reconnect and a catch-up choice                  |
| destination board deleted             | pause and require a new destination                                       |
| template deleted                      | pause; do not use a different template automatically                      |
| insufficient list slots               | create nothing during preflight; show needed capacity and require resume  |
| provider failure after some creations | retain confirmed output and captured input; expose partial run and resume |
| unknown provider create outcome       | block the affected step for reconciliation; do not create another copy    |

manual and scheduled application share the same rules. a failed run does not delete a board or list it already created as an automatic rollback. an empty board created before provider failure stays visible with the operation result.

## reference

the baseline snapshot, relative-date, and weekly/monthly behavior follows [tasksboard templates](https://support.tasksboard.com/lists/templates/). excluded attachments, reminders, and collaboration fields are not included. lanes makes partial work and missed-run handling explicit and stores snapshots outside google notes.

## acceptance

- `templates-01`: source edits and deletion do not change an existing snapshot or already created output.
- `templates-02`: completed inclusion, open child context, relative offsets, no-date mode, and time preservation match the preview.
- `templates-03`: application creates distinct identities, remaps hierarchy/dependencies, and starts tasks open without source history.
- `templates-04`: same-named lists are not merged, and insufficient list capacity creates nothing during preflight.
- `templates-05`: interruption resumes the same captured template revision without recreating confirmed tasks or lists.
- `templates-06`: repeated ticks claim one run per schedule slot, including daylight-saving transitions and schedule edits.
- `templates-07`: a multi-week pause offers one latest catch-up or skip, not an automatic backlog.
- `templates-08`: deleted destinations/templates and expired grants pause schedules while preserving previous output.
- `templates-09`: gallery data requires no external service and passes the same validation as a personal template.

- `templates-10`: validated edits close immediately, retain their account owner after view closure, update metadata optimistically, and preserve rejected drafts and ambiguous receipt identities.
