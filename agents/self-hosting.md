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

keep the exact files and commands for these concerns documented beside their owning configuration:

- dependency installation, local development, build, and deploy.
- worker entry points, static output, and the d1 binding in `wrangler.jsonc`.
- migrations and the selected remote database.
- application url, oauth callback, and owner access configuration.
- google client credentials, session signing, and stored-token encryption.
- any scheduled recurrence or template work.

keep safe example values separate from local secrets. the agent carries out the documented steps directly; a separate setup program is not required.

## updates and limits

read the version's migration and deployment instructions before updating. preserve data and encryption keys. a worker rollback does not itself reverse a database migration.

application history and database backups serve different purposes. make the treatment of both clear before changing storage or retention.

the default installation uses free-plan resources. quotas can pause an operation; free hosting does not promise unlimited capacity. custom domains are optional. verify current platform requirements before claiming the complete setup needs no billing account or payment method.
