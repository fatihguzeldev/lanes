# lanes

a self-hosted workspace for google tasks.

your google lists become columns. boards give them a place. labels, planning, templates and history live in your own cloudflare account.

one installation, one owner, several google accounts. each account keeps its own tasks and organization.

## make it yours

clone the repository and give your agent [AGENTS.md](AGENTS.md) and the [self-hosting guide](agents/self-hosting.md). ask it to host lanes in your cloudflare account.

you handle account sign-in, two-factor authentication and google consent. the agent handles the build, database, configuration and deployment. it can also handle google console configuration when you give it authorized browser access.

the default setup uses a worker, static assets, d1 and a `workers.dev` address. it is designed for the free plan; quotas can pause work. no custom domain or paid service is required by the application.

google oauth stays in testing mode. add every connected account to the project’s test users and reconnect when its seven-day authorization expires.

## a place for your tasks

- boards, lists, subtasks, notes, stars, labels, priorities and dependencies.
- kanban, stacked lists, a calendar, search and account-wide today and starred views.
- scheduled days, local times, repeat rules, personal templates and scheduled checklists.
- confirmed change history and visible progress for interrupted operations.
- file and google sheets import, csv and sheets export, account transfers and workspace archives.

google owns its task content. lanes owns the extra organization. an interrupted request stays visible; an uncertain create is not silently sent again.

the [specs](specs/index.md) define the behavior. the [guides](agents/index.md) explain its owners, boundaries and setup.

## work on lanes

use the node version in [.node-version](.node-version), then:

```sh
npm ci
npm run db:migrate
npm run dev
```

copy [.dev.vars.example](.dev.vars.example) to `.dev.vars` for local credentials. without valid owner configuration, the public client opens a setup screen and private endpoints stay closed.

```sh
npm run check
```

this runs formatting, type checking, import boundary checks, tests and the production build. local tests use real sqlite transactions behind the d1 interface. live google behavior and cloudflare limits need their own controlled checks.

read [contributing](agents/contributing.md) before changing a contract or opening a pull request.
