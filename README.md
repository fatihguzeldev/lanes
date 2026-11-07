# lanes

a self-hosted workspace for google tasks.

google tasks lists become columns, grouped into boards. lanes stores labels, planning, templates and history in your cloudflare account.

each installation has one owner and can connect several google accounts. accounts keep their tasks and organization separate.

## features

- kanban, list and calendar views.
- search, today and starred views across an account's boards.
- subtasks, notes, stars, labels, priorities and dependencies.
- scheduled days, local times, repeat rules, personal templates and scheduled checklists.
- task history.
- file and google sheets import, csv and sheets export, account transfers and workspace archives.

## self-hosting

clone the repository and give your agent [AGENTS.md](AGENTS.md) and the [self-hosting guide](agents/self-hosting.md). ask it to host lanes in your cloudflare account.

the agent handles the build, database, configuration and deployment. you handle sign-in, two-factor authentication and google consent. with authorized browser access, the agent can also configure google console.

your deployment settings stay in ignored `wrangler.deploy.jsonc`. live secrets stay in cloudflare.

the default setup uses a cloudflare worker, static assets, d1 and a `workers.dev` address. it is designed for the free plan; quotas can pause work. you do not need a custom domain or paid service.

google oauth uses testing mode. add each connected account to the project's test users and reconnect when its seven-day authorization expires.

## development

use the node version in [.node-version](.node-version). copy [.dev.vars.example](.dev.vars.example) to ignored `.dev.vars` and fill in local settings and credentials.

```sh
npm ci
npm run db:migrate
npm run dev
```

local development uses the tracked config and a separate local database.

```sh
npm run check
```

this runs formatting, type checking, import boundary checks, tests and the production build.

read [contributing](agents/contributing.md) before changing a contract or opening a pull request.

## license

[mit](LICENSE). third-party files retain their own licenses.
