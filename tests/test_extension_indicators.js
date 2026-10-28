/* v2.8 stage D: indicator depth at Claude in Chrome parity.
 *  - while a command runs on a tab, the tab's agent layer is driven
 *    {working:true}; when it ends, {working:false, static:true};
 *    the chat's other tabs carry the static pill state;
 *  - the in-page Stop button's message cancels the in-flight command
 *    (the result comes back "canceled") and is written to the record;
 *  - the static pill's heartbeat answers active only while the chat
 *    owns the tab and the pill was not dismissed;
 *  - the group title carries ⌛ working / 🔔 waiting / ✅ done, and
 *    group identity survives the prefixes.
 *
 *   node test_extension_indicators.js     exit 0 = all passed
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
const { tabs, groups, sent, E, page, mkTab, FakeWS, panel, agentUIOf, agentUILog, visualLog } = F;

let cmdSeq = 0;
function cmdStart(sessionId, action, args, extra) {
  const id = "c" + (++cmdSeq);
  FakeWS.last.deliver({ t: "cmd", id, sessionId, action, args: args || {}, ttlMs: 120000, ...(extra || {}) });
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
const tabMsg = (kind, tab) => panel(kind, {}, { id: "extid", frameId: 0, tab: { id: tab.id, url: tab.url, windowId: tab.windowId } });
const groupOf = (tabId) => groups.get(tabs.get(tabId).groupId);
const bare = (t) => String(t || "").replace(/^(⌛|🔔|✅)\s?/, "");

(async () => {
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = sent.find((m) => m.t === "hello"); }
  FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);

  const A = await pair("https://shop.example.com/form", "Chat A");
  const T = A.tab.id;
  let r = await cmd(A.sid, "navigate", { url: "https://shop.example.com/other" });
  const T2 = r.data.tabId;
  check("setup: the chat holds two grouped tabs",
        r.ok && tabs.get(T).groupId > -1 && tabs.get(T).groupId === tabs.get(T2).groupId, { r, g: [tabs.get(T).groupId, tabs.get(T2).groupId] });

  /* ---- working layer during a command, static layer after ---- */
  agentUILog.length = 0;
  page.point = () => ({ tag: "div", text: "", fp: "div|plain" });
  r = await cmd(A.sid, "computer", { action: "left_click", coordinate: [5, 5], tabId: T });
  const seq = agentUILog.filter((e) => e.tabId === T && e.arg && typeof e.arg.working === "boolean").map((e) => e.arg.working);
  check("the worked tab is driven working:true while the command runs and working:false after",
        r.ok && seq.includes(true) && seq.lastIndexOf(false) > seq.indexOf(true), seq);
  check("after the command the worked tab settles to the static state",
        agentUIOf[T] && agentUIOf[T].working === false && agentUIOf[T].static === true, agentUIOf[T]);
  check("the chat's other tab carries the static pill state",
        agentUIOf[T2] && agentUIOf[T2].working === false && agentUIOf[T2].static === true, agentUIOf[T2]);

  /* ---- indicators hide for captures ---- */
  const v0 = visualLog.length;
  r = await cmd(A.sid, "screenshot", { tabId: T });
  const seg = visualLog.slice(v0);
  const hideIdx = seg.findIndex((e) => e.kind === "agentui" && e.arg && e.arg.op === "hideForCapture");
  const capIdx = seg.findIndex((e) => e.kind === "capture");
  const showIdx = seg.findIndex((e) => e.kind === "agentui" && e.arg && e.arg.op === "showAfterCapture");
  check("the agent layer hides before a capture and returns after it",
        r.ok && hideIdx > -1 && capIdx > hideIdx && showIdx > capIdx, seg.map((e) => e.kind + ":" + (e.arg && e.arg.op || "")));

  /* ---- group title prefix: done state ---- */
  await tick(30);
  const g = groupOf(T);
  check("after a finished job the group title carries ✅ over the bare title",
        g && g.title.startsWith("✅") && bare(g.title) === "Muse · Chat A", g && g.title);
  const st = await panel("state");
  const chat = st.chats.find((c) => c.sessionId === A.sid);
  check("panel state still reads the prefixed group as the chat's group",
        !!chat && chat.grouped === true && chat.groupMissing === false, chat && { grouped: chat.grouped, groupMissing: chat.groupMissing });

  /* ---- prefix state machine: waiting, then working ---- */
  await F.sw(`pending.set("px", { sessionId: "${A.sid}", chat: "Chat A", title: "t", detail: "", resolve: () => {}, timer: 0 })`);
  await F.sw(`refreshGroupPrefix("${A.sid}")`);
  check("a waiting prompt puts 🔔 on the group title", groupOf(T).title.startsWith("🔔"), groupOf(T).title);
  await F.sw(`pending.delete("px")`);
  await F.sw(`inflight.set("jx", { id: "jx", sessionId: "${A.sid}", tabs: new Set() })`);
  await F.sw(`refreshGroupPrefix("${A.sid}")`);
  check("an in-flight job puts ⌛ on the group title", groupOf(T).title.startsWith("⌛"), groupOf(T).title);
  await F.sw(`inflight.delete("jx")`);
  await F.sw(`refreshGroupPrefix("${A.sid}")`);
  check("with the job gone the title returns to ✅ and identity is intact",
        groupOf(T).title.startsWith("✅") && bare(groupOf(T).title) === "Muse · Chat A", groupOf(T).title);

  /* ---- heartbeat + dismiss ---- */
  let hb = await tabMsg("agent_heartbeat", tabs.get(T2));
  check("the static pill heartbeat answers active while the chat owns the tab", hb && hb.active === true, hb);
  await tabMsg("agent_dismiss_static", tabs.get(T2));
  check("dismissing takes the static layer down", agentUIOf[T2] && agentUIOf[T2].static === false, agentUIOf[T2]);
  hb = await tabMsg("agent_heartbeat", tabs.get(T2));
  check("after dismissal the heartbeat answers inactive", hb && hb.active === false, hb);
  r = await cmd(A.sid, "computer", { action: "left_click", coordinate: [6, 6], tabId: T });
  check("a dismissed pill stays dismissed across later refreshes",
        r.ok && agentUIOf[T2] && agentUIOf[T2].static === false, agentUIOf[T2]);

  /* ---- the Stop button cancels the in-flight command ---- */
  const wid = cmdStart(A.sid, "computer", { action: "wait", duration: 3, tabId: T });
  await tick(150);
  check("the waiting command has the working layer up", agentUIOf[T] && agentUIOf[T].working === true, agentUIOf[T]);
  const stopRes = await tabMsg("agent_stop", tabs.get(T));
  r = await result(wid, 8000);
  check("Stop from the page answers ok and the in-flight command returns canceled",
        stopRes && stopRes.ok === true && !r.ok && r.error === "canceled", { stopRes, r });
  const st2 = await panel("state");
  check("the stop is written to the event record",
        st2.audit.some((e) => /stopped from the page/i.test((e.action || "") + " " + (e.what || ""))), st2.audit.slice(0, 3));
  await tabMsg("agent_stop_dropped", tabs.get(T));
  const st3 = await panel("state");
  check("a dropped stop is also written to the record",
        st3.audit.some((e) => /did not land/i.test((e.action || "") + " " + (e.what || ""))), st3.audit.slice(0, 3));

  /* ---- heartbeat after release ---- */
  await panel("remove_tab", { tabId: T2 });
  await tick(20);
  hb = await tabMsg("agent_heartbeat", { id: T2, url: "https://shop.example.com/other", windowId: 1 });
  check("once the tab is released the heartbeat answers inactive", hb && hb.active === false, hb);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
