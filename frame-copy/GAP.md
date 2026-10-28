# Muse Chrome Bridge — framed-page current-state gap map

Date: 2026-10-28  
Scope: current code only. No code was changed for this audit.

Subject tree:

- `extension/sw.js`
- `extension/policy.js`
- `extension/pill.js`
- `extension/cursor.js`
- `extension/manifest.json`

Incident to explain, supplied with the audit request: on factory.8090.ai the agent chat UI is inside an embedded frame. Bridge reads and screenshots can show that UI. Synthetic clicks resolve to the main frame's conversation container. Synthetic typing lands nowhere unless a person first clicks the composer and gives it real focus. This was observed on 2026-10-06 and again on 2026-10-28.

The code audit confirms the architectural conditions for that failure. It does **not** independently prove the factory frame's origin, process model, or Chrome's internal hit-test result. Those items are marked **UNKNOWN** where relevant.

---

## 1. Headline verdict

The extension has a **tab model**, not a frame model.

Every important map and dispatcher is keyed only by `tabId`:

- debugger attachment: one `attached` entry per tab;
- isolated execution world: one cached world per tab, always created in the root frame;
- element refs: `ref -> {tabId, backendNodeId, role, name}`, with no frame identity;
- CDP dispatch: `cdp(tabId, method, params)` always sends to `chrome.debugger` target `{tabId}`;
- input: mouse, keys, and text are all sent through that same tab-level dispatcher;
- page host validation: only the root frame URL is checked.

There is no code path that can select a child frame target, child debugger session, or child execution context. A per-frame implementation therefore cannot be a small patch to the click handler. The identity model, debugger session manager, execution-world manager, coordinate model, focus model, and ref validation all have to gain a frame dimension.

Reads partly escape the failure for two unrelated reasons:

1. `read_page`/`find` consume one browser-supplied accessibility response for the tab target and treat all returned nodes as one flat tree.
2. The in-page probe starts in the root document but manually traverses open shadow roots and **same-origin** frame documents for some modes (`point`, `focus`, `fields`, `shotcheck`).

Screenshots escape it for a third reason: they photograph the composited tab surface and need no node resolution, execution context, focus, or input routing.

---

## 2. The root invariant: no frame identity exists in worker state

### 2.1 Debugger state is keyed by tab only

Evidence — `extension/sw.js:1167-1185`:

- `attached` is declared as `tabId -> lastUse`.
- `attaching` is also keyed by tab.
- `attach(tabId)` calls `chrome.debugger.attach({ tabId }, "1.3")`.
- `detach(tabId)` deletes the cached world for that tab and calls `chrome.debugger.detach({ tabId })`.

There is no `targetId`, CDP `sessionId`, frame ID, or parent/child target record in the attachment state.

### 2.2 The CDP dispatcher cannot address a child session

Evidence — `extension/sw.js:1199-1234`:

- The allow-list `CDP_METHODS` contains tab/page-oriented methods such as `Page.getFrameTree`, `DOM.resolveNode`, `Input.dispatchMouseEvent`, and `Runtime.callFunctionOn`.
- It contains **no `Target.*` method**.
- `cdp(tabId, method, params, ms)` checks the allow-list, calls `attach(tabId)`, then calls:

```js
chrome.debugger.sendCommand({ tabId }, method, params || {})
```

The function signature has no target or session parameter. Therefore no caller in `sw.js` can direct a command to a child frame session, even if a caller somehow discovered one.

A text search of the extension tree found:

- no `Target.attachToTarget`;
- no `Target.setAutoAttach`;
- no `Target.getTargets` — `chrome.debugger.getTargets()` is used only during restart cleanup at `sw.js:2727-2741`;
- no `chrome.debugger.onEvent` listener;
- no frame target registry.

### 2.3 Only one isolated world is created, and it is in the root frame

Evidence — `extension/sw.js:1237-1246`:

- `worlds` is declared as `tabId -> {frameId, loaderId, contextId}`.
- `worldFor(tabId)` calls `Page.getFrameTree`.
- It reads only `frameTree.frame`, the root frame.
- It creates the isolated world `muse_bridge` with that root frame's ID.
- It caches exactly one context per tab.

The child entries in the returned frame tree are not enumerated, stored, or given worlds.

### 2.4 Node execution is forced through that root world

Evidence — `extension/sw.js:1250-1268`:

- `runInWorld(tab, backendNodeId, ...)` obtains the root context from `worldFor(tab.id)`.
- For a node operation it calls `DOM.resolveNode` with `{ backendNodeId, executionContextId: <root contextId> }`.
- It then calls `Runtime.callFunctionOn` on the resolved object or in that root context.

There is no alternate branch for a node whose owning document is a child frame.

### 2.5 Host checks see only the root document

Evidence — `extension/sw.js:1270-1281`:

- `probe()` runs the page probe through `runInWorld()` and compares the returned host with the expected tab host.
- `assertHost()` calls `Page.getFrameTree` and checks only `frameTree.frame.url`.

Child frame navigation, child frame origin, and child frame replacement are not tracked as separate state.

### 2.6 Refs erase frame identity at creation time

Evidence — `extension/sw.js:1380-1412`:

- `refs` stores `ref -> {tabId, b, role, name}`.
- `nodeRefs` stores `tabId -> Map(backendNodeId -> ref)`.
- `refFor(tabId, b, role, name)` receives no frame parameter and stores none.

A ref therefore cannot later answer the questions an input path needs:

- Which frame owns this node?
- Which target/session owns that frame?
- Which execution context should resolve it?
- Which coordinate space does its box use?
- Which frame's focus should receive text or keys?

### 2.7 Ref revalidation is also tab-only

Evidence — `extension/sw.js:1455-1467`:

- `nodeForRef()` recovers `{tabId, backendNodeId, role, name}`.
- It validates the node with one `Accessibility.getPartialAXTree` call through `cdp(tab.id, ...)`.
- No frame or session is supplied or recovered.

**Exact first break:** frame identity is lost when `buildTree()` mints a ref in `refFor()`. Every later click, focus, form fill, and file operation starts from an identity that is already frameless.

---

## 3. Debugger attach model today

### 3.1 Current mechanic

Evidence — `extension/sw.js:1170-1188`, `1222-1234`, `2716-2741`:

1. Attachment is lazy. The first `cdp()` call for a tab calls `attach(tabId)`.
2. Concurrent first calls are de-duplicated by the `attaching` map.
3. `chrome.debugger.attach` receives only `{tabId}` and protocol version `"1.3"`.
4. The resulting attachment is reused until detach.
5. `chrome.debugger.onDetach` removes the tab from `attached` and `worlds`. If the reason is `canceled_by_user`, it also drops the owning chat session.
6. Tab/session removal paths call the same tab-level `detach()` (`sw.js:425`, `927`, `959`).
7. `sweepIdle()` detaches a tab after `DEBUGGER_IDLE_MS` if no command is in flight.
8. After a service-worker restart, `cleanupAfterRestart()` enumerates debugger targets only to detach already-attached targets whose `tabId` belongs to a stored bridge session.

### 3.2 What is absent

There is no implementation for:

- discovering page child targets or out-of-process iframe targets;
- `Target.setAutoAttach` / `Target.attachToTarget`;
- storing a CDP session ID;
- listening for target attached/detached events;
- listening for frame attached, detached, navigated, or swapped-out events;
- creating an execution context in a child frame;
- invalidating a child context independently of the root document;
- detaching one child session without detaching the whole tab.

### 3.3 Exact framed-page break

The attach model ends at the tab target. A child frame that requires its own target/session/context cannot be represented, attached, kept alive, or detached. All downstream DOM, Runtime, Accessibility, and Input calls inherit that limit because they all pass through `cdp(tabId, ...)`.

### 3.4 What a per-frame model must change

In `extension/sw.js`:

- Replace `attached: Map<tabId, lastUse>` with a target/session registry keyed by a stable frame handle, while keeping tab ownership above it.
- Change `attach()`, `detach()`, and `cdp()` to accept a target/session reference and construct the debuggee with that session identity.
- Add `Target.*` discovery/attach methods to `CDP_METHODS` if the chosen design uses CDP target attachment.
- Add debugger event handling for target/session lifecycle.
- Replace the single-entry `worlds` map with worlds keyed by frame/target plus loader.
- Change idle sweep and restart cleanup to account for child sessions, not only tab targets.
- Invalidate refs and worlds by owning target/frame and loader, not only by tab.

---

## 4. Click flow

## 4.1 Entry and target resolution

Evidence — `extension/sw.js:2160-2205`:

1. `TOOLS.computer` resolves the tab with `resolveTab(ctx, refTab(a))`.
2. If a ref is supplied, `nodeForRef(tab, ref)` returns only a `backendNodeId`.
3. For pointed actions, `smoothShowNode(tab, backend)` attempts to scroll the node into view and return its centre.
4. If that returns no centre, `pointForNode(tab.id, backend)` is used.
5. If raw coordinates are supplied, `smoothShowPoint(tab, x, y)` works in the root page's viewport/scroll model.

No frame is resolved at any step.

## 4.2 Which execution contexts are searched?

There are two different search mechanisms. Neither executes a separate child-frame context.

### A. Accessibility search

Evidence — `extension/sw.js:1419-1452`:

- `buildTree()` makes one call: `Accessibility.getFullAXTree {}` through the tab target.
- It builds one `byId` map from the returned node list.
- It mints refs from `backendDOMNodeId` values.
- It does not call `Page.getFrameTree`, enumerate child frames, or annotate a node with a frame.

So the worker's element search space is “whatever this one tab-target accessibility response returns,” flattened into one tree.

### B. In-page probe search

Evidence — `extension/sw.js:1239-1276` and `extension/policy.js:467`, `501-507`, `566-584`, `673-699`, `758-805`:

- Probe code starts in the root frame's isolated world.
- `pageProbe()`'s `up()` helper can climb across open shadow roots and same-origin frame boundaries.
- `deepEach()` and `deepScan()` manually descend open shadow roots and same-origin frame documents by reading `contentDocument`.
- `hitAt()` starts with `document.elementFromPoint` in the root document.
- If the hit element is a same-origin iframe, `hitAt()` subtracts the iframe rectangle plus `clientLeft`/`clientTop`, switches to the child document, and repeats `elementFromPoint` — up to 10 frame levels.
- If the frame is cross-origin, `frameInfo()` cannot obtain its document and `hitAt()` returns only a generic cross-origin frame result.

This is DOM traversal from the root context. It is **not** execution inside a child frame's own isolated world or debugger session.

Cross-origin frame contents are unreachable to this JS traversal by design.

## 4.3 Coordinate computation

Evidence — `extension/sw.js:1483-1549`:

- `quadsCenter()` calls `DOM.getContentQuads {backendNodeId}` through the tab target and averages the first quad.
- `smoothShowNode()` compares that centre with `viewport(tab.id)`.
- `viewport()` calls `Page.getLayoutMetrics` through the tab target and returns the root page's visual viewport (`pageX`, `pageY`, `clientWidth`, `clientHeight`).
- If the node is off-screen, `smoothShowNode()` calls `runInWorld()` so the node can `scrollIntoView`; `runInWorld()` resolves the node into the root execution context.
- `pointForNode()` calls `DOM.scrollIntoViewIfNeeded` and `DOM.getContentQuads`, again only through the tab target.
- `smoothShowPoint()` scrolls with `window.scrollBy` in the root world and adjusts the point using the root viewport's movement.

No worker code applies a frame-chain transform: no accumulated iframe offset, border (`clientLeft`/`clientTop`), frame scroll, frame scale, or nested-frame translation is stored or applied on the ref/click path.

The probe's `hitAt()` does perform a local transform while **classifying** a point in a same-origin frame (`policy.js:773-787`). That transform is not returned as a reusable frame handle and is not used to produce a frame-local input point.

**UNKNOWN:** The code does not establish which coordinate space Chrome returns from `DOM.getContentQuads` for every backend node owned by a child frame under a `{tabId}` target. The code simply consumes the result as if it belonged with the root viewport metrics.

## 4.4 Point classification before the press

Evidence — `extension/sw.js:1567-1586`, `1645-1701`:

- `analyzePoint()` runs the probe in `point` or `refpoint` mode through the root world.
- For a same-origin framed element, the probe can return a description of the inner actionable element, but `describe()` records only a `frameHost` string (`policy.js:750-756`). It does not return a frame ID, frame path, target ID, session ID, execution context, or element handle usable by the worker.
- For a cross-origin frame, the probe returns `{crossOriginFrame: true, frameHost, tag: "iframe"}`.
- Unless the result is cross-origin, `analyzePoint()` also calls `axAt()`.
- `axAt()` adds the root viewport scroll offset to the point and calls `DOM.getNodeForLocation` through the tab target. That cross-check also has no frame identity.

`gatedPress()` then classifies the descriptor, optionally asks for approval, re-analyzes the same point, compares descriptor fingerprints, and runs the press callback.

The fingerprint is made from descriptor strings. It is not a frame-scoped element identity.

## 4.5 Visible cursor path

Evidence — `extension/sw.js:665-707`:

- `pill()` and `cursor()` call `chrome.scripting.executeScript` with `target: { tabId }`.
- The target object contains no `frameIds` and no `allFrames` selection.
- `cursorGo(tabId, x, y, pulse)` sends root-page viewport coordinates to that injected cursor function.

The visible cursor is therefore not a per-frame component in the current code. This does not itself dispatch the click, but a frame-session input design must decide whether the cursor stays in root viewport coordinates or is injected/routed per frame.

## 4.6 Actual mouse dispatch

Evidence — `extension/sw.js:1645-1655`, `1683-1701`, `2199-2205`:

- `clickAt()` sends `mouseMoved`, `mousePressed`, and `mouseReleased` through `mouse()`.
- `mouse()` calls `cdp(tabId, "Input.dispatchMouseEvent", {type, x, y, ...})`.
- `cdp()` sends that command to `{tabId}` only.
- The ordinary click path contains no `DOM.focus` call and no other explicit focus operation. Any focus change is only a possible side effect of the mouse press itself.

Hover, drag, and wheel use the same `mouse()`/tab-target dispatch. The direct scroll fallback uses `runInWorld()` in the root context (`sw.js:2229-2245`).

## 4.7 Exact click break points

### Break C1 — identity is dropped when the ref is minted

`refFor()` stores only tab + backend node + role + name. Once the composer and a main-frame container are both represented only this way, the click path has no frame-scoped identity to route or verify.

### Break C2 — node execution is rooted

`smoothShowNode()` and other node functions resolve the backend node through `runInWorld()`, whose only execution context is the root frame world created by `worldFor()`.

### Break C3 — classification can see more than dispatch can use

For a same-origin frame, `hitAt()` can identify an inner element by manually walking `contentDocument`. It returns only `frameHost` as provenance. The dispatch layer receives no frame path or session and falls back to the same tab-level input call.

For a cross-origin frame, classification stops at the iframe element itself.

### Break C4 — coordinates are not bound to a frame

Ref-derived points, raw points, point classification, and input dispatch all use one unlabelled `{x, y}` pair. The worker never records whether that pair is root-viewport, frame-viewport, or page coordinates for a particular frame, and it never stores the transform between those spaces.

### Break C5 — dispatch cannot select the child

`mouse()` → `cdp()` → `chrome.debugger.sendCommand({tabId}, ...)` is the only route. There is no child target/session argument to supply.

### Break C6 — focus is never explicitly acquired

A click is expected to create focus as a side effect. If the press is resolved to the parent conversation container — the observed factory result — the inner composer does not become the focused element. The later type path has no recovery mechanism; see §5.

**UNKNOWN:** Which internal Chrome step first redirects or resolves the factory press to the main-frame conversation container cannot be determined from this extension code alone. The code proves that no child session/context/frame identity is available to prevent or correct it; it does not prove whether the decisive failure occurs in backend-node resolution, quad interpretation, `DOM.getNodeForLocation`, or browser input routing for that page.

## 4.8 What a per-frame click model must change

Files/functions:

- `sw.js: refFor`, `nodeRefs`, `refs`, `buildTree`, `nodeForRef` — store and validate the owning frame handle with every ref.
- `sw.js: worldFor`, `runInWorld`, `probe` — resolve and execute in the owning frame's context.
- `sw.js: quadsCenter`, `smoothShowNode`, `pointForNode`, `viewport` — make viewport and quad spaces explicit per frame; store or compute the frame-chain transform to the root viewport.
- `policy.js: pageProbe hitAt/describe` — return a stable frame path/identity, not only `frameHost`.
- `sw.js: axAt`, `analyzePoint`, `axActionable` — run node-for-location and partial-tree checks on the owning frame/session with the correct local point.
- `sw.js: mouse`, `clickAt`, `gatedPress`, `TOOLS.computer` — dispatch through the owning frame session, or deliberately dispatch through the root session using a proven root-viewport transform. The current code does not define or test that choice.
- `sw.js: pill`, `cursor`, `cursorGo` — select the intended frame for injection or keep the overlay explicitly in root coordinates.

---

## 5. Type, key, and form_input flow

## 5.1 `computer` action `type`: text goes to pre-existing focus only

Evidence — `extension/sw.js:2283-2304`:

1. The `type` case reads `focusInfo(tab, host)`.
2. It classifies the already-focused element.
3. After any approval and focus-fingerprint recheck, it calls:

```js
withFocus(tab.id, () => cdp(tab.id, "Input.insertText", { text }))
```

4. It does **not** call `DOM.focus`.
5. It does not use the ref-derived backend node or point computed earlier by `TOOLS.computer` to focus a field. Even when a ref was supplied and resolved before the switch, the `type` case ignores that backend/point for focus.
6. After insertion, if the previously focused field had a known length and a re-read shows the same fingerprint and same length, it audits `not_typed` and throws:

> “the text did not reach the field (it did not change). Click the field first, then type again”

That error text is an explicit statement of the current contract: synthetic typing depends on a prior successful click/focus.

### Why `withFocus()` does not solve this

Evidence — `extension/sw.js:1666-1677`:

- `withFocus(tabId, fn)` toggles `Emulation.setFocusEmulationEnabled` on the tab target around the callback.
- It does not name an element.
- It does not name a frame.
- It does not call `DOM.focus`.

It is focus emulation for the tab target, not target-field focus acquisition.

## 5.2 How focus is inspected

Evidence — `extension/sw.js:1594-1643` and `extension/policy.js:809-842`:

- `focusInfo()` first runs the page probe in `focus` mode through the root world.
- The probe follows `document.activeElement` through open shadow roots.
- For a same-origin iframe, it follows the frame element to the child document's `activeElement`.
- For a cross-origin iframe, it returns `kind: "crossOriginFrame"` and only the frame host.
- The worker can merge facts from `axFocused()`, which uses one tab-target `Accessibility.getFullAXTree` call and `DOM.describeNode`.
- In the ordinary probe path, the returned focus descriptor contains no frame path, target/session ID, execution context ID, or backend node handle for the focused child element.

So focus **inspection** can sometimes describe a same-origin framed field, while focus **routing** still has no frame handle to act on.

## 5.3 Keys

Evidence — `extension/sw.js:1671-1677`, `1714-1753`, `2306-2310`:

- `pressKeysGated()` calls `focusInfo()` before activation, typing, or paste keys.
- `sendKey()` wraps `Input.dispatchKeyEvent` keyDown/keyUp in `withFocus()`.
- Both are sent through `cdp(tabId, ...)`.
- There is no focus-acquisition step and no frame/session selection.

An Enter key after a failed composer click therefore goes wherever the tab target's current focus state points. It is not routed to the composer as an element.

## 5.4 `form_input`: it attempts focus, but through the same frameless plumbing

Evidence — `extension/sw.js:2315-2388`:

1. `nodeForRef()` returns a backend node ID from the frameless ref.
2. `probe(..., "node", ..., backend)` calls `runInWorld()`, which resolves that node using the root execution context.
3. Classification merges accessibility facts via `axActionable()` on the tab target.
4. `smoothShowNode()` scrolls using the same root viewport/quad path as clicks.
5. For a text field it calls `cdp(tab.id, "DOM.focus", {backendNodeId})`.
6. It then calls `runInWorld()` again to select the field's contents — still through the root world.
7. It inserts text with `Input.insertText` through the tab target, or sends Delete through `sendKey()`.
8. Select/checkbox paths mutate the node and dispatch `input`/`change` events inside `runInWorld()` — again through the root world.

`form_input` differs from bare `type`: it does attempt an explicit `DOM.focus`. The break is that the focus call, node resolution, event mutation, and text insertion are not bound together by an owning frame/session/context. The code supplies only tab + backend node to each separate tab-target call.

**UNKNOWN:** Whether a particular `DOM.focus {backendNodeId}` call succeeds for a particular framed node under Chrome's tab target cannot be determined from this code. The code does prove that the surrounding select/mutate steps use the root isolated world and that no child-frame route exists if the node requires one.

## 5.5 `file_upload` has the same identity limit

Evidence — `extension/sw.js:2478-2490`:

- It resolves the same frameless ref to a backend node.
- It probes the node through `runInWorld()`.
- It calls `DOM.setFileInputFiles {files, backendNodeId}` through the tab target.

No frame/session is supplied.

## 5.6 Exact type/key/form break points

### Break T1 — bare `type` has no target-focus operation

The type path inserts into current browser focus. It never focuses the composer, whether the caller supplied coordinates or a ref.

### Break T2 — focus state is external to the bridge's model

The bridge can inspect a focus descriptor, but it does not store the focused element as a frame-scoped handle. A human click changes browser focus outside the bridge's state model; after that, the same tab-level `Input.insertText` can succeed. That is the code-level explanation for the human-click workaround.

### Break T3 — inspection and insertion use different levels of detail

`focusInfo()` can traverse same-origin frames in JS and identify a field. `Input.insertText` receives only text and is sent to the tab target. No owning frame/session/context accompanies the insertion.

### Break T4 — keys inherit failed focus

`sendKey()` dispatches to the tab target. If the preceding synthetic click focused the parent container or nothing useful, Enter and typing keys inherit that wrong focus.

### Break T5 — `form_input` focus is not frame-bound

Its `DOM.focus` call is a real focus attempt, unlike bare `type`, but it is still addressed only by tab + backend node. Its follow-up operations resolve the node in the root world. There is no owning-frame context in which the whole focus → select → insert sequence is executed.

## 5.7 What a per-frame type/key/form model must change

Files/functions:

- `sw.js: TOOLS.computer` `type` case — accept and use a frame-scoped field target; explicitly focus that field before insertion when a target is supplied.
- `sw.js: focusInfo`, `axFocused` — return and store the focused element's frame handle and backend identity, not only a descriptor/fingerprint.
- `sw.js: withFocus`, `sendKey`, `pressKeysGated` — apply focus emulation and key dispatch on the owning frame session.
- `sw.js: TOOLS.form_input` — perform probe, `DOM.focus`, selection, mutation, event dispatch, and insertion through the ref's owning frame session/context as one routed operation.
- `sw.js: TOOLS.file_upload` — call `DOM.setFileInputFiles` on the owning frame session.
- `policy.js: pageProbe` `focus`/`node` modes — return a stable frame path/identity in addition to the human descriptor.

---

## 6. Page reading: why reads can see framed content while input cannot reach it

Page reading is not one mechanism. The tools differ sharply.

## 6.1 `read_page`: one accessibility response, flattened

Evidence — `extension/sw.js:1419-1452`, `1933-1941`:

- `TOOLS.read_page` calls `buildTree()`.
- `buildTree()` calls `Accessibility.getFullAXTree {}` once through the tab target.
- It builds parent/child maps from the returned nodes.
- It renders role/name lines and mints refs for returned nodes with `backendDOMNodeId`.
- It does not assemble separate per-frame trees.

This path does not need to focus a frame, execute code in a frame, or dispatch an event into a frame. It consumes a browser-computed semantic tree returned for the tab target. That is the structural reason a read can expose an element that the later input path cannot route to: **the read result carries a backend node ID, but the ref strips away any frame provenance needed to use that ID in a frame-scoped way.**

**UNKNOWN:** From this code alone it cannot be determined, for a given page, exactly which framed nodes Chrome includes in the single `Accessibility.getFullAXTree` response, or in which target/context namespace every returned backend ID is intended to be used. The code neither checks nor records that information.

## 6.2 `find`: same tree, same limit

Evidence — `extension/sw.js:1943-1951`:

- `TOOLS.find` calls the same `buildTree()` with depth 60 and effectively unbounded output size.
- It ranks the flattened `{ref, role, name}` list with `P.rankForQuery`.

It has no additional frame handling beyond `read_page`.

## 6.3 `get_page_text`: root document only

Evidence — `extension/sw.js:1953-1960` and `extension/policy.js:870-873`:

- `TOOLS.get_page_text` runs probe mode `text` through `runInWorld()`.
- `runInWorld()` executes in the root frame world.
- Probe `text` mode selects `document.querySelector("main, article, [role=main]") || document.body` in that root document and returns its `innerText`, capped at 100,000 characters.
- This mode does **not** call `deepScan()`, does not walk child frame documents, and does not stitch per-frame text.

Therefore the general claim “page reading sees framed content” does **not** apply equally to `get_page_text`. Its code path is root-document text extraction.

**UNKNOWN:** If framed text appeared in a particular incident through `get_page_text`, the mechanism is not established by this code.

## 6.4 `get_form_values`: explicit same-origin frame traversal

Evidence — `extension/sw.js:1962-1975` and `extension/policy.js:673-699`, `844-862`:

- `TOOLS.get_form_values` runs probe mode `fields`.
- Probe `fields` mode returns `deepScan().fields`.
- `deepScan()` starts at the root document, walks open shadow roots, and recursively walks same-origin frame documents to depth 10.
- A visible cross-origin frame is flagged, but its fields cannot be read from the parent document.

This path can therefore list fields inside a same-origin framed composer even though no child execution context exists.

## 6.5 Probe point/focus reading: same-origin traversal, cross-origin opacity

Evidence — `extension/policy.js:758-842`:

- `point`/`refpoint`: `hitAt()` descends same-origin frames manually and returns the inner element description plus `frameHost`.
- `focus`: follows `activeElement` through open shadow roots and same-origin frames.
- Cross-origin frames return only a generic frame descriptor or focus kind.

These are inspection paths. They do not create a reusable frame-scoped handle for input.

## 6.6 Why the asymmetry happens

The asymmetry is built into the kinds of operations used:

| Operation kind | Current route | Needs frame focus/session? |
|---|---|---|
| Accessibility read | One tab-target CDP response, flattened by worker | No focus or event routing in worker code |
| Same-origin DOM inspection | Root JS manually reads `contentDocument` | No child context in worker code |
| Screenshot | Tab-surface capture | No DOM/context/focus routing |
| Click/type/key/form mutation | Backend/context/focus/input operations addressed only by tab | Yes — and no frame route exists |

Reading can therefore succeed by consuming data that the browser or same-origin DOM exposes to the root context. Acting requires the bridge to preserve the owning frame and route a state-changing operation back to it. That preservation and routing layer is absent.

## 6.7 What a per-frame reading model must change

Files/functions:

- `sw.js: buildTree` — either annotate every returned node/ref with its owning frame, or assemble trees from per-frame targets/contexts.
- `sw.js: refFor`, `nodeForRef` — preserve and validate that provenance.
- `sw.js: TOOLS.get_page_text` — run text extraction in each frame context and stitch results with frame identity/order, instead of reading only the root document.
- `policy.js: pageProbe` `fields`, `focus`, `point`, `node` modes — return frame path/identity with each result; cross-origin frames need a version of the probe executed in the child context rather than parent-side `contentDocument` access.
- `sw.js: assertHost`, `probe` — validate the relevant frame's URL/host, not only the root frame's.

---

## 7. Screenshot path: why framed pages work

## 7.1 Direct screenshot

Evidence — `extension/sw.js:2109-2165`:

1. `shoot()` computes the clip from the root page viewport returned by `viewport()`.
2. After the sensitivity gate, it calls `Page.captureScreenshot` through `cdp(tab.id, ...)`.
3. The capture parameters include `clip`, `scale`, and `fromSurface: true` (`sw.js:2140-2142`).
4. The returned image is the tab surface image; the function performs no backend-node lookup, no `DOM.resolveNode`, no execution-context call, no focus operation, and no frame traversal to obtain pixels.

That is the structural reason screenshots include framed UI: capture is a tab-surface operation, not a DOM operation inside the frame. The frame only has to be composited into the tab's visible surface.

The code also refuses background-tab capture after a timeout because Chrome does not draw a background tab (`sw.js:2138-2147`).

## 7.2 Live view

Evidence — `extension/sw.js:2575-2591`:

- `captureLiveView()` uses `chrome.tabs.captureVisibleTab(tab.windowId, {format: "jpeg", quality: 50})` for the active owned tab.
- This is also a window/tab surface capture, not a frame DOM operation.

## 7.3 Sensitivity gate is separate from capture

Evidence — `extension/sw.js:1989-2107`:

- The screenshot gate merges probe `fields`, probe `shotcheck`, and `shotDomFlags()`.
- Probe scanning can traverse same-origin frames and flags visible cross-origin frames.
- `shotDomFlags()` is intended to inspect closed shadow roots through a CDP DOM scan.

Incidental confirmed defect in that gate:

- `shotDomFlags()` calls `cdp(tab.id, "DOM.getDocument", ...)` at `sw.js:2029-2031`.
- `DOM.getDocument` is **not** present in the `CDP_METHODS` allow-list at `sw.js:1199-1220`.
- `cdp()` therefore throws `cdp_method_not_allowed`; `shotDomFlags()` catches it and returns `{}`.
- The closed-shadow-root sensitivity branch is consequently inoperative.

This defect does not explain the framed-input failure and does not prevent `Page.captureScreenshot` itself from working. It affects only one sensitivity-detection source.

## 7.4 What a per-frame model must change for screenshots

The capture call can remain tab-level if the product wants a picture of the whole composited tab.

The sensitivity gate cannot remain solely root-probe based in a complete per-frame model:

- `sw.js: shotProbeSens`, `shotDomFlags` — scan each frame/target/context, including cross-origin child frames, rather than treating their contents as parent-inaccessible.
- `sw.js: CDP_METHODS` — either allow the DOM method the gate actually calls or remove/replace the dead scan.
- `policy.js: deepScan` — retain same-origin traversal, but do not treat it as coverage for cross-origin child documents.

---

## 8. Incident chain, mapped to the code

1. **Screenshot succeeds.**  
   `shoot()` captures the composited tab surface with `Page.captureScreenshot ... fromSurface: true`. No frame routing is needed.

2. **A framed control can be read or described.**  
   `buildTree()` consumes a tab-target accessibility response and mints a backend-node ref. For same-origin frames, probe inspection can also walk `contentDocument` manually.

3. **The ref loses the frame.**  
   `refFor()` stores only tab, backend node, role, and name.

4. **Click preparation stays rooted.**  
   Scroll, quad lookup, node resolution, and point classification use the tab target and root isolated world. Classification may return a `frameHost` string, but no frame handle reaches dispatch.

5. **The press is dispatched only at tab level.**  
   `mouse()` sends `Input.dispatchMouseEvent` through `cdp(tabId, ...)`. The observed factory result is that this resolves to the main frame's conversation container rather than the framed composer.

6. **The composer never receives bridge-created focus.**  
   The click path has no explicit focus operation. Bare `type` also has no focus operation.

7. **Typing depends on whatever focus already exists.**  
   `Input.insertText` is sent at tab level. If the composer is not the focused element, the text has no bridge-selected destination. The type path's own post-check can report `not_typed` and instruct the user to click the field first.

8. **A human click supplies the missing state.**  
   Once a person clicks the composer, browser focus is already on the correct field before the bridge sends text. The bridge did not create or record that focus; it merely benefits from it.

The missing layer is therefore not “better coordinates” alone. It is the combination of:

- frame identity;
- frame session/context routing;
- an explicit coordinate-space contract;
- frame-scoped focus acquisition and verification.

---

## 9. Consolidated change surface for a per-frame model

This section names what would have to change. It does not prescribe Claude in Chrome's implementation, which was not part of this current-state audit.

### 9.1 New state: a frame handle

`extension/sw.js` would need a durable per-action handle containing at least:

- `tabId`;
- target identity;
- CDP session identity, if a separate session is used;
- `frameId`;
- `loaderId`;
- parent frame / frame path;
- frame URL/origin;
- execution context ID for the bridge world in that frame;
- coordinate transform between frame viewport and root viewport.

None of these fields exists as a combined record today.

### 9.2 Debugger/session layer

Change:

- `attach()` (`sw.js:1170`);
- `detach()` (`sw.js:1181`);
- `CDP_METHODS` (`sw.js:1199-1220`);
- `cdp()` (`sw.js:1222-1234`);
- `sweepIdle()` (`sw.js:2716-2725`);
- `cleanupAfterRestart()` (`sw.js:2727-2741`).

Required additions:

- child target discovery and attachment;
- session-aware command dispatch;
- target/session detach and navigation lifecycle;
- per-session idle and cleanup handling.

### 9.3 Execution/probe layer

Change:

- `worldFor()` (`sw.js:1239-1246`);
- `runInWorld()` (`sw.js:1250-1268`);
- `probe()` (`sw.js:1270-1276`);
- `assertHost()` (`sw.js:1278-1281`);
- `policy.js: pageProbe()` (`policy.js:467-875`).

Required additions:

- one bridge world per relevant frame, not one per tab;
- node resolution in the owning frame's context;
- probe execution inside cross-origin child contexts, because parent JS cannot read their documents;
- frame identity returned with probe results.

### 9.4 Ref and reading layer

Change:

- `refFor()`, `refs`, `nodeRefs` (`sw.js:1380-1412`);
- `buildTree()` (`sw.js:1419-1452`);
- `nodeForRef()` (`sw.js:1455-1467`);
- `axActionable()` (`sw.js:1554-1565`);
- `axFocused()` (`sw.js:1631-1643`);
- `TOOLS.read_page`, `TOOLS.find`, `TOOLS.get_page_text`, `TOOLS.get_form_values` (`sw.js:1933-1975`).

Required additions:

- frame identity stored on every ref;
- ref validation on the owning session;
- frame-aware tree assembly or node annotation;
- per-frame text extraction.

### 9.5 Geometry layer

Change:

- `quadsCenter()` (`sw.js:1483-1490`);
- `smoothShowNode()` (`sw.js:1494-1524`);
- `smoothShowPoint()` (`sw.js:1526-1535`);
- `pointForNode()` (`sw.js:1537-1543`);
- `viewport()` (`sw.js:1545-1549`);
- `axAt()` (`sw.js:1567-1573`);
- `analyzePoint()` (`sw.js:1575-1586`);
- `policy.js: hitAt()` (`policy.js:773-787`).

Required additions:

- explicit root-viewport versus frame-viewport coordinate types;
- nested frame offset, border, scroll, and scale transforms;
- scrolling the correct frame chain;
- hit testing on the owning frame/session.

### 9.6 Input/focus layer

Change:

- `mouse()` and `clickAt()` (`sw.js:1645-1655`);
- `withFocus()` (`sw.js:1666-1669`);
- `sendKey()` (`sw.js:1671-1677`);
- `gatedPress()` (`sw.js:1683-1701`);
- `pressKeysGated()` (`sw.js:1714-1753`);
- `TOOLS.computer` click/type/key/scroll/drag cases (`sw.js:2160-2313`);
- `TOOLS.form_input` (`sw.js:2315-2388`);
- `TOOLS.file_upload` (`sw.js:2478-2490`).

Required additions:

- dispatch mouse/key/text on the owning frame session, or a proven root-session alternative with an explicit transform;
- explicit frame-scoped focus before bare `type` when a field target is given;
- focus verification in the same frame that will receive the text;
- form focus/select/mutate/insert executed as one frame-routed sequence.

### 9.7 Presentation layer

Change:

- `pill()` (`sw.js:665-678`);
- `cursor()`, `cursorGo()` (`sw.js:688-713`);
- `extension/pill.js`;
- `extension/cursor.js`.

Current injection targets only `{tabId}` with no frame selector. A per-frame design must either:

- keep pill/cursor in the root document and pass root-viewport coordinates; or
- inject into the owning frame and pass frame-local coordinates.

The current code does not record which coordinate contract the cursor is using beyond the root viewport values supplied by callers.

### 9.8 Screenshot sensitivity layer

Change:

- `shotDomFlags()` (`sw.js:2029-2107`);
- `shotProbeSens()` (`sw.js:2089-2098`);
- `CDP_METHODS` (`sw.js:1199-1220`).

Required additions:

- make the intended closed-root scan callable or replace it;
- scan child frame sessions/contexts for sensitive fields;
- keep the actual composited capture at tab level unless region semantics change.

---

## 10. UNKNOWN register

The following cannot be pinned down from the audited code and are not guessed in this report:

1. **Factory frame type/origin — UNKNOWN.**  
   The assignment describes an embedded frame but does not establish whether it is same-origin or cross-origin, same-process or out-of-process, or which target Chrome assigns to it.

2. **Accessibility inclusion rule — UNKNOWN.**  
   The code does not establish which child-frame nodes a given `Accessibility.getFullAXTree {}` response on `{tabId}` will contain, or the intended session namespace for every returned backend node ID.

3. **Framed-node quad coordinate space — UNKNOWN.**  
   `DOM.getContentQuads` results for child-frame backend nodes are consumed without a documented or stored coordinate-space conversion in worker code.

4. **Root-context resolution result for each framed node — UNKNOWN.**  
   The code proves `DOM.resolveNode` is asked to use the root execution context. It does not prove, for every framed node type/origin, whether Chrome returns an object, returns a different object, or errors.

5. **Internal browser input-routing step — UNKNOWN.**  
   The incident establishes the observed end result on factory.8090.ai. The extension code alone does not establish the exact internal Chrome step at which the press becomes a press on the main-frame conversation container.

6. **Human-focus recovery mechanism inside Chrome — UNKNOWN in detail.**  
   The code proves the bridge does not set the composer's focus in the bare `type` path and that typing depends on current focus. The incident proves a human click makes later typing work. The precise browser routing change after that human click is not visible in this code.

7. **Claude in Chrome's implementation — UNKNOWN in this audit.**  
   This report maps only the Muse Chrome Bridge's current state. It makes no claim about which target, session, context, or coordinate mechanism Claude in Chrome uses internally.
