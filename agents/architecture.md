# architecture

this architecture is a proposal. everything in it is subject to change.

## runtime

host lanes as one cloudflare deployment: a static browser client, a worker for server behavior, and d1 for application data. use a scheduled worker entry for bounded recurrence or template work when its timing rules require it.

the browser client uses react and typescript.

entry documents are prerendered from the existing react views during the build. the worker validates the owner session, selects a static document, and includes a safely serialized session snapshot for the browser. the renderer stays in build tooling; worker imports never reach browser components or react rendering code.

## source ownership

```text
src/
  app/
    entry/
    workspace/
    theme/
  shared/
    browser/
    contracts/
    ui/
    styles/
  modules/
    accounts/
    operations/
    tasks/
    boards/
    history/
    transfer/
  worker/
    configuration/
    composition/
    protocol/
    routes/
    scheduling/
    transport/
migrations/
```

`app/` starts the browser application and composes its screens. it owns workspace navigation, the selected view, and guards that coordinate drafts across features. accounts owns selected-account persistence and paging; app composes that controller. it does not construct feature requests, implement commands, or own a feature's editor state.

`worker/` is the server composition root. its entry points apply configuration, origin, session, and protocol checks, then dispatch routes to owners. composition wires concrete capabilities together; routes translate http inputs and outputs. scheduled wiring chooses bounded work without implementing the owning workflow.

`shared/` contains lanes-wide code with no feature dependency. `browser/` owns request transport, connection tracking, and resource loading. `ui/` owns visual primitives; it does not submit commands. `contracts/` owns shared identifiers and protocol shapes. `styles/` owns tokens and base rules. receipt identities and submission monitoring belong to operations, not shared ui.

| owner      | responsibility                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| accounts   | installation ownership, sessions, google authorization, credentials, connection preferences, disconnect and removal        |
| operations | cross-feature receipt admission, claims, retries, confirmed outcomes, inspection, and account cleanup of its journal       |
| tasks      | google lists and tasks, task metadata, labels, planning, provider commands, projection, sync, list snapshots and templates |
| boards     | list grouping, board appearance, navigation, views, calendar composition, and board templates                              |
| history    | confirmed changes, observed external changes, and completion history presentation                                          |
| transfer   | file formats, imports, exports, sheets, account copying, and workspace archives                                            |

## inside an owner

inside each owner, separate runtime roles, then group browser and server code by the behavior being changed. use `contracts/` for shared wire schemas, `model/` for runtime-independent rules, `browser/` for browser flows, and `server/` for server capabilities. transfer's `formats/` owns portable parsing and normalization. create these directories only when they have a responsibility to hold.

within browser and server code, group a related flow together. editor fields, its draft controller, local styles, and `tests/` belong under the editor. do not split one flow between generic `client/` and `components/` folders. keep reusable visual primitives in shared ui; feature presentation stays with its feature.

put tests in a `tests/` directory under the responsibility they verify. fixtures stay with their format or behavior. shared sqlite and invocation fixtures live in `tests/support/`; repository-wide import and transport checks live in `tests/architecture/`. production code cannot import test code.

split at an actual responsibility. moving a mixed component into a similarly mixed hook does not establish ownership. do not leave old-path re-exports, pass-through barrels, or wrappers whose only purpose is to preserve the former layout.

public server context and capability types are separate from private database rows and mappers. another owner may consume a declared command or query capability; it may not import persistence internals merely because they are exported.

### accounts and operations

accounts separates session cookies and installation/session storage, oauth state and authorization, conditional grant writes, connected-account reads/preferences, credential refresh, and account lifecycle coordination. initial owner binding, its first task connection, and its session still commit together.

operations separates public receipt queries from the execution journal. lifecycle retention owns terminal payload pruning and aged receipt cleanup. the journal owns claims and receipt settlement in `tasks_operations` and `tasks_operation_*`. tasks owns `tasks_list_reservations`. task list inventory and reservation policy stay with tasks; captured-command retention stays with the command owner. worker composition supplies those concrete capabilities. their prepared writes join the journal's existing batch rather than committing independently.

account cleanup follows the existing bounded lifecycle order. each owner prepares or performs its own cleanup slice; a caller does not duplicate another owner's delete statements. account state checks and writable-account selection belong to accounts.

### task and board server flows

- command capture owns validated input, replay identity, and captured plans. dispatch and reconciliation use the captured input. settlement combines confirmed provider values, metadata effects, history, and receipt writes at the existing commit boundary.
- projection owns stable task identity and confirmed values. sync owns provider inventory, reconciliation jobs, leases, cursors, and follow-up work. recording a confirmed command does not require importing the sync scheduler. identity reconciliation and list observations prepare their guarded writes; the scheduler owns claims, work budgets, generations, and the batch that commits them.
- metadata separates task patches, labels, and resumable label deletion. recurrence separates successor work, reopen choices, and status queries.
- task queries share the bounded hierarchy, coverage, cursor, and export-selection model. label reads are a separate query capability. snapshot capture and reusable template definitions have separate services.
- boards separates queries from guarded mutations. list grouping, template definitions, application, and scheduling remain board-owned; list snapshots and list-template rules remain task-owned.

### browser and transfer flows

feature controllers own their draft, selection, request, and dialog lifetimes. creation intent and confirmed-phase rules are separate from receipt recovery and the react record/editor lifetime. board columns own their scoped query, paging, and readiness; board composition combines those reads with pending presentation. app composition supplies navigation callbacks. moving presentation into a popover must not move an ongoing save controller into the popover's shorter lifetime.

app retains mutation owners for visited accounts while selection changes the visible workspace. inactive owners do not mount editors, menus, or foreground sync. captured work keeps its account, input, and receipt identity; failures remain reachable when its presentation closes or another account is selected. unsent drafts still use the navigation guard.

tasks owns one account-level projection of pending task changes shared by board, list, calendar, today, starred, and completed views. presentation closes after validated capture; the owner serializes dependent writes and replaces optimistic values only after confirmation and a fresh read. this queue lives in the current online browser session. it does not persist through reload or provide offline editing. provider receipts remain the durable recovery boundary.

wait for data that determines an action, including destination choices not yet loaded, consequence previews, authorization, and bulk import or template preparation. an admitted routine save does not keep its form open or lock unrelated controls.

tasks owns editing, creation, completion, movement, labels, planning, and sync presentation. boards composes board/list/calendar views and owns board management. history owns opening a retained event's task; it uses a read capability and delegates editing back to the app.

transfer groups imports, archive capture/restore, exports, sheets, parsing workers, and account copying. the browser form does not implement another version of the server import protocol. parser workers stay with the browser flow that starts them; portable format rules stay under `formats/`.

sheets export separates retained-state queries from capture, confirmation, and provider execution. archive export separates capture from frozen download queries and integrity checks. metadata restore separates source resolution, destination matching and explicit choices, local command settlement, and resumable application. owner writes and their restore receipts remain in the same guarded batch.

## dependency direction

app and worker are composition roots. feature code does not import either root. shared code does not import features or composition roots.

- accounts server code owns authorization and account data. account browser flows use operations for durable submissions.
- operations uses account access guards and receives resource-specific reservation and retention capabilities through composition. it does not own task inventory tables.
- tasks uses accounts for authorized provider access, operations for receipts, and history for confirmed changes.
- boards composes task commands, queries, and browser capabilities. tasks does not depend on board layout.
- history may consume task contracts, planning rules, and explicit task reads. it does not issue task mutations.
- transfer calls the owning task, board, account, history, and operation capabilities. it does not implement a second owner service or write another owner's private tables.

browser code cannot import server code, database bindings, credentials, or server configuration. server code cannot import browser presentation, including through an intermediate helper. contracts, models, and format rules cannot depend on either runtime's implementation.

`scripts/check-boundaries.mjs` resolves static imports, exports, dynamic imports, aliases, and worker urls. it checks runtime import cycles, declared cross-owner capabilities, portable import paths, test placement, and browser/server dependency chains. this checks source dependencies; it does not prove that arbitrary code is safe to execute in every runtime.

## data ownership

google is authoritative for the task fields its api supports, including titles, notes, completion, scheduled day, and ordering. d1 owns board organization, labels, priorities, stars, dependencies, scheduled time, application repeat rules, account connections, task mappings, sync state, and history.

the task owner combines those records into the view consumed by the browser. google response shapes stay at its adapter boundary. account identity must travel with task references, queries, mutations, sync state, and history; provider ids alone are not an account boundary.

google's task api records a scheduled day, but cannot read or write its scheduled time. it also lacks native repeat-rule, star, and reminder fields. application scheduling must be described honestly in other google clients. see the [task resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks).

## changes, sync, and history

task commands own task and list changes made through lanes. imports, templates, and calendar edits use those commands for provider-backed changes. account preferences and board changes use their own owners and the same operation receipt journal.

record confirmed outcomes. a click or an optimistic ui change is not proof that google accepted a mutation. google and d1 do not share a transaction; define how interrupted operations are recognized and reconciled before claiming reliable writes.

sync belongs inside the task owner. it reconciles external changes with the local view. an observed google edit must not be fed back into an outgoing write merely to record it.

history distinguishes a change made through lanes from a change discovered during sync. discovery time is not the exact time or full sequence of external edits. google does not provide an audit trail to backfill. d1 backups are separate from product history.
