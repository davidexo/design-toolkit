/* design-toolkit (github.com/davidexo/design-toolkit). Load it on any localhost page by script tag or bookmarklet.

   Tweak the design right on the page, then ⌘↵ (or Copy prompt) puts a ready-made prompt on the clipboard
   for Claude Code to make the same changes in the source.

   T  Text     click any copy and type.
   R  Radius   click any box, drag the corner handle, use the arrow keys or click the value to type one.
   S  Spacing  click any element, drag its padding, margin or gap bands, or click a value to type one.
   V  Move     drag any element anywhere; the prompt explains the move in layout terms (new container,
               new order, neighbours, alignment, overlap) so Claude can turn it into real layout.
   C  Comment  click any element (or select some text) and leave a note in your own words.

   Values snap to a 2px grid. Radius: ⌥ (or ⌘) for 1px values. Spacing uses Figma's keys: ⌥ drags the
   opposite side too, ⌥⇧ all four sides, ⌘ ignores the grid. ↵ child, ⇧↵ parent, ⇥ ⇧⇥ siblings.
   Plain JS, no dependencies, UI lives in a shadow root so it never fights the page. */

(() => {
  /* Server rendering imports this too (Next.js, Remix): only run in a browser, and only once. */
  if (typeof window === "undefined" || window.__permanentToolkit) return;
  window.__permanentToolkit = true;

  const GRID = 2;
  const BLUE = "#0a84ff";
  const PAD = "#30d158";
  const MARGIN = "#ff9f0a";
  const GAP = "#bf5af2";
  /* One colour per absolute move, so page, screenshot and prompt all point at the same element. Blue stays the UI's. */
  const MOVE_COLORS = [
    ["orange", "#ff9f0a"],
    ["pink", "#ff375f"],
    ["green", "#30d158"],
    ["purple", "#bf5af2"],
    ["cyan", "#64d2ff"],
    ["yellow", "#ffd60a"],
  ];
  const SIDES = ["top", "right", "bottom", "left"];

  /* ---------- state ---------- */

  let tool = null; // null | "text" | "radius" | "spacing"
  let status = "idle"; // idle | done | error
  let message = "";
  /* On: Claude maps every value onto the project's existing tokens. Off: the exact value wins, even
     when no token exists for it yet. Remembered per browser. */
  let useTokens = true;
  try {
    useTokens = localStorage.getItem("ptk-tokens") !== "off";
  } catch {}
  /* Toolbar appearance: dark (default), light, or auto to follow the system. Remembered per browser. */
  let theme = "dark";
  try {
    theme = ["light", "auto"].includes(localStorage.getItem("ptk-theme")) ? localStorage.getItem("ptk-theme") : "dark";
  } catch {}

  let editing = null; // text: element currently contenteditable
  const textEdits = new Map(); // element -> { before, shown, after, tag, path, components, snapshot }
  /* Values as they first rendered. A copied edit is still on screen, so the next edit of the same
     element must still say what the source holds, not what the page shows now. */
  const originalText = new WeakMap();
  const originalNodeText = new WeakMap(); // text node -> its value as it first rendered

  let hovered = null; // radius + spacing: element under the pointer
  let selected = null; // radius + spacing: element being tuned
  let drag = null; // a drag in progress, see the handle and band handlers
  let field = null; // { input, el, read, step, apply } while you type a value
  let hoverBand = null; // spacing: band under the pointer, so its 0 label can show

  const radiusEdits = new Map(); // element -> { before, shown, after, full, inline, tag, path, components }
  const originalRadius = new WeakMap();
  const spaceEdits = new Map(); // element -> { props: Map(prop -> { before, shown, after, inline }), tag, path, components }
  const originalSpace = new WeakMap();

  const moveEdits = new Map(); // element -> { dx, dy, base, inline, from, ...describe }

  /* Comments are notes, not values: several can sit on one element, so they are a list. */
  const comments = []; // { n, el, text, quote, tag, path, components }
  let composing = null; // { el, quote, comment? } while the note box is open

  const styleEdits = new Map(); // element -> { props: Map(prop -> { before, shown, after, inline }), tag, path, components }: fill and border
  const originalStyle = new WeakMap();
  const removeEdits = new Map(); // element -> { display, twins, tag, path, components }: deleted with the Move tool
  const count = () => textEdits.size + radiusEdits.size + spaceEdits.size + styleEdits.size + moveEdits.size + removeEdits.size + comments.length;
  const boxTool = () => tool === "radius" || tool === "spacing" || tool === "move" || tool === "comment";

  /* ---------- page styles (attributes only, so React keeps owning the DOM) ---------- */

  const pageStyle = document.createElement("style");
  pageStyle.textContent = `
    html[data-ptk-tool="text"] body *:not([data-ptk-host]) { cursor: text !important; }
    html[data-ptk-tool="radius"] body *:not([data-ptk-host]),
    html[data-ptk-tool="spacing"] body *:not([data-ptk-host]),
    html[data-ptk-tool="move"] body *:not([data-ptk-host]) { cursor: default !important; }
    html[data-ptk-tool="comment"] body *:not([data-ptk-host]) { cursor: crosshair !important; }
    html[data-ptk-tool="comment"] body *:not([data-ptk-host])::selection { background: rgba(255, 214, 10, .45); }
    [data-ptk-editing] { outline: 1.5px solid ${BLUE} !important; outline-offset: 3px; caret-color: ${BLUE}; }
    [data-ptk-edited]:not([data-ptk-editing]) { outline: 1.5px dashed ${BLUE} !important; outline-offset: 3px; }
  `;
  document.head.appendChild(pageStyle);

  try {
    const face = new FontFace("PTK Camera", "url(https://permanent.is/fonts/ABCCameraPlainVariable.woff2)", { weight: "100 900" });
    face.load().then((f) => document.fonts.add(f)).catch(() => {});
  } catch {}

  /* ---------- toolbar + overlay ---------- */

  const host = document.createElement("div");
  host.setAttribute("data-ptk-host", "");
  host.dataset.theme = theme;
  const root = host.attachShadow({ mode: "open" });

  /* Using the toolkit must never change the app's state: an open dropdown, popover or dialog has to stay
     open while you comment on it or tune it. So nothing the toolkit does reaches the page as an outside
     press or a focus change. */
  /* Presses on the toolbar keep focus where it was (only fields we type into take it). */
  root.addEventListener("mousedown", (e) => {
    if (!e.composedPath()[0].closest?.("input, textarea")) e.preventDefault();
  });
  /* Events from the toolkit stop at its host, so the page's outside-press and focus listeners never see them. */
  ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "touchstart", "touchend", "focusin", "focusout", "keydown", "keyup", "keypress", "input", "beforeinput"].forEach((t) =>
    host.addEventListener(t, (e) => e.stopPropagation()),
  );
  /* When a toolkit field takes focus, the app's element loses it. Hide that blur from the app (menus and
     focus traps close or steal focus back on it), and hand focus back when the field closes. */
  const intoToolkit = (e) => e.relatedTarget === host;
  window.addEventListener("focusout", (e) => intoToolkit(e) && e.stopPropagation(), true);
  window.addEventListener("blur", (e) => intoToolkit(e) && e.stopPropagation(), true);
  window.addEventListener("focusin", (e) => e.target === host && e.stopPropagation(), true);
  let appFocus = null; // the app's focused element before a toolkit field took focus
  const deepActive = () => {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };
  function focusField(input) {
    const a = deepActive();
    if (a && a !== host && !host.contains(a)) appFocus = a;
    input.focus({ preventScroll: true });
  }
  function giveFocusBack() {
    const a = appFocus;
    appFocus = null;
    if (a?.isConnected && document.activeElement === host) a.focus({ preventScroll: true });
  }
  root.innerHTML = `
    <style>
      :host { all: initial; }
      /* Dark by default. Light (or Auto on a light system) swaps the ink and the pane, nothing else:
         the page overlays (blue selection, bands, tags) read on any page as they are. */
      :host, :host([data-theme="dark"]) { --ink-rgb: 255, 255, 255; --elev-rgb: 38, 38, 38; --shadow-rgb: 0, 0, 0; --danger: #ff6961; }
      :host([data-theme="light"]) { --ink-rgb: 20, 20, 20; --elev-rgb: 252, 252, 252; --shadow-rgb: 0, 0, 0; --danger: #e5484d; }
      @media (prefers-color-scheme: light) {
        :host([data-theme="auto"]) { --ink-rgb: 20, 20, 20; --elev-rgb: 252, 252, 252; --shadow-rgb: 0, 0, 0; --danger: #e5484d; }
      }
      * { box-sizing: border-box; }
      .tag, .lb {
        font: 460 13px/1 "PTK Camera", ui-sans-serif, system-ui, -apple-system, sans-serif; letter-spacing: -0.0025em;
        -webkit-font-smoothing: antialiased; user-select: none;
      }
      /* Toolbar: PERMANENT ui's canvas-toolbar (bencho's bar family). 38px slots, 6px hug, 2px gap, a frosted
         pane, dimmed tools with a thumb that springs in under the chosen one, corner wedges for options.
         The pane is a little more opaque than the original because it floats over any page. */
      .bar, .menu {
        --rule: rgba(var(--ink-rgb), .1); --pick: #4c9df5;
        --slot: 38px; --pad: 6px; --gap: 2px; --r: 14px; --tool-r: 10px;
        font: 460 13px/1 "PTK Camera", ui-sans-serif, system-ui, -apple-system, sans-serif; letter-spacing: -0.0025em;
        -webkit-font-smoothing: antialiased; user-select: none; color: rgb(var(--ink-rgb));
        border-radius: var(--r); background: rgba(var(--elev-rgb), .8);
        -webkit-backdrop-filter: blur(12px) saturate(150%); backdrop-filter: blur(12px) saturate(150%); isolation: isolate;
        box-shadow: inset 0 1px 0 rgba(var(--ink-rgb), .06), 0 0 0 1px var(--rule), 0 10px 40px rgba(var(--shadow-rgb), .25);
      }
      .bar {
        position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 2147483647;
        display: flex; align-items: center; gap: var(--gap); padding: var(--pad);
        max-width: calc(100vw - 16px); overflow-x: auto; scrollbar-width: none;
      }
      /* Dragged somewhere: placed by its top-left corner (see placeBar). */
      .bar:not([data-placed]) { left: calc((100vw - var(--dock, 0px)) / 2); }
      .bar[data-placed] { transform: none; bottom: auto; }
      .bar { touch-action: none; } /* the whole bar drags, buttons included */
      .bar[data-dragging], .bar[data-dragging] * { cursor: grabbing !important; }
      .bar .close { width: 30px; }
      .bar .close > svg { width: 14px; height: 14px; }
      /* Collapsed: one + button that drags like the bar and opens it again. */
      .bar .expand { display: none; }
      .bar[data-collapsed] > :not(.expand) { display: none; }
      .bar[data-collapsed] .expand {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: var(--slot); height: var(--slot); padding: 0 10px;
        border-radius: var(--tool-r); color: rgb(var(--ink-rgb)); transition: background-color .2s;
      }
      .bar[data-collapsed] .expand:hover { background: rgba(var(--ink-rgb), .08); }
      /* The X turns into a + as the bar collapses, and back as it opens (display: none restarts each animation). */
      .bar .expand > svg { width: 16px; height: 16px; rotate: 45deg; animation: x-to-plus .4s cubic-bezier(.3, 1.42, .4, 1) both; }
      .bar .close > svg { animation: plus-to-x .4s cubic-bezier(.3, 1.42, .4, 1) both; }
      @keyframes x-to-plus { from { rotate: 0deg; } }
      @keyframes plus-to-x { from { rotate: 45deg; } }
      @media (prefers-reduced-motion: reduce) { .bar .expand > svg, .bar .close > svg { animation: none; } }
      .bar button, .menu button { all: unset; box-sizing: border-box; cursor: pointer; -webkit-tap-highlight-color: transparent; }
      .bar button:focus-visible, .menu button:focus-visible { outline: 2px solid var(--pick); outline-offset: 2px; }
      .bar .tool {
        position: relative; display: grid; place-items: center; flex: none; width: var(--slot); height: var(--slot);
        border-radius: var(--tool-r); color: rgb(var(--ink-rgb)); opacity: .45; transition: opacity .2s, background-color .2s;
      }
      .bar .tool:hover { opacity: .8; background: rgba(var(--ink-rgb), .05); }
      /* the thumb grows in under the chosen tool */
      .bar .tool::before {
        content: ""; position: absolute; inset: 0; z-index: 0; border-radius: inherit; background: rgba(var(--ink-rgb), .1);
        opacity: 0; scale: .72; pointer-events: none; transition: opacity .14s, scale .3s cubic-bezier(.3, 1.42, .4, 1);
      }
      .bar .tool > svg { position: relative; z-index: 1; width: 17px; height: 17px; transition: scale .3s cubic-bezier(.3, 1.42, .4, 1); }
      .bar .tool[aria-pressed="true"] { opacity: 1; }
      .bar .tool[aria-pressed="true"]::before { opacity: 1; scale: 1; }
      .bar .tool[aria-pressed="true"] > svg { scale: 1.05; }
      .bar .tool:active > svg { scale: .92; transition-duration: 90ms; }
      .slot { position: relative; display: inline-flex; flex: none; }
      /* a corner wedge, the universal "there is more here" */
      .bar .notch { position: absolute; right: 3px; bottom: 3px; width: 9px; height: 9px; z-index: 2; }
      .bar .notch::after {
        content: ""; position: absolute; right: 0; bottom: 0; border-left: 5px solid transparent; border-bottom: 5px solid rgb(var(--ink-rgb));
        opacity: .4; transition: opacity .16s;
      }
      .bar .notch:hover::after, .bar .notch[aria-expanded="true"]::after { opacity: .9; }
      .bar [data-needs-edits][hidden] { display: none; }
      .split { width: 1px; height: 20px; margin: 0 5px; flex: none; background: rgba(var(--ink-rgb), .12); }
      /* Copy prompt: the one action, so an icon button like the tools but filled in the accent, never dimmed once there is something to copy. */
      .bar .copy {
        position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: none;
        min-width: var(--slot); height: var(--slot); padding: 0 10px; border-radius: var(--tool-r); background: ${BLUE}; color: #fff;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, .22), 0 2px 8px rgba(10, 132, 255, .35);
        transition: background-color .2s, box-shadow .2s, color .2s, scale .3s cubic-bezier(.3, 1.42, .4, 1);
      }
      .bar .copy:has(.badge:not([hidden])) { padding: 0 13px 0 10px; } /* clear of the corner wedge */
      .bar .copy > svg { width: 18px; height: 18px; transition: scale .3s cubic-bezier(.3, 1.42, .4, 1); }
      .bar .copy:hover { background: #3a9bff; }
      .bar .copy:active { scale: .94; transition-duration: 90ms; }
      .bar .copy.done { background: #30d158; color: #fff; box-shadow: 0 2px 8px rgba(48, 209, 88, .35); }
      .bar .copy[aria-disabled="true"]:not(.done) { background: rgba(var(--ink-rgb), .08); color: rgba(var(--ink-rgb), .35); box-shadow: none; cursor: default; }
      .bar .copy + .notch::after { border-bottom-color: #fff; opacity: .55; }
      .bar .copy[aria-disabled="true"] + .notch::after { border-bottom-color: rgb(var(--ink-rgb)); opacity: .3; }
      /* edit count trails the icon, so the button grows a little when there is something to copy */
      .badge {
        font-size: 13px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums;
        animation: pop .3s cubic-bezier(.3, 1.42, .4, 1) both;
      }
      @keyframes pop { from { scale: .4; opacity: 0; } }
      .badge[hidden] { display: none; }
      svg { flex: none; }
      kbd { font: inherit; color: rgba(var(--ink-rgb), .5); }

      /* Options rise out of the bar like the shape flyout. */
      .menu { position: fixed; z-index: 2147483647; display: none; min-width: 236px; padding: var(--pad); animation: rise .3s cubic-bezier(.22, 1.14, .36, 1) both; }
      @keyframes rise {
        0% { opacity: 0; transform: translateY(9px) scale(.965); }
        55% { opacity: 1; }
        to { opacity: 1; transform: none; }
      }
      .menu .mh { padding: 6px 8px; font-size: 11px; color: rgba(var(--ink-rgb), .45); }
      .menu .mi { display: grid; grid-template-columns: 16px 1fr; column-gap: 8px; align-items: center; width: 100%; padding: 8px; border-radius: var(--tool-r); transition: background-color .15s; }
      .menu .mi:hover { background: rgba(var(--ink-rgb), .07); }
      .menu .mi svg { width: 14px; height: 14px; visibility: hidden; }
      .menu .mi[aria-checked="true"] svg { visibility: visible; }
      .menu .mi small { grid-column: 2; margin-top: 3px; font-size: 11px; color: rgba(var(--ink-rgb), .5); white-space: normal; line-height: 1.3; }
      .menu .mi[aria-disabled="true"] { opacity: .4; pointer-events: none; }
      /* Toggle card: label and hint on the left, a switch on the right. */
      .menu .tg { display: flex; align-items: center; gap: 16px; width: 100%; padding: 10px; border-radius: var(--tool-r); transition: background-color .15s; }
      .menu .tg:hover { background: rgba(var(--ink-rgb), .07); }
      .menu .tg-text { display: grid; gap: 4px; flex: 1; }
      .menu .tg small { font-size: 11px; color: rgba(var(--ink-rgb), .5); line-height: 1.3; }
      .menu .tg .sw { position: relative; flex: none; width: 30px; height: 18px; border-radius: 999px; background: rgba(var(--ink-rgb), .18); transition: background-color .2s; }
      .menu .tg .sw::after {
        content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff;
        box-shadow: 0 1px 2px rgba(0, 0, 0, .3); transition: translate .3s cubic-bezier(.3, 1.42, .4, 1);
      }
      .menu .tg[aria-checked="true"] .sw { background: var(--pick); }
      .menu .tg[aria-checked="true"] .sw::after { translate: 12px 0; }
      .menu hr { border: 0; height: 1px; margin: 6px 4px; background: rgba(var(--ink-rgb), .1); }
      .tip, .toast {
        position: fixed; z-index: 2147483647; display: none; color: rgb(var(--ink-rgb)); background: rgba(var(--elev-rgb), .92);
        font: 460 12px/1.2 "PTK Camera", ui-sans-serif, system-ui, -apple-system, sans-serif; -webkit-font-smoothing: antialiased;
        box-shadow: 0 0 0 1px rgba(var(--ink-rgb), .08), 0 10px 30px rgba(0, 0, 0, .3); pointer-events: none;
      }
      .tip { padding: 6px 8px; border-radius: 8px; white-space: nowrap; }
      .tip kbd { margin-left: 10px; }
      .toast { left: 50%; transform: translateX(-50%); padding: 8px 12px; border-radius: 10px; font-size: 13px; max-width: calc(100vw - 32px); text-align: center; }
      .toast.err { color: var(--danger); }
      @media (prefers-reduced-motion: reduce) { .menu { animation-duration: 1ms; } .bar .tool, .bar .tool::before, .bar .tool > svg, .bar .notch::after { transition-duration: 1ms; } }

      .box { position: fixed; z-index: 2147483645; pointer-events: none; display: none; }
      .box.hover { box-shadow: 0 0 0 1px ${BLUE}; }
      .box.sel { box-shadow: 0 0 0 1.5px ${BLUE}; }
      .handle {
        position: fixed; z-index: 2147483647; display: none; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%;
        background: #fff; box-shadow: 0 0 0 1.5px ${BLUE}, 0 1px 3px rgba(0,0,0,.3); cursor: nwse-resize; touch-action: none;
      }
      .handle:hover, .handle.drag { transform: scale(1.2); }
      .tag, .lb {
        position: fixed; z-index: 2147483647; display: none; color: #fff; font-size: 11px; font-variant-numeric: tabular-nums;
        white-space: nowrap; cursor: text;
      }
      .tag { padding: 4px 6px; border-radius: 6px; background: ${BLUE}; }
      .tag:hover { background: #2a93ff; }
      .tag .off { opacity: .7; }
      .tag input, .lb input {
        all: unset; width: 4ch; margin: -2px 0 -2px 2px; padding: 2px 3px; border-radius: 3px;
        background: rgba(255,255,255,.25); color: #fff; font: inherit; font-variant-numeric: tabular-nums;
      }
      .lb input { margin: -2px -2px; }

      .space { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; display: none; }
      .band { position: fixed; pointer-events: auto; touch-action: none; opacity: .22; transition: opacity .12s; }
      .band.zero { opacity: 0; }
      .band:hover, .band.drag { opacity: .45; }
      .band.zero:hover, .band.zero.drag { opacity: .3; }
      .band.v { cursor: ns-resize; }
      .band.h { cursor: ew-resize; }
      .band.padding { background: ${PAD}; }
      .band.margin { background: ${MARGIN}; }
      .band.gap { background: repeating-linear-gradient(45deg, ${GAP} 0 2px, transparent 2px 5px); opacity: .55; }
      .band.gap:hover, .band.gap.drag { opacity: .9; }
      .lb { padding: 2px 4px; border-radius: 4px; transform: translate(-50%, -50%); pointer-events: auto; }
      .lb.padding { background: #1f9e44; }
      .lb.margin { background: #c97700; }
      .lb.gap { background: #9a3fd0; }

      .box.drop { box-shadow: 0 0 0 1.5px ${GAP}; background: rgba(191,90,242,.06); z-index: 2147483644; }
      .ghost {
        position: fixed; z-index: 2147483644; pointer-events: none; display: none;
        outline: 1.5px dashed rgba(10,132,255,.8); outline-offset: -1px; background: repeating-linear-gradient(45deg, rgba(10,132,255,.12) 0 2px, transparent 2px 7px);
      }
      .mtag { position: fixed; z-index: 2147483647; display: none; padding: 4px 6px; border-radius: 6px; background: ${BLUE}; color: #fff; pointer-events: none;
        font: 460 11px/1 "PTK Camera", ui-sans-serif, system-ui, sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap; -webkit-font-smoothing: antialiased; }
      .mtag .into { opacity: .75; }
      .insert { position: fixed; z-index: 2147483646; display: none; pointer-events: none; border-radius: 2px; background: ${BLUE}; box-shadow: 0 0 0 1px rgba(255,255,255,.6); }

      .panel {
        /* A side panel docked to the right edge, like Figma's design panel. The page is pushed left to make room. */
        position: fixed; z-index: 2147483646; top: 0; right: 0; bottom: 0; width: 260px; display: none; padding: 4px 0 16px;
        background: rgb(var(--elev-rgb)); color: rgba(var(--ink-rgb), .9);
        box-shadow: inset 1px 0 0 rgba(var(--ink-rgb), .1);
        font: 460 12px/1 "PTK Camera", ui-sans-serif, system-ui, -apple-system, sans-serif; letter-spacing: -0.0025em;
        -webkit-font-smoothing: antialiased; user-select: none;
        overflow: auto; overscroll-behavior: contain;
      }
      /* Add to Figma: the panel's one action, full width at the bottom. */
      .panel section[data-sec="figma"] { padding-top: 16px; }
      .panel .addfig {
        all: unset; box-sizing: border-box; display: flex; align-items: center; justify-content: center; width: 100%; height: 32px;
        border-radius: 8px; cursor: pointer; background: rgb(var(--ink-rgb)); color: rgb(var(--elev-rgb)); font-weight: 520; font-size: 12px;
        transition: opacity .2s, transform .16s cubic-bezier(.23, 1, .32, 1);
      }
      .panel .addfig:hover { opacity: .88; }
      .panel .addfig:active { transform: scale(.98); }
      .panel .addfig:focus-visible { outline: 2px solid ${BLUE}; outline-offset: 2px; }
      .panel .hint { margin: 0; padding: 12px; color: rgba(var(--ink-rgb), .5); line-height: 1.4; }
      .panel[data-empty] section, .panel:not([data-empty]) .hint { display: none; }
      .panel header { padding: 10px 12px 8px; border-bottom: 1px solid rgba(var(--ink-rgb), .08); display: grid; gap: 4px; }
      .panel .el { color: rgba(var(--ink-rgb), .9); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .panel .comp { color: rgba(var(--ink-rgb), .4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .panel section { padding: 10px 12px 0; }
      .panel section[hidden] { display: none; }
      .panel h4 { all: unset; display: flex; align-items: center; justify-content: space-between; height: 20px; margin-bottom: 6px; color: rgba(var(--ink-rgb), .5); }
      .panel .row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .panel .row4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-top: 6px; }
      .panel .row4[hidden] { display: none; }
      .panel .row1 { display: grid; grid-template-columns: 1fr; }
      /* Colour fields: a swatch that opens the system picker, then the value as text (hex, rgba, none). */
      .panel .f.c .sw {
        position: relative; flex: none; width: 14px; height: 14px; border-radius: 4px; overflow: hidden; cursor: pointer;
        box-shadow: inset 0 0 0 1px rgba(var(--ink-rgb), .2);
        background-image: linear-gradient(var(--sw, transparent), var(--sw, transparent)), repeating-conic-gradient(rgba(var(--ink-rgb), .25) 0 25%, transparent 0 50%);
        background-size: auto, 6px 6px;
      }
      .panel .f.c .sw { all: unset; box-sizing: border-box; position: relative; flex: none; width: 14px; height: 14px; border-radius: 4px; cursor: pointer;
        box-shadow: inset 0 0 0 1px rgba(var(--ink-rgb), .2);
        background-image: linear-gradient(var(--sw, transparent), var(--sw, transparent)), repeating-conic-gradient(rgba(var(--ink-rgb), .25) 0 25%, transparent 0 50%);
        background-size: auto, 6px 6px; }
      .panel .f.c .sw:focus-visible { outline: 2px solid ${BLUE}; outline-offset: 2px; }
      .panel .f.c .sw[aria-expanded="true"] { box-shadow: 0 0 0 2px rgb(var(--elev-rgb)), 0 0 0 3px ${BLUE}; }

      /* PERMANENT ui's colour picker, unfolded in place under the field: presets, a saturation/brightness
         field, a hue strip, then hex and the eyedropper. Hue is kept while dragging through grey or black. */
      .cp { display: grid; gap: 12px; margin-top: 8px; padding: 10px; border-radius: 10px; background: rgba(var(--ink-rgb), .06);
        animation: cp-open .32s cubic-bezier(.23, 1, .32, 1) both; }
      @keyframes cp-open { from { opacity: 0; transform: translateY(-4px); } }
      .cp-presets { display: flex; justify-content: space-between; }
      .cp-preset { all: unset; position: relative; width: 18px; height: 18px; border-radius: 999px; background: var(--c); cursor: pointer;
        box-shadow: inset 0 0 0 1px rgba(var(--ink-rgb), .1); transition: scale .15s cubic-bezier(.23, 1, .32, 1); }
      .cp-preset[aria-checked="true"] { box-shadow: 0 0 0 2px rgb(var(--elev-rgb)), 0 0 0 4px var(--c); }
      .cp-preset:hover { scale: 1.12; }
      .cp-preset:active { scale: .96; }
      .cp-preset::before { content: ""; position: absolute; inset: -4px; }
      .cp-preset:focus-visible { outline: 2px solid ${BLUE}; outline-offset: 4px; }
      .cp-field { position: relative; height: 128px; border-radius: 6px; cursor: crosshair; touch-action: none;
        background: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, var(--hue));
        box-shadow: inset 0 0 0 1px rgba(var(--ink-rgb), .08); }
      .cp-hue { position: relative; height: 12px; margin: 0 6px; border-radius: 999px; cursor: ew-resize; touch-action: none;
        background: linear-gradient(to right, #f00, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00); }
      .cp-hue::before { content: ""; position: absolute; inset: 0 -6px; border-radius: inherit; background: inherit; }
      .cp-hue::after { content: ""; position: absolute; inset: -10px -6px; }
      .cp-field:focus-visible, .cp-hue:focus-visible { outline: 2px solid ${BLUE}; outline-offset: 3px; }
      .cp-knob { position: absolute; z-index: 1; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 999px; pointer-events: none;
        box-shadow: 0 0 0 2.5px #fff, 0 0 0 3.5px rgba(0, 0, 0, .18), 0 2px 8px rgba(0, 0, 0, .35); transition: scale .15s cubic-bezier(.23, 1, .32, 1); }
      .cp-field:active .cp-knob, .cp-hue:active .cp-knob { scale: 1.15; }
      .cp-foot { display: flex; gap: 6px; }
      .cp-hexf { display: flex; flex: 1; align-items: center; gap: 2px; height: 28px; padding: 0 10px; border-radius: 999px;
        background: rgb(var(--elev-rgb)); box-shadow: inset 0 0 0 1px rgba(var(--ink-rgb), .1); color: rgba(var(--ink-rgb), .4);
        font: 400 12px/1 ui-monospace, "SF Mono", Menlo, monospace; }
      .cp-hexf:focus-within { box-shadow: inset 0 0 0 1px ${BLUE}; }
      .cp-hexf input { all: unset; flex: 1; min-width: 0; color: rgba(var(--ink-rgb), .9); text-transform: lowercase; cursor: text; }
      .cp-drop { all: unset; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 999px; cursor: pointer;
        background: rgb(var(--elev-rgb)); box-shadow: inset 0 0 0 1px rgba(var(--ink-rgb), .1); color: rgba(var(--ink-rgb), .6);
        transition: color .15s, scale .15s; }
      .cp-drop:hover { color: rgba(var(--ink-rgb), .95); }
      .cp-drop:active { scale: .96; }
      .cp-drop:focus-visible { outline: 2px solid ${BLUE}; outline-offset: 2px; }
      .cp-drop svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
      @media (prefers-reduced-motion: reduce) { .cp, .cp-preset, .cp-knob, .cp-drop { animation: none; transition-duration: 1ms; } }
      .panel .f {
        display: flex; align-items: center; gap: 4px; height: 28px; padding: 0 6px; border-radius: 8px;
        background: rgba(var(--ink-rgb), .05); box-shadow: inset 0 0 0 1px transparent; transition: box-shadow .12s;
      }
      .panel .f:hover { box-shadow: inset 0 0 0 1px rgba(var(--ink-rgb), .1); }
      .panel .f:focus-within { box-shadow: inset 0 0 0 1px ${BLUE}; }
      .panel .k { flex: none; min-width: 12px; color: rgba(var(--ink-rgb), .4); cursor: ew-resize; text-align: center; }
      .panel .f input {
        all: unset; min-width: 0; width: 100%; color: rgba(var(--ink-rgb), .9); font: inherit; font-variant-numeric: tabular-nums; cursor: text;
      }
      .panel .f input:placeholder-shown { color: rgba(var(--ink-rgb), .4); }
      .panel .indep { all: unset; display: grid; place-items: center; width: 20px; height: 20px; border-radius: 6px; cursor: pointer; color: rgba(var(--ink-rgb), .5); }
      .panel .indep:hover { background: rgba(var(--ink-rgb), .05); color: rgba(var(--ink-rgb), .9); }
      .panel .indep[aria-pressed="true"] { background: rgba(var(--ink-rgb), .1); color: rgb(var(--ink-rgb)); }
      .panel .indep svg { width: 14px; height: 14px; }
      @media (prefers-reduced-motion: reduce) { button, .handle, .band { transition: none; } }
    </style>
    <div class="box hover"></div>
    <div class="box sel"></div>
    <div class="space"></div>
    <div class="handle" title="Drag to set the radius. Hold ⌥ for values off the 2px grid"></div>
    <div class="tag" title="Click or press ↵ to type a value"></div>
    <div class="box drop"></div>
    <div class="ghosts"></div>
    <div class="mtag"></div>
    <aside class="panel" aria-label="Selected element">
      <header><span class="el"></span><span class="comp"></span></header>
      <p class="hint">Select an element to edit its radius, spacing, fill and border.</p>
      <section data-sec="radius">
        <h4>Radius</h4>
        <div class="row"><label class="f" data-f="radius" title="Corner radius"><span class="k">◜</span><input inputmode="decimal" aria-label="Corner radius"></label></div>
      </section>
      <section data-sec="gap">
        <h4>Gap</h4>
        <div class="row"><label class="f" data-f="gap" title="Gap between items"><span class="k">⇹</span><input inputmode="decimal" aria-label="Gap"></label></div>
      </section>
      <section data-sec="padding">
        <h4>Padding
          <button class="indep" aria-pressed="false" title="Independent padding" aria-label="Independent padding">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/></svg>
          </button>
        </h4>
        <div class="row" data-pair>
          <label class="f" data-f="padding-left padding-right" title="Horizontal padding"><span class="k">H</span><input inputmode="decimal" aria-label="Horizontal padding"></label>
          <label class="f" data-f="padding-top padding-bottom" title="Vertical padding"><span class="k">V</span><input inputmode="decimal" aria-label="Vertical padding"></label>
        </div>
        <div class="row4" data-four hidden>
          <label class="f" data-f="padding-top" title="Top padding"><span class="k">T</span><input inputmode="decimal" aria-label="Top padding"></label>
          <label class="f" data-f="padding-right" title="Right padding"><span class="k">R</span><input inputmode="decimal" aria-label="Right padding"></label>
          <label class="f" data-f="padding-bottom" title="Bottom padding"><span class="k">B</span><input inputmode="decimal" aria-label="Bottom padding"></label>
          <label class="f" data-f="padding-left" title="Left padding"><span class="k">L</span><input inputmode="decimal" aria-label="Left padding"></label>
        </div>
      </section>
      <section data-sec="margin">
        <h4>Margin</h4>
        <div class="row4" style="margin-top:0">
          <label class="f" data-f="margin-top" title="Top margin"><span class="k">T</span><input inputmode="decimal" aria-label="Top margin"></label>
          <label class="f" data-f="margin-right" title="Right margin"><span class="k">R</span><input inputmode="decimal" aria-label="Right margin"></label>
          <label class="f" data-f="margin-bottom" title="Bottom margin"><span class="k">B</span><input inputmode="decimal" aria-label="Bottom margin"></label>
          <label class="f" data-f="margin-left" title="Left margin"><span class="k">L</span><input inputmode="decimal" aria-label="Left margin"></label>
        </div>
      </section>
      <section data-sec="fill">
        <h4>Fill</h4>
        <div class="row1">
          <div class="f c" data-f="fill" title="Background colour"><button class="sw" type="button" aria-label="Open fill colour picker" aria-expanded="false"></button><input class="hex" spellcheck="false" aria-label="Fill colour"></div>
        </div>
      </section>
      <section data-sec="border">
        <h4>Border</h4>
        <div class="row">
          <label class="f" data-f="border" title="Border width"><span class="k">W</span><input inputmode="decimal" aria-label="Border width"></label>
          <div class="f c" data-f="border-color" title="Border colour"><button class="sw" type="button" aria-label="Open border colour picker" aria-expanded="false"></button><input class="hex" spellcheck="false" aria-label="Border colour"></div>
        </div>
      </section>
      <section data-sec="figma">
        <button class="addfig" type="button">Add to Figma</button>
      </section>
    </aside>
    <style>
      /* Comments: numbered pins on the page, one note box at a time. */
      .pins { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }
      .pin {
        all: unset; position: fixed; pointer-events: auto; cursor: pointer; display: grid; place-items: center;
        min-width: 22px; height: 22px; padding: 0 6px; margin: -11px 0 0 -11px; box-sizing: border-box; border-radius: 11px 11px 11px 3px;
        background: ${BLUE}; color: #fff; font: 600 11px/1 "PTK Camera", ui-sans-serif, system-ui, sans-serif; font-variant-numeric: tabular-nums;
        box-shadow: 0 0 0 1.5px #fff, 0 2px 8px rgba(0, 0, 0, .3); transition: scale .2s cubic-bezier(.3, 1.42, .4, 1);
      }
      .pin:hover, .pin[data-on] { scale: 1.12; }
      .pin:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
      .note {
        position: fixed; z-index: 2147483647; display: none; width: 280px; padding: 10px; border-radius: 14px;
        background: rgba(var(--elev-rgb), .94); color: rgb(var(--ink-rgb)); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
        box-shadow: inset 0 1px 0 rgba(var(--ink-rgb), .06), 0 0 0 1px rgba(var(--ink-rgb), .1), 0 10px 40px rgba(0, 0, 0, .3);
        font: 460 13px/1.4 "PTK Camera", ui-sans-serif, system-ui, -apple-system, sans-serif; -webkit-font-smoothing: antialiased;
        animation: rise .25s cubic-bezier(.22, 1.14, .36, 1) both;
      }
      .note .who { display: block; margin: 2px 2px 8px; color: rgba(var(--ink-rgb), .55); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .note q { display: block; margin: 0 2px 8px; padding-left: 8px; border-left: 2px solid #ffd60a; color: rgba(255, 255, 255, .8); font-size: 12px; quotes: none;
        display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
      .note textarea {
        all: unset; box-sizing: border-box; display: block; width: 100%; min-height: 64px; max-height: 200px; padding: 8px 10px; border-radius: 8px;
        background: rgba(var(--ink-rgb), .08); color: rgb(var(--ink-rgb)); font: inherit; font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; overflow: auto;
      }
      .note textarea::placeholder { color: rgba(var(--ink-rgb), .4); }
      .note textarea:focus-visible { box-shadow: 0 0 0 1.5px ${BLUE}; }
      .note .acts { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
      .note button { all: unset; box-sizing: border-box; cursor: pointer; height: 28px; padding: 0 10px; border-radius: 8px; font-size: 12px; }
      .note button:focus-visible { outline: 2px solid ${BLUE}; outline-offset: 2px; }
      .note .del { color: var(--danger); margin-right: auto; }
      .note .cancel { margin-left: auto; color: rgba(var(--ink-rgb), .7); }
      .note .del + .cancel { margin-left: 0; }
      .note .cancel:hover { color: rgb(var(--ink-rgb)); }
      .note .add { background: ${BLUE}; color: #fff; font-weight: 520; }
      .note .add[aria-disabled="true"] { opacity: .4; pointer-events: none; }
    </style>
    <div class="pins"></div>
    <div class="note" role="dialog" aria-label="Comment">
      <span class="who"></span>
      <q hidden></q>
      <textarea rows="3" aria-label="Comment for your agent" placeholder="What should change here?"></textarea>
      <div class="acts"><button class="del" type="button" hidden>Delete</button><button class="cancel" type="button">Cancel</button><button class="add" type="button">Add</button></div>
    </div>
    <div class="bar" role="toolbar" aria-label="Design toolkit"></div>
    <div class="menu" role="menu"></div>
    <div class="tip" role="tooltip"></div>
    <div class="toast" role="status" aria-live="polite"></div>
  `;
  const bar = root.querySelector(".bar");
  const menu = root.querySelector(".menu");
  const tip = root.querySelector(".tip");
  const toast = root.querySelector(".toast");
  const hoverBox = root.querySelector(".box.hover");
  const selBox = root.querySelector(".box.sel");
  const handle = root.querySelector(".handle");
  const tag = root.querySelector(".tag");
  const dropBox = root.querySelector(".box.drop");
  const ghosts = root.querySelector(".ghosts");
  const mtag = root.querySelector(".mtag");
  const spaceLayer = root.querySelector(".space");
  const panel = root.querySelector(".panel");
  const pins = root.querySelector(".pins");
  const note = root.querySelector(".note");
  const noteText = note.querySelector("textarea");

  const glyph = (d) => `<svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICON = {
    /* move and text are the canvas-toolbar's own glyphs; radius and spacing are drawn to match */
    move: glyph("M4.2 3.2a1.4 1.4 0 0 1 1.5-.3l15.2 6.2a1.4 1.4 0 0 1-.2 2.6l-6 1.6a1.6 1.6 0 0 0-1.2 1.1l-1.6 6a1.4 1.4 0 0 1-2.6.2L3.1 5.4a1.4 1.4 0 0 1 .3-1.5z"),
    type: glyph("M5 3.5h14A2.5 2.5 0 0 1 21.5 6v1.5a1.5 1.5 0 1 1-3 0v-1h-5v12h1.3a1.5 1.5 0 1 1 0 3H9.2a1.5 1.5 0 1 1 0-3h1.3v-12h-5v1a1.5 1.5 0 1 1-3 0V6A2.5 2.5 0 0 1 5 3.5"),
    radius: glyph("M4 21a1.5 1.5 0 0 1-1.5-1.5V12A9.5 9.5 0 0 1 12 2.5h7.5a1.5 1.5 0 0 1 0 3H12A6.5 6.5 0 0 0 5.5 12v7.5A1.5 1.5 0 0 1 4 21"),
    spacing: glyph("M6 2.5h12A3.5 3.5 0 0 1 21.5 6v12a3.5 3.5 0 0 1-3.5 3.5H6A3.5 3.5 0 0 1 2.5 18V6A3.5 3.5 0 0 1 6 2.5m0 3a.5.5 0 0 0-.5.5v12c0 .28.22.5.5.5h12a.5.5 0 0 0 .5-.5V6a.5.5 0 0 0-.5-.5zm3.5 4h5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5v-4c0-.28.22-.5.5-.5"),
    comment: glyph("M12 2.5c5.25 0 9.5 3.64 9.5 8.25S17.25 19 12 19c-.93 0-1.83-.11-2.68-.33l-4.1 2.36a1.2 1.2 0 0 1-1.77-1.27l.6-3.18C2.95 15.08 2.5 12.96 2.5 10.75 2.5 6.14 6.75 2.5 12 2.5"),
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.5" y="8.5" width="12" height="12" rx="3"/><path d="M15.5 8.5V6.5a3 3 0 0 0-3-3h-6a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h2"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  };


  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  const MOD = isMac ? "⌘" : "Ctrl";
  /* Move first, like the canvas-toolbar; its slot carries the corner wedge for move options. */
  const TOOLS = [
    ["move", "Move", "V"],
    ["text", "Text", "T"],
    ["spacing", "Spacing", "S"],
    ["comment", "Comment", "C"],
  ];
  let collapsed = false;
  let barAt = null; // { cx, cy }: the bar's centre once dragged, null for the default spot (bottom centre)
  try {
    collapsed = localStorage.getItem("ptk-collapsed") === "on";
    barAt = JSON.parse(localStorage.getItem("ptk-pos") || "null");
  } catch {}
  let menuOpen = null; // null | "move" | "copy"

  const toolButton = (id, label, key) =>
    `<button class="tool" data-tool="${id}" aria-pressed="false" aria-label="${label}" aria-keyshortcuts="${key}" data-tip="${label}" data-key="${key}">${ICON[id === "text" ? "type" : id]}</button>`;
  bar.innerHTML =
    TOOLS.map(([id, label, key]) =>
      id === "move"
        ? `<span class="slot">${toolButton(id, label, key)}<button class="notch" data-menu="move" aria-haspopup="menu" aria-expanded="false" aria-label="Move options" data-tip="Move options"></button></span>`
        : toolButton(id, label, key),
    ).join("") +
    `<span class="split" data-needs-edits></span>
    <span class="slot" data-needs-edits><button class="copy" aria-disabled="true" aria-label="Copy prompt">${ICON.copy}<span class="badge" hidden></span></button><button class="notch" data-menu="copy" aria-haspopup="menu" aria-expanded="false" aria-label="Prompt options" data-tip="Prompt options"></button></span>
    <button class="tool close" aria-label="Collapse toolbar" data-tip="Collapse">${ICON.close}</button>
    <button class="expand" aria-label="Open design toolkit" data-tip="Design toolkit">${ICON.close}</button>`;
  const copyButton = bar.querySelector(".copy");
  const badge = bar.querySelector(".badge");

  function render() {
    if (history.length) scheduleCheckpoint();
    const n = count();
    bar.querySelectorAll(".tool").forEach((b) => b.setAttribute("aria-pressed", String(tool === b.dataset.tool)));
    bar.querySelectorAll("[data-menu]").forEach((b) => b.setAttribute("aria-expanded", String(menuOpen === b.dataset.menu)));
    copyButton.setAttribute("aria-disabled", String(n === 0));
    /* Copy prompt (and its divider) only appear once there is something to copy. */
    const showCopy = n > 0 || (status === "done" && lastCopy === "prompt"); // stay for the ✓ after copying, then go
    bar.querySelectorAll("[data-needs-edits]").forEach((x) => (x.hidden = !showCopy));
    if (!showCopy && menuOpen === "copy") menuOpen = null;
    copyButton.dataset.tip = n ? "Copy prompt" : "Make an edit first";
    copyButton.dataset.key = n ? `${MOD}↵` : "";
    badge.hidden = !n;
    badge.textContent = n;
    /* A check for a moment after copying, the copy glyph otherwise. */
    const glyphName = status === "done" && !n && lastCopy === "prompt" ? "check" : "copy";
    if (copyButton.dataset.glyph !== glyphName) {
      copyButton.dataset.glyph = glyphName;
      copyButton.querySelector("svg").outerHTML = ICON[glyphName];
    }
    copyButton.classList.toggle("done", glyphName === "check");
    bar.toggleAttribute("data-collapsed", collapsed);
    placeBar();

    /* Status floats above the toolbar instead of pushing the tools around. */
    const show = status === "done" || status === "error";
    toast.textContent = show ? message : "";
    toast.classList.toggle("err", status === "error");
    if (show) {
      const b = bar.getBoundingClientRect();
      Object.assign(toast.style, { display: "block", left: `${b.left + b.width / 2}px`, ...nextToBar(10) });
    } else toast.style.display = "none";
    renderMenu();
  }

  /* Option menus, opened from the corner wedges. */
  function renderMenu() {
    if (!menuOpen) return (menu.style.display = "none");
    const item = (attrs, checked, label, hint, disabled = false) =>
      `<button class="mi" ${attrs} aria-checked="${checked}" aria-disabled="${disabled}">${ICON.check}<span>${label}</span>${hint ? `<small>${hint}</small>` : ""}</button>`;
    if (menuOpen === "move") {
      /* One toggle card: off is Flow (the default), on is Absolute. Updated in place so the switch slides. */
      const hint = moveAbsolute ? "Place anywhere, sent with a screenshot." : "Off: drop into containers, in the layout.";
      const tg = menu.querySelector(".tg");
      if (tg && menu.style.display === "block") {
        tg.setAttribute("aria-checked", String(moveAbsolute));
        tg.querySelector("small").textContent = hint;
      } else menu.innerHTML = `<button class="tg" role="menuitemcheckbox" data-set="toggle-absolute" aria-checked="${moveAbsolute}">
          <span class="tg-text"><span>Absolute position</span><small>${hint}</small></span>
          <span class="sw" aria-hidden="true"></span>
        </button>`;
    } else {
      const n = count();
      menu.innerHTML = `<div class="mh">Prompt</div>
        ${item('role="menuitemcheckbox" data-set="tokens"', useTokens, "Use design tokens", useTokens ? "Round values to your existing tokens." : "Off: exact values, even without a token.")}
        <hr />
        <div class="mh">Appearance</div>
        ${item('role="menuitemradio" data-set="theme-dark"', theme === "dark", "Dark")}
        ${item('role="menuitemradio" data-set="theme-light"', theme === "light", "Light")}
        ${item('role="menuitemradio" data-set="theme-auto"', theme === "auto", "Auto", "Follow the system setting.")}
        <hr />
        ${item('role="menuitem" data-set="revert"', false, `Revert all edits${n ? ` (${n})` : ""}`, "", n === 0)}`;
    }
    if (menu.style.display !== "block") {
      menu.style.animation = "none";
      void menu.offsetWidth; // restart the rise each time it opens
      menu.style.animation = "";
    }
    menu.style.display = "block";
    const slot = bar.querySelector(`[data-menu="${menuOpen}"]`).parentElement.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    const w = menu.offsetWidth;
    const left = slot.left + slot.width / 2 - w / 2;
    Object.assign(menu.style, { left: `${Math.max(8, Math.min(left, innerWidth - w - 8))}px`, ...nextToBar(8) });
  }

  const setMenu = (name) => {
    menuOpen = name;
    tip.style.display = "none";
    render();
  };

  bar.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (dragged) return; // the release at the end of a drag is not a click
    if (pressOpened) return void (pressOpened = false); // the release after a long press that opened options
    if (b.classList.contains("close")) return setCollapsed(true);
    if (b.classList.contains("expand")) {
      setCollapsed(false);
      return tool || setTool("move"); // opening the toolkit starts on Move
    }
    if (b.dataset.tool) setTool(tool === b.dataset.tool ? null : b.dataset.tool);
    else if (b.dataset.menu) setMenu(menuOpen === b.dataset.menu ? null : b.dataset.menu);
    else if (b.classList.contains("copy") && count()) copy();
  });

  /* A tool with options (the corner wedge) also opens them on right-click or a long press, like Figma. */
  const menuFor = (b) => (b && !b.dataset.menu ? b.closest(".slot")?.querySelector("[data-menu]")?.dataset.menu : null);
  let pressTimer = null;
  let pressOpened = false;
  bar.addEventListener("contextmenu", (e) => {
    const m = menuFor(e.target.closest("button"));
    if (!m) return;
    e.preventDefault();
    setMenu(m);
  });
  bar.addEventListener("pointerdown", (e) => {
    pressOpened = false;
    const m = menuFor(e.target.closest("button"));
    if (!m || e.button !== 0) return;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      if (dragged) return;
      pressOpened = true;
      setMenu(m);
    }, 450);
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((t) => bar.addEventListener(t, () => clearTimeout(pressTimer)));

  menu.addEventListener("click", (e) => {
    const b = e.target.closest(".mi, .tg");
    if (!b) return;
    const set = b.dataset.set;
    if (set === "toggle-absolute") moveAbsolute = !moveAbsolute;
    if (set === "tokens") useTokens = !useTokens;
    if (set?.startsWith("theme-")) {
      host.dataset.theme = theme = set.slice(6);
      window.dispatchEvent(new CustomEvent("design-toolkit:theme", { detail: { theme } })); // pages can follow it
    }
    if (set === "revert") {
      menuOpen = null;
      return revertAll();
    }
    try {
      localStorage.setItem("ptk-tokens", useTokens ? "on" : "off");
      localStorage.setItem("ptk-move", moveAbsolute ? "absolute" : "flow");
      localStorage.setItem("ptk-theme", theme);
    } catch {}
    render();
  });

  /* Tooltips: name and shortcut above the hovered button, like Figma's. */
  bar.addEventListener("pointerover", (e) => {
    const b = e.target.closest("[data-tip]");
    if (!b || menuOpen) return (tip.style.display = "none");
    tip.innerHTML = `${esc(b.dataset.tip)}${b.dataset.key ? `<kbd>${esc(b.dataset.key)}</kbd>` : ""}`;
    tip.style.display = "block";
    const r = b.getBoundingClientRect();
    const bb = bar.getBoundingClientRect();
    const w = tip.offsetWidth;
    Object.assign(tip.style, { left: `${Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8))}px`, ...nextToBar(8) });
  });
  bar.addEventListener("pointerleave", () => (tip.style.display = "none"));

  function setTool(next) {
    if (next && collapsed) setCollapsed(false);
    if (editing) commit(editing);
    if (composing) closeNote();
    if (!next) select(null); // switching tools keeps the selection, like Figma; only leaving the toolkit clears it
    hovered = null;
    tool = next;
    if (next) document.documentElement.setAttribute("data-ptk-tool", next);
    else document.documentElement.removeAttribute("data-ptk-tool");
    if (status !== "idle") status = "idle";
    render();
    paint(); // docks or undocks the panel right away
    if (boxTool()) requestAnimationFrame(follow);
  }

  /* ---------- toolbar position and collapse ---------- */

  /* Popovers sit above the bar, or below it once it has been dragged into the top half of the window. */
  function nextToBar(gap) {
    const b = bar.getBoundingClientRect();
    return b.top + b.height / 2 < innerHeight / 2 ? { top: `${b.bottom + gap}px`, bottom: "auto" } : { top: "auto", bottom: `${innerHeight - b.top + gap}px` };
  }

  /* Placed by its centre, so it grows and shrinks (count, collapse) around the same point, always on screen. */
  function placeBar() {
    if (!barAt) {
      bar.removeAttribute("data-placed");
      bar.style.left = bar.style.top = "";
      return;
    }
    bar.setAttribute("data-placed", "");
    const w = bar.offsetWidth;
    const h = bar.offsetHeight;
    const left = Math.max(8, Math.min(barAt.cx - w / 2, innerWidth - dockWidth() - w - 8));
    const top = Math.max(8, Math.min(barAt.cy - h / 2, innerHeight - h - 8));
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
  }

  const remember = () => {
    try {
      localStorage.setItem("ptk-collapsed", collapsed ? "on" : "off");
      if (barAt) localStorage.setItem("ptk-pos", JSON.stringify(barAt));
      else localStorage.removeItem("ptk-pos");
    } catch {}
  };

  /* Collapsing puts the tools away; edits, pins and the count stay. */
  function setCollapsed(next) {
    collapsed = next;
    if (collapsed) {
      menuOpen = null;
      tip.style.display = "none";
      if (tool) setTool(null);
    }
    remember();
    render();
  }

  /* Drag the bar from anywhere on it, buttons included. A press that barely moves is still a click. */
  let dragged = false;
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const b = bar.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
    dragged = false;
    const move = (ev) => {
      if (!dragged && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
      if (!dragged) {
        dragged = true;
        clearTimeout(pressTimer); // a drag is not a long press
        bar.setAttribute("data-dragging", "");
        menuOpen = null;
        tip.style.display = "none";
      }
      barAt = { cx: start.cx + ev.clientX - start.x, cy: start.cy + ev.clientY - start.y };
      render();
    };
    const up = () => {
      removeEventListener("pointermove", move, true);
      removeEventListener("pointerup", up, true);
      removeEventListener("pointercancel", up, true);
      bar.removeAttribute("data-dragging");
      if (dragged) {
        /* Keep the stored centre inside the window it was dropped in. */
        const r = bar.getBoundingClientRect();
        barAt = { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
        remember();
        setTimeout(() => (dragged = false), 0); // the click that follows a drag does not toggle
      }
    };
    /* On the window, so a fast drag that leaves the bar keeps going. */
    addEventListener("pointermove", move, true);
    addEventListener("pointerup", up, true);
    addEventListener("pointercancel", up, true);
  });
  /* Double-click the bar's frame (not a button) to put it back at the bottom centre. */
  bar.addEventListener("dblclick", (e) => {
    if (e.target.closest("button")) return;
    barAt = null;
    remember();
    render();
  });
  addEventListener("resize", () => placeBar());

  /* The toolbar, plus anything the page marks data-toolkit-ignore (its own dev panels): tools pass clicks through to them. */
  const fromToolbar = (e) => e.composedPath().some((n) => n === host || n.hasAttribute?.("data-toolkit-ignore"));

  /* ---------- hints for Claude: where the element sits ---------- */

  function domPath(el) {
    const parts = [];
    for (let n = el; n && n !== document.body && parts.length < 4; n = n.parentElement) {
      let part = n.tagName.toLowerCase();
      if (n.id) part += `#${n.id}`;
      const classes = [...n.classList].filter((c) => !c.startsWith("ptk")).slice(0, 2);
      if (classes.length) part += "." + classes.join(".");
      parts.unshift(part.slice(0, 60));
    }
    return parts.join(" > ");
  }

  /* In dev builds React leaves its fiber on the node; the nearest named components point at the file. */
  function componentNames(el) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    const names = [];
    for (let f = key && el[key]; f && names.length < 3; f = f.return) {
      const t = f.type;
      if (!t || typeof t === "string") continue;
      const name = t.displayName || t.name || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name;
      if (name && !/^(Anonymous|ForwardRef|Memo)$/.test(name) && !names.includes(name)) names.push(name);
    }
    return names;
  }

  const describe = (el) => ({ tag: el.tagName.toLowerCase(), path: domPath(el), components: componentNames(el) });
  const where = ({ path, components }) => (components.length ? `${path} (in <${components.join("> in <")}>)` : path);

  /* ================= Text ================= */

  const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const SKIP = new Set(["INPUT", "TEXTAREA", "SELECT", "SCRIPT", "STYLE", "SVG", "HTML", "BODY"]);

  function pickText(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    for (let i = 0; el && i < 6; i++, el = el.parentElement) {
      if (SKIP.has(el.tagName.toUpperCase()) || el.closest("svg")) return null;
      if (hasOwnText(el)) return el;
    }
    return null;
  }

  function begin(el) {
    if (editing === el) return;
    if (editing) commit(editing);
    rememberPristine(el);
    if (!originalText.has(el)) originalText.set(el, el.innerText.trim());
    for (const n of textNodes(el)) if (!originalNodeText.has(n)) originalNodeText.set(n, n.nodeValue);
    if (!textEdits.has(el)) {
      textEdits.set(el, { before: originalText.get(el), shown: el.innerText.trim(), ...describe(el), snapshot: snapshot(el) });
    }
    editing = el;
    el.setAttribute("contenteditable", "plaintext-only");
    if (el.contentEditable !== "plaintext-only") el.setAttribute("contenteditable", "true");
    el.setAttribute("data-ptk-editing", "");
    el.setAttribute("spellcheck", "false");
  }

  function commit(el) {
    el.removeAttribute("contenteditable");
    el.removeAttribute("data-ptk-editing");
    el.removeAttribute("spellcheck");
    if (editing === el) editing = null;
    const edit = textEdits.get(el);
    if (!edit) return;
    edit.after = el.innerText.trim();
    edit.parts = changedParts(el, edit.snapshot);
    if (edit.after === edit.shown) textEdits.delete(el);
    mark(el);
    render();
  }

  const textNodes = (el) => {
    const out = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n);
    return out;
  };
  const squash = (t) => (t ?? "").replace(/\s+/g, " ").trim();

  /* What changed, text node by text node, so "before" is a string that exists in the source as written
     ("Test drive" in a button, not the button's whole visible text "Test drive\n+" with its icon). Null
     when typing replaced the nodes themselves and they can no longer be matched up; then the whole
     element's text is used. */
  function changedParts(el, nodes) {
    const parts = [];
    for (const [n, shownValue] of nodes) {
      if (shownValue === null || !squash(shownValue)) continue;
      const now = n.isConnected && el.contains(n) ? n.nodeValue : "";
      if (squash(now) === squash(shownValue)) continue;
      parts.push({ before: squash(originalNodeText.get(n) ?? shownValue), shown: squash(shownValue), after: squash(now) });
    }
    const known = new Set(nodes.map(([n]) => n));
    const added = textNodes(el).filter((n) => !known.has(n) && squash(n.nodeValue));
    if (!added.length) return parts.length ? parts : null;
    /* New text typed into an emptied node lands in a fresh node: pair it with the one change, if that is all there is. */
    if (parts.length === 1 && !parts[0].after) {
      parts[0].after = squash(added.map((n) => n.nodeValue).join(" "));
      return parts;
    }
    return null;
  }

  /* Remember every node so a revert restores React's own text nodes instead of replacing them. */
  function snapshot(el) {
    const nodes = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_ALL);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) nodes.push([n, n.nodeType === 3 ? n.nodeValue : null]);
    return nodes;
  }

  function restore(el, nodes) {
    const keep = new Set(nodes.map(([n]) => n));
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_ALL);
    const extra = [];
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (!keep.has(n)) extra.push(n);
    extra.forEach((n) => n.remove());
    for (const [n, v] of nodes) if (v !== null && n.isConnected) n.nodeValue = v;
  }

  /* ================= Box tools: picking, selection, overlay, typed values ================= */

  const capture = (node, e) => {
    try {
      node.setPointerCapture(e.pointerId);
    } catch {}
  };
  const MEDIA = new Set(["IMG", "VIDEO", "CANVAS", "IFRAME", "PICTURE"]);
  const px = (cs, prop) => parseFloat(cs.getPropertyValue(prop)) || 0;
  const snap = (v, free) => (free ? Math.round(v) : Math.round(v / GRID) * GRID);
  /* An off-grid value steps to the next grid line first, so ⌥ detours never stick. */
  const stepValue = (now, dir, e) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return Math.round(now) + dir;
    const step = e.shiftKey ? 10 : GRID; // ⇧ is Figma's big nudge
    return dir > 0 ? Math.floor(now / GRID) * GRID + step : Math.ceil(now / GRID) * GRID - step;
  };

  function drawsBox(el) {
    if (MEDIA.has(el.tagName)) return true;
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor.match(/[\d.]+/g);
    return (
      (bg && (bg.length < 4 || Number(bg[3]) > 0)) ||
      cs.backgroundImage !== "none" ||
      px(cs, "border-top-width") > 0 ||
      px(cs, "border-left-width") > 0 ||
      cs.boxShadow !== "none" ||
      px(cs, "border-top-left-radius") > 0
    );
  }

  function hasSpace(el) {
    const cs = getComputedStyle(el);
    if (SIDES.some((s) => px(cs, `padding-${s}`) || px(cs, `margin-${s}`))) return true;
    return /flex|grid/.test(cs.display) && (px(cs, "row-gap") || px(cs, "column-gap"));
  }

  /* Climb from what you clicked to the nearest element worth tuning: for Radius one that draws a box
     (the pill, not its label), for Spacing one that has spacing or draws a box. */
  function pick(node, test) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    el = el?.closest("svg")?.parentElement ?? el;
    const start = el;
    for (let i = 0; el && i < 8; i++, el = el.parentElement) {
      if (el === document.body || el === document.documentElement) break;
      if (test(el)) return el;
    }
    return start && start !== document.body && start !== document.documentElement ? start : null;
  }
  const pickFor = (node) =>
    pick(node, tool === "radius" ? drawsBox : tool === "move" || tool === "comment" ? (el) => drawsBox(el) || hasOwnText(el) || MEDIA.has(el.tagName) : (el) => hasSpace(el) || drawsBox(el));

  function select(el) {
    el = (el && inflowOwner.get(el)) ?? el;
    if (el) rememberPristine(el);
    if (field && el !== selected) closeField(true);
    /* A panel field still holding focus applies to the old element (on blur) before the switch. */
    const active = root.activeElement;
    if (el !== selected && selected && active && panel.contains(active)) {
      applyFieldInput(active);
      active.blur();
    }
    selected = el;
    if (el && !originalRadius.has(el)) originalRadius.set(el, getComputedStyle(el).borderRadius);
    if (el && !originalStyle.has(el)) {
      const cs = getComputedStyle(el);
      originalStyle.set(el, Object.fromEntries(STYLE_PROPS.map((p) => [p, cs.getPropertyValue(p)])));
    }
    if (el && !originalSpace.has(el)) {
      const cs = getComputedStyle(el);
      originalSpace.set(el, Object.fromEntries(SPACE_PROPS.map((p) => [p, cs.getPropertyValue(p)])));
    }
    paint();
  }

  /* Overlay boxes are fixed-position copies of the target's rect, including its own radius. */
  function place(box, el) {
    if (!el || !el.isConnected) {
      box.style.display = "none";
      return null;
    }
    const r = rectOf(el);
    Object.assign(box.style, {
      display: "block",
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      borderRadius: getComputedStyle(el).borderRadius,
    });
    return r;
  }

  function paint() {
    const on = boxTool();
    place(hoverBox, on && hovered !== selected ? hovered : null);
    const r = place(selBox, tool ? selected : null);
    /* Move carries the radius handle (Radius is no longer a separate tool), hidden while the element is being moved. */
    paintRadius((tool === "move" && drag?.kind !== "move" && drag?.kind !== "flow") || tool === "radius" ? r : null);
    paintSpacing(tool === "spacing" ? r : null);
    paintPanel();
    paintMove(tool === "move" ? r : null);
  }

  /* Pages scroll and animate under the overlay, so it follows every frame while a box tool is on. */
  function follow() {
    if (!boxTool()) return;
    paint();
    requestAnimationFrame(follow);
  }

  /* Click a value (or press ↵ in Radius) to type one. Typed values round to the nearest grid value.
     ↑ ↓ inside the field step like everywhere else, ⇧↵ applies a spacing value to all four sides. */
  function openField(el, prefix, f) {
    if (field) closeField(true);
    el.innerHTML = `${prefix}<input inputmode="decimal" aria-label="Value in px" spellcheck="false" value="${esc(f.read())}">`;
    const input = el.querySelector("input");
    field = { ...f, input, el };
    focusField(input);
    input.select();
    input.addEventListener("keydown", onFieldKey);
    input.addEventListener("blur", () => field?.input === input && closeField(true));
  }

  function closeField(apply, all = false) {
    if (!field) return;
    const f = field;
    field = null;
    const raw = f.input.value.trim().toLowerCase();
    if (apply && selected && raw !== "") f.apply(raw, all);
    paint();
  }

  function onFieldKey(e) {
    e.stopPropagation(); // the page and the toolkit's own shortcuts stay quiet while typing
    if (e.key === "Enter") {
      e.preventDefault();
      closeField(true, e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeField(false);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      field.step(e.key === "ArrowUp" ? 1 : -1, e);
      field.input.value = field.read();
      field.input.select();
    }
  }

  /* ================= Radius ================= */

  const maxRadius = (el) => {
    const r = el.getBoundingClientRect();
    return Math.min(r.width, r.height) / 2;
  };
  const currentRadius = (el) => Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, maxRadius(el));
  const isFull = (el, r) => r >= maxRadius(el) - 0.5;
  const radiusLabel = (el, r) => (isFull(el, r) ? "Full" : `${r}`);

  function setRadius(el, r) {
    r = Math.max(0, Math.min(r, Math.floor(maxRadius(el))));
    if (!radiusEdits.has(el)) {
      radiusEdits.set(el, { before: originalRadius.get(el), shown: getComputedStyle(el).borderRadius, inline: el.style.borderRadius, ...describe(el) });
    }
    const edit = radiusEdits.get(el);
    edit.full = isFull(el, r);
    edit.after = edit.full ? "9999px" : `${r}px`;
    el.style.borderRadius = edit.after;
    if (getComputedStyle(el).borderRadius === edit.shown || (edit.full && isFull(el, parseFloat(edit.shown)))) {
      el.style.borderRadius = edit.inline;
      radiusEdits.delete(el);
    }
    mark(el);
    render();
    paint();
  }

  function paintRadius(r) {
    if (!r) {
      handle.style.display = tag.style.display = "none";
      return;
    }
    const value = currentRadius(selected);
    /* The handle sits near where the corner's curve starts, never closer than 10px so it stays grabbable. */
    const inset = Math.max(10, value * 0.3 + 6);
    Object.assign(handle.style, { display: "block", left: `${r.left + inset}px`, top: `${r.top + inset}px` });
    handle.classList.toggle("drag", drag?.kind === "radius");
    const off = !isFull(selected, value) && Math.round(value) % GRID !== 0;
    if (field?.el !== tag) tag.innerHTML = `Radius ${radiusLabel(selected, Math.round(value))}${off ? ' <span class="off">· off grid</span>' : ""}`;
    if (tool === "move" && drag?.kind !== "radius" && field?.el !== tag) return void (tag.style.display = "none");
    const below = r.bottom + 28 < innerHeight;
    Object.assign(tag.style, { display: "block", left: `${r.left}px`, top: below ? `${r.bottom + 6}px` : `${Math.max(4, r.top - 26)}px` });
  }

  const radiusField = () => ({
    read: () => radiusLabel(selected, Math.round(currentRadius(selected))),
    step: (dir, e) => setRadius(selected, stepValue(currentRadius(selected), dir, e)),
    apply: (raw) => {
      if (raw === "full" || raw === "f") setRadius(selected, Infinity);
      else if (!Number.isNaN(parseFloat(raw))) setRadius(selected, snap(parseFloat(raw)));
    },
  });

  tag.addEventListener("pointerdown", (e) => e.stopPropagation());
  tag.addEventListener("click", () => selected && field?.el !== tag && openField(tag, "Radius ", radiusField()));

  handle.addEventListener("pointerdown", (e) => {
    if (!selected) return;
    e.preventDefault();
    e.stopPropagation();
    capture(handle, e);
    drag = { kind: "radius", start: currentRadius(selected), x: e.clientX, y: e.clientY };
  });
  handle.addEventListener("pointermove", (e) => {
    if (drag?.kind !== "radius" || !selected) return;
    /* Dragging toward the middle of the box rounds the corner more, like Figma. */
    const delta = (e.clientX - drag.x + (e.clientY - drag.y)) / 2;
    setRadius(selected, snap(drag.start + delta, e.altKey || e.metaKey || e.ctrlKey));
  });
  const endDrag = () => {
    drag = null;
    paint();
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);

  /* ================= Spacing ================= */

  const SPACE_PROPS = [...SIDES.map((s) => `padding-${s}`), ...SIDES.map((s) => `margin-${s}`), "row-gap", "column-gap"];
  const OPPOSITE = { top: "bottom", bottom: "top", left: "right", right: "left" };
  /* Figma's padding drag: ⌥ mirrors onto the opposite side, ⌥⇧ takes all four. */
  const dragProps = (prop, e) => {
    if (!/^(padding|margin)-/.test(prop) || !e.altKey) return [prop];
    if (e.shiftKey) return sidesOf(prop);
    const [kind, side] = prop.split("-");
    return [prop, `${kind}-${OPPOSITE[side]}`];
  };
  const sidesOf = (prop) => (/^(padding|margin)-/.test(prop) ? SIDES.map((s) => `${prop.split("-")[0]}-${s}`) : ["row-gap", "column-gap"]);

  /* One band per side. dir is the drag direction that grows the value: padding grows inward, margin outward. */
  const BANDS = [
    ["padding-top", [0, 1]],
    ["padding-right", [-1, 0]],
    ["padding-bottom", [0, -1]],
    ["padding-left", [1, 0]],
    ["margin-top", [0, -1]],
    ["margin-right", [1, 0]],
    ["margin-bottom", [0, 1]],
    ["margin-left", [-1, 0]],
  ].map(([prop, dir]) => {
    const kind = prop.split("-")[0];
    const band = document.createElement("div");
    band.className = `band ${kind} ${dir[1] ? "v" : "h"}`;
    const lb = document.createElement("div");
    lb.className = `lb ${kind}`;
    lb.title = `${prop}: drag the band (⌥ opposite side too, ⌥⇧ all sides, ⌘ off grid), or click to type (⇧↵ for all sides)`;
    spaceLayer.append(band, lb);
    return { prop, props: [prop], dir, kind, band, lb };
  });
  const gapLabel = document.createElement("div");
  gapLabel.className = "lb gap";
  gapLabel.title = "Gap: drag a gap, or click to type";
  spaceLayer.append(gapLabel);
  const gapBands = []; // pooled, one per space between children

  function setSpace(el, props, v) {
    const cs = getComputedStyle(el);
    if (!spaceEdits.has(el)) spaceEdits.set(el, { props: new Map(), ...describe(el) });
    const edit = spaceEdits.get(el);
    for (const prop of props) {
      const value = /^padding|gap/.test(prop) ? Math.max(0, v) : v;
      if (!edit.props.has(prop)) {
        edit.props.set(prop, { before: originalSpace.get(el)[prop], shown: cs.getPropertyValue(prop), inline: el.style.getPropertyValue(prop) });
      }
      const pe = edit.props.get(prop);
      el.style.setProperty(prop, `${value}px`);
      pe.after = `${value}px`;
      if (getComputedStyle(el).getPropertyValue(prop) === pe.shown) {
        if (pe.inline) el.style.setProperty(prop, pe.inline);
        else el.style.removeProperty(prop);
        edit.props.delete(prop);
      }
    }
    if (!edit.props.size) spaceEdits.delete(el);
    mark(el);
    render();
    paint();
  }

  /* ================= Fill and border ================= */

  const BORDER_SIDES = (what) => SIDES.map((s) => `border-${s}-${what}`);
  const STYLE_PROPS = ["background-color", ...BORDER_SIDES("width"), ...BORDER_SIDES("style"), ...BORDER_SIDES("color")];

  /* Computed colours come back as rgb()/rgba(); people and prompts read hex. */
  function hexOf(color) {
    const m = String(color).match(/rgba?\(([^)]+)\)/);
    if (!m) return color;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    if (a === 0) return "none";
    const hex = `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
    return a < 1 ? `${hex} at ${Math.round(a * 100)}%` : hex;
  }
  const isColorProp = (prop) => /color$/.test(prop);
  const shownStyle = (prop, v) => (isColorProp(prop) ? hexOf(v) : v);

  function setStyle(el, props, value, keep = false) {
    const cs = getComputedStyle(el);
    if (!styleEdits.has(el)) styleEdits.set(el, { props: new Map(), ...describe(el) });
    const edit = styleEdits.get(el);
    for (const prop of props) {
      if (!edit.props.has(prop)) {
        edit.props.set(prop, { before: originalStyle.get(el)?.[prop] ?? cs.getPropertyValue(prop), shown: cs.getPropertyValue(prop), inline: el.style.getPropertyValue(prop) });
      }
      const pe = edit.props.get(prop);
      el.style.setProperty(prop, value);
      pe.after = getComputedStyle(el).getPropertyValue(prop);
      /* keep: a value you set on purpose stays in the prompt even when it matches what the page computes
         (a border colour that equals the text colour it would otherwise inherit). */
      if (pe.after === pe.shown && !keep) {
        if (pe.inline) el.style.setProperty(prop, pe.inline);
        else el.style.removeProperty(prop);
        edit.props.delete(prop);
      }
    }
    if (!edit.props.size) styleEdits.delete(el);
    mark(el);
    render();
    paint();
  }

  /* A width on a borderless element needs a style too, or nothing shows. */
  function setBorderWidth(el, v) {
    v = Math.max(0, v);
    if (v > 0 && getComputedStyle(el).borderTopStyle === "none") setStyle(el, BORDER_SIDES("style"), "solid");
    setStyle(el, BORDER_SIDES("width"), `${v}px`);
  }

  function setColor(el, f, raw) {
    const v = raw.trim().toLowerCase();
    const value = v === "none" || v === "transparent" ? "transparent" : /^[0-9a-f]{3,8}$/.test(v) ? `#${v}` : v;
    if (!CSS.supports("color", value)) return;
    if (f === "fill") setStyle(el, ["background-color"], value);
    else {
      if (getComputedStyle(el).borderTopStyle === "none") setBorderWidth(el, 1);
      setStyle(el, BORDER_SIDES("color"), value, true);
    }
  }

  const spaceField = (props) => ({
    read: () => `${Math.round(px(getComputedStyle(selected), props[0]) * 10) / 10}`,
    step: (dir, e) => setSpace(selected, props, stepValue(px(getComputedStyle(selected), props[0]), dir, e)),
    apply: (raw, all) => {
      const v = parseFloat(raw);
      if (!Number.isNaN(v)) setSpace(selected, all ? sidesOf(props[0]) : props, snap(v));
    },
  });

  function gapInfo(cs) {
    if (/grid/.test(cs.display)) return { props: ["row-gap", "column-gap"], dir: null };
    if (!/flex/.test(cs.display)) return null;
    const row = !cs.flexDirection.startsWith("column");
    return { props: [row ? "column-gap" : "row-gap"], row, dir: row ? [1, 0] : [0, 1] };
  }

  function setBox(node, x, y, w, h) {
    Object.assign(node.style, { display: "block", left: `${x}px`, top: `${y}px`, width: `${Math.max(0, w)}px`, height: `${Math.max(0, h)}px` });
  }
  function setLabel(lb, x, y, text) {
    if (field?.el === lb) return;
    lb.textContent = text;
    Object.assign(lb.style, { display: "block", left: `${x}px`, top: `${y}px` });
  }

  function paintSpacing(r) {
    if (!r) {
      spaceLayer.style.display = "none";
      return;
    }
    spaceLayer.style.display = "block";
    const cs = getComputedStyle(selected);
    const b = Object.fromEntries(SIDES.map((s) => [s, px(cs, `border-${s}-width`)]));
    const p = Object.fromEntries(SIDES.map((s) => [s, px(cs, `padding-${s}`)]));
    const m = Object.fromEntries(SIDES.map((s) => [s, Math.max(0, px(cs, `margin-${s}`))]));
    const ix = r.left + b.left;
    const iy = r.top + b.top;
    const iw = r.width - b.left - b.right;
    const ih = r.height - b.top - b.bottom;
    const MIN = 6; // a 0 side still gets a band you can grab
    const t = (v) => Math.max(v, MIN);
    const geo = {
      "padding-top": [ix, iy, iw, t(p.top)],
      "padding-bottom": [ix, iy + ih - t(p.bottom), iw, t(p.bottom)],
      "padding-left": [ix, iy + p.top, t(p.left), ih - p.top - p.bottom],
      "padding-right": [ix + iw - t(p.right), iy + p.top, t(p.right), ih - p.top - p.bottom],
      "margin-top": [r.left, r.top - t(m.top), r.width, t(m.top)],
      "margin-bottom": [r.left, r.bottom, r.width, t(m.bottom)],
      "margin-left": [r.left - t(m.left), r.top, t(m.left), r.height],
      "margin-right": [r.right, r.top, t(m.right), r.height],
    };
    for (const bd of BANDS) {
      const [x, y, w, h] = geo[bd.prop];
      const value = px(cs, bd.prop);
      setBox(bd.band, x, y, w, h);
      bd.band.classList.toggle("zero", value === 0);
      bd.band.classList.toggle("drag", drag?.band === bd.band);
      const show = value !== 0 || hoverBand === bd.band || drag?.band === bd.band || field?.el === bd.lb;
      if (show) setLabel(bd.lb, x + w / 2, y + h / 2, `${Math.round(value * 10) / 10}`);
      else bd.lb.style.display = "none";
    }

    /* Gap: a band between each pair of children along the main axis; grid only gets the label. */
    const gap = gapInfo(cs);
    const kids = gap
      ? [...selected.children].filter((k) => {
          const kcs = getComputedStyle(k);
          return kcs.display !== "none" && !/absolute|fixed/.test(kcs.position) && k.getBoundingClientRect().width + k.getBoundingClientRect().height > 0;
        })
      : [];
    let used = 0;
    if (gap && gap.dir && kids.length > 1) {
      const rects = kids.map((k) => k.getBoundingClientRect());
      for (let i = 0; i < rects.length - 1 && used < 40; i++) {
        const a = rects[i];
        const c = rects[i + 1];
        const from = gap.row ? a.right : a.bottom;
        const to = gap.row ? c.left : c.top;
        if (to < from - 1) continue; // wrapped onto a new line or reversed
        let band = gapBands[used];
        if (!band) {
          band = document.createElement("div");
          spaceLayer.insertBefore(band, gapLabel);
          gapBands.push(band);
        }
        band.className = `band gap ${gap.row ? "h" : "v"}`;
        band.classList.toggle("drag", drag?.band === band);
        const size = Math.max(to - from, MIN);
        const start = (from + to) / 2 - size / 2;
        if (gap.row) setBox(band, start, iy + p.top, size, ih - p.top - p.bottom);
        else setBox(band, ix + p.left, start, iw - p.left - p.right, size);
        band.gapDir = gap.dir;
        used++;
      }
    }
    gapBands.slice(used).forEach((band) => (band.style.display = "none"));
    if (gap && kids.length > 1) {
      const rg = px(cs, "row-gap");
      const cg = px(cs, "column-gap");
      const text = gap.dir ? `Gap ${px(cs, gap.props[0])}` : rg === cg ? `Gap ${cg}` : `Gap ${rg} / ${cg}`;
      const first = gapBands[0]?.style.display === "block" && used ? gapBands[0].getBoundingClientRect() : null;
      if (first) setLabel(gapLabel, first.left + first.width / 2, first.top + first.height / 2, text);
      else setLabel(gapLabel, ix + iw / 2, iy + ih / 2, text);
      gapLabel.gapProps = gap.props;
    } else {
      gapLabel.style.display = "none";
    }
  }

  spaceLayer.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const lb = e.target.closest(".lb");
    if (lb) return; // labels open a field on click
    const band = e.target.closest(".band");
    if (!band || !selected) return;
    e.preventDefault();
    capture(band, e);
    const bd = BANDS.find((x) => x.band === band);
    const props = bd ? bd.props : gapLabel.gapProps;
    drag = { kind: "space", band, props, dir: bd ? bd.dir : band.gapDir, start: px(getComputedStyle(selected), props[0]), x: e.clientX, y: e.clientY };
    paint();
  });
  spaceLayer.addEventListener("pointermove", (e) => {
    const band = e.target.closest?.(".band");
    if (!drag && hoverBand !== band) hoverBand = band;
    if (drag?.kind !== "space" || !selected) return;
    const delta = drag.dir[0] * (e.clientX - drag.x) + drag.dir[1] * (e.clientY - drag.y);
    const props = drag.props.length > 1 ? drag.props : dragProps(drag.props[0], e);
    setSpace(selected, props, snap(drag.start + delta, e.metaKey || e.ctrlKey)); // ⌘ ignores the grid, like Figma's snapping
  });
  spaceLayer.addEventListener("pointerleave", () => (hoverBand = null));
  const endSpaceDrag = () => {
    if (drag?.kind === "space") drag = null;
    paint();
  };
  spaceLayer.addEventListener("pointerup", endSpaceDrag);
  spaceLayer.addEventListener("pointercancel", endSpaceDrag);
  spaceLayer.addEventListener("click", (e) => {
    const lb = e.target.closest(".lb");
    if (!lb || !selected || field?.el === lb) return;
    if (lb === gapLabel) openField(lb, "Gap ", spaceField(gapLabel.gapProps));
    else openField(lb, "", spaceField(BANDS.find((x) => x.lb === lb).props));
  });

  /* ================= Move ================= */

  /* Two modes, switched in the toolbar:
     Flow (default)  drag an element into any container, like Figma's auto layout. A line shows the slot;
                     on drop a styled copy takes that slot and the original leaves, so the page reflows
                     exactly as the change would. The prompt asks for a JSX move or reorder.
     Absolute        drag it anywhere. It floats above everything, a dashed ghost keeps its old spot, and
                     the prompt asks for position: absolute there (with an annotated screenshot). */
  let moveAbsolute = false;
  try {
    moveAbsolute = localStorage.getItem("ptk-move") === "absolute";
  } catch {}
  let pendingPrompt = false; // a screenshot went to the clipboard; the next ⌘↵ copies the text

  const docRect = (r) => ({ left: r.left + scrollX, top: r.top + scrollY, width: r.width, height: r.height });
  const viewRect = (d) => {
    const left = d.left - scrollX;
    const top = d.top - scrollY;
    return { left, top, width: d.width, height: d.height, right: left + d.width, bottom: top + d.height };
  };

  const cloneLayer = document.createElement("div");
  cloneLayer.setAttribute("data-ptk-clones", "");
  Object.assign(cloneLayer.style, { position: "absolute", left: "0", top: "0", width: "0", height: "0", zIndex: "2147483000", pointerEvents: "none" });
  const inflowOwner = new WeakMap(); // in-flow copy -> the original element

  /* A copy with every computed style inlined, so it looks right wherever it goes. */
  function styledCopy(el) {
    if (el.hasAttribute("data-ptk-inflow")) return el.cloneNode(true); // already fully inlined
    const clone = el.cloneNode(true);
    const src = [el, ...el.querySelectorAll("*")];
    const dst = [clone, ...clone.querySelectorAll("*")];
    src.forEach((o, i) => {
      const c = dst[i];
      if (!c) return;
      const cs = getComputedStyle(o);
      let css = "";
      for (let j = 0; j < cs.length; j++) if (cs[j] !== "visibility") css += `${cs[j]}:${cs.getPropertyValue(cs[j])};`;
      c.setAttribute("style", css);
      c.removeAttribute("id");
      [...c.attributes].forEach((a) => a.name.startsWith("data-ptk") && c.removeAttribute(a.name));
      c.style.pointerEvents = "none";
      if (o.tagName === "CANVAS") {
        try {
          c.getContext("2d").drawImage(o, 0, 0);
        } catch {}
      }
    });
    Object.assign(clone.style, { translate: "none", transform: "none", transition: "none", animation: "none" });
    return clone;
  }

  function floatCopy(node, rect) {
    const clone = styledCopy(node);
    clone.removeAttribute("data-ptk-inflow");
    const shadow = getComputedStyle(node).boxShadow;
    Object.assign(clone.style, {
      position: "absolute",
      margin: "0",
      boxSizing: "border-box",
      visibility: "visible",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      boxShadow: `${shadow === "none" ? "" : `${shadow}, `}0 12px 32px rgba(0,0,0,.35)`,
    });
    if (!cloneLayer.isConnected) document.documentElement.append(cloneLayer);
    cloneLayer.append(clone);
    return clone;
  }

  const contains = (outer, inner, slack = 2) =>
    inner.left >= outer.left - slack && inner.top >= outer.top - slack && inner.right <= outer.right + slack && inner.bottom <= outer.bottom + slack;
  const visibleKids = (c, skip) =>
    [...c.children].filter((k) => {
      /* Moved originals are described on their own; their in-flow copies stand in for them. */
      if (k === skip || k === host || (skip && k.contains(skip)) || moveEdits.has(k)) return false;
      const r = k.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(k).display !== "none";
    });

  /* Text, controls and inline boxes hold copy, not layout: dropping onto a paragraph is not a move into it. */
  const LEAF = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "SPAN", "A", "BUTTON", "LABEL", "LI", "STRONG", "EM", "SMALL", "CODE", "INPUT", "TEXTAREA", "SELECT", "IMG", "SVG", "VIDEO", "CANVAS"]);
  const isLayoutBox = (c) => !LEAF.has(c.tagName.toUpperCase()) && !c.hasAttribute("data-ptk-inflow") && !/^inline(?!-(flex|grid|block))/.test(getComputedStyle(c).display);

  /* Human-readable handle for an element in the prompt: tag, readable class, a bit of its text. */
  function short(n) {
    if (!n) return "nothing";
    if (n === document.body) return "<body>";
    const cls = [...n.classList].find((c) => !c.startsWith("ptk"));
    const name = cls ? `.${cls.replace(/^[A-Za-z]+-module__[A-Za-z0-9_-]+__/, "")}` : "";
    /* A moved element is hidden while its floating copy shows: read the copy's visible text. */
    const text = (n.innerText || moveEdits.get(n)?.clone?.innerText || "").trim().replace(/\s+/g, " ");
    const snippet = text ? ` "${text.slice(0, 32)}${text.length > 32 ? "…" : ""}"` : "";
    const comp = componentNames(inflowOwner.get(n) ?? n)[0];
    return `<${n.tagName.toLowerCase()}${name}${snippet}>${comp ? ` (in <${comp}>)` : ""}`;
  }

  /* Reading order inside a container: along x for a flex row, otherwise top to bottom, then left to right. */
  function slotFor(container, kids, x, y) {
    const cs = getComputedStyle(container);
    const rowFlex = /flex/.test(cs.display) && !cs.flexDirection.startsWith("column");
    const before = (k) => {
      const kr = k.getBoundingClientRect();
      if (rowFlex) return kr.left + kr.width / 2 < x;
      if (kr.bottom <= y) return true;
      if (kr.top >= y) return false;
      return kr.left + kr.width / 2 < x;
    };
    let index = kids.length;
    for (let i = 0; i < kids.length; i++) {
      if (!before(kids[i])) {
        index = i;
        break;
      }
    }
    return { container, rowFlex, index, prev: kids[index - 1] ?? null, next: kids[index] ?? null, count: kids.length + 1 };
  }

  /* Where the element sits now, by visible siblings in DOM order (1-based for people). */
  function slotOf(el) {
    const kids = visibleKids(el.parentElement, null);
    const index = kids.indexOf(el);
    return { container: el.parentElement, index, prev: kids[index - 1] ?? null, next: kids[index + 1] ?? null, count: kids.length };
  }

  const rectOf = (el) => {
    const e = moveEdits.get(el);
    return (e?.mode === "flow" ? e.inflow : e?.clone ?? el).getBoundingClientRect();
  };
  const movedAt = (x, y) => {
    for (const [el, e] of [...moveEdits].reverse()) {
      if (e.mode !== "absolute") continue;
      const r = e.clone.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
    }
    return null;
  };

  /* Delete with the Move tool: the element disappears and the page reflows as if it were gone. */
  function removeElement(el) {
    if (!el || el === document.body || removeEdits.has(el)) return;
    const moved = moveEdits.get(el);
    if (moved) {
      unmove(el, moved);
      moveEdits.delete(el);
    }
    /* Repeats: elements in the same spot of the same kind of parent (".member-row > span.role"), so a
       classless <kbd> in every tile counts too. */
    const d = describe(el);
    let twins = 1;
    try {
      twins = Math.max(1, document.querySelectorAll(d.path.split(" > ").slice(-2).join(" > ")).length);
    } catch {}
    removeEdits.set(el, { display: el.style.display, twins, label: short(el), ...d });
    el.style.display = "none";
    select(null);
    hovered = null;
    mark(el);
    render();
    paint();
  }

  function unmove(el, edit) {
    edit.clone?.remove();
    edit.inflow?.remove();
    el.style.visibility = edit.inline.visibility;
    el.style.display = edit.inline.display;
  }

  function newEdit(el, mode) {
    const old = moveEdits.get(el);
    if (old && old.mode === mode) return old;
    if (old) {
      unmove(el, old);
      moveEdits.delete(el);
    }
    const edit = { mode, from: { ...slotOf(el), rect: docRect(el.getBoundingClientRect()) }, inline: { visibility: el.style.visibility, display: el.style.display }, ...describe(el) };
    moveEdits.set(el, edit);
    return edit;
  }

  /* ---------- Absolute ---------- */

  function setMove(el, dx, dy) {
    const fresh = moveEdits.get(el)?.mode !== "absolute";
    const edit = newEdit(el, "absolute");
    if (fresh) {
      edit.dx = edit.dy = 0;
      edit.clone = floatCopy(el, edit.from.rect);
      /* Lowest move number not in use, so numbers and colours stay stable while you work. */
      const used = new Set([...moveEdits.values()].filter((m) => m !== edit && m.mode === "absolute").map((m) => m.n));
      edit.n = 1;
      while (used.has(edit.n)) edit.n++;
      [edit.colorName, edit.color] = MOVE_COLORS[(edit.n - 1) % MOVE_COLORS.length];
      Object.assign(edit.clone.style, { outline: `2px solid ${edit.color}`, outlineOffset: "2px" });
      el.style.visibility = "hidden";
    }
    edit.dx = dx;
    edit.dy = dy;
    if (dx === 0 && dy === 0) {
      unmove(el, edit);
      moveEdits.delete(el);
    } else {
      Object.assign(edit.clone.style, { left: `${edit.from.rect.left + dx}px`, top: `${edit.from.rect.top + dy}px` });
    }
    mark(el);
    render();
    paint();
  }

  /* The container an absolute element now floats in: the deepest layout box under its centre that holds it. */
  function containerFor(el, r) {
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
    const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    const hits = document.elementsFromPoint(cx, cy).filter((n) => n !== el && !el.contains(n) && !host.contains(n) && n !== host);
    for (let c = hits[0]; c && c !== document.documentElement; c = c.parentElement) {
      if (c === document.body) return c;
      if (!el.contains(c) && isLayoutBox(c) && contains(c.getBoundingClientRect(), r)) return c;
    }
    return document.body;
  }

  function overlaps(r, kids) {
    return kids.filter((n) => {
      const k = n.getBoundingClientRect();
      const w = Math.min(r.right, k.right) - Math.max(r.left, k.left);
      const h = Math.min(r.bottom, k.bottom) - Math.max(r.top, k.top);
      return w > 0 && h > 0 && w * h > 0.15 * Math.min(r.width * r.height, k.width * k.height);
    });
  }

  function describeAbsolute(el, edit) {
    const r = edit.clone.getBoundingClientRect();
    const container = containerFor(el, r);
    const c = container.getBoundingClientRect();
    const lines = [];
    const off = [`left ${Math.round(r.left - c.left)}px`, `top ${Math.round(r.top - c.top)}px`];
    const right = Math.round(c.right - r.right);
    const bottom = Math.round(c.bottom - r.bottom);
    lines.push(`position: absolute inside ${short(container)}${container !== edit.from.container ? ` (moved out of ${short(edit.from.container)})` : ""}`);
    lines.push(`offsets: ${off.join(", ")} (or right ${right}px, bottom ${bottom}px if that anchor reads better)`);
    const ov = overlaps(r, visibleKids(container, el));
    if (ov.length) lines.push(`sits on top of: ${ov.map(short).join(", ")}`);
    return lines.map((l) => `   ${l}`).join("\n");
  }

  function startMove(e, el) {
    const edit = moveEdits.get(el);
    const start = edit?.mode === "absolute" ? [edit.dx, edit.dy] : [0, 0];
    drag = { kind: "move", el, x: e.clientX, y: e.clientY, start };
  }

  function dragMove(e) {
    let dx = e.clientX - drag.x;
    let dy = e.clientY - drag.y;
    /* ⇧ locks to the stronger axis, ⌘ (or ⌥) leaves the grid, like Figma. */
    if (e.shiftKey && Math.abs(dx) > Math.abs(dy)) dy = 0;
    else if (e.shiftKey) dx = 0;
    const free = e.metaKey || e.ctrlKey || e.altKey;
    setMove(drag.el, snap(drag.start[0] + dx, free), snap(drag.start[1] + dy, free));
  }

  /* ---------- Flow ---------- */

  /* Put the element into a slot: its in-flow copy goes there and the original leaves the layout. */
  function placeFlow(el, container, next) {
    const edit = newEdit(el, "flow");
    if (!edit.inflow) {
      el.style.display = edit.inline.display; // measure it in place before the copy is made
      edit.inflow = styledCopy(el);
      edit.inflow.setAttribute("data-ptk-inflow", "");
      edit.inflow.style.pointerEvents = "auto";
      edit.inflow.style.visibility = "visible";
      if (/absolute|fixed/.test(getComputedStyle(el).position)) edit.inflow.style.position = "static";
      inflowOwner.set(edit.inflow, el);
    }
    edit.inflow.remove();
    if (container === edit.from.container && next === edit.from.next) {
      unmove(el, edit); // dropped back where it was
      moveEdits.delete(el);
    } else {
      container.insertBefore(edit.inflow, next && next.parentElement === container ? next : null);
      el.style.display = "none";
      const kids = visibleKids(container, el);
      const index = kids.indexOf(edit.inflow);
      edit.to = { container, index, prev: kids[index - 1] ?? null, next: kids[index + 1] ?? null, count: kids.length };
    }
    mark(el);
    render();
    paint();
  }

  /* The slot under the pointer: deepest layout box there, then the gap between its children. */
  function slotAt(x, y, el) {
    const edit = moveEdits.get(el);
    const own = (n) => n === el || el.contains(n) || n === host || cloneLayer.contains(n) || (edit?.inflow && edit.inflow.contains(n));
    let c = document.elementsFromPoint(x, y).find((n) => !own(n)) ?? document.body;
    while (c && c !== document.body && (own(c) || !isLayoutBox(c))) c = c.parentElement;
    c = c ?? document.body;
    const kids = visibleKids(c, el).filter((k) => k !== edit?.inflow);
    return slotFor(c, kids, x, y);
  }

  function startFlowDrag(e, el) {
    const edit = moveEdits.get(el);
    const src = edit?.mode === "flow" ? edit.inflow : edit?.mode === "absolute" ? edit.clone : el;
    const r = src.getBoundingClientRect();
    const float = floatCopy(edit?.mode === "absolute" ? el : src, docRect(r));
    float.style.opacity = ".9";
    const hide = edit?.mode === "absolute" ? edit.clone : src;
    drag = { kind: "flow", el, float, hide, hideVis: hide.style.visibility, x: e.clientX, y: e.clientY, r: docRect(r), slot: null };
    hide.style.visibility = "hidden";
  }

  function dragFlow(e) {
    drag.float.style.left = `${drag.r.left + e.clientX - drag.x}px`;
    drag.float.style.top = `${drag.r.top + e.clientY - drag.y}px`;
    drag.slot = slotAt(e.clientX, e.clientY, drag.el);
    paint();
  }

  function dropFlow(cancel) {
    const { el, float, hide, hideVis, slot } = drag;
    drag = null;
    float.remove();
    hide.style.visibility = hideVis;
    if (!cancel && slot) placeFlow(el, slot.container, slot.next);
    else paint();
  }

  /* Arrow keys in flow: step one slot earlier or later among the siblings, like Figma's auto layout. */
  function flowNudge(el, dir) {
    const edit = moveEdits.get(el)?.mode === "flow" ? moveEdits.get(el) : null;
    const container = edit?.to?.container ?? el.parentElement;
    const kids = visibleKids(container, el).filter((k) => k !== edit?.inflow);
    const at = edit?.to ? edit.to.index : slotOf(el).index;
    const index = Math.max(0, Math.min(kids.length, at + dir));
    placeFlow(el, container, kids[index] ?? null);
  }

  function describeFlow(edit) {
    const f = edit.from;
    const t = edit.to;
    const around = `${t.prev ? `after ${short(t.prev)}` : "first"}${t.next ? `, before ${short(t.next)}` : ""}`;
    if (t.container === f.container) {
      return `   reorder: position ${f.index + 1} → ${t.index + 1} of ${t.count} in ${short(t.container)} (now ${around})`;
    }
    const how = t.container.contains(f.container) ? " (an ancestor of where it was)" : f.container.contains(t.container) ? " (inside where it was)" : "";
    return `   move: out of ${short(f.container)} (position ${f.index + 1} of ${f.count})\n   into: ${short(t.container)}${how} at position ${t.index + 1} of ${t.count} (${around})`;
  }

  /* ---------- overlay ---------- */

  const insertLine = Object.assign(document.createElement("div"), { className: "insert" });
  root.append(insertLine);

  /* Add to Figma (in the side panel): one click copies a prompt for the agent to capture that element
     into Figma through the Figma MCP server (its generate_figma_design capture). */
  const figButton = panel.querySelector(".addfig");

  function figmaPrompt(el) {
    const d = describe(el);
    return `Add this element to Figma: ${short(el)} on ${location.href}
Selector: ${d.path}

Use the Figma MCP server for this (its generate_figma_design capture), not a screenshot or a rebuild by hand: capture it from the running page with "Select element" on this element, so it lands as editable Figma layers. Ask me which Figma file to use if you don't have one.`;
  }

  figButton.addEventListener("click", async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(figmaPrompt(selected));
      lastCopy = "figma";
      status = "done";
      message = "Copied. Paste it into your agent";
    } catch {
      status = "error";
      message = "Could not reach the clipboard. Click the page and try again";
    }
    render();
    paint();
    setTimeout(() => status !== "idle" && ((status = "idle"), render(), paint()), 2400);
  });

  function paintMove(r) {
    /* Ghosts: one dashed placeholder per absolute move, at its original spot. */
    const list = tool === "move" ? [...moveEdits.values()].filter((e) => e.mode === "absolute") : [];
    while (ghosts.children.length < list.length) ghosts.append(Object.assign(document.createElement("div"), { className: "ghost" }));
    [...ghosts.children].forEach((g, i) => {
      const e = list[i];
      if (!e) return (g.style.display = "none");
      const v = viewRect(e.from.rect);
      Object.assign(g.style, {
        display: "block",
        left: `${v.left}px`,
        top: `${v.top}px`,
        width: `${v.width}px`,
        height: `${v.height}px`,
        outlineColor: e.color,
        background: `repeating-linear-gradient(45deg, ${e.color}2e 0 2px, transparent 2px 7px)`,
      });
    });
    insertLine.style.display = dropBox.style.display = mtag.style.display = "none";
    if (tool !== "move") return;
    const tagAt = (rect, html, color = BLUE) => {
      mtag.innerHTML = html;
      mtag.style.background = color;
      const below = rect.bottom + 28 < innerHeight;
      Object.assign(mtag.style, { display: "block", left: `${rect.left}px`, top: below ? `${rect.bottom + 6}px` : `${Math.max(4, rect.top - 26)}px` });
    };
    const name = (n) => esc(short(n).replace(/ \(in <.*$/, ""));

    if (drag?.kind === "flow" && drag.slot) {
      const s = drag.slot;
      const c = s.container.getBoundingClientRect();
      const cs = getComputedStyle(s.container);
      const pl = c.left + px(cs, "padding-left");
      const pr = c.right - px(cs, "padding-right");
      const pt = c.top + px(cs, "padding-top");
      const pb = c.bottom - px(cs, "padding-bottom");
      const a = s.prev?.getBoundingClientRect();
      const b = s.next?.getBoundingClientRect();
      if (s.rowFlex) {
        const x = a && b ? (a.right + b.left) / 2 : a ? a.right + 2 : b ? b.left - 2 : pl;
        const ref = a ?? b;
        Object.assign(insertLine.style, { display: "block", left: `${x - 1}px`, top: `${ref ? ref.top : pt}px`, width: "2px", height: `${ref ? ref.height : pb - pt}px` });
      } else {
        const y = a && b ? (a.bottom + b.top) / 2 : a ? a.bottom + 2 : b ? b.top - 2 : pt;
        Object.assign(insertLine.style, { display: "block", left: `${pl}px`, top: `${y - 1}px`, width: `${pr - pl}px`, height: "2px" });
      }
      place(dropBox, s.container === document.body ? null : s.container);
      tagAt(drag.float.getBoundingClientRect(), `position ${s.index + 1} of ${s.count} <span class="into">· in ${name(s.container)}</span>`);
      return;
    }
    if (!r || !selected) return;
    const edit = moveEdits.get(selected);
    if (edit?.mode === "absolute") {
      const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
      tagAt(r, `Move ${edit.n} <span class="into">· x ${sign(edit.dx)}  y ${sign(edit.dy)}</span>`, edit.color);
    } else if (edit?.mode === "flow" && edit.to) {
      const t = edit.to;
      tagAt(r, t.container === edit.from.container ? `position ${edit.from.index + 1} → ${t.index + 1}` : `position ${t.index + 1} of ${t.count} <span class="into">· in ${name(t.container)}</span>`);
    }
  }

  /* ---------- screenshot (absolute moves) ---------- */

  /* Grab one frame of this tab (Chrome asks once to share it), the whole visible page, and draw an
     arrow from each old spot to its new one. The toolkit's own UI is hidden for the frame. */
  async function screenshot() {
    const moves = [...moveEdits.values()].filter((e) => e.mode === "absolute");
    if (!moves.length || !navigator.mediaDevices?.getDisplayMedia) return null;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: false, preferCurrentTab: true, selfBrowserSurface: "include" });
    } catch {
      return null;
    }
    const hidden = [...root.children].filter((n) => n.tagName !== "STYLE"); // ghosts too: the image draws its own
    const was = hidden.map((n) => n.style.visibility);
    hidden.forEach((n) => (n.style.visibility = "hidden"));
    try {
      const video = Object.assign(document.createElement("video"), { srcObject: stream, muted: true });
      await video.play();
      await new Promise((res) => setTimeout(res, 250)); // let the hidden UI leave the frame
      const scale = video.videoWidth / innerWidth;
      /* The whole visible page, so the agent sees each move in the context of everything around it. */
      const [x0, y0, x1, y1] = [0, 0, innerWidth, innerHeight];
      /* Instructions under the page, one line per move in its colour, so the image explains itself. */
      const notes = moves
        .sort((a, b) => a.n - b.n)
        .map((e) => ({ color: e.color, text: `Move ${e.n}: move the ${e.colorName}-marked element to its new position.` })); // the picture shows which one
      const FOOT = 20 + notes.length * 24 + 12;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round((x1 - x0) * scale);
      const shotH = Math.round((y1 - y0) * scale);
      canvas.height = shotH + Math.round(FOOT * scale);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, x0 * scale, y0 * scale, canvas.width, shotH, 0, 0, canvas.width, shotH);
      ctx.scale(scale, scale);
      {
        const top = y1 - y0;
        ctx.fillStyle = "#141414";
        ctx.fillRect(0, top, x1 - x0, FOOT);
        ctx.fillStyle = "rgba(255,255,255,.12)";
        ctx.fillRect(0, top, x1 - x0, 1);
        ctx.font = '500 14px ui-sans-serif, system-ui, -apple-system, sans-serif';
        notes.forEach((note, k) => {
          const y = top + 20 + k * 24;
          ctx.fillStyle = note.color;
          ctx.beginPath();
          ctx.arc(26, y + 8, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,.92)";
          ctx.fillText(note.text, 40, y + 13);
        });
      }
      const W = x1 - x0;
      const H = y1 - y0;

      /* Where the line from a box's centre toward a point leaves the box. */
      const edge = (b, tx, ty) => {
        const cx = b.left + b.width / 2 - x0;
        const cy = b.top + b.height / 2 - y0;
        const dx = tx - cx;
        const dy = ty - cy;
        const t = Math.min(dx ? b.width / 2 / Math.abs(dx) : Infinity, dy ? b.height / 2 / Math.abs(dy) : Infinity, 1);
        return [cx + dx * t, cy + dy * t];
      };
      const pill = (text, x, y, color) => {
        ctx.font = '600 11px ui-sans-serif, system-ui, -apple-system, sans-serif';
        const w = ctx.measureText(text).width + 10;
        const px0 = Math.min(Math.max(2, x), W - w - 2);
        const py0 = Math.min(Math.max(2, y), H - 18);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(px0, py0, w, 16, 5);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.fillText(text, px0 + 5, py0 + 12);
      };

      /* Where each element was: a dashed, hatched box in its colour, drawn into the image whatever tool is on. */
      for (const e of moves) {
        const a = viewRect(e.from.rect);
        const [x, y, w, h] = [a.left - x0, a.top - y0, a.width, a.height];
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
        ctx.strokeStyle = `${e.color}55`;
        ctx.lineWidth = 2;
        for (let d = -h; d < w; d += 7) {
          ctx.beginPath();
          ctx.moveTo(x + d, y + h);
          ctx.lineTo(x + d + h, y);
          ctx.stroke();
        }
        ctx.restore();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
        ctx.setLineDash([]);
      }

      for (const e of moves) {
        const a = viewRect(e.from.rect);
        const b = e.clone.getBoundingClientRect();
        const [acx, acy] = [a.left + a.width / 2 - x0, a.top + a.height / 2 - y0];
        const [bcx, bcy] = [b.left + b.width / 2 - x0, b.top + b.height / 2 - y0];
        /* Edge to edge when the boxes sit apart. When they overlap (a big element nudged a little), each
           centre lies inside the other box and edge() would hand back the wrong ends, flipping the arrow:
           then go centre to centre, old spot to new. */
        /* Edge to edge only when the boxes sit apart. When they touch or overlap at all, edge to edge would run
           backwards (from the old box's far side to the new box's near side): go centre to centre, old to new. */
        const overlap = a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
        const [ax, ay] = overlap ? [acx, acy] : edge(a, bcx, bcy);
        const [bx, by] = overlap ? [bcx, bcy] : edge(b, acx, acy);
        /* Bend the arrow off the content, toward whichever side of the page has more room. */
        const len = Math.hypot(bx - ax, by - ay) || 1;
        let nx = -(by - ay) / len;
        let ny = (bx - ax) / len;
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const bend = Math.min(80, len * 0.3);
        const room = (sx, sy) => Math.min(Math.max(0, mx + sx * bend), W) === mx + sx * bend && Math.min(Math.max(0, my + sy * bend), H) === my + sy * bend;
        if (ny > 0 && room(-nx, -ny) && my > H / 2) [nx, ny] = [-nx, -ny];
        else if (!room(nx, ny)) [nx, ny] = [-nx, -ny];
        const qx = mx + nx * bend;
        const qy = my + ny * bend;
        const ang = Math.atan2(by - qy, bx - qx);
        const head = () => {
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx - 12 * Math.cos(ang - 0.45), by - 12 * Math.sin(ang - 0.45));
          ctx.lineTo(bx - 12 * Math.cos(ang + 0.45), by - 12 * Math.sin(ang + 0.45));
          ctx.closePath();
        };
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (const [color, width] of [["rgba(255,255,255,.9)", 6], [e.color, 2.5]]) {
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.quadraticCurveTo(qx, qy, bx, by);
          ctx.stroke();
          head();
          if (width > 3) ctx.stroke();
          ctx.fill();
        }
        pill(`Move ${e.n} · from`, a.left - x0, a.top - y0 - 20, e.color);
        pill(`Move ${e.n}`, b.left - x0, b.top - y0 - 20, e.color);
      }
      return await new Promise((res) => canvas.toBlob(res, "image/png"));
    } catch {
      return null;
    } finally {
      stream.getTracks().forEach((t) => t.stop());
      hidden.forEach((n, i) => (n.style.visibility = was[i]));
    }
  }

  /* ================= Panel: Figma's design sidebar for the selection ================= */

  /* Every field names the props it drives; "radius" and "gap" resolve per element. Type a value, step
     with ↑ ↓ (⇧ 10, ⌥/⌘ 1px), or drag the field's label to scrub, like Figma. */
  const fieldProps = (f) => {
    if (f === "radius") return null;
    if (f === "border") return BORDER_SIDES("width");
    if (f === "fill") return ["background-color"];
    if (f === "border-color") return BORDER_SIDES("color");
    if (f === "gap") return gapInfo(getComputedStyle(selected))?.props ?? [];
    return f.split(" ");
  };

  function readField(f) {
    if (f === "radius") return radiusLabel(selected, Math.round(currentRadius(selected)));
    if (f === "fill") return hexOf(getComputedStyle(selected).backgroundColor);
    if (f === "border-color") {
      const cs = getComputedStyle(selected);
      return cs.borderTopStyle === "none" || !px(cs, "border-top-width") ? "none" : hexOf(cs.borderTopColor);
    }
    const cs = getComputedStyle(selected);
    const values = fieldProps(f).map((prop) => Math.round(px(cs, prop) * 10) / 10);
    return values.every((v) => v === values[0]) ? `${values[0] ?? ""}` : "Mixed";
  }

  function writeField(f, v) {
    if (f === "fill" || f === "border-color") return setColor(selected, f, String(v));
    if (f === "border") return setBorderWidth(selected, v);
    if (f === "radius") setRadius(selected, v);
    else setSpace(selected, fieldProps(f), v);
  }

  const fieldNow = (f) => (f === "radius" ? currentRadius(selected) : px(getComputedStyle(selected), fieldProps(f)[0]));

  function applyFieldInput(input) {
    const f = input.closest(".f").dataset.f;
    const raw = input.value.trim().toLowerCase();
    if (!selected || raw === "" || raw === "mixed") return;
    if (f === "fill" || f === "border-color") return raw !== readField(f) && writeField(f, raw.replace(/ at \d+%$/, ""));
    if (f === "radius" && (raw === "full" || raw === "f")) return writeField(f, Infinity);
    const v = parseFloat(raw);
    if (!Number.isNaN(v)) writeField(f, snap(v));
  }

  let lastPanelFor = null;
  /* Dock: while Move, Radius or Spacing has a selection, the panel sits on the right and the page makes room. */
  const DOCK = 260;
  let docked = null; // the page's own inline margin-right while docked
  function setDock(on) {
    const html = document.documentElement;
    if (on && docked === null) {
      docked = html.style.getPropertyValue("margin-right");
      html.style.setProperty("margin-right", `${DOCK}px`, "important");
      bar.style.setProperty("--dock", `${DOCK}px`);
    } else if (!on && docked !== null) {
      if (docked) html.style.setProperty("margin-right", docked);
      else html.style.removeProperty("margin-right");
      docked = null;
      bar.style.removeProperty("--dock");
    }
  }
  const dockWidth = () => (docked === null ? 0 : DOCK);

  function paintPanel() {
    /* Only once something is selected: the page makes room for the panel then, and gets it back on deselect. */
    const on = !!tool && !!selected?.isConnected;
    setDock(on);
    if (!on) {
      panel.style.display = "none";
      lastPanelFor = null;
      closePicker();
      return;
    }
    panel.style.display = "block";
    const has = !!selected?.isConnected;
    panel.toggleAttribute("data-empty", !has);
    if (!has) {
      closePicker();
      panel.querySelector(".el").textContent = "No selection";
      panel.querySelector(".comp").textContent = "";
      lastPanelFor = null;
      return;
    }
    if (lastPanelFor !== selected) {
      lastPanelFor = selected;
      closePicker();
      const d = describe(selected);
      const cls = [...selected.classList].filter((c) => !c.startsWith("ptk"))[0];
      panel.querySelector(".el").textContent = `<${d.tag}>${cls ? ` .${cls.replace(/^[A-Za-z]+-module__[A-Za-z0-9_-]+__/, "")}` : ""}`;
      panel.querySelector(".comp").textContent = d.components.length ? d.components.map((c) => `<${c}>`).join(" in ") : "";
      /* Sides that already differ open the four-field view, like Figma's independent padding. */
      const cs = getComputedStyle(selected);
      const split = px(cs, "padding-top") !== px(cs, "padding-bottom") || px(cs, "padding-left") !== px(cs, "padding-right");
      setIndependent(split);
    }
    panel.querySelector('[data-sec="gap"]').hidden = !gapInfo(getComputedStyle(selected));
    const focused = root.activeElement;
    for (const f of panel.querySelectorAll(".f.c")) {
      const cs = getComputedStyle(selected);
      const color = f.dataset.f === "fill" ? cs.backgroundColor : readField("border-color") === "none" ? "transparent" : cs.borderTopColor;
      f.querySelector(".sw").style.setProperty("--sw", color);
      const hex = hexOf(color);
      if (cp.for === f.dataset.f) syncPicker(hex);
    }
    for (const input of panel.querySelectorAll(".f input")) {
      if (input === focused) continue;
      const value = readField(input.closest(".f").dataset.f);
      if (value === "Mixed") {
        input.value = "";
        input.placeholder = "Mixed";
      } else if (input.value !== value) {
        input.value = value;
      }
    }
  }

  function setIndependent(on) {
    panel.querySelector(".indep").setAttribute("aria-pressed", String(on));
    panel.querySelector("[data-four]").hidden = !on;
    panel.querySelector("[data-pair]").hidden = on;
  }

  panel.addEventListener("click", (e) => {
    const b = e.target.closest(".indep");
    if (b) setIndependent(b.getAttribute("aria-pressed") !== "true");
  });

  panel.addEventListener("keydown", (e) => {
    const input = e.target.closest?.("input");
    if (!input) return;
    e.stopPropagation(); // the page and the toolkit's own shortcuts stay quiet while typing
    if (!input.closest(".f")) return; // the colour picker's hex field handles its own keys
    const f = input.closest(".f").dataset.f;
    if (e.key === "Enter") {
      e.preventDefault();
      applyFieldInput(input);
      input.select();
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.value = readField(f) === "Mixed" ? "" : readField(f);
      input.blur();
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && selected && !input.closest(".c")) {
      e.preventDefault();
      writeField(f, stepValue(fieldNow(f), e.key === "ArrowUp" ? 1 : -1, e));
      input.value = readField(f);
      input.select();
    }
  });
  panel.addEventListener("focusout", (e) => {
    const input = e.target.closest?.("input");
    if (input && selected && input.closest(".f")) applyFieldInput(input);
  });
  panel.addEventListener("focusin", (e) => e.target.select?.());

  /* ---------- colour picker (PERMANENT ui's ColorPicker, in the panel) ---------- */

  const PRESETS = ["#4c9df5", "#6e56cf", "#d6409f", "#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#12a594", "#141414"];
  const clamp01 = (n) => Math.min(1, Math.max(0, n));
  function hexToHsv(hex) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return null;
    const h6 = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
    const n = parseInt(h6, 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    let h = 0;
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
  }
  function hsvToHex({ h, s, v }) {
    const f = (n) => {
      const k = (n + h / 60) % 6;
      return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
    };
    return `#${[f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  }

  const cpEl = document.createElement("div");
  cpEl.className = "cp";
  cpEl.innerHTML = `<div class="cp-presets" role="radiogroup" aria-label="Presets">${PRESETS.map((p) => `<button class="cp-preset" type="button" role="radio" aria-checked="false" aria-label="${p}" data-c="${p}" style="--c:${p}"></button>`).join("")}</div>
    <div class="cp-field" role="slider" tabindex="0" aria-label="Saturation and brightness" aria-valuemin="0" aria-valuemax="100"><span class="cp-knob"></span></div>
    <div class="cp-hue" role="slider" tabindex="0" aria-label="Hue" aria-valuemin="0" aria-valuemax="360"><span class="cp-knob"></span></div>
    <div class="cp-foot"><label class="cp-hexf"><span aria-hidden="true">#</span><input spellcheck="false" aria-label="Hex"></label>${
      window.EyeDropper ? `<button class="cp-drop" type="button" aria-label="Pick a colour from the screen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 6.5 3 3M4 20l1.2-3.6L13 8.6l2.4 2.4-7.8 7.8L4 20Zm11-15.5 1.4-1.4a2 2 0 0 1 2.8 0l1.7 1.7a2 2 0 0 1 0 2.8L19.5 9"/></svg></button>` : ""
    }</div>`;
  const cpField = cpEl.querySelector(".cp-field");
  const cpHue = cpEl.querySelector(".cp-hue");
  const cpHex = cpEl.querySelector(".cp-hexf input");
  const cp = { for: null, hsv: { h: 210, s: 0.7, v: 0.96 }, hex: "" };

  function drawPicker() {
    const { h, s, v } = cp.hsv;
    const hex = hsvToHex(cp.hsv);
    const hueColor = `hsl(${h} 100% 50%)`;
    cpField.style.setProperty("--hue", hueColor);
    Object.assign(cpField.firstElementChild.style, { left: `${s * 100}%`, top: `${(1 - v) * 100}%`, background: hex });
    Object.assign(cpHue.firstElementChild.style, { left: `${(h / 360) * 100}%`, top: "50%", background: hueColor });
    cpField.setAttribute("aria-valuenow", Math.round(s * 100));
    cpField.setAttribute("aria-valuetext", `saturation ${Math.round(s * 100)}%, brightness ${Math.round(v * 100)}%`);
    cpHue.setAttribute("aria-valuenow", Math.round(h));
    if (root.activeElement !== cpHex) cpHex.value = hex.slice(1);
    cpEl.querySelectorAll(".cp-preset").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.c === hex)));
  }

  /* A value set from outside (typed in the field, another element) moves the handles; our own drags keep their hue. */
  function syncPicker(hex) {
    if (hex === cp.hex) return;
    cp.hex = hex;
    const next = hexToHsv(hex);
    if (next && hsvToHex(cp.hsv) !== hex) cp.hsv = next.s === 0 ? { ...next, h: cp.hsv.h } : next;
    drawPicker();
  }

  function commitPicker(next) {
    cp.hsv = next;
    cp.hex = hsvToHex(next);
    drawPicker();
    if (selected && cp.for) writeField(cp.for, cp.hex);
  }

  function openPicker(f) {
    closePicker();
    const field = panel.querySelector(`.f.c[data-f="${f}"]`);
    cp.for = f;
    cp.hex = "";
    field.querySelector(".sw").setAttribute("aria-expanded", "true");
    field.parentElement.after(cpEl);
    syncPicker(hexToHsv(readField(f)) ? readField(f) : "#4c9df5");
  }
  function closePicker() {
    if (!cp.for) return;
    panel.querySelector(`.f.c[data-f="${cp.for}"] .sw`)?.setAttribute("aria-expanded", "false");
    cp.for = null;
    cpEl.remove();
  }

  panel.addEventListener("click", (e) => {
    const sw = e.target.closest(".f.c .sw");
    if (!sw) return;
    const f = sw.closest(".f").dataset.f;
    cp.for === f ? closePicker() : openPicker(f);
  });
  cpEl.addEventListener("click", async (e) => {
    const preset = e.target.closest(".cp-preset");
    if (preset) {
      const next = hexToHsv(preset.dataset.c);
      if (next) commitPicker(next.s === 0 ? { ...next, h: cp.hsv.h } : next);
      return;
    }
    if (e.target.closest(".cp-drop") && window.EyeDropper) {
      try {
        const { sRGBHex } = await new window.EyeDropper().open();
        const next = hexToHsv(sRGBHex);
        if (next) commitPicker(next);
      } catch {} // dismissed
    }
  });
  const fromField = (e) => {
    const r = cpField.getBoundingClientRect();
    commitPicker({ h: cp.hsv.h, s: clamp01((e.clientX - r.left) / r.width), v: clamp01(1 - (e.clientY - r.top) / r.height) });
  };
  const fromHue = (e) => {
    const r = cpHue.getBoundingClientRect();
    commitPicker({ ...cp.hsv, h: clamp01((e.clientX - r.left) / r.width) * 359.9 });
  };
  for (const [el, fn] of [[cpField, fromField], [cpHue, fromHue]]) {
    el.addEventListener("pointerdown", (e) => {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {}
      fn(e);
    });
    el.addEventListener("pointermove", (e) => e.buttons & 1 && fn(e));
  }
  cpField.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault();
    commitPicker({ ...cp.hsv, s: clamp01(cp.hsv.s + d[0]), v: clamp01(cp.hsv.v + d[1]) });
  });
  cpHue.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 30 : 5;
    const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    commitPicker({ ...cp.hsv, h: (cp.hsv.h + d + 360) % 360 });
  });
  const applyHex = () => {
    const v = cpHex.value.replace(/[^0-9a-f]/gi, "");
    const next = hexToHsv(`#${v}`);
    if (next) commitPicker(next.s === 0 ? { ...next, h: cp.hsv.h } : next);
    else drawPicker();
  };
  cpHex.addEventListener("input", () => (cpHex.value = cpHex.value.replace(/[^0-9a-f]/gi, "").slice(0, 6)));
  cpHex.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyHex();
    if (e.key === "Escape") {
      e.preventDefault();
      drawPicker();
      cpHex.blur();
    }
  });
  cpHex.addEventListener("blur", applyHex);

  /* Scrub: drag a field's label sideways. 1px of mouse is 1px of value, snapped to the grid unless ⌥/⌘. */
  panel.addEventListener("pointerdown", (e) => {
    const k = e.target.closest(".k");
    if (!k || !selected) return;
    e.preventDefault();
    capture(k, e);
    drag = { kind: "scrub", f: k.closest(".f").dataset.f, start: fieldNow(k.closest(".f").dataset.f), x: e.clientX };
  });
  panel.addEventListener("pointermove", (e) => {
    if (drag?.kind !== "scrub" || !selected) return;
    writeField(drag.f, snap(drag.start + (e.clientX - drag.x), e.altKey || e.metaKey || e.ctrlKey));
  });
  const endScrub = () => drag?.kind === "scrub" && (drag = null);
  panel.addEventListener("pointerup", endScrub);
  panel.addEventListener("pointercancel", endScrub);

  /* ================= Comment ================= */

  /* Click an element (or select some text on it) to open the note box under it. Each comment gets a
     numbered pin at the element's top-right corner; click a pin to edit or delete it. */
  let commentDown = null; // where the press started, so a plain click and a text selection can be told apart

  function openNote(el, { quote = "", comment = null } = {}) {
    composing = { el, quote, comment };
    note.querySelector(".who").textContent = short(el);
    const q = note.querySelector("q");
    q.hidden = !quote;
    q.textContent = quote;
    noteText.value = comment?.text ?? "";
    note.querySelector(".del").hidden = !comment;
    note.querySelector(".add").textContent = comment ? "Save" : "Add";
    syncAdd();
    note.style.display = "block";
    select(el);
    placeNote();
    trackPins();
    requestAnimationFrame(() => focusField(noteText));
  }

  function closeNote() {
    composing = null;
    note.style.display = "none";
    giveFocusBack();
    if (tool === "comment") select(null);
    paintPins();
  }

  function saveNote() {
    if (!composing) return;
    const text = noteText.value.trim();
    const { el, quote, comment } = composing;
    if (comment && !text) comments.splice(comments.indexOf(comment), 1);
    else if (comment) comment.text = text;
    else if (text) {
      /* Its visible text tells the agent which of several look-alike elements you meant. */
      const own = (el.innerText || "").trim().replace(/\s+/g, " ");
      comments.push({ el, text, quote, label: own.length > 60 ? `${own.slice(0, 60)}…` : own, ...describe(el) });
    }
    closeNote();
    render();
  }

  function deleteNote() {
    if (composing?.comment) comments.splice(comments.indexOf(composing.comment), 1);
    closeNote();
    render();
  }

  const syncAdd = () => note.querySelector(".add").setAttribute("aria-disabled", String(!noteText.value.trim() && !composing?.comment));

  /* Under the element when it fits, above it otherwise, always on screen. */
  function placeNote() {
    if (!composing) return;
    const el = composing.el;
    if (!el.isConnected) return closeNote();
    const r = el.getBoundingClientRect();
    const w = note.offsetWidth;
    const h = note.offsetHeight;
    const below = r.bottom + 10;
    const top = below + h < innerHeight - 72 ? below : Math.max(8, r.top - h - 10);
    Object.assign(note.style, { left: `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`, top: `${Math.min(top, innerHeight - h - 8)}px` });
  }

  function paintPins() {
    while (pins.children.length > comments.length) pins.lastChild.remove();
    comments.forEach((c, i) => {
      let pin = pins.children[i];
      if (!pin) {
        pin = document.createElement("button");
        pin.className = "pin";
        pin.type = "button";
        pins.append(pin);
      }
      pin.textContent = i + 1;
      pin.setAttribute("aria-label", `Comment ${i + 1}: ${c.text}`);
      pin.title = c.text;
      pin.toggleAttribute("data-on", composing?.comment === c);
      const r = c.el.isConnected ? c.el.getBoundingClientRect() : null;
      if (!r || (!r.width && !r.height)) return (pin.style.display = "none");
      Object.assign(pin.style, { display: "grid", left: `${Math.max(14, Math.min(r.right, innerWidth - 14))}px`, top: `${Math.max(14, Math.min(r.top, innerHeight - 14))}px` });
    });
  }

  /* Pins and the note box follow the page while there is anything to show. */
  let pinsRunning = false;
  function trackPins() {
    if (pinsRunning) return;
    pinsRunning = true;
    const tick = () => {
      paintPins();
      placeNote();
      if (comments.length || composing) requestAnimationFrame(tick);
      else pinsRunning = false;
    };
    requestAnimationFrame(tick);
  }

  pins.addEventListener("click", (e) => {
    const pin = e.target.closest(".pin");
    if (!pin) return;
    const c = comments[[...pins.children].indexOf(pin)];
    if (c) openNote(c.el, { quote: c.quote, comment: c });
  });
  note.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.classList.contains("add")) saveNote();
    else if (b.classList.contains("del")) deleteNote();
    else closeNote();
  });
  noteText.addEventListener("input", syncAdd);

  /* The press never reaches the page (so nothing loses focus), which also means the browser will not
     select text. Dragging selects it by hand instead, caret to caret. */
  const caretAt = (x, y) => {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p && { node: p.offsetNode, offset: p.offset };
    }
    const r = document.caretRangeFromPoint?.(x, y);
    return r && { node: r.startContainer, offset: r.startOffset };
  };

  function commentPress(e) {
    /* A press elsewhere keeps what you typed so far, like clicking away from a sticky note. */
    if (composing) noteText.value.trim() ? saveNote() : closeNote();
    getSelection()?.removeAllRanges();
    commentDown = { target: pickFor(e.target), from: caretAt(e.clientX, e.clientY), x: e.clientX, y: e.clientY };
  }

  function commentDrag(e) {
    const d = commentDown;
    if (!d?.from || Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
    const to = caretAt(e.clientX, e.clientY);
    if (!to || host.contains(to.node)) return;
    try {
      getSelection().setBaseAndExtent(d.from.node, d.from.offset, to.node, to.offset);
    } catch {}
  }

  function commentRelease() {
    if (!commentDown) return;
    const { target } = commentDown;
    commentDown = null;
    const sel = getSelection();
    const quote = sel && !sel.isCollapsed ? sel.toString().trim().replace(/\s+/g, " ") : "";
    if (quote) {
      let anchor = sel.getRangeAt(0).commonAncestorContainer;
      if (anchor.nodeType !== 1) anchor = anchor.parentElement;
      const el = pickFor(anchor) ?? target;
      if (el) openNote(el, { quote: quote.length > 280 ? `${quote.slice(0, 280)}…` : quote });
    } else if (target) openNote(target);
  }

  /* ================= Undo / redo ================= */

  /* Every finished action (a drag, a typed value, a text edit, a delete, a comment) becomes a checkpoint of
     all toolkit state: the edit maps, the comments, each touched element's inline style and edited text, and
     where the move copies sit. ⌘Z / ⌘⇧Z step between checkpoints. Elements are remembered as they were before
     the toolkit first touched them, so undoing past an element's first edit puts it back exactly. */
  const pristine = new WeakMap();
  const touched = new Set();
  function rememberPristine(el) {
    if (pristine.has(el)) return;
    pristine.set(el, { style: el.getAttribute("style"), text: snapshot(el) });
    touched.add(el);
  }

  const copyProps = (e) => ({ ...e, props: new Map([...e.props].map(([k, v]) => [k, { ...v }])) });
  const copyMap = (map, copy = (v) => ({ ...v })) => new Map([...map].map(([k, v]) => [k, copy(v)]));

  function takeState() {
    const els = new Map();
    for (const el of touched) els.set(el, { style: el.getAttribute("style"), text: textEdits.has(el) ? snapshot(el) : null });
    return {
      els,
      text: copyMap(textEdits),
      radius: copyMap(radiusEdits),
      space: copyMap(spaceEdits, copyProps),
      style: copyMap(styleEdits, copyProps),
      move: copyMap(moveEdits),
      remove: copyMap(removeEdits),
      comments: comments.map((c) => ({ ...c })),
      artifacts: [...moveEdits.values()].flatMap((e) =>
        [e.clone, e.inflow].filter(Boolean).map((node) => ({ node, parent: node.parentNode, next: node.nextSibling, style: node.getAttribute("style") })),
      ),
    };
  }

  /* What makes two states different, from the edits themselves (the elements' styles follow from them). */
  const sig = (st) =>
    JSON.stringify([
      [...st.text.values()].map((e) => e.after),
      [...st.radius.values()].map((e) => e.after),
      [...st.space.values(), ...st.style.values()].map((e) => [...e.props].map(([k, v]) => k + v.after)),
      [...st.move.values()].map((e) => [e.mode, e.dx, e.dy, e.to?.index]),
      st.remove.size,
      st.comments.map((c) => c.text),
      st.artifacts.map((a) => a.style),
    ]);

  function applyState(st) {
    if (editing) {
      editing.removeAttribute("contenteditable");
      editing.removeAttribute("data-ptk-editing");
      editing = null;
    }
    closeField(false);
    if (composing) closeNote();
    /* Move copies: take away the ones this state does not have, put back the ones it does, where they were. */
    const keep = new Set(st.artifacts.map((a) => a.node));
    for (const e of moveEdits.values()) for (const n of [e.clone, e.inflow]) if (n && !keep.has(n)) n.remove();
    for (const a of st.artifacts) {
      if (a.parent && a.node.parentNode !== a.parent) a.parent.insertBefore(a.node, a.next?.parentNode === a.parent ? a.next : null);
      if (a.style == null) a.node.removeAttribute("style");
      else a.node.setAttribute("style", a.style);
    }
    for (const el of touched) {
      const now = st.els.get(el) ?? pristine.get(el);
      if (now.style == null) el.removeAttribute("style");
      else el.setAttribute("style", now.style);
      if (st.text.has(el) || textEdits.has(el)) restore(el, st.els.get(el)?.text ?? pristine.get(el).text);
    }
    const fill = (map, src, copy = (v) => ({ ...v })) => {
      map.clear();
      for (const [k, v] of src) map.set(k, copy(v));
    };
    fill(textEdits, st.text);
    fill(radiusEdits, st.radius);
    fill(spaceEdits, st.space, copyProps);
    fill(styleEdits, st.style, copyProps);
    fill(moveEdits, st.move);
    fill(removeEdits, st.remove);
    comments.length = 0;
    comments.push(...st.comments.map((c) => ({ ...c })));
    touched.forEach(mark);
    if (selected && (!selected.isConnected || !selected.getClientRects().length)) select(null);
    trackPins();
    paintPins();
    render();
    paint();
  }

  let history = [];
  let at = -1;
  let checkpointTimer = null;
  let pending = false; // an action happened since the last checkpoint
  let restoring = false; // undo/redo is applying a state: that is not a new action
  function checkpoint() {
    clearTimeout(checkpointTimer);
    if (drag || editing || field) return; // mid-action: the end of it checkpoints
    pending = false;
    const st = takeState();
    if (at >= 0 && sig(st) === sig(history[at])) return;
    history = history.slice(0, at + 1);
    history.push(st);
    if (history.length > 100) history.shift();
    at = history.length - 1;
  }
  const scheduleCheckpoint = () => {
    if (restoring) return;
    pending = true;
    clearTimeout(checkpointTimer);
    checkpointTimer = setTimeout(checkpoint, 250); // a burst of steps (typing, ↑↑↑) is one undo step
  };
  function resetHistory() {
    clearTimeout(checkpointTimer);
    pending = false;
    history = [takeState()];
    at = 0;
  }
  function restoreTo(i) {
    restoring = true;
    try {
      applyState(history[i]);
    } finally {
      restoring = false;
    }
    clearTimeout(checkpointTimer);
    pending = false;
  }
  function undo() {
    if (pending) checkpoint(); // keep the last action, even if its pause has not passed yet
    if (at <= 0) return false;
    restoreTo(--at);
    return true;
  }
  function redo() {
    if (pending) checkpoint(); // a new action since the undo: there is nothing to redo any more
    if (at >= history.length - 1) return false;
    restoreTo(++at);
    return true;
  }

  /* ================= shared: markers, revert, prompt, copy ================= */

  const mark = (el) => el.toggleAttribute("data-ptk-edited", textEdits.has(el) || radiusEdits.has(el) || spaceEdits.has(el) || styleEdits.has(el) || moveEdits.has(el) || removeEdits.has(el));

  function revertAll() {
    if (editing) commit(editing);
    closeField(false);
    for (const [el, e] of textEdits) restore(el, e.snapshot);
    for (const [el, e] of radiusEdits) el.style.borderRadius = e.inline;
    for (const [el, e] of moveEdits) unmove(el, e);
    for (const [el, e] of removeEdits) el.style.display = e.display;
    for (const [el, e] of styleEdits) {
      for (const [prop, pe] of e.props) {
        if (pe.inline) el.style.setProperty(prop, pe.inline);
        else el.style.removeProperty(prop);
      }
    }
    if (composing) closeNote();
    for (const [el, e] of spaceEdits) {
      for (const [prop, pe] of e.props) {
        if (pe.inline) el.style.setProperty(prop, pe.inline);
        else el.style.removeProperty(prop);
      }
    }
    clearEdits();
    status = "idle";
    render();
    paint();
    resetHistory();
  }

  function clearEdits() {
    const els = [...textEdits.keys(), ...radiusEdits.keys(), ...spaceEdits.keys(), ...styleEdits.keys(), ...moveEdits.keys(), ...removeEdits.keys()];
    textEdits.clear();
    radiusEdits.clear();
    spaceEdits.clear();
    moveEdits.clear();
    removeEdits.clear();
    styleEdits.clear();
    comments.length = 0;
    paintPins();
    els.forEach(mark);
  }

  const earlier = (e) => (e.shown !== e.before ? ` (an earlier edit may already have made it ${e.shown})` : "");
  /* Instruction notes: one short line each, listed once at the end, only for the kinds of edits present. */
  const tokenNote = () =>
    useTokens ? "Use existing design tokens (nearest if no exact match, raw values if the project has none)." : "Use these exact values.";
  const SHARED_NOTE = 'Change the shared rule ("set by"), so every instance updates.';

  /* ---------- which CSS rule sets a value, and how far it reaches ---------- */

  const specificity = (sel) => {
    const ids = (sel.match(/#[\w-]+/g) || []).length;
    const cls = (sel.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length;
    const tags = (sel.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|::?[\w-]+(\([^)]*\))?/g, " ").match(/[a-z][\w-]*/gi) || []).length;
    return ids * 100 + cls * 10 + tags;
  };
  const readable = (sel) => sel.replace(/([A-Za-z]+)-module__[A-Za-z0-9_-]+__([\w-]+)/g, "$2").replace(/\s+/g, " ").trim();

  /* The stylesheet rule that wins for these properties on this element: highest specificity, then
     the later one. Cross-origin sheets cannot be read, and CSS-in-JS may have no named rule; then null. */
  function ruleFor(el, props) {
    let best = null;
    let order = 0;
    const visit = (rules) => {
      for (const rule of rules) {
        order++;
        if (rule.cssRules && !rule.selectorText) {
          if (!rule.media || matchMedia(rule.media.mediaText).matches) visit(rule.cssRules);
          continue;
        }
        if (!rule.selectorText || !props.some((p) => rule.style.getPropertyValue(p))) continue;
        for (const part of rule.selectorText.split(",").map((x) => x.trim())) {
          let hit = false;
          try {
            hit = el.matches(part);
          } catch {}
          if (!hit) continue;
          const spec = specificity(part);
          if (!best || spec > best.spec || (spec === best.spec && order > best.order)) best = { selector: part, spec, order, sheet: rule.parentStyleSheet };
        }
      }
    };
    for (const sheet of document.styleSheets) {
      if (sheet.ownerNode === pageStyle) continue; // the toolkit's own cursor and outline rules
      try {
        visit(sheet.cssRules);
      } catch {}
    }
    if (!best) return null;
    let shared = [];
    try {
      shared = [...document.querySelectorAll(best.selector)];
    } catch {}
    const href = best.sheet?.href;
    const source = href ? href.split("/").pop().split("?")[0] : best.sheet?.ownerNode?.tagName === "STYLE" ? "a <style> on the page" : "";
    return { selector: readable(best.selector), shared, source };
  }

  /* "set by: .button in a <style> on the page, shared by 7 elements here ("Cancel", "Save changes", …)" */
  function setBy(el, props) {
    const r = ruleFor(el, props);
    if (!r) return "";
    const n = r.shared.length;
    const names = r.shared
      .filter((x) => x !== el && x.getClientRects().length)
      .map((x) => squash(x.innerText).slice(0, 24))
      .filter(Boolean)
      .slice(0, 3);
    const reach = n > 1 ? `, shared by ${n} elements here${names.length ? ` (also ${names.map((t) => JSON.stringify(t)).join(", ")}${n - 1 > names.length ? ", …" : ""})` : ""}` : ", used only by this element";
    return `   set by: ${r.selector}${r.source ? ` in ${r.source}` : ""}${reach}`;
  }

  function spaceLines(edit) {
    const lines = [];
    const done = new Set();
    /* Four sides changed together read as one shorthand. */
    for (const kind of ["padding", "margin"]) {
      const sides = SIDES.map((s) => edit.props.get(`${kind}-${s}`));
      if (sides.every(Boolean) && sides.every((s) => s.after === sides[0].after && s.before === sides[0].before)) {
        lines.push(`${kind}: ${sides[0].before}${earlier(sides[0])} → ${sides[0].after}`);
        SIDES.forEach((s) => done.add(`${kind}-${s}`));
      }
    }
    for (const [prop, pe] of edit.props) if (!done.has(prop)) lines.push(`${prop}: ${pe.before}${earlier(pe)} → ${pe.after}`);
    return lines.map((l) => `   ${l}`).join("\n");
  }

  function prompt() {
    let i = 0;
    const sections = [];
    const how = [];
    /* Text reads best as plain arrows: "Old" → "New". The quoted string is what the agent searches for. */
    const textLines = [];
    for (const e of textEdits.values()) {
      const emptied = !e.after;
      for (const p of e.parts?.length ? e.parts : [e]) {
        const earlierText = p.shown !== p.before ? ` (the page may already show ${JSON.stringify(p.shown)})` : "";
        const to = p.after ? JSON.stringify(p.after) : emptied ? `delete (and the <${e.tag}> that held it)` : "delete";
        textLines.push(`${JSON.stringify(p.before)} → ${to}${earlierText}`);
      }
    }
    const TEXT_RULE = "Replace each string where it is defined, including code that sets it again. Fix spelling and capitalisation only.";
    if (textEdits.size) {
      sections.push(`Text\n\n${textLines.join("\n")}`);
      how.push(TEXT_RULE);
    }
    if (radiusEdits.size) {
      const list = [...radiusEdits.entries()].map(([el, e]) => {
        const by = setBy(el, ["border-radius", "border-top-left-radius"]);
        return `${++i}. <${e.tag}> ${where(e)}\n   border-radius: ${e.before}${earlier(e)} → ${e.full ? "fully rounded (pill, 9999px)" : e.after}${by ? `\n${by}` : ""}`;
      });
      sections.push(`Corner radius\n\n${list.join("\n\n")}`);
      how.push(SHARED_NOTE, tokenNote());
    }
    if (spaceEdits.size) {
      const list = [...spaceEdits.entries()].map(([el, e]) => {
        const by = setBy(el, [...e.props.keys()]);
        return `${++i}. <${e.tag}> ${where(e)}\n${spaceLines(e)}${by ? `\n${by}` : ""}`;
      });
      sections.push(`Spacing\n\n${list.join("\n\n")}`);
      how.push(SHARED_NOTE, tokenNote());
    }
    if (styleEdits.size) {
      const change = (prop, pe) => {
        const [from, to] = [shownStyle(prop, pe.before), shownStyle(prop, pe.after)];
        return from === to ? `${prop}: ${to}` : `${prop}: ${from} → ${to}`; // set on purpose, same as it computed
      };
      const list = [...styleEdits.entries()].map(([el, e]) => {
        const lines = [];
        const done = new Set();
        /* Four border sides changed together read as one line per property. */
        for (const what of ["width", "style", "color"]) {
          const sides = BORDER_SIDES(what).map((p) => e.props.get(p));
          if (sides.every(Boolean) && sides.every((x) => x.after === sides[0].after && x.before === sides[0].before)) {
            const prop = `border-${what}`;
            lines.push(change(prop, sides[0]));
            BORDER_SIDES(what).forEach((p) => done.add(p));
          }
        }
        for (const [prop, pe] of e.props) if (!done.has(prop)) lines.push(change(prop, pe));
        const by = setBy(el, [...e.props.keys(), "background", "border"]);
        return `${++i}. <${e.tag}> ${where(e)}\n${lines.map((l) => `   ${l}`).join("\n")}${by ? `\n${by}` : ""}`;
      });
      sections.push(`Fill and border\n\n${list.join("\n\n")}`);
      how.push(SHARED_NOTE, tokenNote());
    }
    const flows = [...moveEdits.entries()].filter(([, e]) => e.mode === "flow" && e.to);
    const absolutes = [...moveEdits.entries()].filter(([, e]) => e.mode === "absolute");
    if (flows.length) {
      const list = flows.map(([, e]) => `${++i}. <${e.tag}> ${where(e)}\n${describeFlow(e)}`);
      sections.push(`Moved in the layout\n\n${list.join("\n\n")}`);
      how.push("Move the JSX to match (reorder the data if it comes from a .map()). Keep it in normal flow.");
    }
    if (absolutes.length) {
      const list = absolutes
        .sort(([, a], [, b]) => a.n - b.n)
        .map(([el, e]) => `${++i}. Move ${e.n} (${e.colorName}${shotAttached ? " in the screenshot" : ""}): <${e.tag}> ${where(e)}\n${describeAbsolute(el, e)}`);
      sections.push(`Positioned absolutely\n\n${list.join("\n\n")}${shotAttached ? "\n\nScreenshot attached: each move's colour joins its dashed “from” box to where I put it." : ""}`);
      how.push("Absolute moves: position: absolute in the named container (make it relative), at those offsets.", tokenNote());
    }
    /* Removals read as one line each; a repeated element says so, so the agent removes it everywhere. */
    const removeLines = [...removeEdits.values()].map((e) => {
      const at = e.path.split(" > ").slice(-2).join(" > ");
      const kind = e.label.match(/^<[^ >]+/)[0].slice(1);
      return e.twins > 1 ? `Remove ${e.label} (${at}), from every place it repeats: it is one of ${e.twins} ${kind} on the page.` : `Remove ${e.label} (${at}).`;
    });
    if (removeEdits.size) {
      sections.push(`Removed\n\n${removeLines.join("\n")}`);
    }
    if (comments.length) {
      const list = comments.map((c, k) => {
        const n = ++i;
        const quote = c.quote ? `\n   on the text: ${JSON.stringify(c.quote)}` : "";
        const label = !c.quote && c.label ? `\n   element text: ${JSON.stringify(c.label)}` : "";
        return `${n}. <${c.tag}> ${where(c)}${n !== k + 1 ? ` (pin ${k + 1})` : ""}${label}${quote}\n   comment: ${c.text.replace(/\n/g, "\n            ")}`;
      });
      sections.push(`Comments\n\n${list.join("\n\n")}`);
      how.push("Comments are my notes, not exact values: make the smallest change that does it, ask if unclear.");
    }
    /* Only copy changed: the arrows and one line of instructions are the whole prompt. */
    if (textEdits.size + removeEdits.size === count()) {
      const parts = [textLines.join("\n"), removeLines.join("\n")].filter(Boolean).join("\n\n");
      return `${removeEdits.size ? "On" : "Change this copy on"} ${location.href}:\n\n${parts}${textEdits.size ? `\n\n${TEXT_RULE}` : ""}`;
    }
    const intro = comments.length === count() ? `Comments on ${location.href}:` : `Apply these design changes from ${location.href}:`;
    const notes = [...new Set(how)].map((n) => `- ${n}`).join("\n");
    return `${intro}\n\n${sections.join("\n\n")}\n\n${notes}`;
  }

  let shotAttached = false;
  let lastCopy = "prompt"; // which copy the "done" status belongs to: the prompt or Add to Figma

  async function copy() {
    if (editing) commit(editing);
    if (composing) saveNote();
    closeField(true);
    const n = count();
    if (!n) return;
    /* Screenshot first, as its own clipboard step: chat inputs paste an image or text, rarely both. */
    let shotFailed = false;
    /* Absolute moves always come with a screenshot: the picture is what makes a free position clear. */
    if (!pendingPrompt && [...moveEdits.values()].some((e) => e.mode === "absolute")) {
      status = "done";
      message = "Choose this tab to grab the screenshot";
      render();
      const blob = await screenshot();
      if (blob) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          pendingPrompt = true;
          shotAttached = true;
          status = "done";
          message = `Screenshot copied. Paste it, then ${isMac ? "⌘" : "Ctrl"}↵ for the prompt`;
          return render();
        } catch {}
      }
      shotFailed = true; // declined, or a browser that cannot capture (like an embedded preview)
    }
    try {
      const text = prompt();
      await navigator.clipboard.writeText(text);
      lastCopy = "prompt";
      /* Lets a page see what was copied (the test page records each prompt). */
      window.dispatchEvent(new CustomEvent("design-toolkit:copy", { detail: { prompt: text, edits: n } }));
      pendingPrompt = false;
      shotAttached = false;
    } catch {
      status = "error";
      message = "Could not reach the clipboard. Click the page and try again";
      return render();
    }
    /* The page keeps the new look; only the markers go, so the next copy holds just new edits. Moves are
       the exception: their floating copies go, so Claude's real layout change is what you see next. */
    for (const [el, e] of moveEdits) unmove(el, e);
    clearEdits();
    resetHistory(); // what was copied is the new starting point
    status = "done";
    message = `Copied ${n} edit${n === 1 ? "" : "s"}${shotFailed ? " without a screenshot (capture unavailable here)" : ""}. Paste into Claude`;
    render();
    setTimeout(() => status === "done" && ((status = "idle"), render()), 2400);
  }

  /* ---------- events ---------- */

  /* Capture phase on window: the page never sees clicks while a tool is on, so links and buttons
     stay put. Text never prevents pointerdown, so the browser still drops the caret where you clicked. */
  const swallow = (e) => {
    if (!tool || fromToolbar(e)) return;
    e.stopPropagation();
    if (e.type === "click" || e.type === "auxclick" || (tool !== "text" && e.type === "mousedown")) e.preventDefault();
  };

  window.addEventListener("pointerdown", (e) => {
    if (!tool || fromToolbar(e) || e.button !== 0) return;
    e.stopPropagation();
    if (tool === "text") {
      const el = pickText(e.target);
      if (el) begin(el);
      else if (editing) commit(editing);
    } else if (tool === "comment") {
      e.preventDefault();
      commentPress(e);
    } else {
      e.preventDefault();
      /* Move: pressing on the selection (or anything inside it) drags it; elsewhere picks and drags the new one. */
      const target = tool === "move" ? movedAt(e.clientX, e.clientY) ?? (selected && selected.contains(e.target) ? selected : pickFor(e.target)) : pickFor(e.target);
      select(target);
      if (tool === "move" && target) (moveAbsolute ? startMove : startFlowDrag)(e, target);
    }
  }, true);
  window.addEventListener("pointerup", () => setTimeout(() => pending && scheduleCheckpoint(), 0), true); // after the drop below settles
  window.addEventListener("pointerup", () => {
    if (tool === "comment") return commentRelease();
    if (drag?.kind === "flow") return dropFlow(false);
    if (drag?.kind !== "move") return;
    drag = null;
    paint();
  }, true);
  /* Double-click text with Move, Radius or Spacing on: switch to Text and start typing where you clicked, like Figma. */
  window.addEventListener("dblclick", (e) => {
    if (!["move", "radius", "spacing"].includes(tool) || fromToolbar(e)) return;
    const el = pickText(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const at = caretAt(e.clientX, e.clientY);
    setTool("text");
    begin(el);
    el.focus({ preventScroll: true });
    if (at && el.contains(at.node)) {
      const sel = getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.setStart(at.node, at.offset);
      sel.addRange(range);
    }
  }, true);
  ["mousedown", "mouseup", "pointerup", "click", "auxclick", "dblclick", "submit"].forEach((t) => window.addEventListener(t, swallow, true));

  window.addEventListener("pointermove", (e) => {
    if (commentDown) commentDrag(e);
    if (drag?.kind === "move") return dragMove(e);
    if (drag?.kind === "flow") return dragFlow(e);
    if (!boxTool() || drag) return;
    if (fromToolbar(e)) return void (hovered = null);
    hoverBand = null;
    hovered = pickFor(e.target);
  }, true);

  /* Option menus close on any press outside them (their own chevron toggles them itself). */
  window.addEventListener("pointerdown", (e) => {
    if (!menuOpen) return;
    const path = e.composedPath();
    if (!path.includes(menu) && !path.some((n) => n.dataset?.menu)) setMenu(null);
  }, true);

  window.addEventListener("keydown", (e) => {
    if (composing && e.composedPath().includes(note)) {
      e.stopPropagation(); // typing a note never triggers tools or the page's shortcuts
      if (e.key === "Escape") {
        e.preventDefault();
        closeNote();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        saveNote();
        if (count()) copy();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        saveNote();
      }
      return;
    }
    if (menuOpen && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      return setMenu(null);
    }
    const mod = e.metaKey || e.ctrlKey;
    /* ⌘Z / ⌘⇧Z (or ⌘Y): the toolkit's own history. Typing keeps the browser's undo; with nothing to undo here,
       the keys go on to the app. */
    if (mod && /^[zy]$/i.test(e.key)) {
      const t = e.composedPath()[0];
      const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (!typing && (e.key.toLowerCase() === "y" || e.shiftKey ? redo() : undo())) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    if (mod && e.key === "Enter" && (count() || editing)) {
      e.preventDefault();
      e.stopPropagation();
      copy();
      return;
    }
    if (editing && e.composedPath().includes(editing)) {
      e.stopPropagation(); // keep the app's own shortcuts quiet while typing
      if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        commit(editing);
      } else if (e.key === " " && !e.isComposing) {
        /* Space presses buttons (and scrolls in some editors) instead of typing, so type it ourselves. */
        e.preventDefault();
        document.execCommand("insertText", false, " ");
      }
      return;
    }
    const t = e.composedPath()[0];
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (typing || mod) return;

    if (boxTool() && selected) {
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      /* ⇧↵ walks up to the parent, ↵ in Spacing walks down to the first child (Figma's keys). */
      if (e.key === "Enter" && e.shiftKey) {
        take();
        const up = selected.parentElement;
        if (up && up !== document.body && up !== document.documentElement) select(up);
        return;
      }
      if (e.key === "Tab") {
        take();
        const next = e.shiftKey ? selected.previousElementSibling : selected.nextElementSibling;
        if (next) select(next);
        return;
      }
      if (tool === "move" && (e.key === "Delete" || e.key === "Backspace")) {
        take();
        return removeElement(selected);
      }
      if (tool === "move" && /^Arrow/.test(e.key)) {
        take();
        if (!moveAbsolute) return flowNudge(selected, e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1);
        const edit = moveEdits.get(selected)?.mode === "absolute" ? moveEdits.get(selected) : null;
        const step = e.shiftKey ? 10 : e.altKey || e.metaKey ? 1 : GRID;
        const [dx, dy] = edit ? [edit.dx, edit.dy] : [0, 0];
        const ax = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const ay = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        setMove(selected, dx + ax, dy + ay);
        return;
      }
      if (e.key === "Enter" && (tool === "spacing" || tool === "move")) {
        take();
        if (selected.firstElementChild) select(selected.firstElementChild);
        return;
      }
      if (tool === "radius" && e.key === "Enter") {
        take();
        openField(tag, "Radius ", radiusField());
        return;
      }
      if (tool === "radius" && /^Arrow/.test(e.key)) {
        take();
        setRadius(selected, stepValue(currentRadius(selected), e.key === "ArrowUp" || e.key === "ArrowRight" ? 1 : -1, e));
        return;
      }
    }
    if (e.altKey) return;
    const key = e.key.toLowerCase();
    const shortcuts = { t: "text", s: "spacing", v: "move", c: "comment" };
    if (shortcuts[key] && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      setTool(tool === shortcuts[key] ? null : shortcuts[key]);
    } else if (e.key === "Escape" && tool) {
      e.preventDefault();
      e.stopPropagation();
      if (drag?.kind === "flow") dropFlow(true);
      else if (drag?.kind === "move") {
        setMove(drag.el, drag.start[0], drag.start[1]); // cancel the drag in progress
        drag = null;
      } else if (boxTool() && selected) select(null);
      else setTool(null);
    }
  }, true);

  window.addEventListener("focusout", (e) => {
    if (editing && e.target === editing && !fromToolbar(e)) {
      /* Wait a tick: focus moving into the same element (caret moves) should not commit. */
      setTimeout(() => editing && document.activeElement !== editing && !editing.contains(document.activeElement) && commit(editing), 0);
    }
  }, true);

  const mount = () => {
    document.body.appendChild(host);
    resetHistory();
    render();
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
