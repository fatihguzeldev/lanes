# website

the public introduction to lanes. this static site has its own browser entry, styles, assets, and build. it shares the root package dependencies; it does not import the workspace application or use its worker, database, sessions, or google credentials.

## development

run these commands from the repository root after `npm ci`:

```sh
npm run website:dev
npm run website:build
npm run website:preview
```

development uses `http://127.0.0.1:5174`; preview serves the production build at `http://127.0.0.1:4174`. check the port before starting either process and reuse an existing matching server.

`npm run website:typecheck` checks the site's types. `npm run website:test` runs its focused behavior tests. `npm run website:build` runs the type check and writes the static output to ignored `website/dist/`. `npm run check` validates both the application and the website.

## ownership

`src/` owns the introduction, product demonstrations, github link, and maker footer. demonstrations use sample content and do not access a visitor's tasks. `public/` contains the site's independently served assets, including the existing lanes mark and licensed dm sans font.

the site and personal lanes instance deploy independently. the application never serves or deploys the website output. full repository checks build both entries, including checks run before an application deployment. the website needs only its static build output; it does not need the application's private deployment configuration.

## deployment

`lanes.fatihguzel.dev` uses the `lanes-website` cloudflare pages project, connected to `fatihguzeldev/lanes` through cloudflare's github integration.

| setting           | value                   |
| ----------------- | ----------------------- |
| production branch | `main`                  |
| root directory    | repository root         |
| build command     | `npm run website:build` |
| output directory  | `website/dist`          |
| node version      | `.node-version`         |

pushes to `main` trigger the pages build and deployment. deployment settings live in cloudflare; github actions runs repository checks without a cloudflare deployment token. do not select the application's `build:cloudflare` command or deploy its root wrangler configuration for this project.

see [the website spec](spec.md) for behavior and acceptance criteria.
