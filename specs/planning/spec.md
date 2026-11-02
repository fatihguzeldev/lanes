# planning

planning gives tasks a scheduled day, optional time, and optional lanes repeat rule. the calendar presents those same tasks; it does not own another set of events.

## ownership and dependencies

the task owner owns date/time validation, repeat rules, occurrence identity, and successor creation. boards owns calendar composition and view preferences. accounts supplies authorization and connection state. [sync](../sync/spec.md) owns durable execution; [templates](../templates/spec.md) owns scheduled creation of whole checklists.

## dates, times, and zones

store a scheduled day as a calendar date, independent of timestamp formatting. google's `due` field is day-only; its timestamp time portion cannot carry a time or a native repeat rule. see the [task resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks).

an optional scheduled time is a local wall-clock time stored by lanes with an iana time zone. require a day before adding a time or repeat rule. clearing a day also clears its time and stops repetition, with the consequence shown before saving.

each connected account has a planning time zone and week-start preference. initialize the zone from the browser on first connection and store it explicitly. a browser traveling to another zone does not silently change schedules. default week start to monday and allow sunday.

use the account zone to determine today, overdue, date-filter boundaries, calendar headings, and history day groups. existing timed tasks and rules retain their stored zones when the account preference changes. show a zone label when a task differs from the account zone; changing the preference does not rewrite google dates.

the calendar places a task on its stored scheduled day. sort same-day timed tasks by their stored local time and show their zone when needed. do not turn a date-only task into a previous-day event by converting midnight between zones.

for a nonexistent local time during a daylight-saving transition, use the first valid instant after the gap. for a repeated local time, use the earlier occurrence. keep the wall-clock rule and zone so later occurrences return to the intended local time. date-only rules do not need a midnight instant to choose their day.

google owns scheduled-day edits discovered externally. preserve a lanes time when the external edit changes only the day; clear the time and pause the repeat rule when the external day is removed. record the rule pause locally without treating it as a request to write the old day back to google.

## calendar behavior

support month and week views, previous/next navigation, and a today action. scope to the current board by default and offer the account-wide view explicitly. respect search, filters, completed visibility, account zone, and week-start settings.

show dated top-level tasks and dated subtasks. each subtask includes parent context. date-only tasks appear separately from timed tasks within a day. undated tasks remain accessible in an unscheduled section and the ordinary list view.

create a task on a selected day by choosing its destination list. moving a task to another day changes its scheduled day through the task command and preserves its other fields. retain its time unless explicitly changed. removing it from the calendar clears scheduling through the same validated action, not task deletion.

calendar actions have keyboard equivalents. display pending saves, failed reschedules, partial data, and expired-account state consistently with the board. do not make a read-only calendar look draggable.

calendar is task planning: no durations, meeting invitations, resource booking, reminders, browser notifications, or google calendar event creation. google may display its own dated tasks; lanes does not control the presentation of native google clients.

## repeat rule

support daily, weekdays, weekly, monthly, and yearly presets, plus a positive interval and selected weekdays for weekly repetition. interval is 1–365 units. a rule ends never, on an inclusive calendar day, or after 1–10,000 created occurrences, including the initial task. reject an end day before the anchor and a weekly rule with no selected weekdays.

the scheduled day is the anchor. weekly rules keep their selected weekdays and interval weeks relative to that anchor week. monthly and yearly rules use calendar arithmetic, not a fixed number of seconds. clamp an unavailable month day to that month's last day and retain the original anchor: january 31 can produce february 28 and then march 31. a february 29 yearly anchor uses february 28 in a non-leap year.

apply lanes repeat rules to top-level tasks. their subtasks form the occurrence's checklist and cannot independently repeat while nested. promoting a subtask makes it eligible. this keeps parent completion from producing competing child series.

repeat metadata remains in lanes. other google clients show the scheduled day and ordinary task content, without lanes' time or rule. explain this when configuring a rule. do not write repeat instructions into notes or claim native google recurrence.

## completion and the next occurrence

after a repeating occurrence is confirmed completed, create one successor immediately or leave a visible pending successor if execution is interrupted. choose the first rule date strictly after that occurrence's scheduled day and not before today in the rule's zone.

skip past dates instead of producing a backlog of missed occurrences. skipped dates do not consume the occurrence-count limit. if no eligible date remains within the end rule, mark the series finished and create nothing.

the successor is open and gets new task identities. copy the title, notes, labels, priority, star, local time, rule, and eligible subtasks into the same list, immediately after the completed occurrence in manual order. for an in-app completion, capture this input and the then-open subtasks before completing the parent/children; completing the checklist must not make its successor empty. children already completed before that action are not copied. internal dependency edges among copied tasks are remapped; references to other existing blockers remain attached to those blockers. tasks depending on the completed occurrence do not start depending on the successor.

retries and overlapping workers use the same series/occurrence key. one confirmed completion can create at most one intended successor. provider ambiguity still follows [uncertain outcomes](../sync/spec.md#uncertain-outcomes); it is not solved by retrying a create.

editing the active occurrence's rule or scheduled day changes future calculation. do not rewrite completed occurrences or create a new task merely because a future date arrived. deleting the active occurrence stops that series; deletion does not mean completion.

## reopening an occurrence

if completion is reversed before a successor was sent to google, cancel that pending successor and reopen the original. if the generated successor is still untouched, open, and has not generated another occurrence, show that undo will remove it and reopen the original after confirmation.

if the successor or its subtasks were edited, moved, completed, or have an uncertain mutation, refuse automatic destructive undo. offer an explicit reopen-as-one-off action: retain the successor, detach the reopened historical occurrence from active repetition, and explain that both tasks remain. do not delete work performed after completion.

grouped undo can partially fail at google. show confirmed changes and recovery steps. never leave two occurrences silently claiming to be the sole active successor of one series.

## external completion and native repeat rules

sync checks tracked lanes occurrences for external completion. when it first observes a completed state, use the same successor command and occurrence key as an in-app completion. use the last observed pre-completion input/open-child set when available; otherwise use currently open children and disclose incomplete checklist coverage. repeated observation does not create another successor. the last observed state cannot reveal complete/reopen/complete cycles that occurred entirely between syncs.

background checks are best-effort bounded work. there is no promise to observe every external edit within a fixed number of minutes. healthy foreground refresh can discover it sooner; paused grants, quota exhaustion, and a long work queue delay it.

google's native repeat rules are not exposed through the tasks api. show native task data the api provides, but do not edit or claim to preserve an inaccessible rule during copying. warn when enabling lanes repetition that it must not be combined with a native google repeat rule; reliable automatic detection is unavailable. see the [tasksboard reference](https://support.tasksboard.com/how-to/set-delete-repeating-tasks/).

## failures and lifecycle

expired authorization pauses provider work while retaining the rule and pending occurrence. reconnect reconciles completion and any uncertain creation before resuming. quota failure leaves a completed task completed and its successor pending or blocked; it must not undo accepted work to hide the failure.

confirmed list deletion stops its task series. moving a task to another list in the same account preserves its rule. disconnect pauses; explicit local account removal deletes retained rules. importing or copying a completed occurrence never schedules an immediate successor.

scheduled work uses stored zones and durable cursors. cloudflare cron delivery time is not an exact alarm. do not implement a repeating task by polling every account or generating future occurrences on every tick.

## acceptance

- `planning-01`: a date-only task remains on the same calendar day across browser zones and daylight-saving changes.
- `planning-02`: adding, moving, and clearing a scheduled day uses the same task model in every view; clearing explains its effect on time and repeat.
- `planning-03`: month-end, leap-year, weekday, interval, end-day, and count rules produce the documented sequence.
- `planning-04`: a late completion skips past dates and produces one eligible successor without a backlog.
- `planning-05`: duplicate commands and repeated external observations cannot intentionally create two successors for one occurrence.
- `planning-06`: successor copying preserves open subtasks and intended metadata without retargeting existing dependants.
- `planning-07`: undo removes only an untouched successor; edited successors survive the explicit one-off reopen path.
- `planning-08`: expiry, task/list deletion, partial undo, and an uncertain successor creation leave an inspectable, recoverable state.
- `planning-09`: changing account zone does not rewrite stored dates or existing rule zones; daylight-saving gaps and overlaps follow the specified rule.
- `planning-10`: native google recurrence is never described as readable or editable lanes metadata.
