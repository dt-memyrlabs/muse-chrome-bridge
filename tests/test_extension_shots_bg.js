/* v2.8 stage A: background-tab screenshots. Claude in Chrome forces a
 * frame draw on a hidden tab (a throwaway capture at the lowest
 * quality) so the real capture finds a frame; a tab Chrome still will
 * not draw answers tab_not_visible, and a foreground tab is captured
 * directly with no draw.
 *
 *   node test_extension_shots_bg.js     exit 0 = all passed
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
const { tabs, sent, cdpLog, E, page, mkTab, FakeWS, panel, cdpBox } = F;

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
  const t = mkTab(url, { active: true });
  for (const x of tabs.values()) if (x.id !== t.id) x.active = false;
  await panel("share", { tabId: t.id });
  const req = sent.filter((m) => m.t === "pair_request").pop();
  FakeWS.last.deliver({ t: "pair_code", reqId: req.reqId, code: "ABCD2345", expiresIn: 300 });
  await tick(10);
  const sid = "sess-" + name;
  FakeWS.last.deliver({ t: "paired", reqId: req.reqId, sessionId: sid, chatName: name });
  await approveShare();
  await tick(30);
  return { tab: tabs.get(t.id), sid };
}
const shots = (tabId) => cdpLog.filter((c) => c.tabId === tabId && c.method === "Page.captureScreenshot");

(async () => {
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = sent.find((m) => m.t === "hello"); }
  FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);

  const A = await pair("https://shop.example.com/admin", "Chat A");
  // A second tab for the same chat, left in the background.
  let r = await cmd(A.sid, "navigate", { url: "https://shop.example.com/orders" });
  check("setup: second tab opened", r.ok, r);
  const bgId = r.data.tabId;
  tabs.get(bgId).active = false;
  tabs.get(A.tab.id).active = true;

  // Foreground tab: captured directly, no draw capture before it.
  const before = shots(A.tab.id).length;
  r = await cmd(A.sid, "screenshot", { tabId: A.tab.id });
  check("foreground screenshot succeeds", r.ok && typeof r.data.image === "string", r);
  check("foreground screenshot makes no draw capture first",
        shots(A.tab.id).length === before + 1 && shots(A.tab.id).every((s) => s.params.quality !== 1), shots(A.tab.id));

  // Background tab: a throwaway draw (jpeg, quality 1) precedes the real capture.
  const bgBefore = shots(bgId).length;
  r = await cmd(A.sid, "screenshot", { tabId: bgId });
  check("background screenshot succeeds after a forced draw", r.ok && typeof r.data.image === "string", r);
  const bgShots = shots(bgId).slice(bgBefore);
  check("the draw is a throwaway jpeg at quality 1, before the real capture",
        bgShots.length >= 2 && bgShots[0].params.format === "jpeg" && bgShots[0].params.quality === 1 && bgShots[0].params.fromSurface === true,
        bgShots.map((s) => s.params));

  // A background tab Chrome still will not draw (every real capture
  // hangs) answers tab_not_visible, not a hang and not a fake image.
  cdpBox.hook = ({ method, params }) => {
    if (method === "Page.captureScreenshot" && params.quality !== 1) {
      const e = new Error("cdp_timeout"); e.code = "cdp_timeout"; return e;
    }
    return null;
  };
  r = await cmd(A.sid, "screenshot", { tabId: bgId });
  check("an undrawable background tab answers tab_not_visible", !r.ok && r.error === "tab_not_visible", r);
  cdpBox.hook = null;

  // The computer screenshot action takes the same path.
  tabs.get(A.tab.id).active = false;
  const n0 = shots(A.tab.id).length;
  r = await cmd(A.sid, "computer", { action: "screenshot", tabId: A.tab.id });
  check("computer screenshot of a background tab also forces a draw first",
        r.ok && shots(A.tab.id).slice(n0).some((s) => s.params.quality === 1), r);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
