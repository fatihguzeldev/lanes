# self-hosting

clone lanes, ask an agent to host it, complete the required sign-ins and consent, and receive the application url. the agent follows the repository's entry points and handles configuration and deployment.

## what the owner needs

- a cloudflare free account.
- the google accounts they want to connect.
- a google account with permission to create or manage the installation's cloud project.
- an agent with terminal access. authorized browser access lets it perform google console configuration too; the owner handles sign-in, two-factor authentication, and account consent.

the agent can choose ordinary defaults for resource names and other routine details. ask for the owner account and a target cloudflare account when there is a choice. obtain client credentials during the authorized setup; ask the owner to supply them only when the agent cannot retrieve them. do not ask the owner to design the infrastructure.

## who does what

| part                      | owner                                                                                                                       | agent                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cloudflare access         | sign in through wrangler or authorize a cloudflare mcp connection; choose the target account if needed                      | reuse existing access or guide the sign-in; either route is sufficient when it has the required permissions                                                             |
| google configuration      | complete sign-in, two-factor authentication, and required account consent; perform console steps only when the agent cannot | create or select the project, enable apis, and configure oauth through available tools or an authorized browser; give exact instructions for any step it cannot perform |
| google client credentials | supply credentials through local input only if the agent cannot retrieve them                                               | obtain the client id and secret or client configuration during setup and store the credentials in the worker's secrets                                                  |
| application secrets       | no external credentials to obtain                                                                                           | generate session and token-encryption keys and preserve them across updates                                                                                             |
| hosting                   | no separate server or database account to manage                                                                            | install required local tools, build, create or reuse cloudflare resources, apply migrations, configure bindings, deploy, and verify                                     |
| connected accounts        | sign in to each google account and grant tasks access; reconnect when its testing-mode authorization expires                | verify the connection and account separation, then return the application url                                                                                           |

wrangler and cloudflare mcp are alternative ways to give the agent cloudflare access. the owner does not need to configure both. see [wrangler login](https://developers.cloudflare.com/workers/wrangler/commands/general/#login).

google publishes [mcp servers](https://github.com/google/mcp), but a google mcp connection is not a setup requirement. do not assume it can create the web oauth client or configure its audience and test users. use available tools where they support the operation and an authorized browser for console configuration. the owner does not need to operate the console manually when the agent can do it. account permissions are still required; sign-in, two-factor authentication, and consent stay with the owner.

if browser access is unavailable or a step requires the owner, hand off only that step with the exact page and values. resume the setup afterward.

the google configuration consists of choosing a project, enabling the tasks api, configuring an external audience in testing mode, adding the connecting accounts to test users, and creating a web oauth client with the exact callback url supplied by the agent. configure sheets access when that feature is used. see [google's setup guide](https://developers.google.com/workspace/guides/get-started).

the default address is on `workers.dev`; buying a domain is optional. the owner does not need to obtain application secrets from another service. resources, bindings, migrations, and deployment commands belong to the agent's work.

## agent workflow

1. read [product](product.md), the [architecture proposal](architecture.md), and [security](security.md). inspect the checkout, working tree, package manifest, and deployment configuration. use commands and paths present in that version of the repository. if an entry point required for deployment is missing, report it rather than inventing a deployment path.
2. check existing cloudflare authentication and reuse it. use an authorized cloudflare mcp connection or wrangler's browser sign-in according to the available tools and permissions. do not require both. a copied api token is not a default prerequisite.
3. confirm the target account and free plan. find the intended worker and d1 database before creating resources. reuse a matching installation. default to a `workers.dev` address.
4. apply the repository's schema migrations to the intended database. configure the bindings and generate installation secrets once. preserve the database, keys, and existing secrets when continuing or updating an installation.
5. establish the exact application address and oauth callback url from the deployment. the installation must remain closed to unauthorized ownership claims while oauth is being configured.
6. perform the google configuration described above using available tools or an authorized browser. ask the owner to complete sign-in and any required consent. provide exact console instructions only for steps the agent cannot perform. use one oauth web client for the installation.
7. confirm that every google account to connect is listed in test users. retrieve the client credentials during setup, or receive them through local input if necessary, and store them in the worker's secrets. terminal access alone does not automate all google console steps.
8. configure the instance owner before allowing application access. complete the build and deploy using the repository's documented entry points. keep credentials out of the static client.
9. have the owner sign in and grant tasks access for each connected account. verify that account's task lists, account selection, and expired-connection states. use a dedicated test list for any write checks.
10. return the application url and a short account of what was deployed and verified. leave an interrupted setup with a clear next step and reuse the existing resources on the next attempt.

verify the `workers.dev` callback and the personal testing-mode flow together. do not work around a setup issue by publishing the oauth app or enabling a paid plan.

## google permissions

basic sign-in and tasks access are different permissions. use `openid`, `email`, and `profile` for identity and `https://www.googleapis.com/auth/tasks` for task access. gmail inbox access is not needed.

one client serves all connected accounts on that instance. each account grants access separately. request sheets permission when that feature is used and match the scope to its file-access behavior. broad drive access is not a default requirement. see [tasks authorization](https://developers.google.com/workspace/tasks/auth) and [sheets scopes](https://developers.google.com/workspace/sheets/api/scopes).

the [portability spec](../specs/portability/spec.md#google-sheets) defines url-based sheets import with incremental spreadsheet read access and new-file export with `drive.file`. this path needs no picker browser token or separate frontend credentials. explain the actual permission breadth; a pasted sheet url is not a provider-enforced per-file read grant.

testing-mode task authorizations and refresh tokens expire after seven days. the owner reconnects each affected account through lanes. new accounts must first be added to test users. this limitation is accepted; see [google's audience rules](https://support.google.com/cloud/answer/15549945).

workspace administrators can restrict third-party access. adding an account to test users does not override its organization's policy.

## configuration entry points

| concern                               | entry point                                                                                                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| node and dependencies                 | [`.node-version`](../.node-version), [`package.json`](../package.json), [`package-lock.json`](../package-lock.json)                                                               |
| local configuration example           | [`.dev.vars.example`](../.dev.vars.example); copy to ignored `.dev.vars`                                                                                                          |
| browser startup                       | [`src/web/main.tsx`](../src/web/main.tsx), [`src/web/App.tsx`](../src/web/App.tsx)                                                                                                |
| http and scheduled worker             | [`src/worker/index.ts`](../src/worker/index.ts)                                                                                                                                   |
| resource bindings, assets and cron    | [`wrangler.jsonc`](../wrangler.jsonc)                                                                                                                                             |
| server configuration validation       | [`src/worker/env.ts`](../src/worker/env.ts)                                                                                                                                       |
| oauth and owner sessions              | [`src/modules/accounts/server.ts`](../src/modules/accounts/server.ts)                                                                                                             |
| grant refresh and disconnect          | [`src/modules/accounts/provider-access.ts`](../src/modules/accounts/provider-access.ts)                                                                                           |
| application service composition       | [`src/worker/services.ts`](../src/worker/services.ts), [`template-services.ts`](../src/worker/template-services.ts), [`transfer-services.ts`](../src/worker/transfer-services.ts) |
| local owner commands                  | [`src/worker/local-commands.ts`](../src/worker/local-commands.ts)                                                                                                                 |
| task commands and provider settlement | [`src/modules/tasks/server/provider-commands.ts`](../src/modules/tasks/server/provider-commands.ts)                                                                               |
| admitted operation receipts           | [`src/modules/tasks/server/operations.ts`](../src/modules/tasks/server/operations.ts)                                                                                             |
| schema changes                        | [`migrations/`](../migrations/) in filename order                                                                                                                                 |
| scheduler and cleanup                 | [`src/worker/scheduler.ts`](../src/worker/scheduler.ts), [`maintenance.ts`](../src/worker/maintenance.ts)                                                                         |

use `npm ci` to install the locked dependencies. `npm run check` runs formatting, type checking, import boundaries, tests and the build. `npm run dev` uses `127.0.0.1:5173` and local cloudflare bindings. check the port before starting it; reuse the matching process.

`npm run db:migrate` applies migrations to local d1 only. `npm run db:migrate:remote` changes the configured remote database. verify the account, database id and migration plan before using the remote command.

`npm run deploy` builds the browser and worker, then invokes wrangler. the vite/cloudflare build writes the deployment output under `dist/`; do not deploy a hand-built copy of the client or a different worker entry.

the agent carries out these steps directly. a separate setup program is not required.

### bindings and values

replace the placeholder database id in `wrangler.jsonc` with the intended d1 database id. the binding name stays `DB`; `ASSETS` serves the built client. use an ordinary worker and d1 database on the free plan.

| value                  | meaning and storage                                                 |
| ---------------------- | ------------------------------------------------------------------- |
| `APP_ORIGIN`           | exact public origin, including `https://`; configure in worker vars |
| `OWNER_EMAIL`          | bootstrap owner email; configure before the first sign-in           |
| `GOOGLE_CLIENT_ID`     | this installation’s web oauth client id; worker secret              |
| `GOOGLE_CLIENT_SECRET` | the matching client secret; worker secret                           |
| `SESSION_KEY`          | independent random 32-byte key encoded as base64url; worker secret  |
| `TOKEN_ENCRYPTION_KEY` | a second random 32-byte base64url key; worker secret                |
| `TOKEN_KEY_ID`         | stable identifier for the encryption key, default `v1`; worker var  |

store remote secrets through `wrangler secret put` or the authorized cloudflare tools. do not put their values in `wrangler.jsonc`, browser environment values, source files, issue text or command output. generate both application keys independently. local `.dev.vars` is ignored and must contain separate development credentials and keys.

the production callback is exactly `${APP_ORIGIN}/auth/google/callback`. the local callback is `http://127.0.0.1:5173/auth/google/callback`. register each origin/callback actually used by that oauth client; a local callback does not authorize a `workers.dev` deployment.

oauth starts at `POST /auth/google/start`. callbacks return to the browser through `GET /auth/google/callback`. owner sign-out uses `POST /auth/signout`. the client reads `GET /api/session`; application mutations also require the exact origin and `x-lanes-api: 1` header.

the configured cron ticks once per minute. each tick advances bounded admitted work or one cleanup family using persisted fairness state. a tick is not an exact-time delivery guarantee, and idle accounts do not receive a full google poll on every tick.

### installation checks

verify the deployed health response, the configured session response, and the owner-only sign-in boundary before connecting task accounts. complete real google consent on the `workers.dev` callback. list each test account explicitly in the oauth audience and confirm that switching accounts cannot expose another account’s task references.

use a dedicated google test list for create/edit/complete/move/delete checks. verify the actual etag and cross-list movement behavior used by that version; local mocks cannot establish provider guarantees. check a timed repeat, a template run, a small import, optional sheets consent and a download with controlled data.

measure worker cpu, provider requests and d1 usage on the deployed free plan. local sqlite transaction tests establish application behavior, not cloudflare cpu acceptance. reduce work slices if a valid request exceeds a free limit; do not enable billing as a workaround.

## updates and limits

read the version's migration and deployment instructions before updating. preserve data and encryption keys. a worker rollback does not itself reverse a database migration.

before an update, record the deployed worker version and obtain a d1 backup or time travel bookmark. store any exported database outside the checkout or under an ignored private path. keep the corresponding token-encryption key and key id separately; a database backup does not contain the worker’s secrets.

install the locked dependencies and run `npm run check`. inspect the pending migrations, apply them to the intended remote database, then deploy. test owner sign-in, account separation, task access and a retained operation after the update. preserve installation ownership, both keys, oauth client configuration and resource bindings.

if a rollback is needed, first establish whether the previous worker can read the migrated schema. roll back code only when that remains compatible. restoring d1 is a separate explicit decision that can discard later writes. test the recovery path with controlled data before relying on it.

application history and database backups serve different purposes. make the treatment of both clear before changing storage or retention.

the default installation uses free-plan resources. quotas can pause an operation; free hosting does not promise unlimited capacity. custom domains are optional. verify current platform requirements before claiming the complete setup needs no billing account or payment method.

check the current [worker limits](https://developers.cloudflare.com/workers/platform/limits/), [d1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [d1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) during installation. the free plan’s cpu and query limits apply to background work as well as browser requests. other applications in the same cloudflare account share account-wide allowances. d1 time travel currently retains seven days on the free plan; an archive’s task history has its separate 90-day product policy.
