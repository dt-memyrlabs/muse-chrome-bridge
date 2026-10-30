/* v2.8 stage E: orphaned tabs (FULL-GAP §11), adapted to our model.
 *  - an ungrouped web tab whose opener is one of the chat's tabs is
 *    detected (Claude's findOrphanedTabs shape) and SURFACED — in
 *    panel state and in tabs_context — but never taken silently:
 *    adding it runs the ordinary one-confirmation share;
 *  - non-web children, other chats' children, and grouped children
 *    are not orphans;
 *  - a group whose members all belong to one chat is adopted as
 *    that chat's group (remembered + titled) instead of releasing
 *    its tabs; a mixed group is not adopted.
 *
 *   node test_extension_orphans.js     exit 0 = all passed
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
const { tabs, groups, sent, E, mkTab, mkGroup, setGroup, FakeWS, panel } = F;

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
const bare = (t) => String(t || "").replace(/^(⌛|🔔|✅)\s?/, "");

(async () => {
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = sent.find((m) => m.t === "hello"); }
  FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);

  const A = await pair("https://shop.example.com/form", "Chat A");
  const T = A.tab.id;

  /* ---- detection ---- */
  const orphan = mkTab("https://blog.example.net/post", { openerTabId: T });
  const childPage = mkTab("chrome://extensions", { openerTabId: T });
  const stranger = mkTab("https://elsewhere.example.org/", { openerTabId: 9999 });
  const groupedChild = mkTab("https://shop.example.com/cart", { openerTabId: T });
  const ownGroup = mkGroup("Muse · Chat A", 1);
  setGroup(groupedChild.id, ownGroup.id);
  await tick(20);

  let st = await panel("state");
  let chat = st.chats.find((c) => c.sessionId === A.sid);
  check("panel state surfaces the orphaned tab for the chat",
        !!chat && chat.orphans.length === 1 && chat.orphans[0].tabId === orphan.id && chat.orphans[0].host === "blog.example.net",
        chat && chat.orphans);
  let r = await cmd(A.sid, "tabs_context", {});
  check("tabs_context surfaces the same orphan",
        r.ok && Array.isArray(r.data.orphans) && r.data.orphans.length === 1 && r.data.orphans[0].tabId === orphan.id, r.data && r.data.orphans);
  check("non-web children, other openers' children, and grouped children are not orphans",
        !!chat && !chat.orphans.some((o) => [childPage.id, stranger.id, groupedChild.id].includes(o.tabId)), chat && chat.orphans);

  /* ---- adding an orphan goes through the one confirmation ---- */
  r = await cmd(A.sid, "get_page_text", { tabId: orphan.id });
  check("the orphan is NOT controlled before it is added", !r.ok && r.error === "tab_not_shared", r);
  const addP = panel("add_tab", { sessionId: A.sid, tabId: orphan.id });
  const card = await approveShare();
  await addP;
  await tick(30);
  check("adding the orphan asked the one full-control confirmation", !!card, card);
  r = await cmd(A.sid, "get_page_text", { tabId: orphan.id });
  check("after the confirmed add, the chat controls the tab", r.ok, r);
  st = await panel("state");
  chat = st.chats.find((c) => c.sessionId === A.sid);
  check("the added tab leaves the orphan list", !!chat && !chat.orphans.some((o) => o.tabId === orphan.id), chat && chat.orphans);

  /* ---- group adoption: all members belong to the chat ---- */
  const mate = mkTab("https://shop.example.com/help", {});
  const addP2 = panel("add_tab", { sessionId: A.sid, tabId: mate.id });
  await approveShare();
  await addP2;
  await tick(30);
  // The user groups two of the chat's tabs by hand, in a fresh group
  // with no title: membership sync must adopt the group, not release.
  const hand = mkGroup("", 1);
  setGroup(orphan.id, hand.id);
  setGroup(mate.id, hand.id);
  E.tabsUpdated.fire(orphan.id, { groupId: hand.id }, { ...tabs.get(orphan.id) });
  await tick(60);
  const g = groups.get(hand.id);
  const st2 = await panel("state");
  const chat2 = st2.chats.find((c) => c.sessionId === A.sid);
  check("a group made only of the chat's tabs is adopted and titled for the chat",
        !!g && bare(g.title) === "Muse · Chat A", g && g.title);
  check("the adopted group reads as the chat's group in panel state",
        !!chat2 && chat2.tabsList.some((t) => t.tabId === orphan.id) && chat2.tabsList.some((t) => t.tabId === mate.id),
        chat2 && chat2.tabsList);
  r = await cmd(A.sid, "get_page_text", { tabId: mate.id });
  check("tabs in the adopted group stay controlled", r.ok, r);

  /* ---- a mixed group is not adopted ---- */
  const foreign = mkTab("https://other.example.com/", {});
  const mixed = mkGroup("", 1);
  setGroup(mate.id, mixed.id);
  setGroup(foreign.id, mixed.id);
  E.tabsUpdated.fire(mate.id, { groupId: mixed.id }, { ...tabs.get(mate.id) });
  await tick(60);
  check("a group with a foreign tab in it is not adopted (keeps no Muse title)",
        bare(groups.get(mixed.id).title) !== "Muse · Chat A", groups.get(mixed.id).title);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
