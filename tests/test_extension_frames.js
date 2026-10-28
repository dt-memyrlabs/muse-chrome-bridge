/* The frame-copy mechanics (v2.5.0), after Claude in Chrome's model:
 * input is dispatched on the TAB session — one debugger session per
 * tab, focus emulation on for the session and ended at detach — and
 * an element's point is measured in the page (bounding-rect centre in
 * top-level viewport coordinates, same-origin frame offsets added),
 * never from CDP quads for a framed node. A press at that point is
 * hit-tested by the browser into the frame under it and focuses the
 * frame's field, so type after a bridge click lands with no human
 * pre-click. Also covered: form_input's framed fallback (click to
 * focus + insertText when the field is not resolvable in the root
 * world) and the restored DOM.getDocument closed-shadow screenshot
 * scan.
 *
 *   node test_extension_frames.js     exit 0 = all passed
 */
"use strict";
const { install } = require("./fake_chrome");

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("PASS " + name); }
  else { failures++; console.log("FAIL " + name + (detail !== undefined ? "  -- " + JSON.stringify(detail).slice(0, 500) : "")); }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const F = install({ fakeSocket: true });
const { tabs, sent, inputs, cdpLog, page, mkTab, FakeWS, panel } = F;

let cmdSeq = 0;
function cmdStart(sessionId, action, args) {
  const id = "c" + (++cmdSeq);
  FakeWS.last.deliver({ t: "cmd", id, sessionId, action, args: args || {}, ttlMs: 120000 });
  return id;
}
async function result(id, ms = 6000) {
  for (let i = 0; i < ms / 5; i++) {
    const r = sent.find((m) => m.t === "result" && m.id === id);
    if (r) return r;
    await tick(5);
  }
  return { ok: false, error: "TEST_TIMEOUT" };
}
const cmd = (sid, action, args) => result(cmdStart(sid, action, args));
async function pendingPrompts() { return (await panel("state")).prompts; }
async function waitPrompt(n = 1) {
  for (let i = 0; i < 200; i++) { const p = await pendingPrompts(); if (p.length >= n) return p; await tick(5); }
  return [];
}
// v2.7: a share lands only on the ONE full-control confirmation.
async function approveShare() {
  for (let i = 0; i < 200; i++) {
    const sp = (await pendingPrompts()).find((p) => /full control/i.test(p.title));
    if (sp) { await panel("approve", { id: sp.id }); return sp; }
    await tick(5);
  }
  return null;
}
async function pair(tabId, sid, name) {
  await panel("share", { tabId });
  const req = sent.filter((m) => m.t === "pair_request").pop();
  FakeWS.last.deliver({ t: "pair_code", reqId: req.reqId, code: "ABCD2345", expiresIn: 300 });
  await tick(10);
  FakeWS.last.deliver({ t: "paired", reqId: req.reqId, sessionId: sid, chatName: name });
  await approveShare();
  await tick(30);
}
const mouseEvts = (tabId) => inputs.filter((i) => i.tabId === tabId && i.method === "Input.dispatchMouseEvent");
const emuEvts = (tabId) => cdpLog.filter((c) => c.tabId === tabId && c.method === "Emulation.setFocusEmulationEnabled");
const inserted = (tabId) => inputs.filter((i) => i.tabId === tabId && i.method === "Input.insertText");

/* A framed page, as the page-side sees it: an iframe at (50, 60) with
 * a 2/3px border holds a document whose elements report rects in the
 * FRAME's viewport coordinates. Top-level point = element centre +
 * frame rect origin + border, per level. */
const topDoc = { defaultView: { frameElement: null } };
const frameEl = {
  getBoundingClientRect: () => ({ left: 50, top: 60, width: 400, height: 300 }),
  clientLeft: 2, clientTop: 3, ownerDocument: topDoc,
};
const childDoc = { defaultView: { frameElement: frameEl } };
// button: centre (350, 220) in the frame -> (402, 283) top-level
// field:  centre (200, 112) in the frame -> (252, 175) top-level

(async () => {
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = sent.find((m) => m.t === "hello"); }
  check("worker connects (hello sent)", !!hello);
  FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);

  const T = mkTab("https://chat.example.com/app", { active: true }).id;
  await pair(T, "sess-A", "Chat A");

  page.ax[T] = [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "" }, childIds: ["2", "3"], backendDOMNodeId: 1 },
    { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Preview" }, backendDOMNodeId: 77 },
    { nodeId: "3", parentId: "1", role: { value: "textbox" }, name: { value: "Message" }, backendDOMNodeId: 88 },
  ];
  page.elements[77] = { tagName: "BUTTON",
    getBoundingClientRect: () => ({ left: 300, top: 200, width: 100, height: 40 }), ownerDocument: childDoc };
  page.elements[88] = { tagName: "INPUT",
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 200, height: 24 }), ownerDocument: childDoc };
  // Quads deliberately disagree with the page's own geometry: for a
  // framed node the press must follow the in-page measurement.
  page.quads = () => [[0, 0, 10, 0, 10, 10, 0, 10]];
  page.point = () => ({ tag: "button", text: "Preview", fp: "button|preview" });

  let r = await cmd("sess-A", "read_page", { tabId: T });
  const btnRef = r.ok && (r.data.tree.match(/button "Preview" \[(ref_\d+)\]/) || [])[1];
  const fldRef = r.ok && (r.data.tree.match(/textbox "Message" \[(ref_\d+)\]/) || [])[1];
  check("setup: read_page gives the framed button and field refs", !!btnRef && !!fldRef, r.data && r.data.tree);

  /* ---- 1. click: Claude's sequence, framed point, focus emulation -- */
  const emu0 = emuEvts(T).length, mouse0 = mouseEvts(T).length;
  const t1 = Date.now();
  r = await cmd("sess-A", "computer", { action: "left_click", ref: btnRef });
  const ev = mouseEvts(T).slice(mouse0);
  check("a click on a framed ref succeeds", r.ok, r);
  check("click sequence is moved -> pressed -> released on the tab session",
        ev.map((e) => e.params.type).join() === "mouseMoved,mousePressed,mouseReleased", ev);
  check("the press lands at the in-page measured top-level point (402, 283), not the quad point",
        ev.length === 3 && ev[1].params.x === 402 && ev[1].params.y === 283, ev[1] && ev[1].params);
  check("pressed carries the buttons bitmask, clickCount and force; released clears buttons",
        ev.length === 3 && ev[1].params.buttons === 1 && ev[1].params.clickCount === 1 && ev[1].params.force === 0.5 &&
        ev[2].params.buttons === 0, ev.map((e) => e.params));
  const emu = emuEvts(T).slice(emu0);
  const firstMouseIdx = cdpLog.findIndex((c) => c.tabId === T && c.method === "Input.dispatchMouseEvent");
  const firstEmuIdx = cdpLog.findIndex((c) => c.tabId === T && c.method === "Emulation.setFocusEmulationEnabled");
  check("focus emulation is enabled once, before the first input command",
        emu.length === 1 && emu[0].params.enabled === true && firstEmuIdx !== -1 && firstEmuIdx < firstMouseIdx,
        { emu, firstEmuIdx, firstMouseIdx });
  check("the click takes Claude's beat (settle + press pause), not an instant dispatch",
        Date.now() - t1 >= 55, Date.now() - t1);

  /* ---- 2. repeated clicks: cadence, no emulation toggling ---------- */
  const t2 = Date.now();
  r = await cmd("sess-A", "computer", { action: "triple_click", ref: btnRef });
  const ev3 = mouseEvts(T).slice(mouse0 + 3);
  check("a triple click is moved, then press/release x3 with rising clickCount",
        r.ok && ev3.map((e) => e.params.type).join() ===
          "mouseMoved,mousePressed,mouseReleased,mousePressed,mouseReleased,mousePressed,mouseReleased" &&
        ev3[3].params.clickCount === 2 && ev3[5].params.clickCount === 3, ev3.map((e) => [e.params.type, e.params.clickCount]));
  check("...with 100 ms between clicks", Date.now() - t2 >= 240, Date.now() - t2);
  check("focus emulation stays on across clicks (enabled once per session, never toggled off)",
        emuEvts(T).filter((c) => c.params.enabled === true).length === 1 &&
        emuEvts(T).filter((c) => c.params.enabled === false).length === 0, emuEvts(T));

  /* ---- 3. detach ends focus emulation first ------------------------- */
  await F.sw(`detach(${T})`);
  check("detach disables focus emulation (Claude's order: emulation off, then detach)",
        emuEvts(T).filter((c) => c.params.enabled === false).length === 1, emuEvts(T));
  r = await cmd("sess-A", "computer", { action: "left_click", ref: btnRef });
  check("the next input after detach re-enables focus emulation",
        r.ok && emuEvts(T).filter((c) => c.params.enabled === true).length === 2, emuEvts(T));

  /* ---- 4. type after a bridge click lands in the framed field ------- */
  // v2.8: with the framed field visible to the probe as the focus, type
  // goes by real key events per character (Claude's type()); the field
  // grows by the delivered key text exactly as it grew by insertText.
  const delivered = (tabId) => inputs.filter((i) => i.tabId === tabId &&
    (i.method === "Input.insertText" || (i.method === "Input.dispatchKeyEvent" && i.params.type !== "keyUp")))
    .map((i) => i.params.text || "").join("");
  page.point = () => ({ tag: "input", type: "text", isField: true, fp: "input|msg" });
  page.focus = () => ({ kind: "element", tag: "input", isField: true, fp: "input|msg",
                        len: delivered(T).length });
  r = await cmd("sess-A", "computer", { action: "left_click", ref: fldRef });
  check("clicking the framed field succeeds", r.ok, r);
  const del0 = delivered(T).length, ins0 = inserted(T).length;
  r = await cmd("sess-A", "computer", { action: "type", text: "hello", tabId: T });
  check("type after the bridge's click lands in the framed field (no human pre-click, no not_typed)",
        r.ok && delivered(T).slice(del0) === "hello" && inserted(T).length === ins0, r);

  /* ---- 5. probe-blind focus after a bridge click; honest error else - */
  page.focus = () => ({ kind: "none", fp: "none" });
  r = await cmd("sess-A", "computer", { action: "left_click", ref: fldRef });
  const ins1 = inserted(T).length;
  r = await cmd("sess-A", "computer", { action: "type", text: "again", tabId: T });
  check("when the probe cannot see the framed focus, type still follows the bridge's own click",
        r.ok && inserted(T).length === ins1 + 1 && inserted(T)[ins1].params.text === "again", r);
  const T2 = mkTab("https://other.example.com/", { active: true }).id;
  await pair(T2, "sess-B", "Chat B");
  r = await cmd("sess-B", "computer", { action: "type", text: "x", tabId: T2 });
  check("with nothing focused and no bridge click, type refuses honestly (not_focused) and sends nothing",
        !r.ok && r.error === "not_focused" && inserted(T2).length === 0, r);

  /* ---- 6. form_input into a framed field: click-to-focus fallback --- */
  page.node = () => ({ tag: "input", type: "text", isField: true, fp: "input|msg" });
  // The framed field has no select() and the root world cannot run the
  // selection step on it (document is not reachable for it there), so
  // the root-world path fails and the fallback must take over.
  const mouseBefore = mouseEvts(T).length, insBefore = inserted(T).length;
  r = await cmd("sess-A", "form_input", { ref: fldRef, value: "draft text" });
  const fev = mouseEvts(T).slice(mouseBefore);
  check("form_input on a field the root world cannot resolve still sets the value",
        r.ok, r);
  check("...DOM.focus was attempted first (the root-world path)",
        cdpLog.some((c) => c.tabId === T && c.method === "DOM.focus" && c.params.backendNodeId === 88), null);
  check("...then a real press at the measured framed point (252, 175) focuses it",
        fev.some((e) => e.params.type === "mousePressed" && e.params.x === 252 && e.params.y === 175), fev);
  check("...and the text follows focus via insertText",
        inserted(T).length === insBefore + 1 && inserted(T)[insBefore].params.text === "draft text",
        inserted(T).slice(insBefore));

  /* ---- 7. the closed-shadow screenshot scan runs again -------------- */
  page.fields = () => [];
  page.domTree = () => ({ nodeName: "#document", children: [
    { nodeName: "DIV", children: [], shadowRoots: [
      { nodeName: "#shadow-root", children: [
        { nodeName: "INPUT", attributes: ["type", "password"] } ] } ] } ] });
  r = await cmd("sess-A", "screenshot", { tabId: T });
  check("a password field inside a closed shadow root no longer makes the screenshot ask (v2.7: recorded, not asked)",
        r.ok && /^data:image\//.test((r.data && r.data.image) || "") && (await pendingPrompts()).length === 0, r);
  check("...and DOM.getDocument actually went through the CDP dispatcher",
        cdpLog.some((c) => c.tabId === T && c.method === "DOM.getDocument"), null);
  const shotEv = (await panel("state")).audit.filter((a) => /Screenshot a page with a password field/.test(a.action));
  check("...and the sensitive capture is written to the event record instead",
        shotEv.length === 1 && shotEv[0].outcome === "no prompt: full control", shotEv);
  page.domTree = null;

  console.log(`\n${passes}/${passes + failures} passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
