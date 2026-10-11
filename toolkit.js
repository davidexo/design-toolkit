/* design-toolkit (github.com/davidexo/design-toolkit). Load it on any localhost page by script tag or bookmarklet.

   Tweak the design right on the page, then ⌘↵ (or Copy prompt) puts a ready-made prompt on the clipboard
   for Claude Code to make the same changes in the source.

   T  Text     click any copy and type.
   R  Radius   click any box, drag the corner handle, use the arrow keys or click the value to type one.
   S  Spacing  click any element, drag its padding, margin or gap bands, or click a value to type one.
   V  Move     drag any element anywhere; the prompt explains the move in layout terms (new container,
               new order, neighbours, alignment, overlap) so Claude can turn it into real layout.

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

  let editing = null; // text: element currently contenteditable
  const textEdits = new Map(); // element -> { before, shown, after, tag, path, components, snapshot }
  /* Values as they first rendered. A copied edit is still on screen, so the next edit of the same
     element must still say what the source holds, not what the page shows now. */
  const originalText = new WeakMap();

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

  const count = () => textEdits.size + radiusEdits.size + spaceEdits.size + moveEdits.size;
  const boxTool = () => tool === "radius" || tool === "spacing" || tool === "move";

  /* ---------- page styles (attributes only, so React keeps owning the DOM) ---------- */

  const pageStyle = document.createElement("style");
  pageStyle.textContent = `
    html[data-ptk-tool="text"] body *:not([data-ptk-host]) { cursor: text !important; }
    html[data-ptk-tool="radius"] body *:not([data-ptk-host]),
    html[data-ptk-tool="spacing"] body *:not([data-ptk-host]),
    html[data-ptk-tool="move"] body *:not([data-ptk-host]) { cursor: default !important; }
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
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .bar, .tag, .lb {
        font: 460 13px/1 "PTK Camera", ui-sans-serif, system-ui, -apple-system, sans-serif; letter-spacing: -0.0025em;
        -webkit-font-smoothing: antialiased; user-select: none;
      }
      .bar {
        position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 2147483647;
        display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 999px;
        max-width: calc(100vw - 16px); overflow-x: auto; scrollbar-width: none;
        background: #141414; color: rgba(255,255,255,.9); box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 8px 24px rgba(0,0,0,.24);
      }
      button {
        all: unset; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 999px;
        color: rgba(255,255,255,.8); cursor: pointer; white-space: nowrap;
        transition: background-color .2s cubic-bezier(.23,1,.32,1), color .2s cubic-bezier(.23,1,.32,1), transform .16s cubic-bezier(.23,1,.32,1);
      }
      button:hover { background: rgba(255,255,255,.05); color: rgba(255,255,255,.9); }
      button:active { transform: scale(.97); }
      button:focus-visible { outline: 2px solid ${BLUE}; outline-offset: 1px; }
      button[aria-pressed="true"] { background: rgba(255,255,255,.1); color: #fff; }
      button.icon { width: 32px; padding: 0; justify-content: center; }
      button.toggle { gap: 8px; padding: 0 10px; color: rgba(255,255,255,.5); }
      .switch { position: relative; width: 20px; height: 12px; border-radius: 999px; background: rgba(255,255,255,.2); transition: background-color .2s cubic-bezier(.23,1,.32,1); }
      .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 8px; height: 8px; border-radius: 50%; background: #fff; transition: transform .2s cubic-bezier(.23,1,.32,1); }
      button.toggle[aria-pressed="true"] { background: none; color: rgba(255,255,255,.8); }
      button.toggle[aria-pressed="true"] .switch { background: ${BLUE}; }
      button.toggle[aria-pressed="true"] .switch::after { transform: translateX(8px); }
      button.copy { background: #fff; color: #141414; padding: 0 8px 0 12px; }
      button.copy:hover { background: rgba(255,255,255,.9); color: #141414; }
      svg { width: 16px; height: 16px; flex: none; }
      kbd { font: inherit; font-size: 11px; padding: 3px 5px; border-radius: 5px; background: rgba(255,255,255,.1); color: rgba(255,255,255,.5); }
      .copy kbd { background: rgba(0,0,0,.08); color: rgba(20,20,20,.5); }
      .sep { width: 1px; height: 16px; margin: 0 4px; background: rgba(255,255,255,.1); }
      .note { padding: 0 10px 0 6px; color: rgba(255,255,255,.5); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .note.err { color: #ff6b6b; }
      .count { font-variant-numeric: tabular-nums; }

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
        position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 232px; display: none; padding: 4px 0 8px;
        border-radius: 16px; background: #141414; color: rgba(255,255,255,.9);
        box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 8px 24px rgba(0,0,0,.24);
        font: 460 12px/1 "PTK Camera", ui-sans-serif, system-ui, -apple-system, sans-serif; letter-spacing: -0.0025em;
        -webkit-font-smoothing: antialiased; user-select: none;
      }
      .panel header { padding: 10px 12px 8px; border-bottom: 1px solid rgba(255,255,255,.08); display: grid; gap: 4px; }
      .panel .el { color: rgba(255,255,255,.9); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .panel .comp { color: rgba(255,255,255,.4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .panel section { padding: 10px 12px 0; }
      .panel section[hidden] { display: none; }
      .panel h4 { all: unset; display: flex; align-items: center; justify-content: space-between; height: 20px; margin-bottom: 6px; color: rgba(255,255,255,.5); }
      .panel .row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .panel .row4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-top: 6px; }
      .panel .row4[hidden] { display: none; }
      .panel .f {
        display: flex; align-items: center; gap: 4px; height: 28px; padding: 0 6px; border-radius: 8px;
        background: rgba(255,255,255,.05); box-shadow: inset 0 0 0 1px transparent; transition: box-shadow .12s;
      }
      .panel .f:hover { box-shadow: inset 0 0 0 1px rgba(255,255,255,.1); }
      .panel .f:focus-within { box-shadow: inset 0 0 0 1px ${BLUE}; }
      .panel .k { flex: none; min-width: 12px; color: rgba(255,255,255,.4); cursor: ew-resize; text-align: center; }
      .panel .f input {
        all: unset; min-width: 0; width: 100%; color: rgba(255,255,255,.9); font: inherit; font-variant-numeric: tabular-nums; cursor: text;
      }
      .panel .f input:placeholder-shown { color: rgba(255,255,255,.4); }
      .panel .indep { all: unset; display: grid; place-items: center; width: 20px; height: 20px; border-radius: 6px; cursor: pointer; color: rgba(255,255,255,.5); }
      .panel .indep:hover { background: rgba(255,255,255,.05); color: rgba(255,255,255,.9); }
      .panel .indep[aria-pressed="true"] { background: rgba(255,255,255,.1); color: #fff; }
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
    </aside>
    <div class="bar" role="toolbar" aria-label="PERMANENT toolkit"></div>
  `;
  const bar = root.querySelector(".bar");
  const hoverBox = root.querySelector(".box.hover");
  const selBox = root.querySelector(".box.sel");
  const handle = root.querySelector(".handle");
  const tag = root.querySelector(".tag");
  const dropBox = root.querySelector(".box.drop");
  const ghosts = root.querySelector(".ghosts");
  const mtag = root.querySelector(".mtag");
  const spaceLayer = root.querySelector(".space");
  const panel = root.querySelector(".panel");

  const ICON = {
    type: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M2 6a1 1 0 0 1 1-1h8a1 1 0 1 1 0 2H8v5a1 1 0 1 1-2 0V7H3a1 1 0 0 1-1-1Zm14 0a1 1 0 0 1 1-1h4a1 1 0 1 1 0 2h-4a1 1 0 0 1-1-1Zm-4 6a1 1 0 0 1 1-1h8a1 1 0 1 1 0 2h-8a1 1 0 0 1-1-1Zm-9 6a1 1 0 0 1 1-1h17a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1Z" clip-rule="evenodd"/></svg>',
    radius: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 20v-8a7 7 0 0 1 7-7h7"/></svg>',
    move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>',
    spacing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="3"/><rect x="8.5" y="8.5" width="7" height="7" rx="1" stroke-dasharray="2 2"/></svg>',
    reset: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4.47 2.5a1 1 0 0 1 1 1v1.57A9.47 9.47 0 0 1 11.97 2.5a9.5 9.5 0 1 1-9.43 10.62 1 1 0 0 1 1.98-.23A7.5 7.5 0 1 0 6.38 7H9a1 1 0 1 1 0 2H4.47a1 1 0 0 1-1-.96V3.5a1 1 0 0 1 1-1Z"/></svg>',
  };
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function render() {
    const n = count();
    const btn = (id, label, key) =>
      `<button class="tool" data-tool="${id}" aria-pressed="${tool === id}" title="${label} (${key})">${ICON[id === "text" ? "type" : id]}${label} <kbd>${key}</kbd></button>`;
    let html = btn("text", "Text", "T") + btn("radius", "Radius", "R") + btn("spacing", "Spacing", "S") + btn("move", "Move", "V");
    const sw = (id, on, label, title) => `<button class="toggle" data-toggle="${id}" aria-pressed="${on}" title="${title}"><span class="switch" aria-hidden="true"></span>${label}</button>`;
    if (tool === "move") {
      html += `<span class="sep"></span>${sw("absolute", moveAbsolute, "Absolute", moveAbsolute ? "On: drag anywhere, Claude positions it absolutely" : "Off: drag into containers, Claude moves it in the layout")}`;
      if (moveAbsolute) html += sw("shot", moveScreenshot, "Screenshot", "Copy a cropped screenshot of absolute moves first, then the prompt");
    }
    if (boxTool() || radiusEdits.size || spaceEdits.size || moveEdits.size) {
      html += `<span class="sep"></span>
        <button class="toggle" data-toggle="tokens" aria-pressed="${useTokens}" title="${useTokens ? "On: Claude uses your existing design tokens, rounding to the nearest one" : "Off: Claude uses the exact value, even if no token exists yet"}"><span class="switch" aria-hidden="true"></span>Tokens</button>`;
    }
    if (status === "done" || status === "error") {
      html += `<span class="sep"></span><span class="note ${status === "error" ? "err" : ""}" role="status" title="${esc(message)}">${esc(message)}</span>`;
    }
    if (n > 0) {
      html += `<span class="sep"></span>
        <span class="note count">${n} edit${n === 1 ? "" : "s"}</span>
        <button class="icon reset" title="Revert all edits" aria-label="Revert all edits">${ICON.reset}</button>
        <button class="copy" title="Copy a prompt for Claude (${isMac ? "⌘" : "Ctrl"}↵)">Copy prompt <kbd>${isMac ? "⌘" : "Ctrl"}↵</kbd></button>`;
    }
    bar.innerHTML = html;
  }

  bar.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.tool) setTool(tool === b.dataset.tool ? null : b.dataset.tool);
    else if (b.dataset.toggle) {
      const t = b.dataset.toggle;
      if (t === "tokens") useTokens = !useTokens;
      if (t === "absolute") moveAbsolute = !moveAbsolute;
      if (t === "shot") moveScreenshot = !moveScreenshot;
      try {
        localStorage.setItem("ptk-tokens", useTokens ? "on" : "off");
        localStorage.setItem("ptk-move", moveAbsolute ? "absolute" : "flow");
        localStorage.setItem("ptk-shot", moveScreenshot ? "on" : "off");
      } catch {}
      render();
    } else if (b.classList.contains("reset")) revertAll();
    else if (b.classList.contains("copy")) copy();
  });

  function setTool(next) {
    if (editing) commit(editing);
    select(null);
    hovered = null;
    tool = next;
    if (next) document.documentElement.setAttribute("data-ptk-tool", next);
    else document.documentElement.removeAttribute("data-ptk-tool");
    if (status !== "idle") status = "idle";
    render();
    if (boxTool()) requestAnimationFrame(follow);
    else paint();
  }

  const fromToolbar = (e) => e.composedPath().includes(host);

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
    if (!originalText.has(el)) originalText.set(el, el.innerText.trim());
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
    if (edit.after === edit.shown) textEdits.delete(el);
    mark(el);
    render();
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
    pick(node, tool === "radius" ? drawsBox : tool === "move" ? (el) => drawsBox(el) || hasOwnText(el) || MEDIA.has(el.tagName) : (el) => hasSpace(el) || drawsBox(el));

  function select(el) {
    el = (el && inflowOwner.get(el)) ?? el;
    if (field && el !== selected) closeField(true);
    /* A panel field still holding focus applies to the old element (on blur) before the switch. */
    const active = root.activeElement;
    if (el !== selected && selected && active && panel.contains(active)) {
      applyFieldInput(active);
      active.blur();
    }
    selected = el;
    if (el && !originalRadius.has(el)) originalRadius.set(el, getComputedStyle(el).borderRadius);
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
    const r = place(selBox, on ? selected : null);
    paintRadius(tool === "radius" ? r : null);
    paintSpacing(tool === "spacing" ? r : null);
    paintPanel(tool === "move" ? null : r);
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
    input.focus();
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
                     the prompt asks for position: absolute there (optionally with a cropped screenshot). */
  let moveAbsolute = false;
  let moveScreenshot = false;
  try {
    moveAbsolute = localStorage.getItem("ptk-move") === "absolute";
    moveScreenshot = localStorage.getItem("ptk-shot") === "on";
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
    const text = (n.innerText || "").trim().replace(/\s+/g, " ");
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

  /* Grab one frame of this tab (Chrome asks once to share it), crop to where things moved from and to,
     and draw an arrow from each old spot to its new one. The toolkit's own UI is hidden for the frame. */
  async function screenshot() {
    const moves = [...moveEdits.values()].filter((e) => e.mode === "absolute");
    if (!moves.length || !navigator.mediaDevices?.getDisplayMedia) return null;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: false, preferCurrentTab: true, selfBrowserSurface: "include" });
    } catch {
      return null;
    }
    const hidden = [...root.children].filter((n) => n.tagName !== "STYLE" && !n.classList.contains("ghosts"));
    const was = hidden.map((n) => n.style.visibility);
    hidden.forEach((n) => (n.style.visibility = "hidden"));
    try {
      const video = Object.assign(document.createElement("video"), { srcObject: stream, muted: true });
      await video.play();
      await new Promise((res) => setTimeout(res, 250)); // let the hidden UI leave the frame
      const scale = video.videoWidth / innerWidth;
      const boxes = moves.flatMap((e) => [viewRect(e.from.rect), e.clone.getBoundingClientRect()]);
      const pad = 48;
      let x0 = Math.max(0, Math.min(...boxes.map((b) => b.left)) - pad);
      let y0 = Math.max(0, Math.min(...boxes.map((b) => b.top)) - pad);
      const x1 = Math.min(innerWidth, Math.max(...boxes.map((b) => b.right)) + pad);
      let y1 = Math.min(innerHeight, Math.max(...boxes.map((b) => b.bottom)) + pad);
      /* A thin strip loses its context (and leaves no room for the arrow to bend): keep at least 200px tall. */
      const minH = Math.min(200, innerHeight);
      if (y1 - y0 < minH) {
        const grow = minH - (y1 - y0);
        y0 = Math.max(0, y0 - grow / 2);
        y1 = Math.min(innerHeight, y0 + minH);
        y0 = Math.max(0, y1 - minH);
      }
      x0 = Math.max(0, x0);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round((x1 - x0) * scale);
      canvas.height = Math.round((y1 - y0) * scale);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, x0 * scale, y0 * scale, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
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

      for (const e of moves) {
        const a = viewRect(e.from.rect);
        const b = e.clone.getBoundingClientRect();
        const [acx, acy] = [a.left + a.width / 2 - x0, a.top + a.height / 2 - y0];
        const [bcx, bcy] = [b.left + b.width / 2 - x0, b.top + b.height / 2 - y0];
        const [ax, ay] = edge(a, bcx, bcy);
        const [bx, by] = edge(b, acx, acy);
        /* Bend the arrow off the content, toward whichever side of the crop has more room. */
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
    if (f === "gap") return gapInfo(getComputedStyle(selected))?.props ?? [];
    return f.split(" ");
  };

  function readField(f) {
    if (f === "radius") return radiusLabel(selected, Math.round(currentRadius(selected)));
    const cs = getComputedStyle(selected);
    const values = fieldProps(f).map((prop) => Math.round(px(cs, prop) * 10) / 10);
    return values.every((v) => v === values[0]) ? `${values[0] ?? ""}` : "Mixed";
  }

  function writeField(f, v) {
    if (f === "radius") setRadius(selected, v);
    else setSpace(selected, fieldProps(f), v);
  }

  const fieldNow = (f) => (f === "radius" ? currentRadius(selected) : px(getComputedStyle(selected), fieldProps(f)[0]));

  function applyFieldInput(input) {
    const f = input.closest(".f").dataset.f;
    const raw = input.value.trim().toLowerCase();
    if (!selected || raw === "" || raw === "mixed") return;
    if (f === "radius" && (raw === "full" || raw === "f")) return writeField(f, Infinity);
    const v = parseFloat(raw);
    if (!Number.isNaN(v)) writeField(f, snap(v));
  }

  let lastPanelFor = null;
  function paintPanel(r) {
    if (!r || !boxTool()) {
      panel.style.display = "none";
      lastPanelFor = null;
      return;
    }
    panel.style.display = "block";
    if (lastPanelFor !== selected) {
      lastPanelFor = selected;
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
    const f = input.closest(".f").dataset.f;
    if (e.key === "Enter") {
      e.preventDefault();
      applyFieldInput(input);
      input.select();
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.value = readField(f) === "Mixed" ? "" : readField(f);
      input.blur();
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && selected) {
      e.preventDefault();
      writeField(f, stepValue(fieldNow(f), e.key === "ArrowUp" ? 1 : -1, e));
      input.value = readField(f);
      input.select();
    }
  });
  panel.addEventListener("focusout", (e) => {
    const input = e.target.closest?.("input");
    if (input && selected) applyFieldInput(input);
  });
  panel.addEventListener("focusin", (e) => e.target.select?.());

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

  /* ================= shared: markers, revert, prompt, copy ================= */

  const mark = (el) => el.toggleAttribute("data-ptk-edited", textEdits.has(el) || radiusEdits.has(el) || spaceEdits.has(el) || moveEdits.has(el));

  function revertAll() {
    if (editing) commit(editing);
    closeField(false);
    for (const [el, e] of textEdits) restore(el, e.snapshot);
    for (const [el, e] of radiusEdits) el.style.borderRadius = e.inline;
    for (const [el, e] of moveEdits) unmove(el, e);
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
  }

  function clearEdits() {
    const els = [...textEdits.keys(), ...radiusEdits.keys(), ...spaceEdits.keys(), ...moveEdits.keys()];
    textEdits.clear();
    radiusEdits.clear();
    spaceEdits.clear();
    moveEdits.clear();
    els.forEach(mark);
  }

  const earlier = (e) => (e.shown !== e.before ? ` (an earlier edit may already have made it ${e.shown})` : "");
  const tokenRule = (scale) =>
    useTokens
      ? `Use the project's existing design tokens for these values (CSS variables, the ${scale} scale, Tailwind config, utilities). If no token has exactly a value, use the nearest existing one and tell me what you rounded to. Do not hardcode raw values and do not add new tokens.`
      : `Use these exact values. If an existing token has exactly a value, use it; otherwise write the raw px value, even though no token exists for it yet.`;
  const COMPONENT_RULE = "I am tuning the component, not one instance: if every instance shares the rule (all chips, all cards), change the shared rule. Only scope it to this one element if it is clearly a one-off, and say which you did.";

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
    if (textEdits.size) {
      const list = [...textEdits.values()].map((e) =>
        `${++i}. <${e.tag}> ${where(e)}\n   before: ${JSON.stringify(e.before)}${e.shown !== e.before ? ` (an earlier edit may already have made it ${JSON.stringify(e.shown)})` : ""}\n   after:  ${e.after ? JSON.stringify(e.after) : "(deleted) remove this text. If the element only held this text, remove the element too, and tidy any spacing it leaves behind."}`,
      );
      sections.push(`Text\n\n${list.join("\n\n")}`);
      how.push(`Text: find where each "before" string comes from (JSX, a content or constants file, JSON, markdown, i18n); search for a distinctive fragment if the whole string does not match. Change only that copy and keep the surrounding markup and code style. If the same string lives in several places, change the one that renders on this page.`);
    }
    if (radiusEdits.size) {
      const list = [...radiusEdits.values()].map((e) => `${++i}. <${e.tag}> ${where(e)}\n   border-radius: ${e.before}${earlier(e)} → ${e.full ? "fully rounded (pill, 9999px)" : e.after}`);
      sections.push(`Corner radius\n\n${list.join("\n\n")}`);
      how.push(`Radius: find the rule that rounds each element (CSS module class, Tailwind class, styled component, inline style). ${tokenRule("radius")} ${COMPONENT_RULE}`);
    }
    if (spaceEdits.size) {
      const list = [...spaceEdits.values()].map((e) => `${++i}. <${e.tag}> ${where(e)}\n${spaceLines(e)}`);
      sections.push(`Spacing\n\n${list.join("\n\n")}`);
      how.push(`Spacing: find the rule that produces each space (padding, margin or gap on a CSS module class, Tailwind classes like p-4 or gap-3, a styled component, inline style). Space can also come from the parent, such as space-y utilities or sibling selectors; change the rule that actually creates it. ${tokenRule("spacing")} ${COMPONENT_RULE}`);
    }
    const flows = [...moveEdits.entries()].filter(([, e]) => e.mode === "flow" && e.to);
    const absolutes = [...moveEdits.entries()].filter(([, e]) => e.mode === "absolute");
    if (flows.length) {
      const list = flows.map(([, e]) => `${++i}. <${e.tag}> ${where(e)}\n${describeFlow(e)}`);
      sections.push(`Moved in the layout\n\n${list.join("\n\n")}`);
      how.push(`Layout moves: change the JSX to match. A reorder means changing the order of the children; if they come from a .map() over data, reorder the data instead. A move into another container means moving the element's JSX (with its props and wiring) into that parent at that position. Keep everything in normal flow: no absolute positioning, no negative margins. Tidy spacing the move leaves behind.`);
    }
    if (absolutes.length) {
      const list = absolutes
        .sort(([, a], [, b]) => a.n - b.n)
        .map(([el, e]) => `${++i}. Move ${e.n} (${e.colorName}${shotAttached ? " in the screenshot" : ""}): <${e.tag}> ${where(e)}\n${describeAbsolute(el, e)}`);
      sections.push(`Positioned absolutely\n\n${list.join("\n\n")}${shotAttached ? "\n\nI attached a screenshot. Each move has its own colour: the dashed box labelled “Move N · from” is where it was, the outlined element labelled “Move N” is where I put it, and an arrow in the same colour joins them." : ""}`);
      how.push(`Absolute moves: I chose free positioning for these. Make each position: absolute inside the named container (give the container position: relative if it has none) at those offsets, taking it out of the flow. If it moved to another container, move its JSX there too. ${tokenRule("spacing")}`);
    }
    return `I tweaked the design directly in the browser on ${location.href}. Apply these changes to the source code.

${sections.join("\n\n")}

${how.join("\n\n")}`;
  }

  let shotAttached = false;

  async function copy() {
    if (editing) commit(editing);
    closeField(true);
    const n = count();
    if (!n) return;
    /* Screenshot first, as its own clipboard step: chat inputs paste an image or text, rarely both. */
    let shotFailed = false;
    if (moveScreenshot && !pendingPrompt && [...moveEdits.values()].some((e) => e.mode === "absolute")) {
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
      await navigator.clipboard.writeText(prompt());
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
    } else {
      e.preventDefault();
      /* Move: pressing on the selection (or anything inside it) drags it; elsewhere picks and drags the new one. */
      const target = tool === "move" ? movedAt(e.clientX, e.clientY) ?? (selected && selected.contains(e.target) ? selected : pickFor(e.target)) : pickFor(e.target);
      select(target);
      if (tool === "move" && target) (moveAbsolute ? startMove : startFlowDrag)(e, target);
    }
  }, true);
  window.addEventListener("pointerup", () => {
    if (drag?.kind === "flow") return dropFlow(false);
    if (drag?.kind !== "move") return;
    drag = null;
    paint();
  }, true);
  ["mousedown", "mouseup", "pointerup", "click", "auxclick", "dblclick", "submit"].forEach((t) => window.addEventListener(t, swallow, true));

  window.addEventListener("pointermove", (e) => {
    if (drag?.kind === "move") return dragMove(e);
    if (drag?.kind === "flow") return dragFlow(e);
    if (!boxTool() || drag || fromToolbar(e)) return;
    hoverBand = null;
    hovered = pickFor(e.target);
  }, true);

  window.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
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
    const shortcuts = { t: "text", r: "radius", s: "spacing", v: "move" };
    if (shortcuts[key] && !e.shiftKey) {
      e.preventDefault();
      setTool(tool === shortcuts[key] ? null : shortcuts[key]);
    } else if (e.key === "Escape" && tool) {
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
    render();
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
