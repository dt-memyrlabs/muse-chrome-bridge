/* Panel window fix (2026-10-18): the worker's "state" answer used the last
 * focused window's active tab, so with the Muse chat window open, the panel
 * in a work window described the chat window (muse.ai, "nothing to share").
 * The panel now passes its own window id and the worker answers for it.
 *
 *   node test_panel_window.js     exit 0 = all passed
 */
"use strict";
const { install } = require("./fake_chrome");

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("PASS " + name); }
  else { failures++; console.log("FAIL " + name + (detail !== undefined ? "  -- " + JSON.stringify(detail).slice(0, 400) : "")); }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const F = install({ fakeSocket: true });
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = F.sent.find((m) => m.t === "hello"); }
  F.FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);

  // Window 1 = the Muse chat window (last focused). Window 2 = work window.
  const chatTab = F.mkTab("https://muse.ai/chat", { windowId: 1, active: true });
  const workTab = F.mkTab("https://dashboard.stripe.com/acct/dashboard", { windowId: 2, active: true });
  F.setLastFocusedWindow(1);

  const stWork = await F.panel("state", { windowId: 2 });
  check("panel in work window describes the work tab",
    stWork.ok && stWork.current && stWork.current.tabId === workTab.id && stWork.current.host === "dashboard.stripe.com",
    stWork.current);
  check("work tab is shareable in its own panel",
    stWork.current && stWork.current.shareable === true, stWork.current);

  const stChat = await F.panel("state", { windowId: 1 });
  check("panel in chat window describes the muse.ai tab",
    stChat.ok && stChat.current && stChat.current.tabId === chatTab.id && stChat.current.host === "muse.ai",
    stChat.current);

  F.setLastFocusedWindow(2);
  const stWork2 = await F.panel("state", { windowId: 2 });
  check("window id wins when the work window is also last focused",
    stWork2.current && stWork2.current.tabId === workTab.id, stWork2.current);
  const stChat2 = await F.panel("state", { windowId: 1 });
  check("window id wins over last focused for the chat window too",
    stChat2.current && stChat2.current.tabId === chatTab.id, stChat2.current);

  const stFallback = await F.panel("state");
  check("no window id keeps the old last-focused behaviour (fallback)",
    stFallback.current && stFallback.current.tabId === workTab.id, stFallback.current);

  // A session owning a tab in window 2: tabsHere follows the panel's window,
  // so a panel in window 1 can say "tabs in another window" instead of
  // implying the chat is connected here with nothing under control.
  const reqsBefore = F.sent.filter((m) => m.t === "pair_request").length;
  await F.panel("share", { tabId: workTab.id });
  // v2.9: the ONE confirmation is asked at code generation, before any code exists.
  for (let i = 0; i < 200; i++) {
    const sp = ((await F.panel("state")).prompts || []).find((p) => /full control/i.test(p.title));
    if (sp) { await F.panel("approve", { id: sp.id }); break; }
    await tick(5);
  }
  for (let i = 0; i < 200; i++) { if (F.sent.filter((m) => m.t === "pair_request").length > reqsBefore) break; await tick(5); }
  const req = F.sent.filter((m) => m.t === "pair_request").pop();
  F.FakeWS.last.deliver({ t: "pair_code", reqId: req.reqId, code: "WXYZ9876", expiresIn: 300 });
  await tick(10);
  F.FakeWS.last.deliver({ t: "paired", reqId: req.reqId, sessionId: "sessW", chatName: "Work Chat" });
  // v2.7: the share lands only on the ONE full-control confirmation.
  for (let i = 0; i < 200; i++) {
    const sp = ((await F.panel("state")).prompts || []).find((p) => /full control/i.test(p.title));
    if (sp) { await F.panel("approve", { id: sp.id }); break; }
    await tick(5);
  }
  await tick(40);
  const stHere = await F.panel("state", { windowId: 2 });
  const chatHere = stHere.chats.find((c) => c.sessionId === "sessW");
  check("tabsHere counts the session's tab in the panel's own window",
    !!chatHere && chatHere.tabs === 1 && chatHere.tabsHere === 1, chatHere);
  const stThere = await F.panel("state", { windowId: 1 });
  const chatThere = stThere.chats.find((c) => c.sessionId === "sessW");
  check("tabsHere is 0 in the other window while the total stays 1",
    !!chatThere && chatThere.tabs === 1 && chatThere.tabsHere === 0, chatThere);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
