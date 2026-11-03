# self-hosting

clone lanes and ask an agent to deploy it. complete the required account sign-ins and consent.

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

google mcp is optional. do not assume it can create the web oauth client or configure its audience and test users. use available tools where they support the operation and an authorized browser for the remaining console steps. the owner handles sign-in, two-factor authentication, and consent.

if browser access is unavailable or a step requires the owner, hand off only that step with the exact page and values. resume the setup afterward.

the google configuration consists of choosing a project, enabling the tasks api, configuring an external audience in testing mode, adding the connecting accounts to test users, and creating a web oauth client with the exact callback url supplied by the agent. configure sheets access when that feature is used. see [google's setup guide](https://developers.google.com/workspace/guides/get-started).

the default address is on `workers.dev`; buying a domain is optional.

## agent workflow

1. read [product](product.md), the [architecture proposal](architecture.md), and [security](security.md). inspect the checkout, working tree, package manifest, and deployment configuration. use commands and paths present in that version of the repository. if an entry point required for deployment is missing, report it rather than inventing a deployment path.
2. check existing cloudflare authentication and reuse it. use an authorized cloudflare mcp connection or wrangler's browser sign-in according to the available tools and permissions. do not require both. a copied api token is not a default prerequisite.
3. confirm the target account and free plan. find the intended worker and d1 database before creating resources. reuse a matching installation. default to a `workers.dev` address.
4. create `wrangler.deploy.jsonc` from the shared `wrangler.jsonc` only if the private file does not exist. fill its target account, worker name, database id, application origin and owner email. leave the tracked template unchanged. apply migrations to that intended database and generate installation secrets once. preserve the private config, database, keys and existing secrets when continuing an installation.
5. establish the exact application address and oauth callback url from the deployment. the installation must remain closed to unauthorized ownership claims while oauth is being configured.
6. perform the google configuration described above using available tools or an authorized browser. ask the owner to complete sign-in and any required consent. provide exact console instructions only for steps the agent cannot perform. use one oauth web client for the installation.
7. confirm that every google account to connect is listed in test users. retrieve the client credentials during setup, or receive them through local input if necessary, and store them in the worker's secrets. terminal access alone does not automate all google console steps.
8. configure the instance owner before allowing application access. complete the build and deploy using the repository's documented entry points. keep credentials out of the static client.
9. have the owner sign in and grant tasks access for each connected account. verify that account's task lists, account selection, and expired-connection states. use a dedicated test list for any write checks.
10. return the application url and a short account of what was deployed and verified. leave an interrupted setup with a clear next step and reuse the existing resources on the next attempt.

verify the `workers.dev` callback and the personal testing-mode flow together. do not work around a setup issue by publishing the oauth app or enabling a paid plan.

## google permissions

use `openid`, `email`, and `profile` for identity and `https://www.googleapis.com/auth/tasks` for task access. gmail inbox access is not needed.

one client serves all connected accounts on that instance. each account grants access separately. request sheets permission when that feature is used and match the scope to its file-access behavior. broad drive access is not a default requirement. see [tasks authorization](https://developers.google.com/workspace/tasks/auth) and [sheets scopes](https://developers.google.com/workspace/sheets/api/scopes).

url-based sheets import uses incremental spreadsheet read access; new-file export uses `drive.file`. no picker browser token or separate frontend credentials are needed. a pasted sheet url is not a provider-enforced per-file read grant. see [sheets portability](../specs/portability/spec.md#google-sheets).

testing-mode task authorizations and refresh tokens expire after seven days. the owner reconnects each affected account through lanes. new accounts must first be added to test users. see [google's audience rules](https://support.google.com/cloud/answer/15549945).

workspace administrators can restrict third-party access. adding an account to test users does not override its organization's policy.

## configuration entry points

| concern                               | entry point                                                                                                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| node and dependencies                 | [`.node-version`](../.node-version), [`package.json`](../package.json), [`package-lock.json`](../package-lock.json)                                                               |
| local configuration example           | [`.dev.vars.example`](../.dev.vars.example); copy to ignored `.dev.vars`                                                                                                          |
| browser startup                       | [`src/web/main.tsx`](../src/web/main.tsx), [`src/web/App.tsx`](../src/web/App.tsx)                                                                                                |
| http and scheduled worker             | [`src/worker/index.ts`](../src/worker/index.ts)                                                                                                                                   |
| shared local and ci configuration     | [`wrangler.jsonc`](../wrangler.jsonc); copy to ignored `wrangler.deploy.jsonc` for a personal deployment                                                                          |
| server configuration validation       | [`src/worker/env.ts`](../src/worker/env.ts)                                                                                                                                       |
| oauth and owner sessions              | [`src/modules/accounts/server.ts`](../src/modules/accounts/server.ts)                                                                                                             |
| grant refresh and disconnect          | [`src/modules/accounts/provider-access.ts`](../src/modules/accounts/provider-access.ts)                                                                                           |
| application service composition       | [`src/worker/services.ts`](../src/worker/services.ts), [`template-services.ts`](../src/worker/template-services.ts), [`transfer-services.ts`](../src/worker/transfer-services.ts) |
| local owner commands                  | [`src/worker/local-commands.ts`](../src/worker/local-commands.ts)                                                                                                                 |
| task commands and provider settlement | [`src/modules/tasks/server/provider-commands.ts`](../src/modules/tasks/server/provider-commands.ts)                                                                               |
| admitted operation receipts           | [`src/modules/tasks/server/operations.ts`](../src/modules/tasks/server/operations.ts)                                                                                             |
| schema changes                        | [`migrations/`](../migrations/) in filename order                                                                                                                                 |
| scheduler and cleanup                 | [`src/worker/scheduler.ts`](../src/worker/scheduler.ts), [`maintenance.ts`](../src/worker/maintenance.ts)                                                                         |

use `npm ci` to install the locked dependencies. `npm run check` runs formatting, type checking, import boundaries, tests and the build. `npm run dev` uses `127.0.0.1:5173` and local cloudflare bindings. check the port before starting it; reuse the matching process. local development and `npm run build` use the tracked template and do not require the private deploy config.

`npm run db:migrate` applies migrations to local d1 only. `npm run db:migrate:remote` selects `wrangler.deploy.jsonc` explicitly and changes that installation's remote database. verify the account, database id and migration plan before using the remote command.

`npm run build:deploy` runs the vite build in deploy mode with `wrangler.deploy.jsonc`; it fails if that file is missing. `npm run deploy` runs that build, then invokes wrangler using the generated deployment configuration. the vite/cloudflare build writes the deployment output under `dist/`; do not deploy a hand-built copy of the client or a different worker entry. a deploy must not fall back to the tracked template.

run these commands directly; a separate setup program is not required.

### bindings and values

keep the reusable defaults and placeholder values in `wrangler.jsonc`; do not replace them with an installation's account, database, owner or address.

on a fresh installation, the agent copies it once:

```sh
cp wrangler.jsonc wrangler.deploy.jsonc
```

the ignored `wrangler.deploy.jsonc` holds the selected `account_id`, worker `name`, real d1 `database_id`, `APP_ORIGIN` and `OWNER_EMAIL`. these are installation values even when they are not secrets. keep the binding name `DB`; `ASSETS` serves the built client. use an ordinary worker and d1 database on the free plan. preserve an existing private file rather than replacing it with a fresh copy.

| value                  | meaning and storage                                                   |
| ---------------------- | --------------------------------------------------------------------- |
| `APP_ORIGIN`           | exact public origin, including `https://`; private deploy config vars |
| `OWNER_EMAIL`          | bootstrap owner email; private deploy config vars                     |
| `GOOGLE_CLIENT_ID`     | this installation’s web oauth client id; worker secret                |
| `GOOGLE_CLIENT_SECRET` | the matching client secret; worker secret                             |
| `SESSION_KEY`          | independent random 32-byte key encoded as base64url; worker secret    |
| `TOKEN_ENCRYPTION_KEY` | a second random 32-byte base64url key; worker secret                  |
| `TOKEN_KEY_ID`         | stable identifier for the encryption key, default `v1`; worker var    |

store remote secrets through `wrangler secret put <NAME> --config wrangler.deploy.jsonc` or the authorized cloudflare tools targeting that installation. neither config file contains secret values. keep them out of browser environment values, source files, issue text and command output. generate both application keys independently. local `.dev.vars` is ignored and contains separate development settings, credentials and keys; cloudflare secrets are not downloaded into it.

the production callback is exactly `${APP_ORIGIN}/auth/google/callback`. the local callback is `http://127.0.0.1:5173/auth/google/callback`. register each origin/callback actually used by that oauth client; a local callback does not authorize a `workers.dev` deployment.

oauth starts at `POST /auth/google/start`. callbacks return to the browser through `GET /auth/google/callback`. owner sign-out uses `POST /auth/signout`. the client reads `GET /api/session`; application mutations also require the exact origin and `x-lanes-api: 1` header.

the configured cron ticks once per minute. each tick advances bounded admitted work or one cleanup family using persisted fairness state. a tick is not an exact-time delivery guarantee, and idle accounts do not receive a full google poll on every tick.

### github auto-deploy

the [check workflow](../.github/workflows/check.yml) deploys after its checks pass, only for a push to the repository's default branch with repository variable `LANES_AUTO_DEPLOY` set to `true`. pull requests and other branches cannot run the deploy step. default-branch runs finish before the next one starts; a later push does not cancel an active migration or deploy.

configure two github actions repository secrets:

- `CLOUDFLARE_API_TOKEN`: an account-owned token with editor access to the existing target worker and d1 write access for migrations. create the worker with the owner's access first; the deploy token does not need permission to create other workers. d1 write access covers the account's databases.
- `LANES_DEPLOY_CONFIG`: the installation's private config serialized as strict JSON, without comments, trailing commas or application secret values. include its `account_id`, worker name, database, origin and owner.

keep google credentials and application keys in cloudflare worker secrets. the workflow writes the private config with owner-only file permissions, masks installation values before command output, applies remote migrations, then builds and deploys. a redeploy preserves the worker's secret bindings. enable the repository variable only after the initial installation and both github secrets are ready.

### installation checks

verify the deployed health response, the configured session response, and the owner-only sign-in boundary before connecting task accounts. complete real google consent on the `workers.dev` callback. list each test account explicitly in the oauth audience and confirm that switching accounts cannot expose another account’s task references.

use a dedicated google test list for create/edit/complete/move/delete checks. verify the actual etag and cross-list movement behavior used by that version; local mocks cannot establish provider guarantees. check a timed repeat, a template run, a small import, optional sheets consent and a download with controlled data.

measure worker cpu, provider requests and d1 usage on the deployed free plan. local sqlite transaction tests establish application behavior, not cloudflare cpu acceptance. reduce work slices if a valid request exceeds a free limit; do not enable billing as a workaround.

## updates and limits

before an update, record the deployed worker version and obtain a d1 backup or time travel bookmark. store any exported database outside the checkout or under an ignored private path. keep the corresponding token-encryption key and key id separately; a database backup does not contain the worker’s secrets.

install the locked dependencies and run `npm run check`. compare runtime, asset, cron and binding changes in the tracked template with the preserved private deploy config; carry over applicable changes without replacing personal values. inspect the pending migrations, apply them to the intended remote database, then deploy. test owner sign-in, account separation, task access and a retained operation after the update. preserve installation ownership, both keys, oauth client configuration and resource bindings.

if a rollback is needed, first establish whether the previous worker can read the migrated schema. roll back code only when that remains compatible. restoring d1 is a separate explicit decision that can discard later writes. test the recovery path with controlled data before relying on it.

verify current platform requirements before claiming the complete setup needs no billing account or payment method.

check the current [worker limits](https://developers.cloudflare.com/workers/platform/limits/), [d1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [d1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) during installation. the free plan’s cpu and query limits apply to background work as well as browser requests. other applications in the same cloudflare account share account-wide allowances. d1 time travel currently retains seven days on the free plan; an archive’s task history has its separate 90-day product policy.
