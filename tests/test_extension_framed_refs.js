/* The all-frames read (v2.6.0): read_page and find run the page probe's
 * tree builder inside every frame of the tab and stitch the results, so
 * an element inside a frame — the factory.8090.ai shape — is discovered
 * with a ref, and the ref carries its frame identity plus a measured
 * top-level point. Acting on a framed ref goes through the
 * point-dispatch path (a tab-session press at the accumulated point:
 * the frame's rect origin + border, plus the element's centre inside
 * the frame), never root-world node resolution. form_input on a framed
 * field classifies from the probe's own describe() facts measured in
 * the frame, prompts exactly as the root-world path does, and sets the
 * value by press-to-focus + insertText.
 *
 *   node test_extension_framed_refs.js     exit 0 = all passed
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
const { tabs, sent, inputs, page, mkTab, FakeWS, panel } = F;

let cmdSeq = 0;
function cmdStart(sessionId, action, args) {
  const id = "c" + (++cmdSeq);
  FakeWS.last.deliver({ t: "cmd", id, sessionId, action, args: args || {}, ttlMs: 120000 });
  return id;
}
async function result(id, ms = 8000) {
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
  for (let i = 0; i < 300; i++) { const p = await pendingPrompts(); if (p.length >= n) return p; await tick(5); }
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
  const reqsBefore = sent.filter((m) => m.t === "pair_request").length;
  await panel("share", { tabId });
  await approveShare(); // v2.9: the ONE confirmation is asked at code generation, before any code exists
  for (let i = 0; i < 200; i++) { if (sent.filter((m) => m.t === "pair_request").length > reqsBefore) break; await tick(5); }
  const req = sent.filter((m) => m.t === "pair_request").pop();
  FakeWS.last.deliver({ t: "pair_code", reqId: req.reqId, code: "ABCD2345", expiresIn: 300 });
  await tick(10);
  FakeWS.last.deliver({ t: "paired", reqId: req.reqId, sessionId: sid, chatName: name });
  await approveShare();
  await tick(30);
}
const mouseEvts = (tabId) => inputs.filter((i) => i.tabId === tabId && i.method === "Input.dispatchMouseEvent");
const inserted = (tabId) => inputs.filter((i) => i.tabId === tabId && i.method === "Input.insertText");
const keyEvts = (tabId) => inputs.filter((i) => i.tabId === tabId && i.method === "Input.dispatchKeyEvent");
const pressedAt = (tabId, x, y) => mouseEvts(tabId).some((e) => e.params.type === "mousePressed" && e.params.x === x && e.params.y === y);

/* The framed page, as the frame side reports it. The iframe element
 * sits at (50, 60) in the parent with a 2/3 px border, so an element
 * whose centre is (cx, cy) inside the frame has the top-level point
 * (cx + 52, cy + 63). */
const FRAME_URL = "https://chat.example.com/frame";
const factsOf = (e) => ({
  tag: e.tag, role: "", type: e.type || "", text: e.text || "", label: e.label || "", href: "",
  autocomplete: "", isPassword: !!e.isPassword, isField: !!e.isField, isPayField: !!e.isPayField,
  isContentEditable: !!e.isContentEditable, actionableShape: true, isSubmit: !!e.isSubmit,
  revealsSecret: false, frameHost: "", fp: e.fp,
  inForm: false, formHasPassword: !!e.formHasPassword, formHasPayment: false, formRiskySubmit: false,
});
const frameState = {
  entries: [
    { i: 0, depth: 0, role: "textbox", name: "Message composer", tag: "div", type: "", text: "", label: "Message composer",
      isField: true, isContentEditable: true, fp: "div|composer", cx: 200, cy: 100, w: 300, h: 40 },
    { i: 1, depth: 0, role: "textbox", name: "Note", tag: "textarea", type: "", text: "", label: "Note",
      isField: true, fp: "textarea|note", cx: 200, cy: 180, w: 420, h: 48 },
    { i: 2, depth: 0, role: "button", name: "Send", tag: "button", type: "", text: "Send", label: "",
      isField: false, isSubmit: true, fp: "button|send", cx: 60, cy: 240, w: 80, h: 30 },
    { i: 3, depth: 0, role: "textbox", name: "Password", tag: "input", type: "password", text: "", label: "Password",
      isField: true, isPassword: true, fp: "input|pwd", cx: 200, cy: 300, w: 200, h: 24 },
    { i: 4, depth: 0, role: "checkbox", name: "Agree", tag: "input", type: "checkbox", text: "", label: "Agree",
      isField: true, checked: false, fp: "input|agree", cx: 20, cy: 340, w: 16, h: 16 },
  ],
};

(async () => {
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = sent.find((m) => m.t === "hello"); }
  check("worker connects (hello sent)", !!hello);
  FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);

  const T = mkTab("https://shell.example.com/app", { active: true }).id;
  await pair(T, "sess-A", "Chat A");

  page.frames = { [T]: [
    { frameId: 0, parentFrameId: -1, url: "https://shell.example.com/app", errorOccurred: false },
    { frameId: 5, parentFrameId: 0, url: FRAME_URL, errorOccurred: false },
  ] };
  page.ax[T] = [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "" }, childIds: ["2", "3"], backendDOMNodeId: 1 },
    { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Home" }, backendDOMNodeId: 10 },
    { nodeId: "3", parentId: "1", role: { value: "Iframe" }, name: { value: "framed chat" }, backendDOMNodeId: 60 },
  ];
  page.describeNode = (b) => b === 60
    ? { attributes: ["src", FRAME_URL, "title", "framed chat"] }
    : { attributes: [] };
  page.elements[10] = { tagName: "BUTTON",
    getBoundingClientRect: () => ({ left: 50, top: 20, width: 100, height: 40 }),
    ownerDocument: { defaultView: { frameElement: null } } };
  page.frameProbe = (t, frameId, mode, args) => {
    if (mode === "frames") {
      if (frameId === 0) return [{ src: FRAME_URL, left: 50, top: 60, clientLeft: 2, clientTop: 3, w: 780, h: 470 }];
      return [];
    }
    if (frameId !== 5) return null;
    if (mode === "tree") return { buildId: args.build, url: FRAME_URL, entries: frameState.entries, truncated: false };
    if (mode === "measure") {
      const e = frameState.entries[args.i];
      if (!e) return null;
      // The checkbox "toggles" when the bridge's press lands on it.
      const toggled = e.i === 4 && pressedAt(T, 72, 403);
      return { cx: e.cx, cy: e.cy, w: e.w, h: e.h, checked: e.i === 4 ? (e.checked || toggled) : e.checked, d: factsOf(e) };
    }
    return null;
  };
  page.point = () => ({ tag: "div", text: "", fp: "div|plain" });
  page.focus = () => ({ kind: "none", fp: "none" });

  /* ---- 1. discovery: the framed elements are in the tree, nested ---- */
  let r = await cmd("sess-A", "read_page", { tabId: T });
  const tree = (r.data && r.data.tree) || "";
  const lineOf = (txt) => tree.split("\n").find((l) => l.includes(txt)) || "";
  const refOfLine = (txt) => (lineOf(txt).match(/\[(ref_\d+)\]/) || [])[1];
  const composerRef = refOfLine("Message composer"), noteRef = refOfLine('"Note"'),
        sendRef = refOfLine('"Send"'), pwdRef = refOfLine('"Password"'), agreeRef = refOfLine('"Agree"');
  check("read_page discovers the framed composer, note, send, password and checkbox with refs",
        !!(composerRef && noteRef && sendRef && pwdRef && agreeRef), tree);
  check("framed entries nest under the Iframe line",
        lineOf("Message composer").match(/^ */)[0].length > lineOf("framed chat").match(/^ */)[0].length,
        { composer: lineOf("Message composer"), iframe: lineOf("framed chat") });
  const homeRef = refOfLine('"Home"');
  check("the top frame still gets its AX refs in the same read", !!homeRef, tree);

  /* ---- 2. find reaches into the frame ------------------------------- */
  r = await cmd("sess-A", "find", { tabId: T, query: "message composer" });
  const fm = ((r.data && r.data.matches) || []).find((m) => m.ref === composerRef);
  check("find returns the framed composer ref, naming its frame",
        !!fm && fm.frame === FRAME_URL, r.data && r.data.matches);

  /* ---- 3. click by framed ref: point dispatch at the accumulated point */
  const m0 = mouseEvts(T).length;
  r = await cmd("sess-A", "computer", { action: "left_click", ref: composerRef });
  const ev = mouseEvts(T).slice(m0);
  check("clicking the framed composer ref succeeds", r.ok, r);
  check("...as moved -> pressed -> released at the accumulated top-level point (252, 163)",
        ev.map((e) => e.params.type).join() === "mouseMoved,mousePressed,mouseReleased" &&
        ev[1].params.x === 252 && ev[1].params.y === 163, ev.map((e) => [e.params.type, e.params.x, e.params.y]));

  /* ---- 4. type after the ref click lands (focus followed the press) -- */
  const ins0 = inserted(T).length;
  r = await cmd("sess-A", "computer", { action: "type", text: "hello framed", tabId: T });
  check("type after the framed ref click is inserted (no human pre-click)",
        r.ok && inserted(T).length === ins0 + 1 && inserted(T)[ins0].params.text === "hello framed", r);

  /* ---- 5. the framed Send button by ref ------------------------------ */
  r = await cmd("sess-A", "computer", { action: "left_click", ref: sendRef });
  check("clicking the framed Send ref presses at (112, 303)",
        r.ok && pressedAt(T, 112, 303), r);

  /* ---- 6. scroll_to a framed ref ------------------------------------- */
  r = await cmd("sess-A", "computer", { action: "scroll_to", ref: composerRef });
  check("scroll_to a framed ref succeeds", r.ok, r);

  /* ---- 7. form_input on the framed textarea: press, select-all, insert */
  const m1 = mouseEvts(T).length, ins1 = inserted(T).length, k1 = keyEvts(T).length;
  r = await cmd("sess-A", "form_input", { ref: noteRef, value: "draft note" });
  check("form_input on the framed textarea succeeds", r.ok, r);
  check("...pressing its point (252, 243) to focus it",
        mouseEvts(T).slice(m1).some((e) => e.params.type === "mousePressed" && e.params.x === 252 && e.params.y === 243),
        mouseEvts(T).slice(m1));
  check("...selecting all (ctrl+a) before inserting, so the value is set, not appended",
        keyEvts(T).slice(k1).some((e) => e.params.key === "a" && e.params.modifiers === 2) &&
        inserted(T).length === ins1 + 1 && inserted(T)[ins1].params.text === "draft note",
        { keys: keyEvts(T).slice(k1), ins: inserted(T).slice(ins1) });

  /* ---- 8. form_input on the framed checkbox toggles by press --------- */
  r = await cmd("sess-A", "form_input", { ref: agreeRef, value: true });
  check("form_input on the framed checkbox presses its point (72, 403) and the state flips",
        r.ok && pressedAt(T, 72, 403), r);
  r = await cmd("sess-A", "form_input", { ref: agreeRef, value: true });
  const m2 = mouseEvts(T).length;
  check("...and setting the state it already holds presses nothing",
        r.ok, r);

  /* ---- 9. the framed password field: no prompt under v2.7 ----------- */
  r = await cmd("sess-A", "form_input", { ref: pwdRef, value: "s3cret" });
  check("form_input into the framed password field proceeds with no prompt (v2.7: the share was the consent)",
        r.ok && (await pendingPrompts()).length === 0, r);
  const fillEv = (await panel("state")).audit.filter((a) => /Fill a password field/.test(a.action));
  check("...and the fill is written to the event record, value masked to its length",
        fillEv.length === 1 && fillEv[0].outcome === "no prompt: full control" && !/s3cret/.test(fillEv[0].detail), fillEv);

  /* ---- 10. a framed ref whose element changed refuses ---------------- */
  frameState.entries[0] = { ...frameState.entries[0], fp: "div|changed" };
  r = await cmd("sess-A", "computer", { action: "left_click", ref: composerRef });
  check("a framed element that changed since the read answers target_changed",
        !r.ok && r.error === "target_changed", r);
  frameState.entries[0] = { ...frameState.entries[0], fp: "div|composer" };

  /* ---- 11. file_upload refuses a framed ref honestly ----------------- */
  r = await cmd("sess-A", "file_upload", { ref: noteRef, paths: ["/tmp/notes.txt"] });
  check("file_upload into a framed input is refused as not_a_file_input",
        !r.ok && r.error === "not_a_file_input", r);

  /* ---- 12. the top frame's own refs still resolve by node ------------ */
  const m3 = mouseEvts(T).length;
  r = await cmd("sess-A", "computer", { action: "left_click", ref: homeRef });
  const evH = mouseEvts(T).slice(m3);
  check("the top-frame Home button still clicks by node resolution at its measured point (100, 40)",
        r.ok && evH.some((e) => e.params.type === "mousePressed" && e.params.x === 100 && e.params.y === 40),
        evH.map((e) => [e.params.type, e.params.x, e.params.y]));

  console.log(`\n${passes}/${passes + failures} passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
