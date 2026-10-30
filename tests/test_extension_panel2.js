/* v2.8 stage G: panel helpers, worker side (FULL-GAP §12).
 *  - workflow recording: start on a tab, steps accepted ONLY from
 *    that tab, stop saves the step list as a saved prompt;
 *  - element picking: a pick is accepted only from the tab being
 *    picked and lands in panel state;
 *  - the javascript_tool switch and the debug export ride the panel
 *    protocol.
 *
 *   node test_extension_panel2.js     exit 0 = all passed
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
const { tabs, sent, mkTab, FakeWS, panel, captures } = F;

async function pendingPrompts() { return (await panel("state")).prompts; }
async function approveShare() {
  for (let i = 0; i < 200; i++) {
    const sp = (await pendingPrompts()).find((p) => /full control/i.test(p.title));
    if (sp) { await panel("approve", { id: sp.id }); return sp; }
    await tick(5);
  }
  return null;
}
async function pair(url, name) {
  const t = mkTab(url, { active: true });
  for (const x of tabs.values()) if (x.id !== t.id) x.active = false;
  const reqsBefore = sent.filter((m) => m.t === "pair_request").length;
  await panel("share", { tabId: t.id });
  await approveShare(); // v2.9: the ONE confirmation is asked at code generation, before any code exists
  for (let i = 0; i < 200; i++) { if (sent.filter((m) => m.t === "pair_request").length > reqsBefore) break; await tick(5); }
  const req = sent.filter((m) => m.t === "pair_request").pop();
  FakeWS.last.deliver({ t: "pair_code", reqId: req.reqId, code: "ABCD2345", expiresIn: 300 });
  await tick(10);
  const sid = "sess-" + name;
  FakeWS.last.deliver({ t: "paired", reqId: req.reqId, sessionId: sid, chatName: name });
  await approveShare();
  await tick(30);
  return { tab: tabs.get(t.id), sid };
}
const tabMsg = (kind, extra, tab) => panel(kind, extra, { id: "extid", frameId: 0, tab: { id: tab.id, url: tab.url, windowId: tab.windowId, active: !!tab.active } });
const state = () => panel("state");

(async () => {
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = sent.find((m) => m.t === "hello"); }
  FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);

  const A = await pair("https://shop.example.com/form", "Chat A");
  const T = A.tab;
  const other = mkTab("https://other.example.com/", {});

  /* ---- workflow recording ---- */
  let r = await panel("wf_start", { tabId: 99999 });
  check("recording a missing tab is refused", r && r.ok === false, r);
  r = await panel("wf_start", { tabId: T.id });
  let st = await state();
  check("recording starts on the chosen tab", r && r.ok === true && st.recording.active === true && st.recording.tabId === T.id, { r, rec: st.recording });
  r = await tabMsg("wf_step", { step: { kind: "click", desc: "Click button 'Save'", url: "https://shop.example.com/form" } }, other);
  check("a step from another tab is refused", r && r.ok === false, r);
  r = await tabMsg("wf_step", { step: { kind: "click", desc: "Click button 'Save'", url: "https://shop.example.com/form" } }, T);
  const shotsBefore = captures.length;
  await tabMsg("wf_step", { step: { kind: "input", desc: "Type into field 'Email'", url: "https://shop.example.com/form" } }, T);
  st = await state();
  check("steps from the recording tab are stored (with a screenshot of the step)",
        r && r.ok === true && st.recording.steps === 2 && captures.length > shotsBefore, { r, rec: st.recording, captures: captures.length });
  r = await panel("wf_stop");
  st = await state();
  const saved = st.savedPrompts.find((p) => p.command === "workflow");
  check("stopping saves the workflow as a saved prompt with the step list",
        r && r.ok === true && r.steps === 2 && !!saved &&
        saved.prompt.includes("1. Click button 'Save'") && saved.prompt.includes("2. Type into field 'Email'") &&
        saved.url === "https://shop.example.com/form" && st.recording.active === false,
        { r, saved });
  r = await panel("wf_stop");
  check("stopping with nothing recorded is a no-op", r && r.ok === true && r.steps === 0, r);

  /* ---- element picking ---- */
  r = await panel("pick_start", { tabId: T.id });
  st = await state();
  check("picking starts", r && r.ok === true && st.picking === true, { r, picking: st.picking });
  r = await tabMsg("pick_result", { pick: { tag: "button", text: "Wrong tab", x: 1, y: 2 } }, other);
  st = await state();
  check("a pick from another tab is refused", r && r.ok === false && st.picking === true && !st.lastPick, { r, picking: st.picking });
  r = await tabMsg("pick_result", { pick: { tag: "button", id: "save", text: "Save", x: 30, y: 40, url: "https://shop.example.com/form" } }, T);
  st = await state();
  check("the pick lands in panel state and picking ends",
        r && r.ok === true && st.picking === false && !!st.lastPick && st.lastPick.tag === "button" && st.lastPick.id === "save" && st.lastPick.x === 30,
        { r, lastPick: st.lastPick });
  r = await panel("pick_start", { tabId: T.id });
  await tabMsg("pick_cancel", {}, T);
  st = await state();
  check("Esc cancel ends picking without a pick", st.picking === false, st.picking);

  /* ---- javascript switch + debug export ---- */
  r = await panel("set_javascript_enabled", { enabled: true });
  st = await state();
  check("the panel switch turns javascript_tool on in state", r && r.ok === true && st.javascriptEnabled === true, { r, js: st.javascriptEnabled });
  await panel("set_javascript_enabled", { enabled: false });
  r = await panel("debug_export");
  check("debug export carries version, sessions, settings and the record",
        r && r.ok === true && !!r.export && typeof r.export.version === "string" &&
        Array.isArray(r.export.sessions) && r.export.sessions.some((s) => s.chatName === "Chat A") &&
        r.export.settings.javascriptEnabled === false && Array.isArray(r.export.audit),
        r && r.export && Object.keys(r.export));

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
