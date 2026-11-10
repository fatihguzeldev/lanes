# tasks

the task owner provides one task model to the board, calendar, search, history, templates, and portability. those consumers do not keep competing versions of task behavior.

## data and ownership

| field                                                                                      | authority                                            |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| title, notes, list, parent, sibling order, completion, scheduled day, provider update time | google tasks                                         |
| labels, priority, starred state, dependencies                                              | lanes                                                |
| scheduled time, time zone, repeat rule and occurrence identity                             | lanes, under [planning](../planning/spec.md)         |
| cached provider values and sync revision                                                   | task owner projection, under [sync](../sync/spec.md) |

every reference includes its connected account. keep a stable lanes identity and an explicit provider address. cross-list moves must preserve metadata and history even if the provider returns a different id. google response objects do not become public browser contracts.

lanes metadata is stored separately from task notes. do not insert hidden syntax into notes or reinterpret user text as labels, repeat rules, or dependencies. metadata is visible in lanes and its supported exports; it does not become a native google feature.

## create and edit

the list's add-a-task action opens a new row with its task editor already expanded: focus the empty title and expose notes and optional detail controls in the same place. it has no separate approval button. enter in the title, its close control, or an outside click validates and captures a nonblank draft once, then closes immediately without waiting for a request or receipt. a pristine empty entry closes without creating a task; escape cancels an unsubmitted creation draft. invalid input stays in the editor. a definite admission rejection leaves an actionable failed row with the captured draft; edit reopens every chosen field, and discard removes that unsaved row. an uncertain result uses receipt recovery rather than sending another create. nested menus and dialogs remain part of the editor. there is no global create action that silently chooses a list.

after the editor closes, keep the captured task visible at the start of its sibling group while admission, saving, and order reconciliation run in the background. replace it only when its saved identity is confirmed and a fresh read after confirmation verifies that list's sibling order. a newer read of stale positions is not enough, and unrelated lists do not delay this handoff. never show both rows or require a page reload. other tasks, the new row's controls, and the list's add action remain available. failed or uncertain saves use the existing error and receipt flow without resubmitting creation.

serialize browser create submissions within each account and list in capture order; other lists remain independent. an unresolved create keeps later unsent creates in that list from overtaking it. recover its actual receipt before continuing, without replaying the confirmed request. opening its pending editor retains the creation until that editor captures or discards its draft. a missing pending record cannot silently accept an edit. dismissing recovery for a confirmed creation refreshes the saved task instead of hiding it behind a stale collection.

creation previews use the same search, completion, and filter rules as confirmed rows. a fresh scoped read can acknowledge reconciled order for an empty or filtered list without requiring that task on the current local page.

deleting a pending row waits for its confirmed task identity. cancelling that deletion restores the saved row without a failure notice. failed or uncertain deletion keeps the row and its recovery controls visible, tied to the deletion receipt rather than another create.

open a task in its row, with its title selected for editing and notes immediately available. schedule, metadata, dependencies, and checklist controls reveal their own fields when requested. keep a retained non-modal editor when its card is outside the current view; changing presentation must not remount its draft or abandon a submitted save. closing or navigating away still applies the unsent-draft guard.

enter or save on a valid existing-task draft captures the edit, closes the editor, and updates the displayed fields immediately. the user does not wait for google or see a saving label in the row. keep that preview until a fresh read after confirmation replaces it. a failed or uncertain save removes the preview, reports the failure, and retains any confirmed outcome for inspection. invalid input stays in the editor.

serialize edits to the same task with its quick actions. each queued action uses a fresh revision; a queued edit also checks that its edited fields still match the captured baseline. failure or uncertainty stops dependent unsent changes without undoing earlier confirmed work. editing another task and changing the view remain available.

movement joins that task's write order when the intent is captured, before its preflight starts. enriching a captured change at dispatch preserves its place before newer intents; an earlier date clear cannot temporarily override a later chosen date.

clicking outside an editor requests the same close as its close control. clicks in its nested menus or an open dialog do not discard the editor. icon-only detail actions show their meaning on hover and keyboard focus, in addition to their accessible names.

an admitted save continues when its editor closes. keep its operation identity and account fixed while it drains; a later result cannot close another editor or clear that editor's unsent input. a hidden save that needs recovery appears in the workspace's save status.

task menus contain secondary actions. completion remains on the task's checkbox rather than a duplicate menu item. show each row's options control on hover or keyboard focus, and keep it available on devices without hover.

- require a nonblank title, at most 1,024 characters. trim outer whitespace when the owner submits it. notes allow up to 8,192 characters and preserve line breaks.
- create an open task from the editor at the start of the manual sibling order. new subtasks also start their sibling group. show submitted creations in that position immediately, with the newest entry first. explicit insertion positions in duplication, templates, and portability retain their own contracts.
- an explicit first position or known predecessor does not require a complete list scan. validate the destination identity, parent, and predecessor; unrelated list metadata or scan progress cannot invalidate that insertion. inferred positions retain their full-context checks.
- notes are plain text. changing a title or note does not reset other fields or replace unrelated provider values.
- a patch changes only the submitted fields. distinguish an omitted field from an explicit clear.
- retain invalid input and the full captured input of a rejected creation. closing a submitted editor does not claim that its save is confirmed; background failures remain actionable.
- tasks discovered with an empty title remain visible with a presentation fallback. do not rewrite external data merely to satisfy lanes' creation validation.

use the [google task resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks) for provider field capabilities. google status values map to open and completed; columns are lists, not additional task statuses.

## completion and reopening

completing an ordinary task sets its provider completion state and timestamp. reopening clears completion. completed tasks leave the open section and remain available in the completed section, history queries, and exports.

when completing a parent with open subtasks, state how many will also complete and confirm that combined action. capture any repeat successor input before changing the children's states. complete children through the same commands before completing the parent. if a step fails, show the actual partial result; do not invent a transaction spanning google requests.

reopening a parent does not silently reopen completed children. reopening a child under a completed parent also reopens the parent so the open child remains reachable. show both changes and record both confirmed outcomes.

ordinary reopening checks the selected task and any affected parent without waiting for unrelated list coverage. a supported subtask without descendants, dependencies, or recurrence can also complete during reconciliation. keep targeted identity and consequence guards through dispatch; other completion and recurrence paths retain the context they require.

completing a blocked task requires explicit confirmation; see dependencies. recurring task completion and reopening follow [planning](../planning/spec.md#completion-and-the-next-occurrence). a template or import containing completed tasks is not a live completion action and does not trigger recurrence.

## subtasks

support one visible level: a top-level task and its direct subtasks. do not allow self-parenting, cycles, a parent in another list, or a subtask becoming a parent without first being promoted. preserve provider data that cannot be represented; show an explicit unsupported state rather than flattening it silently.

subtasks have their own title, notes, completion, dates, and lanes metadata, and may be reordered among siblings. the parent card exposes their open/completed count. a matching subtask in search remains associated with its parent.

promoting a subtask to top level and nesting an eligible top-level task use provider movement. nesting a task with children requires an explicit reorganization first; do not discard or silently flatten them.

google documents additional restrictions on assigned and native repeating tasks, and a limit of 2,000 subtasks per parent. do not offer an operation the provider forbids; preserve the task and explain the restriction. see [task movement](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/move).

## ordering and movement

manual order belongs to the provider among siblings. use the provider's positioning operations, not lexical guesses about task titles or locally generated position strings.

lifting a task starts its visual movement immediately. the held card follows the pointer while surrounding tasks move smoothly to make room. crossing lists preserves its expanded checklist and metadata. keep this gesture local: pointer movement does not submit commands, refresh provider data, or change provider positions. respect reduced-motion preferences.

release validates the task's identity, current eligibility, list order, and final position before queuing a move. dropping onto the dragged task or back into its existing sibling position is a no-op: do not dispatch a provider move or change its revision. cancelling the gesture or releasing outside an eligible destination restores its prior placement without submitting work.

an eligible drop updates the displayed order immediately while saving online. keep this pending presentation separate from confirmed provider positions. allow further drops while earlier moves save, serialize their provider work, and capture each move against the confirmed state when its turn starts. this queue is limited to the current browser session; it is not an offline outbox.

reordering among the same siblings uses an explicit predecessor, or an explicit first position. it does not wait for a complete task scan, a completed-task scan, or reconciliation of unrelated siblings. retain the selected task, list, parent, and predecessor checks. a relative command is not settled as a no-op from cached sibling positions; an unchanged drag is rejected locally before submission. inferring the last sibling, changing parents, and moving between lists keep the checks their destination and subtree require.

keep a confirmed move's displayed placement until fresh source and destination reads acknowledge their reconciled order. a definite failure restores confirmed placement and discards later unsent moves that depended on it; earlier confirmed moves remain. an uncertain result stops that dependent queue and exposes its operation receipt for checking, without automatically submitting the move again.

the account-owned movement queue verifies affected lists independently of the visible board. after verification, a newer settled view read replaces the move preview in the same render. board, calendar, smart collections, and completed views all acknowledge that handoff. independent queued moves continue after another move fails; a retained move cannot indefinitely restore a task missing from an authoritative read.

moving a top-level task between columns moves it between google lists in the same account. confirm the destination account/list in the command. a subtask can move to another eligible parent or become top level; its destination parent must be in the destination list.

the move menu reuses the workspace's loaded boards and current-board lists, including their paging controls. opening it does not refetch known destinations or wait for a task preflight. read an unvisited board's lists when its submenu opens. choosing a destination captures the move and closes the menu immediately. validate the current task and the tree context needed by that placement in the account queue before admission. dismissing the menu while browsing captures no move; captured work continues after the menu closes.

moving a parent carries its subtasks. treat a provider move's descendant behavior as an integration check: verify the returned tree and mapping before claiming success. if google requires several requests, execute a resumable grouped operation and expose partial state. never implement movement as a silent copy followed by destructive deletion.

preserve lanes identity, labels, priority, star, time, repeat rule, dependencies, and recorded history on movement. update list mappings and provider ids from confirmed responses. a move does not reset a task's scheduled day or completion.

account-to-account movement is outside this command. offer the explicit source-preserving [transfer](../portability/spec.md#account-transfer) flow instead. cross-board movement within an account chooses a destination list; moving the list itself belongs to boards.

## labels, priorities, and stars

choose task labels in a compact anchored picker, with search and removable selected chips in the editor. priority has its own control. opening either control does not expand a generic details form, and an empty label selection shows no quota counter. label selection remains part of the task draft until that task is saved.

label creation and management stay in an anchored menu beside the task. enter or leaving a changed nonblank name captures its edit; escape cancels the draft. colors preview directly from the shared picker. neither action locks another label or waits for an inventory refresh. the account retains captured writes after the menu closes or another account is selected. serialize changes to the same label against fresh revisions; a failed or uncertain change rolls back its preview and retains its receipt and captured input for recovery. later dependent changes stop without replacing a newer draft.

labels belong to an account. each has a name and a color; tasks may carry up to 20. require a trimmed name of 1–64 characters and compare names case-insensitively for uniqueness within that account. preserve the chosen spelling. renaming a label keeps its identity; deleting it removes associations without deleting tasks. this per-task bound keeps editing, rendering, and import requests bounded.

task rows expose a direct star control immediately before their options menu. unstarred controls appear on row hover or keyboard focus; starred controls remain visible. touch keeps the control visible. reserve its space so interaction does not shift the title, and use the accent without a separate hover tile or tooltip.

quick stars and completion toggles preview immediately without disabling either control. serialize online saves in click order for each task and read the current task when each action starts, rather than reusing the clicked row's revision. independent tasks dispatch without waiting for another task's provider request or confirmation. confirmation for blocked tasks and checklists remains required. cancellation, failure, an uncertain save, or handoff to the recurring-reopen workflow drops later unsent actions for that task and restores their confirmed presentation; unrelated tasks can continue. queued work belongs to the current account and browser session. switching accounts changes presentation while the original account retains its queue. reload does not replay an unsent queue and warns while captured work has not finished.

priority is one of none, low, medium, or high. starring is an independent boolean. both are lanes metadata and do not claim to set google's native star. default to no priority, no labels, and not starred.

metadata-only edits can be confirmed during grant expiry or a temporary google outage if the owner session and server are usable and the task is still retained. an explicitly disconnected workspace remains read-only until relinked. mark provider data stale. deletion, due-day edits, and other provider-backed actions remain unavailable without valid provider access.

## dependencies

a task may be blocked by up to 50 other tasks in the same account. the initial picker searches the current board; existing edges survive later movement into another board. cross-account edges, self-dependencies, and cycles are rejected. cycle validation and edge changes share one serialized graph revision so concurrent additions cannot create a cycle that neither request saw.

a task is blocked while at least one existing blocker is open. completed blockers remain listed but do not block. reopening one blocks it again. a confirmed deleted blocker stops blocking; a missing record in an incomplete sync must not be treated as deleted.

show the blockers and the tasks this task blocks. changing one edge updates both views. completing a blocked task asks for confirmation and can proceed after explicit override. dependencies do not prevent editing, rescheduling, movement, or deletion.

deleting a blocker retires the active edge without rewriting old history. a dependency belongs to a specific task occurrence: completing a repeating blocker does not retarget dependants to its successor. copied tasks remap only dependencies inside the copied set.

dependencies are advisory for completion and explicit for organization. lanes stores the graph outside notes and rejects cycles to avoid an unusable dependency graph.

## deletion and bulk actions

task deletion requires confirmation and identifies any included subtasks. deleting a parent deletes its subtree; do not silently promote children. confirmed deletion stops its lanes recurrence and retires active metadata while retaining history for its retention window.

deleting all completed tasks is a separate confirmed list action. use the same per-task outcome rules and report partial deletion. do not substitute google's hide/clear operation while claiming permanent deletion.

there is no history-based version restore or guaranteed trash recovery. a stale view of a deleted task cannot recreate it by sending an edit.

## provider restrictions and limits

google currently documents 20,000 non-hidden tasks per list and 100,000 tasks per account. these are provider bounds, not promised lanes capacity. apply available preflight information, preserve all existing data, and handle a provider refusal explicitly. see [task insertion](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/insert).

tasks assigned from docs or chat can appear in a connected account. assignment creation, routing, and collaborators remain outside scope. display provider-backed content and permit only supported ordinary edits. explain before deletion when it also deletes the original assignment in its source product. do not add an assignment ui.

native google recurrence cannot be managed through the tasks api. lanes must not report its own repeat metadata as a native rule or claim it can reliably detect every native rule.

## dependencies and failures

accounts supplies authorization; sync owns operation and reconciliation rules; history records confirmed task events. boards and planning consume task operations. templates and transfer call them instead of writing task records directly.

validation leaves the draft intact. stale revision conflicts offer refresh and explicit reapplication. failed provider actions preserve the confirmed model. partial parent/subtask operations name each completed and remaining step. metadata failure after google acceptance remains repair work, not a reason to send the provider action again.

## acceptance

- `tasks-01`: title and notes validation respects limits and preserves unicode, line breaks, and unrelated fields.
- `tasks-02`: completion, reopening, and parent/child transitions agree across kanban, calendar, search, and completed-task browsing.
- `tasks-03`: parent completion failure after some children complete exposes that partial result accurately.
- `tasks-04`: nesting rejects cycles and invalid parents; keyboard actions can perform the same moves as dragging.
- `tasks-05`: a cross-list parent move preserves the complete tree, metadata, and history, including provider id changes.
- `tasks-06`: labels remain account-scoped; priority and star do not alter notes or claim native google support.
- `tasks-07`: dependency cycles are rejected; completion and reopening update blocking; confirmed deletion removes active blocking.
- `tasks-08`: completing a blocked task requires an explicit override, including from a bulk operation.
- `tasks-09`: provider errors and stale ids never turn an edit or move into a new task or a destructive fallback.
- `tasks-10`: assigned-task restrictions, native-repeat movement refusal, task storage exhaustion, and ambiguous writes preserve data and show the actual limit.
- `tasks-11`: dropping onto the same task or unchanged sibling position produces no provider mutation and preserves the task's revision and fields.
- `tasks-12`: rapid drops update presentation immediately while provider moves run serially; failed or uncertain moves stop dependent unsent work and preserve confirmed outcomes.
- `tasks-13`: a lifted task follows the pointer and siblings move to make room before release. hover and cancellation submit no work; only a validated changed drop enters the move queue.

- `tasks-14`: opening task details edits the existing row without a modal. optional fields appear on request; validation preserves the draft, and a submitted edit continues when its card leaves the visible collection. a failed background edit restores confirmed data and reports the error.
- `tasks-15`: outside dismissal preserves the unsent-draft guard and nested menus; an admitted hidden save continues independently without closing or clearing a newer editor.
- `tasks-16`: adding a task opens its editor without an approval control. every entry path, including calendar and subtasks, captures valid input and closes immediately on enter or leaving. empty entries make no request and invalid input survives. rejection preserves every captured field without interrupting a newer editor. a pending row accepts further edits, stars, completion, and deletion; those intents wait for the confirmed task identity and never send a temporary id or another create.
- `tasks-17`: opening move destinations uses the workspace's loaded topology without duplicate reads or a source-validation wait. paging remains available; unvisited board lists load on demand. selecting a destination validates fresh source revisions and checklist coverage, and a cancelled preflight cannot submit from a late reply.
- `tasks-18`: rapid stars and completion clicks remain interactive and save serially against fresh task revisions. failed or uncertain work stops later unsent changes to that task, preserves earlier confirmed changes, and exposes its error or receipt. closing a row or changing views does not drop admitted work; leaving an account or unloading cannot silently abandon queued changes.

- `tasks-19`: submitting a valid existing-task edit closes its editor immediately and presents the edited values without a saving marker. failed saves restore confirmed data and report the error; queued edits use fresh revisions without overwriting externally changed fields.

- `tasks-20`: task edits, stars, completion, dates, and deletion share account-owned presentation across board, calendar, search, and completed views. membership, counts, and checklist state follow the same intent as the row controls. confirmation hands off only to a newer settled read; failure removes the failed preview without erasing newer independent changes.
- `tasks-21`: selecting a move destination closes its menu and projects the destination immediately. source, parent, sibling, and checklist checks run before provider admission; required confirmations remain explicit. a failed or uncertain move restores confirmed placement and reports its receipt.
- `tasks-22`: opening a task from a resolved search collection reuses that collection's list and board context. calendar creation reuses the current board's loaded list inventory; unknown destinations still load on demand.

- `tasks-23`: explicit same-list, same-parent reordering succeeds while provider coverage is incomplete or a scan is running. consecutive moves remain interactive, submit their relative intent in order, and do not poll or advance sync before saving. unrelated scan progress does not invalidate the captured reorder; changed task identity, content, parent, or destination still receives the appropriate conflict or restriction.
- `tasks-24`: a new task stays first while its confirmed response shares a position with a stale sibling. reconcile the affected list in the background and retire the preview only when a newer read verifies its own order. incomplete unrelated lists and local read pagination do not prevent that handoff. apply the same rule to subtasks, calendar, and smart collections.
- `tasks-25`: rapid creates in one list preserve capture order through delayed requests and receipt recovery; unrelated lists remain usable. a retained creation editor cannot lose its draft to an older acknowledgment, and filtered-out creations do not remain visible as unmatched rows.
- `tasks-26`: movement, edits, and quick actions to one task do not race their own revisions. affected-list verification works across boards and views, fresh view reads retire previews without a stale frame, and a failed move does not discard independent queued moves.
