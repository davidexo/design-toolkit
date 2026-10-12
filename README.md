# design-toolkit

A minimal toolbar for dialing in design while vibe coding. Tweak text, radius, spacing and layout
right on your localhost page, then copy one prompt that tells Claude Code (or any coding agent) to
make the same changes in the source.

One file, [toolkit.js](toolkit.js), no dependencies, no build step. It lives in a shadow root, so it
never touches your page's styles.

Live demo: https://davidexo.github.io/design-toolkit/

## Install

Easiest: paste this into your coding agent and let it set things up.

```
Set up design-toolkit (https://www.npmjs.com/package/design-toolkit) in this project:
1. Install it with the package manager this project already uses (check the lockfile).
2. In a React app (Next.js, Vite, Remix...), render <DesignToolkit /> from "design-toolkit/react" once in the root layout. Otherwise, import "design-toolkit" in development only.
3. Change nothing else. Then start or reload the dev server and confirm the toolbar shows at the bottom of the page.
```

By hand:

```bash
npm install design-toolkit
```

Then render it once, in your root layout (it only runs in development):

```tsx
import { DesignToolkit } from "design-toolkit/react";

<DesignToolkit />
```

Not using React? `import "design-toolkit"` in development only. Or skip the install and add
`<script src="https://cdn.jsdelivr.net/gh/davidexo/design-toolkit@main/toolkit.js" async></script>`
to your dev page.

## Tools

| Key | Tool |
| --- | --- |
| `T` | **Text**: click any copy and type, `↵` or `Esc` to leave the field. Double-click text with Move, Radius or Spacing on to jump straight into Text |
| `S` | **Spacing**: click any element, drag its padding (green), margin (orange) or gap (purple) bands, click a number to type |
| `V` | **Select**: click anything to select it (the toolkit opens on Select), drag its corner handle to change the radius, drag it into any container to reorder or re-parent; arrows reorder. A **Layers** tree shows top left while something is selected |
| `M` | **Move**: place anything freely; the prompt asks for position: absolute, with an annotated screenshot of the page |
| `C` | **Comment**: click any element, or select some text, and type a note; `↵` adds it, `⇧↵` for a new line. Numbered pins mark each comment, click one to edit or delete it |

Everything snaps to a 2px grid, typed values included (13 becomes 14).

| While tuning | Does |
| --- | --- |
| `⇧` with arrows | step by 10 |
| `⌥` (Radius) or `⌘` (both) | ignore the grid, 1px values |
| `⌥` drag (Spacing) | change the opposite side too, like Figma |
| `⌥⇧` drag (Spacing) | change all four sides |
| `⇧↵` while typing a spacing value | apply it to all four sides |
| `↵` / `⇧↵` / `⇥` / `⇧⇥` (Spacing) | select first child / parent / next / previous sibling |
| `Esc` | deselect, then leave the tool |

**Panel.** While Move, Radius or Spacing is on, a panel docks on the right (the page moves over to make room) and shows the selected element and its
Radius, Gap, Padding (horizontal and vertical, or all four sides via the corner button), Margin, Fill and Border
(width and colour; click a swatch to unfold PERMANENT ui's colour picker with presets, a saturation/brightness field, a hue strip, hex and an eyedropper, or type hex, rgba or none in the field).
Type a value, step with `↑` `↓`, `Tab` between fields, or drag a field's label to scrub, like Figma's
design sidebar.

**Use design tokens** (the corner wedge on Copy prompt). On (default): Claude maps values to your existing design tokens, rounding to the
nearest one. Off: exact values, even if no token exists yet. Remembered per browser.

**Appearance** (same menu). Dark (default), Light, or Auto to follow the system. Remembered per browser.

**Add to Figma.** The side panel ends with an **Add to Figma** button for the selected element. It copies a prompt that tells your agent to capture that element into Figma with the Figma MCP server (generate_figma_design), as editable layers.

**Undo.** `⌘Z` undoes the last toolkit action (a drag, a typed value, a text edit, a delete, a comment) and `⌘⇧Z` redoes it. While you type in a field it is the field's own undo; with nothing to undo the keys reach your app.

**Selection** works like Figma's canvas: a click picks at the current depth (first an outer container, then the
selection's siblings), clicking the selection again goes one level in, and `⌘`-click goes straight to the innermost
element. `⇧`-click adds or removes; `↵` selects all children, `⇧↵` all parents. Panel edits, the corner handle and
Delete apply to everything selected. `⇥` / `⇧⇥` step to the next / previous sibling.

**Layers** (top left, while Select has a selection) works like Figma's: click selects, `⌘`-click adds or removes, `⇧`-click selects a range, `⌥`-click an arrow opens or closes the whole branch, `⌥L` collapses everything but the path to the selection. Icons show column, row and grid layouts. The selection stays when you switch tools, and the side panel shows while
something is selected.

**Options.** Tools with a corner wedge (Move, Copy prompt) open their options from the wedge, a right-click, or a long press.

**Move the toolbar** by dragging it from anywhere, buttons included (a press that barely moves is still a click); double-click its frame to put it back. **×** collapses it to a **+**; click it (or press a tool key) to open it again. Both are remembered per browser.

**Move.** Flow is the default: drag an element and a blue line shows the slot it will take in the
container under your pointer, like Figma's auto layout. On drop the page reflows as if the change were
made, and the prompt is plain: "reorder: position 4 → 1 of 7 in div.chips" or "move out of div.chips
(position 15 of 16) into section.hero at position 3 of 4 (after the h1, before the p)". Arrow keys step
it one slot. Claude is told to change the JSX order or parent, never to position it absolutely. Press `Delete` (or `⌫`) to remove the selected element; the prompt asks for it to be deleted, from the shared template if it repeats.

Turn on **Absolute** to drag anywhere instead. The element floats above everything, a dashed
placeholder keeps its old spot, and the prompt asks for position: absolute inside the container it
landed in, with offsets. Copy prompt always takes a screenshot of the whole visible page first (Chrome
asks you to share the tab), adds a line per move underneath ("Move 1: move the orange-marked element to its new position.") and copies that image. Each absolute move gets its own
colour (orange, pink, green, ...): its placeholder and outline use it on the page, and in the screenshot a
matching arrow joins "Move N · from" to "Move N". The prompt names each move by number and colour. Paste it, then
⌘↵ again for the text. Screen capture does not work in embedded previews such as the Claude app's
browser pane; there you get the prompt only.

After you copy, moved elements go back, so the next thing you see is Claude's real change.

**Deleting text** is an edit too: the prompt asks Claude to remove it (and the element if it only held that text).

**Copy prompt** (`⌘↵`) puts every edit in one prompt: before and after, the element, its DOM path and
the nearest React component names. Claude is told you are tuning the component, so it changes the
shared rule (every chip, every card) unless the element is clearly a one-off. Revert puts every edit back.

While a tool is on, clicks never reach the page, so links and buttons stay put. Edited elements get a
dashed outline until you copy. After copying, the page keeps showing your values until Claude's
change hot-reloads; reload the page to clear them if you discard the prompt.

## How it works

Every tool edits the live page only (inline styles, a styled copy for moves, contenteditable for
text), so nothing is saved until an agent changes the source. The prompt carries what an agent needs
to find the code: before and after values, the element, its DOM path, CSS module class names and the
nearest React component names (read from React's dev-build fiber, when present).
