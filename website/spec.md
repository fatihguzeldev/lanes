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

the page uses an open, light sage surface. forest green marks the identity, primary actions and selection. the workspace keeps the application's neutral surfaces and readable text scale.

## experience

- public copy is lowercase, including sample content, accessible names and metadata. preserve the exact case of filenames, commands and identifiers where it affects their meaning.

- the hero pairs a short google tasks introduction and self-hosting action with one interactive workspace. on wide screens they sit side by side; when the workspace would become too narrow, they stack. preserve readable product text rather than shrinking the interface.
- the upper right contains a working github repository link with its real star count. loading or failure never invents a count; the link remains usable.
- the hero's workspace is the only product scene. it demonstrates boards, grouped lists, calendar, task details and account separation through local fixtures. do not repeat it in feature cards or separate task and account previews below the hero.
- each fixture account has two lists and three tasks: one rich focal task and two simple tasks. the focal card shows notes, schedule, labels and an expanded checklist immediately; its editor starts closed. cards, stars, labels, completed groups and account organization follow the current application components. never add invented product copy or controls that cannot perform their shown action.
- board, list and calendar are selected through three showcase buttons above the preview, outside the application frame. selected, hover and keyboard-focus states stay distinct; do not add an internal layout dropdown.
- at a preview width of 768px or less, workspace navigation opens in a contained drawer and search replaces the toolbar contents without adding another row. the preview's width owns this transition, independently of the page viewport. escape and the visible back control close search; a query survives resizing. closing the drawer restores focus to its trigger.
- the toolbar's avatar opens the application's account-menu treatment with two sample accounts. switching accounts changes the board, lists and tasks together. edits and completion state remain separate for each account and survive switching away and back. the preview never connects a visitor's google account.
- opening a task replaces its card contents with the application's inline editor. labels use a searchable anchored picker; priority uses its own menu. metadata stays in a draft until save, while task and checklist completion apply immediately through the existing completion rules. omit unsupported management and recurrence controls.
- closing a dirty editor or changing the task, account, view, scope or query asks whether to discard its draft. keeping the draft preserves the current editor and selection. page clicks, scrolling and touch pans do not dismiss the editor or open a draft confirmation. explicit close, cancel and save return to the same card; the focal checklist remains expanded.
- the preview shares the hero with the introduction, so navigation does not repeat a link to it. the github link and hero action have distinct hover and keyboard-focus states. omit captions, sample notices, progress summaries and account-selection instructions that repeat what the interface already shows.
- the page describes only capabilities in the product guide. setup requirements, oauth expiry, quotas and licensing details remain in the linked repository guides rather than the public introduction.
- the hero action opens installation in a native dialog, rather than repeating the hero's composition in another page section. the dialog provides the clone command, a separately copyable coding-agent prompt and a setup-guide link. escape or its close button returns focus to the action that opened it. copy confirmations persist while the dialog remains mounted; failures remain truthful and retryable. the prompt is static text, not an ai request form.
- the footer is a quiet maker credit linking to fatih güzel's website. the header owns the repository link and star count.
- motion follows user actions and respects reduced motion. do not use autoplay, scroll-driven state or animated height changes to demonstrate the product. content and useful links remain available without javascript.
- at 320px through wide desktop sizes, headings and controls remain readable and reachable. only an explicitly identified workspace canvas may scroll sideways.
- compact board columns leave a glimpse of the next column. list layout reflows without horizontal scrolling; calendar scrolling stays inside its canvas. preview actions provide 44px touch targets on devices with a coarse pointer, including hybrid inputs; text-entry fields use at least 16px text there.
- the calendar opens with the current demo day visible inside its own scroller. it does not scroll the page or reset the visitor's position during a resize.

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

use the existing react, typescript, vite and vitest dependencies. use semantic html and native controls before abstractions. for example, a demo task uses a labelled `<input type="checkbox" checked={completed}>` with a visible task name. colors and fonts come from site tokens; component styles remain local.

## verification

unit tests cover public github response validation and failures, clipboard payloads and failures, account-separated task changes, editor drafts and navigation guards. type checking and production builds verify the separate entry. browser checks cover the interactive preview, clipboard confirmation, keyboard controls, responsive layout and reduced motion. compare product treatments against their owning application source before claiming fidelity. full repository checks verify that the website does not break the application.

for compact search, enter a query in a wide preview, move focus away, resize the preview below 769px, then clear and replace the query. the input must remain visible and focused while editing; closing search returns focus to its trigger. check this when the preview is a narrow hero column on a wide page as well as on a narrow viewport.

edit and complete tasks in each account, switch away and return, and verify that changes remain with their account. open a dirty editor and attempt account, view, scope and query changes; keeping the draft must preserve its context, and discarding must perform the requested navigation.

## boundaries

preserve the existing application and unrelated working-tree edits. keep sample data separate from real product claims. never include deployment credentials, connect visitor google accounts, or present the personal instance as a public hosted service. work on the `website` branch in small logical commits; publication, deployment and push are outside this change.
