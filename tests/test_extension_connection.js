/* v2.10 Connection area (Daniel, 2026-11-02): on a shared tab the
 * panel gains exactly three things — Refresh connection (a fresh code
 * through the same generation-confirmation flow), Check connection
 * (a step-by-step end-to-end probe with real error text), and Copy
 * debug report (plain text with NO tokens, secrets, codes or page
 * text). This suite covers the worker side of all three, including
 * the refresh redemption re-binding the tab with no second card.
 *
 *   node test_extension_connection.js     exit 0 = all passed
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
const { tabs, sent, FakeWS, panel } = F;

let cmdSeq = 0;
function cmdStart(sessionId, action, args, extra) {
  const id = "c" + (++cmdSeq);
  FakeWS.last.deliver({ t: "cmd", id, sessionId, action, args: args || {}, ttlMs: 120000, ...(extra || {}) });
  return id;
}
async function result(id, ms = 4000) {
  for (let i = 0; i < ms / 5; i++) {
    const r = sent.find((m) => m.t === "result" && m.id === id);
    if (r) return r;
    await tick(5);
  }
  return { ok: false, error: "TEST_TIMEOUT" };
}
const cmd = (sid, action, args, extra) => result(cmdStart(sid, action, args, extra));
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
  const t = mkTabPair(url);
  const reqsBefore = sent.filter((m) => m.t === "pair_request").length;
  await panel("share", { tabId: t.id });
  await approveShare();
  for (let i = 0; i < 200; i++) { if (sent.filter((m) => m.t === "pair_request").length > reqsBefore) break; await tick(5); }
  const req = sent.filter((m) => m.t === "pair_request").pop();
  FakeWS.last.deliver({ t: "pair_code", reqId: req.reqId, code: "ABCD2345", expiresIn: 300 });
  await tick(10);
  const sid = "sess-" + name;
  FakeWS.last.deliver({ t: "paired", reqId: req.reqId, sessionId: sid, chatName: name });
  await tick(30);
  return { tab: tabs.get(t.id), sid };
}
const { mkTab } = F;
function mkTabPair(url) {
  const t = mkTab(url, { active: true });
  for (const x of tabs.values()) if (x.id !== t.id) x.active = false;
  return t;
}
/* Run a panel check_connection while answering the relay's session
 * query the way the real relay would. */
async function runCheck(tabId, live) {
  const before = sent.filter((m) => m.t === "session_check").length;
  const p = panel("check_connection", { tabId });
  for (let i = 0; i < 200; i++) {
    const q = sent.filter((m) => m.t === "session_check")[before];
    if (q) { FakeWS.last.deliver({ t: "session_check_result", id: q.id, sessionId: q.sessionId, live }); break; }
    await tick(5);
  }
  return p;
}

(async () => {
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = sent.find((m) => m.t === "hello"); }
  FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);

  const A = await pair("https://shop.example.com/form", "Chat A");
  const T = A.tab.id;
  tabs.get(T).title = "Distinctive Shop Title ZQX-9911";

  /* ---- Refresh connection: a fresh code for an already-shared tab ---- */
  const reqsBefore = sent.filter((m) => m.t === "pair_request").length;
  await panel("share", { tabId: T }); // the panel's Refresh connection button sends exactly this
  const card = await approveShare();
  check("refresh on a shared tab asks the one generation confirmation again", !!card, await pendingPrompts());
  for (let i = 0; i < 200; i++) { if (sent.filter((m) => m.t === "pair_request").length > reqsBefore) break; await tick(5); }
  const req = sent.filter((m) => m.t === "pair_request").pop();
  check("refresh requested a fresh code from the relay", !!req, sent.slice(-3));
  FakeWS.last.deliver({ t: "pair_code", reqId: req.reqId, code: "REFR5678", expiresIn: 300 });
  await tick(10);
  const stRefresh = await panel("state");
  check("the panel state shows the refresh code, stamped confirmed at generation",
        stRefresh.share && stRefresh.share.code === "REFR5678" && stRefresh.share.confirmedAtGeneration === true,
        stRefresh.share);
  check("the tab still shows as shared with Chat A while the refresh code waits",
        stRefresh.current && stRefresh.current.sharedWith === "Chat A", stRefresh.current);

  /* ---- redeeming the refresh code re-binds with NO second card (case a) ---- */
  sent.length = 0;
  FakeWS.last.deliver({ t: "paired", reqId: req.reqId, sessionId: A.sid, chatName: "Chat A", attach: true });
  await tick(40);
  const promptsAfter = await pendingPrompts();
  check("refresh redemption completed with no second confirmation card",
        !promptsAfter.some((p) => /full control/i.test(p.title)), promptsAfter);
  const ack = sent.find((m) => m.t === "paired_ack");
  check("the attach was acked to the relay", !!ack, sent);
  let r = await cmd(A.sid, "tabs_context", {});
  check("the session still controls the tab after the refresh (round-trip via tabs_context)",
        r.ok && (r.data.tabs || []).some((t) => t.tabId === T), r.data);

  /* ---- Check connection: every step passes against a live relay ---- */
  const okRes = await runCheck(T, true);
  check("check_connection answers ok with four steps",
        okRes.ok && Array.isArray(okRes.steps) && okRes.steps.length === 4, okRes);
  check("happy path: relay, session, group and round-trip all pass",
        okRes.steps.every((s) => s.ok), okRes.steps);

  /* ---- Check connection: the relay has forgotten the session ---- */
  const deadRes = await runCheck(T, false);
  const deadStep = deadRes.steps.find((s) => /Session/.test(s.name));
  check("a relay-dead session fails the session step, naming Refresh connection",
        deadStep && deadStep.ok === false && /Refresh connection/.test(deadStep.detail), deadRes.steps);

  /* ---- Check connection: relay down — step 1 fails, the rest say so ---- */
  await F.sw(`wsReady = false`);
  const downRes = await panel("check_connection", { tabId: T });
  await F.sw(`wsReady = true`);
  check("relay down: the relay step fails with the reason",
        downRes.steps[0].ok === false && downRes.steps[0].detail.length > 0, downRes.steps);
  check("relay down: later steps fail as not checked, never silently pass",
        downRes.steps.slice(1).every((s) => s.ok === false && /not checked/.test(s.detail)), downRes.steps);

  /* ---- Check connection: a tab nobody shared ---- */
  const t2 = mkTab("https://unshared.example.com/", { active: false });
  const unRes = await runCheck(t2.id, true);
  check("an unshared tab fails the session step in plain words",
        unRes.steps[1].ok === false && /not shared/.test(unRes.steps[1].detail), unRes.steps);

  /* ---- Debug report: everything required, nothing forbidden ---- */
  await F.sw(`local.set("enrollSecret", "TESTENROLLSECRET-0123456789abcdef")`);
  // A live pairing code exists right now (mint one and leave it unredeemed):
  const reqs2 = sent.filter((m) => m.t === "pair_request").length;
  await panel("share", { tabId: T });
  await approveShare();
  for (let i = 0; i < 200; i++) { if (sent.filter((m) => m.t === "pair_request").length > reqs2) break; await tick(5); }
  const req2 = sent.filter((m) => m.t === "pair_request").pop();
  FakeWS.last.deliver({ t: "pair_code", reqId: req2.reqId, code: "CODENEVER", expiresIn: 300 });
  await tick(10);
  const rep = await panel("debug_report", { tabId: T, ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
    check: okRes.steps });
  const text = (rep && rep.text) || "";
  check("debug report builds", rep.ok && text.length > 100, rep);
  for (const want of ["2.10.1", "Chrome/130.0.0.0", "Chat A", "shop.example.com",
                      "PASS Relay reachable", "Recent activity", "paired"])
    check("report contains: " + want, text.includes(want), text.slice(0, 400));
  for (const banned of ["CODENEVER", "TESTENROLLSECRET", "Distinctive Shop Title ZQX-9911", A.sid])
    check("report must NOT contain: " + banned, !text.includes(banned), text.slice(0, 400));

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("SUITE ERROR", e); process.exit(2); });
