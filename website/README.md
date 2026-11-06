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

the site and personal lanes instance deploy independently. building or deploying the workspace application does not build or serve the website. the website needs only its static build output; it does not need the application's private deployment configuration.

see [the website spec](spec.md) for behavior and acceptance criteria.
