# website

## purpose

introduce lanes as an open-source, self-hosted workspace for google tasks. help a visitor understand the product and reach the repository's self-hosting guide. the public site is intended for `lanes.fatihguzel.dev`; the personal installation is separate and is never linked as a public service.

## ownership

`website/` owns a static react entry, presentation, local product demonstrations, the public github star link and maker footer. it shares the root dependency installation and imports no application, worker, database, session or google credential code. application builds and deployments remain independent.

styles, behavior and tests stay beside their owner. shared site tokens carry dm sans, the existing tilted three-lane mark, forest green and a light sage ground. product previews keep lanes' neutral surfaces, compact type, icons, colored labels and inline editing treatment.

the html head loads the global stylesheet before first paint. the react root starts empty; the text fallback belongs in `noscript` so it cannot flash before the application mounts. component styles stay with their components.

## page

- public copy is lowercase, including accessible names and metadata. preserve the case of filenames, commands and identifiers where it affects their meaning. the browser title is `lanes`.
- a forest-green header and hero form one continuous field. the header contains the existing mark and a working github link with its real star count. loading and failure never invent a count.
- the hero pairs the google tasks headline with a short description and `make it yours`. the workspace spans the content width beneath them. do not shrink a full workspace into a small illustration beside the headline.
- the hero preview contains board, list and calendar views, search and navigation. it shows the personal board with three lists and seven tasks, including completed tasks. there is no account avatar or account switching in this preview. the desktop search field is centered across the full preview, including navigation; the title and search reflow before they overlap. three controls above the frame select the view. no internal layout dropdown, fake cursor, autoplay, replay control or floating text snapshots.
- `a task is rarely just a title.` introduces a focused task close-up. its rich card shows notes, schedule, colored labels, priority, star and an expanded checklist. opening it uses the same inline editor as the hero. other local tasks remain available as dependency candidates.
- `each account in its own lane.` introduces a wider account workspace. two explicit `personal` and `work` buttons switch the board, lists and tasks together. the selected button uses `aria-pressed`, and choosing the already-selected account preserves its editor. there is no avatar menu. each account has two lists and four tasks. the task close-up and account workspace have different compositions; do not squeeze them into equal feature cards.
- each demonstration owns its state. editing or completing something in one preview does not change another. account changes remain with their account and survive switching away and back.
- `make it yours` links to `#self-host` in the same page. the setup section shares the hero's forest-green field. its heading, cloudflare description and setup-guide link sit on the left; a dark clone terminal and a separately copyable static coding-agent prompt sit on the right. the prompt establishes neutral text and copy-button colors on its light surface. it is normal document content, not a dialog. copy confirmations persist and failures remain truthful and retryable.
- the footer places the lanes mark on the left, the maker credit in the center and `source on github` on the right. it stacks in document order on small screens. omit sample notices, licensing and oauth explanations, progress summaries and redundant instructions. setup details remain in the linked guide.

## product interactions

- task cards, stars, labels, list headers and completed groups follow their owning application sources. the account showcase uses the explicitly requested personal/work controls. only expose controls with implemented behavior.
- opening a task replaces its card with the inline editor. metadata stays in a draft until save; task and checklist completion apply immediately through existing completion rules. omit unsupported recurrence and management controls.
- closing a dirty editor or changing its task, account, view, scope or query asks whether to discard its draft. keeping it preserves its owner, editor and selection. page clicks, scrolling and touch pans do not dismiss it or open confirmation.
- each preview scopes focus restoration to itself. removing a focused task from an open list returns focus to its visible checkbox, completed group or list. a draft dialog never focuses another preview's editor. product dialogs establish their own neutral color tokens even inside the dark hero.
- preserve visible keyboard focus and quiet pointer focus. hover is distinct on github, primary actions, copy controls and view choices. motion only accompanies user actions; reduced motion disables nonessential transitions and smooth scrolling.

## responsive behavior

- support 320px through wide desktop without document-level horizontal overflow. only an identified workspace canvas may scroll sideways.
- at a hero preview width of 768px or less, navigation becomes a contained drawer and search replaces the compact toolbar rather than adding a row. closing the drawer or search restores focus. a query survives resizing.
- board columns fit the canvas on wide screens and leave a glimpse of the next column on narrow screens. lists and forms reflow; calendar scrolling stays inside its canvas and opens with the current demo day visible.
- feature close-ups stack when their content needs space. preserve readable product text and controls rather than scaling the interface. setup switches to a single column when its two tracks no longer fit; commands and prompt text wrap inside their container.
- coarse-pointer targets are at least 44px and editable text is at least 16px. menus stay inside the visible viewport. short viewports retain access to every action through local scrolling.

## commands

from the repository root:

```sh
npm run website:dev
npm run website:typecheck
npm run website:test
npm run website:build
npm run check
```

check the expected port before starting a process and reuse a matching server.

## verification

focused tests cover github validation, clipboard behavior, account isolation, task edits, completion and draft guards. type checking and production builds verify the separate entry. full repository checks verify that the website does not break the application.

browser checks cover manual views and search, the focused task's edit and completion flows, account switching and retained edits, draft cancellation with multiple previews open, the setup anchor and copy controls, responsive layout and reduced motion. compare product treatments with the current application source before claiming fidelity.

## boundaries

preserve unrelated working-tree changes and the existing application. fixtures never connect visitor google accounts. work on `website` in small logical commits. push, publication and deployment are outside this change.
