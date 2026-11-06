# website

## purpose

introduce lanes as an open-source, self-hosted workspace for google tasks. help a visitor understand the workspace and reach the repository's self-hosting guide. the public site is intended for `lanes.fatihguzel.dev`; a personal installation is separate.

## ownership

`website/` owns a static react entry, local presentation and motion, sample product demonstrations, a public github star link, and a maker footer. it shares the root dependency installation and imports no application, worker, database, session, or google credential code. application builds and deployments remain independent.

```text
website/
  index.html
  public/
  src/
    demo/
    github/
    main.tsx
  vite.config.ts
  tsconfig.json
```

styles, local behavior and tests stay beside the component that owns them. shared site tokens carry the existing dm sans font, warm neutral surfaces, green accents and tilted three-lane mark.

## experience

- the first screen contains the lanes identity, a concise google tasks introduction, and a clear self-hosting action.
- the upper right contains a working github repository link with its real star count. loading or failure never invents a count; the link remains usable.
- an explicitly labeled sample workspace demonstrates boards, lists, calendar, and reversible task completion without sign-in, provider calls or persisted visitor tasks.
- the page describes only capabilities in the product guide. installation copy states the selected cloudflare and google setup, including testing-mode reconnection and free-plan quotas where it discusses those choices.
- the footer credits fatih güzel and links to his website and the repository.
- motion follows user actions and one short entrance. reduced motion removes movement. content and useful links remain available without javascript.
- at 320px through wide desktop sizes, headings and controls remain readable and reachable. only an explicitly identified workspace canvas may scroll sideways.

## commands

from the repository root:

```sh
npm run website:dev
npm run website:typecheck
npm run website:build
npm run website:preview
npm test -- website/src
npm run check
```

## implementation

use the existing react, typescript, vite and vitest dependencies. use semantic html and native controls before abstractions. for example, a demo task uses `<button type="button" aria-pressed={completed}>` with a visible task name. colors and fonts come from site tokens; component styles remain local.

## verification

unit tests cover public github response validation and failures, and state changes shared by demo views. type checking and production builds verify the separate entry. browser checks cover the interactive preview, keyboard controls, responsive layout, reduced motion and github success/failure. full repository checks verify that the website does not break the application.

## boundaries

preserve the existing application and unrelated working-tree edits. keep sample data separate from real product claims. never include deployment credentials, connect visitor google accounts, or present the personal instance as a public hosted service. work on the `website` branch in small logical commits; publication, deployment and push are outside this change.
