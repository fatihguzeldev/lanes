# design

lanes keeps neutral surfaces, fine dividers, compact typography, and green accents for controls and selection. more screen space reveals more work; it does not enlarge every element.

## responsive layout

- the workspace navigation becomes a drawer at 768px and below. the toolbar reflows when its own available width cannot hold the title, search, and account controls. keep those controls available.
- a board is a horizontal canvas. columns fit the available canvas width on a narrow screen, with a small indication of the next column. keep horizontal scrolling inside that canvas.
- list views, forms, filters, and editor sections reflow within their containing surface. a narrow column can need the compact layout even on a large monitor.
- calendar time grids and comparison tables may have their own horizontal scroll region. their navigation and actions must remain reachable without scrolling to a distant edge.
- long titles, account addresses, errors, and imported values must wrap or truncate deliberately. a long value must not widen the page or cover an action.

## density and input

use the shared [layout tokens](../src/shared/styles/tokens.css) for workspace gutters, panel padding, controls, and fields. keep local component spacing beside its owner.

fine-pointer controls stay compact. coarse-pointer controls have at least a 44px target; an icon or checkbox can remain smaller inside it. text entry uses a 16px font with coarse input. do not make a control taller while leaving its clickable width too small.

hover can reveal secondary controls, but keyboard focus must reveal them too. touch users must not need hover. preserve visible keyboard focus and the quieter pointer focus return.

## constrained surfaces

menus stay anchored and fit inside the visible viewport. dialogs and detached panels keep their content and actions scrollable at short heights. account for display safe areas and viewport changes without replacing an open draft or submitted operation.

use [the visual viewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport) for floating surfaces: the visible area can shrink independently of the document layout when the keyboard opens or the page is zoomed.

loading placeholders use the same layout classes and control geometry as the content they replace. known labels and the retained account initial remain visible; unknown values use placeholders.

## verification

check narrow phones, tablets, desktop, and wide screens, including widths immediately around a changed layout threshold. include a short landscape viewport, coarse input, long content, open menus, nested controls, and unsent drafts. check both themes.

the document must not overflow horizontally. verify the intended scroll regions separately; hiding overflow on the page does not fix an oversized child. browser emulation verifies layout and pointer rules, not a physical device's keyboard or assistive technology.
