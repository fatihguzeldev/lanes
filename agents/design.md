# design

lanes keeps neutral surfaces, fine dividers, compact typography, and green accents for controls and selection. more screen space reveals more work; it does not enlarge every element.

## responsive layout

- the workspace navigation becomes a drawer at 768px and below. use one compact toolbar row there: navigation, the current view, search, and account. opening search replaces that row's contents; it does not add a row.
- on a narrow screen, the current view's title opens layout, sort, filters, and board options. keep an active filter visible on that trigger. navigation holds manual sync, the theme toggle, and settings; the toolbar shows sync while it is working or needs attention.
- above the drawer threshold, the toolbar reflows when its own available width cannot hold the title, search, and account controls. choose layout changes when content needs them; pointer capability changes target sizes, not which controls are available.
- when a desktop toolbar has room, center the search field on the full window, including navigation. scope and view controls sit to its right without moving or shrinking the field when a query appears. the loading shell uses the same geometry.
- a board is a horizontal canvas. columns fit the available canvas width on a narrow screen, with a small indication of the next column. keep horizontal scrolling inside that canvas.
- list views, forms, filters, and editor sections reflow within their containing surface. a narrow column can need the compact layout even on a large monitor.
- calendar time grids and comparison tables may have their own horizontal scroll region. their navigation and actions must remain reachable without scrolling to a distant edge.
- long titles, account addresses, errors, and imported values must wrap or truncate deliberately. a long value must not widen the page or cover an action.

## density and input

use the shared [layout tokens](../src/shared/styles/tokens.css) for workspace gutters, panel padding, controls, and fields. keep local component spacing beside its owner.

fine-pointer controls stay compact. coarse-pointer controls have at least a 44px target; an icon or checkbox can remain smaller inside it. text entry uses a 16px font with coarse input. do not make a control taller while leaving its clickable width too small.

hover can reveal secondary controls, but keyboard focus must reveal them too. touch users must not need hover. preserve visible keyboard focus and the quieter pointer focus return.

inline board, list, and task creation use flat name fields in place. use the accent for their focus underline; avoid a second input box inside a row. task text keeps its color on hover, and close icons do not need a separate hover tile. icon-only editor actions show a tooltip on hover and keyboard focus, except the direct star control.

the shared `Icon` owns glyph strokes. board and list type icons use an 18px glyph in a 20px slot in navigation and list headings, including inline creation. keep their backgrounds transparent. size these glyphs explicitly rather than overriding their svg dimensions in local css; keep tool styling independent of tooltip wrappers.

single-value edits use inline fields or anchored pickers. colors and emoji show the selected value and save on selection; names and custom image urls save on enter or blur. do not collect these edits behind a shared save button. preview immediate changes and restore confirmed values if saving fails. keep submitted writes alive when their menu closes.

use anchored menus for navigation and destination choices. reserve modal confirmations for destructive changes, account access, unsaved drafts, and multi-step operations that need review. an html form for keyboard submission does not require a separate dialog or approval button.

## constrained surfaces

menus stay anchored and fit inside the visible viewport. dialogs and detached panels keep their content and actions scrollable at short heights. account for display safe areas and viewport changes without replacing an open draft or submitted operation.

destination submenus open to the side on hover and remain reachable across the pointer gap. keyboard and touch expose the same choices; a narrow touch submenu needs a visible way back. outside clicks close the current transient surface, through its owner's draft or pending-work rules.

use [the visual viewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport) for floating surfaces: the visible area can shrink independently of the document layout when the keyboard opens or the page is zoomed.

loading placeholders use the same layout classes and control geometry as the content they replace. known labels, type and action icons, and the retained account initial remain visible; unknown names and counts use placeholders. custom emoji and colors can appear when their metadata arrives; the generic type icon does not need to become a placeholder while waiting.

search uses one input across screen sizes. closing it clears the query through the existing draft guard. keep a pending query visible if the owner cancels that confirmation. settings presentations share one save controller across navigation and toolbar layouts.

## verification

check narrow phones, tablets, desktop, and wide screens, including widths immediately around a changed layout threshold. include a short landscape viewport, coarse input, long content, open menus, nested controls, and unsent drafts. check both themes.

the document must not overflow horizontally. verify the intended scroll regions separately; hiding overflow on the page does not fix an oversized child. browser emulation verifies layout and pointer rules, not a physical device's keyboard or assistive technology.
