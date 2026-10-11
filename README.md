# design-toolkit

A minimal toolbar for dialing in design while vibe coding. Tweak text, radius, spacing and layout
right on your localhost page, then copy one prompt that tells Claude Code (or any coding agent) to
make the same changes in the source.

One file, [toolkit.js](toolkit.js), no dependencies, no build step. It lives in a shadow root, so it
never touches your page's styles.

Live demo: https://davidexo.github.io/design-toolkit/

## Install

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
| `T` | **Text**: click any copy and type, `↵` or `Esc` to leave the field |
| `R` | **Radius**: click any box, drag the corner handle, `↑` `↓` to step, `↵` or click the value to type |
| `S` | **Spacing**: click any element, drag its padding (green), margin (orange) or gap (purple) bands, click a number to type |
| `V` | **Move**: drag an element into any container (flow), or anywhere with **Absolute** picked from its chevron menu; arrows reorder (flow) or nudge (absolute) |

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

**Panel.** While Radius or Spacing has a selection, a panel on the right shows the element and its
Radius, Gap, Padding (horizontal and vertical, or all four sides via the corner button) and Margin.
Type a value, step with `↑` `↓`, `Tab` between fields, or drag a field's label to scrub, like Figma's
design sidebar.

**Use design tokens** (in the Copy prompt chevron menu). On (default): Claude maps values to your existing design tokens, rounding to the
nearest one. Off: exact values, even if no token exists yet. Remembered per browser.

**Move.** Flow is the default: drag an element and a blue line shows the slot it will take in the
container under your pointer, like Figma's auto layout. On drop the page reflows as if the change were
made, and the prompt is plain: "reorder: position 4 → 1 of 7 in div.chips" or "move out of div.chips
(position 15 of 16) into section.hero at position 3 of 4 (after the h1, before the p)". Arrow keys step
it one slot. Claude is told to change the JSX order or parent, never to position it absolutely.

Turn on **Absolute** to drag anywhere instead. The element floats above everything, a dashed
placeholder keeps its old spot, and the prompt asks for position: absolute inside the container it
landed in, with offsets. With **Screenshot** on, Copy prompt first grabs this tab (Chrome asks you to
share it), crops to where things moved from and to, and copies that image. Each absolute move gets its own
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
