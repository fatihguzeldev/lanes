# architecture

this architecture is a proposal. everything in it is subject to change.

## runtime

host lanes as one cloudflare deployment: a static browser client, a worker for server behavior, and d1 for application data. use a scheduled worker entry for bounded recurrence or template work when its timing rules require it.

the browser client uses react and typescript.

## ownership map

```text
src/
  web/
  client/
  worker/
    routes/
  modules/
    accounts/
    tasks/
    boards/
    history/
    transfer/
  ui/
  styles/
migrations/
wrangler.jsonc
```

| owner               | responsibility                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `web/`              | browser startup, routes, application shell, and screen composition                                 |
| `client/`           | context-independent browser requests, reachability, resource loading, and submission dialogs       |
| `worker/`           | server startup, http and scheduled entry points, environment loading, and dependency wiring        |
| `modules/accounts/` | owner session, connected google accounts, oauth, token refresh, and reconnection                   |
| `modules/tasks/`    | google task lists and tasks, application task metadata, mutations, scheduling rules, and sync      |
| `modules/boards/`   | board grouping, layout, filters, calendar presentation, and board templates                        |
| `modules/history/`  | storing and reading confirmed changes and observed external changes                                |
| `modules/transfer/` | parsing and validating imports, exports, sheets access, and account transfers                      |
| `ui/`               | context-independent visual primitives                                                              |
| `styles/`           | shared visual tokens and base rules                                                                |
| `migrations/`       | ordered changes to the d1 schema                                                                   |
| `wrangler.jsonc`    | shared local and ci defaults; personal deployment values belong in ignored `wrangler.deploy.jsonc` |

## inside an owner

keep browser-safe models and contracts with their owner. browser components, client requests, server commands, persistence, and provider access have different responsibilities even when they belong to the same module.

use `client/` inside an owner for requests, hooks, forms, and workflows that coordinate application behavior in the browser. use `components/` for the owner's reusable presentation. keep their tests and styles beside them. neither imports the application shell to obtain a request helper, command, or dialog.

keep runtime-independent models and shared wire contracts at the owner root. response decoders used only by a browser workflow can stay beside that workflow. a response schema belongs to the feature whose response it validates. `src/client/` accepts those schemas from its callers; it does not import feature models.

split a large unit at a responsibility that can be named and reviewed. a new folder groups a related flow, such as template application or archive restoration. moving a long component into a hook with the same mixed responsibilities does not establish a boundary. do not create a folder for every function or keep an old-path re-export after moving its consumers.

### task server

| unit                         | owns                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `tasks/server/commands/`     | command capture, provider preconditions, dispatch, copy plans, result resolution, and command retention |
| `tasks/server/queries/`      | bounded task and list reads, query coverage, and snapshots consumed by export or copy operations        |
| `tasks/server/operations.ts` | durable receipts, claims, dispatched input, retries, and atomic step settlement                         |
| `tasks/server/projection.ts` | confirmed provider values, stable task identity, version checks, and projection writes                  |
| `tasks/server/sync.ts`       | provider inventory, reconciliation jobs, leases, page cursors, and follow-up work                       |

commands and sync both use the projection store. a mutation must not import the sync scheduler merely to record a confirmed task. provider preconditions validate the captured resource before dispatch; command effects prepare metadata, schedule, and history statements for the existing atomic receipt commit. those helpers do not commit independently.

metadata, recurrence, completed deletion, and template lifecycle work stay with tasks. their resumable services are separate from the operation journal and the read projection.

### browser workflows

task client code owns task queries, commands, consequence checks, recurrence work, and optimistic movement. the movement model describes task lists and predecessor identities; it does not import board components or invent provider position values. board presentation consumes that model.

board client code owns board views, list placement, navigation, calendar composition, and the combined template interface. template source capture, management, application, scheduling, and run inspection are separate flows under `boards/client/templates/`. list template documents and lifecycle rules still belong to tasks.

transfer client flows are grouped under `imports/`, `archives/`, `exports/`, `sheets/`, and `parsing/`. account copying and destination selection stay at the client root. parsing workers remain beside the client that starts them. source reads, resumable capture, retained activity, and form presentation have distinct units; the form does not own another implementation of the import protocol.

history client code consumes event contracts and narrow display context. displaying a board title or account time zone does not require importing the board or account service. account client code owns account selection and connection management presentation; shell navigation supplies its callbacks.

task recurrence belongs with the task lifecycle. list templates belong with tasks; board templates belong with boards. the calendar presents the same tasks and schedules used by the other views.

## dependency direction

a route delegates behavior to its owner; it does not grow a second implementation of the rule.

- boards can compose task queries, commands, and presentation. tasks do not depend on board layout.
- transfer calls the owning task or board commands. it does not write another owner's tables.
- task server code uses accounts for authorized google access and history for change recording.
- history does not perform task mutations. accounts does not depend on task or board models.
- feature clients do not import `web/`. the shell composes them and supplies navigation callbacks.
- `src/client/` does not import feature modules or the shell. shared ui does not import browser request infrastructure.
- shared ui does not import application modules. module-specific cards, icons, and formatting stay with their owner.
- cross-owner imports use explicit contract or operation files. one module does not reach into another module's repository or provider implementation.

keep the google tasks adapter under the task owner, oauth under accounts, and sheets behavior under transfer. extract a shared transport capability only when its behavior is actually shared.

## browser and server

the browser can consume browser-safe contracts, models, components, and its http client. it cannot import server modules, credentials, database bindings, or server environment values.

server code does not import browser components or depend on the currently selected account in the ui. resolve the owner session and the connected account on the server for each operation.

enforce these directions with import checks that cover the actual source paths and aliases used by the project.

parse server configuration at the worker entry point. keep database queries with their data owner.

`worker/index.ts` exposes fetch and scheduled entry points. request handling applies configuration, origin, session, and protocol checks before account routes dispatch to services. route files translate http inputs and results; they do not implement task, board, or transfer rules. scheduled wiring composes bounded owner services separately from request handling.

`scripts/check-boundaries.mjs` checks client and component files as browser roots, including helpers not yet reached from the app. it also checks dynamic imports and worker urls. cross-owner server imports are limited to declared operation and query capabilities; adding a capability requires reviewing its callers and updating that declaration. a helper becoming convenient is not a reason to make it public.

## data ownership

google is authoritative for the task fields its api supports, including titles, notes, completion, scheduled day, and ordering. d1 owns board organization, labels, priorities, stars, dependencies, scheduled time, application repeat rules, account connections, task mappings, sync state, and history.

the task owner combines those records into the view consumed by the browser. google response shapes stay at its adapter boundary. account identity must travel with task references, queries, mutations, sync state, and history; provider ids alone are not an account boundary.

google's task api records a scheduled day, but cannot read or write its scheduled time. it also lacks native repeat-rule, star, and reminder fields. application scheduling must be described honestly in other google clients. see the [task resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks).

## changes, sync, and history

task commands own changes made through lanes. imports, templates, and calendar edits use those commands so they follow the same validation and history rules.

record confirmed outcomes. a click or an optimistic ui change is not proof that google accepted a mutation. google and d1 do not share a transaction; define how interrupted operations are recognized and reconciled before claiming reliable writes.

sync belongs inside the task owner. it reconciles external changes with the local view. an observed google edit must not be fed back into an outgoing write merely to record it.

history distinguishes a change made through lanes from a change discovered during sync. discovery time is not the exact time or full sequence of external edits. google does not provide an audit trail to backfill. d1 backups are separate from product history.
