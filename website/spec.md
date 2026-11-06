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

the public site extends that palette with a forest-green opening and sage-tinted page surfaces. inverse text and focus colors keep its controls readable.

## experience

- public copy is lowercase, including sample content, accessible names and metadata. preserve the exact case of filenames, commands and identifiers where it affects their meaning.

- the first screen contains the lanes identity, a concise google tasks introduction, and a clear self-hosting action.
- the upper right contains a working github repository link with its real star count. loading or failure never invents a count; the link remains usable.
- the main workspace demonstrates boards, grouped lists, calendar and reversible task completion using local fixtures. its cards, stars, labels, completed groups and account organization follow the current application components. never add invented product copy or controls that cannot perform their shown action.
- board, list and calendar are selected through three showcase buttons above the preview, outside the application frame. selected, hover and keyboard-focus states stay distinct; do not add an internal layout dropdown.
- the preview immediately follows the introduction, so navigation does not repeat a link to it. keep the header's installation link and github link bright against the green surface, with distinct hover and keyboard-focus states.
- product sections show task customization and account separation through usable product surfaces. place each section's short supporting copy with its heading. omit captions, sample notices, progress summaries and account-selection instructions that repeat what the interface already shows.
- task customization uses the application's inline editing arrangement: the selected card's contents are replaced by its editor, with other tasks above or below. never present a permanent split-pane inspector. labels use a searchable anchored picker; priority uses its own menu. metadata stays in a draft until save, while task and checklist completion apply immediately. cancel protects unsaved changes. the showcase uses local fixtures and omits unsupported management and recurrence controls.
- the page describes only capabilities in the product guide. setup requirements, oauth expiry, quotas and licensing details remain in the linked repository guides rather than the public introduction.
- installation provides the clone command and a separately copyable coding-agent prompt. copying one must not copy the other. confirmation persists until the next copy action; failures remain truthful and retryable. the prompt is not an ai request form.
- the footer credits fatih güzel and links to his website and the repository.
- motion follows user actions and respects reduced motion. scripted preview choreography is a separate design decision. content and useful links remain available without javascript.
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

use the existing react, typescript, vite and vitest dependencies. use semantic html and native controls before abstractions. for example, a demo task uses a labelled `<input type="checkbox" checked={completed}>` with a visible task name. colors and fonts come from site tokens; component styles remain local.

## verification

unit tests cover public github response validation and failures, clipboard payloads and failures, and state changes shared by demo views. type checking and production builds verify the separate entry. browser checks cover the interactive preview, clipboard confirmation, keyboard controls, responsive layout and reduced motion. compare product treatments against their owning application source before claiming fidelity. full repository checks verify that the website does not break the application.

## boundaries

preserve the existing application and unrelated working-tree edits. keep sample data separate from real product claims. never include deployment credentials, connect visitor google accounts, or present the personal instance as a public hosted service. work on the `website` branch in small logical commits; publication, deployment and push are outside this change.
