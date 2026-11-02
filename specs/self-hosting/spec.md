# self-hosting

the installation path is: clone the repository, give an agent the deployment request, complete sign-ins and consent, and receive a working url. the owner does not need to design infrastructure or run a custom setup program.

## ownership and dependencies

deployment configuration owns runtime entry points, bindings, environment validation, migrations, and release compatibility. accounts owns owner access and oauth. task scheduling owns scheduled work. every feature must satisfy the free-plan contract here.

[the self-hosting guide](../../agents/self-hosting.md) is the agent's operational entry point. this spec defines the behavior that workflow must deliver. [architecture](../../agents/architecture.md) proposes one implementation; every part of it remains subject to change.

## required inputs

| input | owner supplies | agent handles |
| --- | --- | --- |
| repository | the checkout and authorization to deploy it | read guides/configuration and select the actual executable entry points |
| cloudflare | a free account, sign-in, and target account when ambiguous | reuse authorization through wrangler or cloudflare mcp; create/reuse resources |
| google project | an account permitted to manage a project and any interactive sign-in/2fa | create/select project, enable apis, configure audience/client/test users through authorized tools or browser |
| instance owner | the intended owner google identity | configure closed access before sign-in is exposed |
| connected accounts | account selection and consent for each | verify distinct grants, initialization, and reconnect behavior |
| credentials | manual secure input only when the agent cannot retrieve them | retrieve client configuration, generate app keys, and store server secrets |

wrangler and cloudflare mcp are alternatives when either has the needed capabilities. google mcp is optional and must not be assumed to support oauth console administration. an authorized browser can perform console configuration; only unavailable or owner-only steps are handed back with exact values.

no bought domain, separate server, database subscription, google service account, production oauth publishing, or billing upgrade is part of the default path. sheets access adds optional api/scope configuration, not a second deployment service.

## deployment contract

the default deployable shape is one static browser client, one worker, one d1 database, and scheduled entry points only for the scoped background work. keep resource names ordinary and editable. if the architecture changes, preserve an equally concrete free deployment path and update the guides.

default to https on `workers.dev`. derive the exact application origin and oauth callback from the selected deployment. the callback must match google configuration exactly. custom domains are optional and require an explicit owner choice.

before creating anything, inspect existing authenticated accounts and intended resource names/bindings. reuse a matching installation. an interrupted setup must be resumable without creating another database, rotating working keys, or replacing a different installation.

the application remains closed while owner configuration or oauth secrets are incomplete. static assets may load a setup-unavailable screen; private endpoints and first-visitor ownership remain disabled. changing an owner configuration is an administrative action, not a public route.

## configuration boundaries

| concern | storage/visibility |
| --- | --- |
| public browser configuration | only nonsecret values needed by the static client |
| application origin, owner bootstrap identity, resource bindings | validated server/deployment configuration |
| oauth client secret, session key, token-encryption key | worker secrets; never static assets or tracked values |
| google refresh/access tokens | encrypted account-owned records; key held outside d1 |
| schema versions, task projections, local metadata, operations | the selected d1 database |
| oauth callback and schedule entry points | explicit worker routing/configuration |

generate installation keys once, using cryptographic randomness. preserve them across redeploys. a missing or mismatched encryption key fails closed with an actionable installation error; it must not erase accounts or regenerate a key over existing encrypted data.

validate required configuration at server startup/entry. do not leak secret values in diagnostics. use a local ignored secret file for local development and isolated local data; a development command must not mutate the deployed database by default.

## discoverable entry points

the deployable repository must document actual paths and executable commands for:

- dependency installation with a lockfile and required runtime version.
- local development, build, focused checks, type checking, and import-boundary verification.
- static output, worker request handler, scheduled handler, and resource bindings.
- oauth start/callback, owner verification, connection management, and server environment parsing.
- ordered schema migrations, local versus remote targets, database backup/export, and restore.
- secret installation, deploying to the intended account, inspecting deployment status, and release rollback.

those commands come from executable configuration, not a parallel prose-only setup implementation. do not require `npm run setup`, a custom wizard, or a second source of deployment truth. the agent executes ordinary project and provider tooling directly.

## google setup

use one web oauth client with an external audience in testing mode. add every tasks/sheets account to test users. keep task access server-side and use incremental sheets permissions defined in [portability](../portability/spec.md#google-sheets).

the owner completes google sign-in and consent; the agent can handle console forms and retrieve client configuration when authorized. if it cannot, specify the exact console page, project, callback, audience, test-user addresses, and credential destination. resume after the owner completes that step.

testing-mode tasks grants expire after seven days and allow up to 100 test users; see [google's audience rules](https://support.google.com/cloud/answer/15549945). this is an accepted operating constraint. background work pauses on expiry and resumes through the account flow; the agent must not publish the app to avoid it.

workspace policies and google callback/domain checks can still block a specific account or deployment. verify the actual personal `workers.dev` callback flow. if google refuses it, report the precise blocker; do not claim the path is verified or buy a domain silently.

## free-plan contract

all included features must work without enabling a paid plan, within provider free quotas. free means no required recurring hosting charge for the default installation within those quotas. it does not mean unlimited tasks, unlimited throughput, or guaranteed availability after exhaustion.

the documented cloudflare free ceilings include:

| resource | documented bound |
| --- | --- |
| worker requests | 100,000 per day |
| worker cpu | 10 ms per invocation, including free cron work |
| outgoing worker subrequests | 50 per invocation |
| d1 queries per worker invocation | 50 |
| d1 rows read/written | 5 million reads and 100,000 writes per day |
| d1 storage | 500 mb per free database, 5 gb total per account |
| d1 recovery window | seven-day time travel on free |

these are external platform limits and can change. verify [worker pricing](https://developers.cloudflare.com/workers/platform/pricing/), [worker limits](https://developers.cloudflare.com/workers/platform/limits/), [d1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), and [d1 limits](https://developers.cloudflare.com/d1/platform/limits/) before making a release capacity claim. account-wide usage from other applications can consume available capacity.

use indexed queries, paginated reads, small persisted work slices, bounded retries, and 90-day history cleanup. parse large workbooks in the browser and validate normalized input on the server. a free cron trigger is not permission to do minutes of cpu work or scan every task.

do not depend on paid queues, always-on compute, external databases, notification services, object storage, an ai provider, or a hosted synchronization service. adding a service changes this contract and needs an explicit product/architecture decision.

quota exhaustion pauses or rejects work and retains confirmed data. the platform may reject a request before lanes can render its own error. explain the known boundary in the deployment handoff; do not promise a custom recovery page when the worker itself cannot run.

## updates and recovery

before updating, identify the actual worker, database, schema version, deployment version, and current secrets. read migration compatibility and capture a supported database backup/recovery point. keep backups private; a raw database may contain encrypted credentials as well as task data.

apply ordered migrations to the intended database and deploy a compatible worker/client pair. account for old browser tabs and in-flight operations. breaking contract/schema changes need an explicit compatibility or maintenance path; silently resetting d1 is not an update strategy.

a worker rollback does not undo a migration. document whether the previous version can read the new schema. prefer compatible migrations; if recovery needs database restoration, require an explicit destructive recovery action and explain which confirmed data after the recovery point would be lost.

database recovery and a credential-free [workspace archive](../portability/spec.md#lanes-workspace-archive) serve different purposes. preserve the token-encryption key separately and securely for a raw database restore. do not add secrets to a product export to make restoration convenient.

changing origin requires deliberate callback and cookie configuration changes. changing oauth client or encryption keys needs a migration/reconnect plan. do not overwrite the existing deployment or revoke grants while merely inspecting an installation.

## deployment verification and handoff

use controlled lists/tasks for provider write checks and report which actions ran. verify:

- the static client and authenticated worker run at the intended origin.
- an unauthorized google identity cannot enter or claim ownership.
- the intended owner can sign in and connect each requested account with separated data.
- creating/editing a test task round-trips through google and survives reload.
- app metadata persists separately and survives reconnect/redeploy.
- scheduled entry points, bounded work, and expired-grant pauses behave as configured.
- browser assets, logs, error responses, and product exports contain no secrets.

return the url, selected cloudflare resources, relevant configuration locations, checks performed, and any concrete unverified flow. state the weekly reconnect requirement and how to update the installation. do not describe a successful build as proof of live oauth or deployed free-plan capacity.

## acceptance

- `self-hosting-01`: a fresh personal deployment requires only the listed accounts, owner input, and sign-in/consent steps; the agent performs routine configuration.
- `self-hosting-02`: either sufficient wrangler access or cloudflare mcp access works; both are not mandatory.
- `self-hosting-03`: setup interrupted after resource creation resumes using the same database and keys.
- `self-hosting-04`: missing owner configuration and invalid secrets fail closed without a first-visitor claim.
- `self-hosting-05`: the actual testing-mode oauth callback succeeds at the deployed origin, or the precise provider blocker is reported without a false success claim.
- `self-hosting-06`: all application entry points and commands resolve to real executable configuration.
- `self-hosting-07`: bounded import, sync, scheduling, and history work are measured on free-plan runtime limits without enabling billing.
- `self-hosting-08`: a redeploy preserves tokens/metadata; an update/rollback drill distinguishes worker rollback from database restoration.
- `self-hosting-09`: optional sheets setup, expired grants, platform quotas, and account policy restrictions have documented recovery paths.
- `self-hosting-10`: handoff names the actual deployment and verification evidence without exposing credentials.
