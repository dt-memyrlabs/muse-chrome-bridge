# Frame-copy spec — how Claude in Chrome actually drives a page

Extraction date: 2026-10-28. Target: Claude in Chrome extension v1.0.101,
the SHA256-verified pulled tree at `~/workspace/rea-claude-chrome/ext/`.
Method: REA 6.8.0 scoped run over the four driving files (evidence index
at the end) plus direct bundle reads. Every mechanic below names its
bundle file and, where useful, the byte offset in the minified bundle.
Anything not established is marked UNKNOWN — nothing is guessed.

## The headline (read this first)

Claude in Chrome does **not** attach to iframe targets. Across the three
driving bundles there are **zero** occurrences of
`Target.attachToTarget`, `Target.setAutoAttach`, `Page.getFrameTree`,
`Runtime.executionContextCreated` tracking, `DOM.focus`,
`DOM.getContentQuads`, `DOM.scrollIntoViewIfNeeded`, or
`Page.getLayoutMetrics`.

Its whole frame ability comes from two facts:

1. **One `chrome.debugger` session per tab** (`{tabId}`, protocol
   `"1.3"`). CDP `Input.*` commands sent on a tab session are
   browser-process input: a mouse press at viewport coordinates is
   hit-tested by the browser into whichever frame sits under the point
   — including a cross-origin iframe — and focuses that frame's field.
   `Input.insertText` and key events then land in the focused element,
   whichever frame owns it. No per-frame session is ever needed.
2. **Everything else is `chrome.scripting.executeScript`**, which can
   run a function in the main frame, in named `frameIds`, or in
   `allFrames`, across origins, under the extension's host permissions.

That is the mechanic our bridge is missing: our input path resolves a
node inside the main frame's document and dispatches against it, so a
composer inside an embedded frame (factory.8090.ai, 2026-10-06 and
2026-10-28) can never receive focus. Claude clicks the point, the
browser focuses the framed field, and typing follows focus.

Files that matter (all under `ext/assets/`):

| File | Role |
|---|---|
| `mcpPermissions-BLfQICzX.js` (623 KB) | The driver: CDP wrapper class, all tools (click/type/read_page/find/screenshot/form_input/…), permission gate |
| `accessibility-tree.js-B-oUarrX.js` (6.8 KB) | Content script, `all_frames: true`, `document_start`: builds the in-page element tree + ref map |
| `agent-visual-indicator.js-BKHK7gXk.js` (18.5 KB) | Content script, main frame, `document_idle`: phantom cursor, pills, hide/show around tool use |
| `service-worker.ts-BbwcTK_t.js` (82 KB) | Service worker shell; no `executeScript`, no debugger calls — delegates to the chunk above |

---

## 1. Frame discovery

**What Claude does**

- No frame enumeration for page work. `read_page`, `find`, coordinate
  resolution, and `get_page_text` all run in the **main frame only**:
  `chrome.scripting.executeScript({target: {tabId}, func, args})`
  through a timeout-wrapped helper (bundle offset ~15565: races
  `chrome.scripting.executeScript` against a timer; failure raises
  `PageLoadingError`, "executeScript waited … for document_idle").
- The tree-builder content script is registered for **all frames**
  (`manifest.json` content_scripts: `all_frames: true`,
  `run_at: document_start`, `<all_urls>`), so every frame carries its
  own copy of the builder and its own ref map — but no tool call found
  in the driver invokes the builder in a child frame.
- A frame inventory exists in exactly one feature:
  `chrome.webNavigation.getAllFrames({tabId})` (offset ~19288), used by
  an interference-cleanup pass to map parent→child frameIds, compare
  per-frame iframe counts, and run cleanup per frame via
  `executeScript({target: {tabId, frameIds: [id]}, injectImmediately: true})`.
  This proves frameId-targeted scripting is the house pattern when a
  frame must be addressed directly.
- The debugger event handler (offset ~186012) listens for
  `Page.frameNavigated` and only reacts when `frame.parentId` is absent
  (top frame) — navigation bookkeeping for beforeunload dialogs, not
  frame attachment.
- Debugger attach sequence per tab (offset ~189727,
  `attachDebuggerImpl`): refuse restricted schemes → detach any prior
  session → `chrome.debugger.attach({tabId}, "1.3")` raced against a
  timeout → `Page.enable` always; `Runtime.enable` only if console
  tracking is on; `Network.enable {maxPostDataSize: 65536}` only if
  network tracking is on → then focus emulation (item 3).

**COPY:**

- Keep one debugger session per controlled tab, `{tabId}`, `"1.3"`,
  attach deduped in-flight and raced against a timeout, with the
  restricted-scheme refusal and the enable sequence above.
- Do **not** build Target/session-per-frame machinery. Frame reach =
  tab-level CDP input (items 3–5) + frameId-targeted
  `chrome.scripting` where a frame must be read or cleaned directly.
- Keep a `webNavigation.getAllFrames` map per tab anyway: it is the
  only reliable frame inventory, and the read/cleanup features need it.

## 2. Element resolution

**What Claude does**

- The tree is **DOM-built in page, not the CDP Accessibility domain**
  (`Accessibility.getFullAXTree`: 0 occurrences). The content script
  defines `window.__generateAccessibilityTree(filter, maxDepth = 15,
  maxChars = 50000, refId)`:
  - Recursive DOM walk from `document.body` (`element.children` only —
    it does not descend into iframe documents or shadow roots; each
    frame's own copy covers its own document).
  - Role inferred from explicit `role` attribute, else a tag/type
    table (a→link, button→button, input by type, select→combobox,
    textarea/input→textbox, h1–h6→heading, …).
  - Name from, in order: selected option text for `<select>`,
    `aria-label`, `placeholder`, `title`, `alt`, `label[for=id]` text,
    submit value, the element's value (if < 50 chars), direct text
    children (≥ 3 chars), capped at 100 chars.
  - Sensitive values are replaced with `[value redacted]`:
    `type=password|hidden`, or `autocomplete` containing
    current-password, new-password, one-time-code, cc-number, cc-csc,
    cc-exp*.
  - Inclusion: skips script/style/meta/link/title/noscript; skips
    `aria-hidden` and invisible elements (computed display/visibility/
    opacity + non-zero offset size) unless filter is `all`; skips
    off-viewport elements unless a `refId` focus is requested; always
    includes interactive elements (native interactive tags, `onclick`,
    `tabindex`, role button/link, `contenteditable`), landmarks, and
    named elements.
  - Every included element gets a stable ref `ref_N` (per-window
    counter) stored as a `WeakRef` in `window.__claudeElementMap` with
    a reverse `WeakMap`; dead refs are pruned each run. Output is text
    lines: `role "name" [ref_N]` plus `href`/`type`/`placeholder`
    attributes, indented by depth; hard cap 10,000 elements; output
    truncated at a line boundary at `maxChars` with a note.
- `read_page` (offset ~335075): permission check → hide indicator,
  wait 50 ms → `executeScript` in the main frame calling the builder
  with `(filter, depth, maxChars, refId)` → returns
  `{pageContent, viewport: {width, height}}`.
- `find` (offset ~292770): builds the tree with filter `"all"`, then
  sends the tree text to a **small/fast model** with a fixed prompt
  ("Find ALL elements that match… return `ref_X | role | name |
  type | reason` lines, max 20"). Returned refs are validated against
  the `[ref_N]` set actually present in the tree before being handed
  back. Find is an LLM pass over the tree text, not a DOM query.
- Ref → coordinates (offset ~281516, function `Wd`): `executeScript`
  in the main frame — deref the WeakRef, verify `document.contains`,
  `el.scrollIntoView({behavior: "instant", block: "center",
  inline: "center"})`, read `offsetHeight` to force layout, then
  `getBoundingClientRect()` and return the **center**
  `[left + width/2, top + height/2]` in main-frame viewport CSS px.
- Model-supplied coordinates (from screenshots) go through `Ku()`
  (offset ~242033): converts screenshot-frame pixels to viewport
  pixels using the per-tab stored context (viewport vs screenshot
  dimensions), and rejects out-of-frame coordinates with an explicit
  error. `Hu()` is the pure ratio helper.
- One hand-rolled cross-frame descent exists, in the upload tool
  (offset ~348563): `document.elementFromPoint(x, y)`; if the hit is
  an `IFRAME`, it tries `contentDocument` (same-origin only,
  try/catch), subtracts the iframe's bounding-rect origin, and
  re-hit-tests inside. Cross-origin frames silently keep the iframe
  element itself.
- `get_page_text`: main-frame script that picks the largest
  article/main-like container (selector list, compared by
  `innerText` length; fallback `document.body`) and returns
  whitespace-normalized `innerText`.

**COPY:**

- Ship the same in-page tree builder as a content script on all
  frames: same role/name/redaction rules, same ref scheme (WeakRef
  map per window), same caps (depth 15, 10,000 elements, 50,000 chars
  default), same text output shape. Tools consume refs, never raw
  selectors.
- `read_page` = timeout-wrapped `executeScript` in the main frame
  calling the builder. `find` = tree text + a small-model ref picker
  with ref validation (or an equivalent deterministic matcher — but
  the ref-validation step is not optional).
- Ref → point = in-page: scrollIntoView instant/center, force layout,
  bounding-rect center. Never cache coordinates across actions;
  resolve at action time.
- Keep a per-tab coordinate context from the last screenshot and
  convert model coordinates through it, rejecting out-of-frame points.
- UNKNOWN: no code was found that merges child-frame trees or resolves
  refs belonging to child-frame documents; whether some tool variant
  in the 1.8 MB sidepanel bundle does so was not exhaustively
  established (pattern counts only). Treat framed-element access as
  coordinate-based (items 3–5), which matches all evidence found.

## 3. Focus

**What Claude does** — three distinct layers:

1. **The CDP click itself.** A click is dispatched on the tab session
   at viewport coordinates (item 5). The browser hit-tests the point
   and focuses the element under it — in the main frame or in any
   iframe, same- or cross-origin. There is no DOM-focus call in the
   mouse path at all.
2. **Focus emulation** (`Emulation.setFocusEmulationEnabled`,
   offsets ~182361 and ~190311): the CDP wrapper's `sendCommand`
   first calls `ensureFocusEmulation(tabId)`, which enables focus
   emulation on tabs that need it (tracked in a per-tab set), so an
   unfocused or background tab still behaves as focused — caret,
   `:focus`, and text input all land — while the agent works.
   `detachDebugger` tears it down first (`endFocusEmulation`, raced
   against a 3 s timeout).
3. **In-page focus for form filling** (`form_input`, offset ~298313):
   resolve the ref in-page, `scrollIntoView({behavior: "smooth",
   block: "center"})`, then `el.focus()`, then set the value natively
   per control type and dispatch bubbling `change` + `input` events —
   all inside `executeScript`, no CDP involved.

`DOM.focus` is never used (0 occurrences).

**COPY:**

- Focus for typing = a real CDP mouse press at the target point on
  the tab session. Never try to focus a framed field from the main
  frame's DOM — that is precisely the failure mode being replaced.
- Enable `Emulation.setFocusEmulationEnabled {enabled: true}` on the
  tab session before Input commands, per tab, and disable it on
  detach.
- Keep a separate in-page `form_input` path (ref → scrollIntoView
  smooth → `.focus()` → native value set per type → `change`/`input`
  events) for programmatic field sets in the main frame's document.

## 4. Text entry

**What Claude does**

- The `type` tool (action layer, offset ~261781) does no targeting:
  permission check, optional origin check, then `cdp.type(tabId,
  text)`. Whatever holds focus receives the text.
- `cdp.type` (offset ~194833): per character —
  - if the character has a key mapping (`getKeyCode`: named-key table,
    else `Key<Letter>` / `Digit<n>` synthesis with `key`, `code`,
    `windowsVirtualKeyCode`): queue `Input.dispatchKeyEvent`
    `keyDown` + `keyUp` (`keyDown` vs `rawKeyDown` chosen by whether
    the key carries text; `text`/`unmodifiedText` set; shift modifier
    bit 8 when `requiresShift` — uppercase or ``~!@#$%^&*()_+{}|:"<>?``);
  - `"\n"` / `"\r"` are converted to the **Enter** key;
  - unmapped characters go through `Input.insertText({text})`
    (offset ~193441) on the same tab session.
  - All queued operations are awaited together (`Promise.all`).
- Key action / chords: `pressKey` = keyDown+keyUp; `pressKeyChord`
  splits modifiers (bitmask alt 1, ctrl 2, meta 4, shift 8) and
  presses the remaining key; reload chords are special-cased to
  `chrome.tabs.reload`.
- `form_input` is the second, different text path: in-page value set
  (item 3, layer 3), including select-by-value-or-text, checkbox/radio
  state, date/time/range/number coercion, each ending with `.focus()`
  + `change`/`input` events and a redacted echo for sensitive fields.

**COPY:**

- `type` targets focus, never a node: click first (item 5), then send
  text on the tab session.
- Reproduce the per-character split exactly: mapped key →
  dispatchKeyEvent down/up with text fields set; newline → Enter key;
  unmapped → `Input.insertText`. Modifiers use the CDP bitmask
  (alt 1, ctrl 2, meta 4, shift 8).
- Keep `form_input` as the in-page path for main-frame fields; do not
  route it through CDP typing.
- UNKNOWN: nothing was found about IME/composition handling; treat as
  absent, not as designed-out.

## 5. Mouse

**What Claude does** — `click(tabId, x, y, button, clickCount,
modifiers)` (offset ~193591) and `dispatchMouseEvent` (~191960):

- First the visual indicator is hidden (`hideIndicatorForToolUse`) and
  the driver waits **50 ms**.
- `mouseMoved` is dispatched first. Before it, a phantom-cursor sync
  message (`chrome.tabs.sendMessage(tabId, {type:
  "UPDATE_PHANTOM_CURSOR", x, y})`) is raced against a 250 ms cap for
  the active tab (item 7); in service-worker context the move uses
  `skipCursorWait` with a 50 ms ack cap.
- Per click count i = 1..n: `mousePressed` {button name, buttons
  bitmask (left 1, right 2, middle 4), clickCount: i, modifiers} →
  12 ms pause when the page is visible → `mouseReleased` {buttons:
  0} → 100 ms between repeated clicks.
- Coordinates are rounded to integers; the params object carries
  `force: 0.5` while buttons are held (drag pressure) and `clickCount`
  only on press/release. `mouseWheel` carries `deltaX/deltaY`.
- Drag (`left_click_drag`) is the same stream: move with buttons held
  between press and release at the end point.
- Scroll (offset ~262617): the point is converted via `Ku()`, deltas
  are `scroll_amount` (default 3) × 100 px in the scroll direction,
  sent as one `mouseWheel` at the point with a 50 ms ack cap. If the
  window is minimized, it falls back to an in-page scroll helper and
  waits 200 ms (fallback body referenced, not fully extracted —
  partial evidence).
- **Frame boundaries need no transform.** All coordinates are
  main-frame viewport CSS pixels on the tab session; the browser
  routes press/release/wheel to the frame under the point. No
  `getContentQuads`, no layout-metrics call, no per-frame offset math
  exists in the input path. No devicePixelRatio multiplication was
  found in the input path either; DPR appears only in screenshot
  bookkeeping (item 6).

**COPY:**

- Dispatch the full sequence on the tab session: hide indicator →
  50 ms → mouseMoved (cursor sync first) → for each click:
  mousePressed → ~12 ms → mouseReleased → 100 ms between clicks.
- Round coordinates; carry button bitmask, clickCount, modifiers,
  and `force: 0.5` while held, exactly as above.
- Scroll = one `mouseWheel` at the point, 100 px per scroll unit,
  default 3 units.
- Never resolve a click target to a frame-local point. The point is
  the contract; the browser does the frame routing.

## 6. Screenshots / capture

**What Claude does**

- One call, tab session only: `Page.captureScreenshot` with
  `{format: "jpeg", captureBeyondViewport: false, fromSurface: true}`
  and adaptive quality. No per-frame capture exists — the tab surface
  already composites every frame, which is why framed content (the
  8090 composer included) is visible in screenshots while being
  unreachable by main-frame DOM tools.
- Size discipline (CDP class statics, offset ~188848):
  `MAX_BASE64_CHARS = 1,398,100`, JPEG quality starts at 0.75, steps
  down 0.05, floor 0.1, until the base64 fits. A clip
  `{x, y, width, height, scale}` is added when the clip-scale setting
  is on; the zoom action uses `format: "png"` with a computed clip.
- Post-capture, the image is processed in-page (canvas, via
  `executeScript`) to the model's target size (≤ 1568 px / token
  budget), and the resulting "coordinate frame"
  (`frameWidth`/`frameHeight`) is stored per tab (context store,
  offset ~25308) — this is what `Ku()` later converts model clicks
  through, and the tool result reports it ("coordinate frame:
  WxH").
- Before capture (`prepareForCapture`, offset ~198842): focus
  emulation/attach is ensured, and an in-page metrics read collects
  `{innerWidth, innerHeight, devicePixelRatio, scrollX, scrollY,
  visibility_state, dom_nodes, ready_state, iframe_count,
  js_heap_mb}`. A security re-check (`verifyBeforeCapture`) can veto
  the capture.
- Background/hidden tabs: a separate draw pass (`drawTab`,
  offset ~193113) issues `Page.captureScreenshot {format: "jpeg",
  quality: 1, captureBeyondViewport: false, fromSurface: true}` to
  force a surface draw; skipped when the window is minimized.

**COPY:**

- Capture = `Page.captureScreenshot` on the tab session,
  `captureBeyondViewport: false`, `fromSurface: true`, JPEG with the
  quality step-down ladder (0.75 → 0.10 by 0.05) against a
  ~1.4 M-char base64 ceiling.
- Resize in-page to the model budget and persist the coordinate
  frame per tab; every later coordinate action converts through it.
- Run the metrics read + sensitivity re-check before every capture;
  keep the forced-draw capture for hidden tabs.

## 7. Everything else a copy must match

- **Phantom cursor** (`agent-visual-indicator.js`): a fixed-position
  overlay (`pointer-events: none`, z-index 2147483646) moved by
  `transform: translate3d(x, y, 0)` with CSS
  `transition: transform 180ms cubic-bezier(0.2, 0, 0, 1)`; the move
  is awaited via `transitionend` with a 220 ms timeout fallback
  before input proceeds. The indicator set (cursor, group pill,
  stop container) hides on tool use and restores after
  (`HIDE_FOR_TOOL_USE` / `SHOW_AFTER_TOOL_USE`), and everything is
  torn down on `beforeunload`.
- **Settle discipline**: every `executeScript` is raced against a
  timeout and fails as "page still loading — try again in a moment"
  rather than acting mid-navigation; 50 ms settle after hiding the
  indicator before any input; screenshot attempts are rate-tracked
  per tab over a 60 s window.
- **Dialogs**: `Page.javascriptDialogOpening` is intercepted;
  `beforeunload` follows a per-tab accept/dismiss policy and is
  answered with `Page.handleJavaScriptDialog`; a top-frame
  `Page.frameNavigated` releases beforeunload waiters.
- **Click interception guard**: before a left click, a guard arms an
  in-page hook (`__cicBgClickGuard`) so a click that would open a
  foreground window from a minimized/background context is drained
  and reported instead of stealing the user's screen.
- **Interference cleanup**: before reads, a pass walks all frames
  (webNavigation map + per-frame scripting, shadow roots via
  `chrome.dom.openOrClosedShadowRoot`) and removes other extensions'
  injected iframes that pollute the tree (kill-switch in storage).
- **Permission gate**: every tool action first runs a per-domain
  permission check (`P(tabId, url, action)` in the snippets) and can
  return `permission_required` instead of acting. (Our bridge's
  Site Allow/Deny + approval rules already cover this layer; the
  mechanic to copy is check-before-every-action, on the exact target
  URL.)
- **Side channels on the same session**: `Runtime.enable` →
  `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` captured via
  `chrome.debugger.onEvent` into a per-tab console log (16 KB text
  cap per message); `Network.enable` → per-tab request log. Detach
  order matters: end focus emulation, then `chrome.debugger.detach`;
  attach state is checkable via `chrome.debugger.getTargets`.
- **Tool surface shape** (for parity of behaviour, from the action
  switch at offset ~261718): click tools take `ref` **or**
  `coordinate`; `type` takes text only; `scroll` takes coordinate +
  direction + amount; `scroll_to` takes a ref; `form_input` takes a
  ref + value; `find` takes a query; `read_page` takes filter/depth/
  max_chars/ref_id. A batch action runs actions sequentially against
  one stored coordinate context.

## Evidence index

- REA 6.8.0,
  `analyze-javascript-application` on `~/workspace/rea-claude-chrome/ext`,
  scoped via `--source-path` to the four driving files.
  Parent evidence: `ev_17ff269b7e591e1d3bad45dfab23e1e9a432e37f94ac92306355afc8b13e6a80`;
  summary view: `ev_ddd6ff5f59a66862e7eac4f2e7adec3faf1655af504be2c48df9683905d7a007`.
  Subject digest: sha256
  `97a2a19fef3e9d4d3af511141408e41073f16007d67a33d79de6a0b2196c50ab`.
  (The earlier full-tree REA run and its limits are recorded in
  `~/workspace/rea-claude-chrome/REVIEW.md`.)
- Direct bundle reads (primary evidence for every mechanic above):
  - `ext/assets/mcpPermissions-BLfQICzX.js` — CDP wrapper class
    (~182000–197500), coordinate/ref plumbing (~242033, ~25308,
    ~281516–283100), tool actions (~261718–269100), find/read_page/
    form_input (~292770, ~298313, ~335075), interference pass
    (~18600–20800), screenshot pipeline (~197930–203900).
  - `ext/assets/accessibility-tree.js-B-oUarrX.js` — read in full.
  - `ext/assets/agent-visual-indicator.js-BKHK7gXk.js` — cursor
    transition + message handlers.
  - `ext/manifest.json` — content-script registration (all_frames,
    document_start), permissions (debugger, scripting, webNavigation).
- Negative results are from full-text counts over the three driving
  bundles (`mcpPermissions`, `service-worker`, `sidepanel`):
  `Target.attachToTarget` 0, `Target.setAutoAttach` 0,
  `Page.getFrameTree` 0, `Accessibility.getFullAXTree` 0,
  `DOM.focus` 0, `DOM.getContentQuads` 0,
  `Page.getLayoutMetrics` 0, `executionContext` 0.
  The 1.8 MB sidepanel bundle was pattern-counted, not read end to
  end; items resting on absence are bounded to that.
