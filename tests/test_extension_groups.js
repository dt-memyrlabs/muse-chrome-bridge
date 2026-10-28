/* Tab groups (DESIGN-GROUPS.md): group membership is the control set.
 * Pair/attach move the tab into the session's "Muse · <chat name>" group;
 * Daniel dragging a tab into the group adopts it; dragging it out releases
 * it; at browser startup, tabs still in a named group are re-adopted with
 * their site checks re-run; tabs_create lands in the creator's group.
 *
 *   node test_extension_groups.js     exit 0 = all passed
 */
"use strict";
const { install } = require("./fake_chrome");

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("PASS " + name); }
  else { failures++; console.log("FAIL " + name + (detail !== undefined ? "  -- " + JSON.stringify(detail).slice(0, 400) : "")); }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const F = install({ fakeSocket: true });
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = F.sent.find((m) => m.t === "hello"); }
  F.FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);
  return F;
}
function helpers(F) {
  const { sent, panel, FakeWS } = F;
  async function owner(tabId) {
    const all = await F.sw(`local.get("sessions", {})`);
    for (const [sid, v] of Object.entries(all)) if (v.tabs && Object.prototype.hasOwnProperty.call(v.tabs, String(tabId))) return { sid, chat: v.chatName };
    return null;
  }
  // v2.7: a share lands only on the ONE full-control confirmation.
  async function approveShare() {
    for (let i = 0; i < 200; i++) {
      const sp = ((await panel("state")).prompts || []).find((p) => /full control/i.test(p.title));
      if (sp) { await panel("approve", { id: sp.id }); return; }
      await tick(5);
    }
  }
  async function pair(tabId, sid, name, attach) {
    await panel("share", { tabId });
    const req = sent.filter((m) => m.t === "pair_request").pop();
    FakeWS.last.deliver({ t: "pair_code", reqId: req.reqId, code: "ABCD2345", expiresIn: 300 });
    await tick(10);
    FakeWS.last.deliver({ t: "paired", reqId: req.reqId, sessionId: sid, chatName: name, ...(attach ? { attach: true } : {}) });
    await approveShare();
    await tick(40);
  }
  let cmdSeq = 0;
  async function cmd(sid, action, args) {
    const id = "g" + (++cmdSeq);
    FakeWS.last.deliver({ t: "cmd", id, sessionId: sid, action, args: args || {}, ttlMs: 120000 });
    for (let i = 0; i < 400; i++) { const r = sent.find((m) => m.t === "result" && m.id === id); if (r) return r; await tick(5); }
    return { ok: false, error: "TEST_TIMEOUT" };
  }
  const groupOf = (tabId) => F.tabs.get(tabId).groupId;
  // v2.8: group titles may carry a state prefix (⌛/🔔/✅); identity is the bare title.
  const groupsTitled = (title) => [...F.groups.values()].filter((g) => String(g.title || "").replace(/^(⌛|🔔|✅)\s?/, "") === title);
  return { owner, pair, cmd, groupOf, groupsTitled };
}

(async () => {
  /* ------------------------------------------------ main flow */
  const F = await boot();
  const { tabs, mkTab, setGroup, mkGroup, moveToWindow } = F;
  const H = helpers(F);

  const t1 = mkTab("https://shop.example.com/admin", { active: true });
  await H.pair(t1.id, "sess-A", "Chat A");
  const gA = H.groupsTitled("Muse · Chat A");
  check("pair moves the tab into a group titled 'Muse · Chat A'",
        gA.length === 1 && H.groupOf(t1.id) === gA[0].id && gA[0].windowId === 1, { groups: gA, tab: tabs.get(t1.id) });
  const sessA = (await F.sw(`local.get("sessions", {})`))["sess-A"];
  check("...and the session records the group for that window",
        sessA && sessA.groups && Number(sessA.groups["1"]) === gA[0].id, sessA);

  // tabs_create lands in the creating session's group
  let r = await H.cmd("sess-A", "tabs_create", {});
  const created = r.ok && tabs.get(r.data.tabId);
  check("tabs_create lands the new tab in the session's group",
        !!created && created.groupId === gA[0].id && (await H.owner(created.id) || {}).chat === "Chat A", r);

  // attach-on-redeem: the second tab joins the SAME group
  const t2 = mkTab("https://crm.example.com/", { active: true });
  await H.pair(t2.id, "sess-A", "Chat A", true);
  check("attach moves the second tab into the same group",
        H.groupOf(t2.id) === gA[0].id && H.groupsTitled("Muse · Chat A").length === 1);

  // a tab in a second window gets the session's own group in that window
  const t3 = mkTab("https://docs.example.org/", { windowId: 2 });
  await H.pair(t3.id, "sess-A", "Chat A", true);
  const gA2 = H.groupsTitled("Muse · Chat A").find((g) => g.windowId === 2);
  check("a second window gets its own group for the same session",
        !!gA2 && gA2.id !== gA[0].id && H.groupOf(t3.id) === gA2.id, H.groupsTitled("Muse · Chat A"));

  // Chat B pairs its own tab: its own group, its own title
  const u1 = mkTab("https://mail.example.org/", { active: true });
  await H.pair(u1.id, "sess-B", "Chat B");
  const gB = H.groupsTitled("Muse · Chat B");
  check("chat B gets its own group", gB.length === 1 && H.groupOf(u1.id) === gB[0].id && gB[0].id !== gA[0].id);

  // cross-chat isolation around groups
  r = await H.cmd("sess-B", "get_page_text", { tabId: t1.id });
  check("chat B cannot act on a tab in chat A's group", !r.ok && r.error === "tab_not_shared", r);
  r = await H.cmd("sess-B", "tabs_context", {});
  check("chat B's tab list holds only its own grouped tab",
        r.ok && r.data.tabs.length === 1 && r.data.tabs[0].tabId === u1.id, r);

  /* ------------------------------------------------ drag in / out */
  // drag-in adopts: a loose tab dropped into A's group becomes A's
  const loose = mkTab("https://notes.example.net/page");
  setGroup(loose.id, gA[0].id);
  await tick(60);
  const lo = await H.owner(loose.id);
  const sessA2 = (await F.sw(`local.get("sessions", {})`))["sess-A"];
  check("a tab dragged into the group is adopted by the session",
        !!lo && lo.chat === "Chat A" && F.pillOf[loose.id] === "Chat A", lo);
  check("...and its site is granted to that session", !!(sessA2 && sessA2.sites["notes.example.net"]), sessA2 && sessA2.sites);

  // drag-in transfer: B's tab dragged into A's group leaves B
  setGroup(u1.id, gA[0].id);
  await tick(60);
  const sessB = (await F.sw(`local.get("sessions", {})`))["sess-B"];
  check("a tab dragged from B's group into A's transfers (one tab, one session)",
        (await H.owner(u1.id) || {}).chat === "Chat A" && !sessB,
        { owner: await H.owner(u1.id), sessB });

  // drag-out releases: ungroup
  setGroup(t2.id, -1);
  await tick(60);
  check("a tab dragged out of the group (ungrouped) is released",
        !(await H.owner(t2.id)) && !F.pillOf[t2.id]);

  // drag-out into a group of Daniel's own: released, but the tab keeps
  // the group Daniel put it in
  const mine = mkGroup("Daniel's own", 1);
  setGroup(loose.id, mine.id);
  await tick(60);
  check("a tab moved into a non-session group is released...",
        !(await H.owner(loose.id)) && !F.pillOf[loose.id]);
  check("...and it stays in Daniel's own group (not ungrouped by the release)",
        H.groupOf(loose.id) === mine.id);

  // a non-web tab dragged in is refused and taken back out of the group
  const nw = mkTab("chrome://extensions/");
  setGroup(nw.id, gA[0].id);
  await tick(60);
  check("a non-web tab dragged into the group is refused and removed from it",
        !(await H.owner(nw.id)) && H.groupOf(nw.id) === -1, tabs.get(nw.id));

  // moving a controlled tab to another window ungroups it: released
  moveToWindow(t3.id, 5);
  await tick(60);
  check("a controlled tab moved to another window leaves the group and is released",
        !(await H.owner(t3.id)) && tabs.get(t3.id).windowId === 5 && H.groupOf(t3.id) === -1);

  // rename a foreign group to a session's title: its tabs are adopted
  const alien = mkGroup("Random", 3);
  const at = mkTab("https://alien.example.com/", { windowId: 3 });
  setGroup(at.id, alien.id);
  await tick(30);
  await chrome.tabGroups.update(alien.id, { title: "Muse · Chat A" });
  await tick(60);
  check("renaming a group to a session's title adopts its tabs",
        (await H.owner(at.id) || {}).chat === "Chat A", await H.owner(at.id));
  // rename it away again: its tabs are released
  await chrome.tabGroups.update(alien.id, { title: "Something else" });
  await tick(60);
  check("renaming a session's group away releases its tabs",
        !(await H.owner(at.id)) && H.groupOf(at.id) === alien.id);

  // cross-window drag-in where only onAttached fires (no groupId update
  // event): the tab must still be adopted
  const gAx = H.groupsTitled("Muse · Chat A")[0];
  const cw = mkTab("https://cross.example.com/", { windowId: 9 });
  tabs.get(cw.id).groupId = gAx.id; tabs.get(cw.id).windowId = gAx.windowId;
  F.E.tabsAttached.fire(cw.id, { newWindowId: gAx.windowId, newPosition: 0 });
  await tick(80);
  check("a tab that lands in the group with only an attach event is adopted",
        (await H.owner(cw.id) || {}).chat === "Chat A", await H.owner(cw.id));

  // panel remove takes the tab out of the group too
  await F.panel("remove_tab", { tabId: t1.id });
  await tick(40);
  check("panel Remove ungroups the tab as well as releasing it",
        !(await H.owner(t1.id)) && H.groupOf(t1.id) === -1);

  const auditLog = async () => await F.sw(`local.get("audit", [])`);
  const chatState = async (sid) => (await F.panel("state")).chats.find((c) => c.sessionId === sid);

  /* --------------------- grouping refused by the window (v2.7.1) */
  // Chrome throws "Grouping is not supported by tabs in this window."
  // for tabs in non-normal windows (the fake models this). v2.7.1
  // copies Claude in Chrome's answer: a refusing window is not retried
  // in place — the tab moves to a window of its own and groups there,
  // and the move is written to the event record. The tab must stay
  // shared throughout, and the membership sync must NOT mistake the
  // move for "left the group" and release it (live incident: Daniel's
  // Stripe tab, 2026-10-18 23:32).
  F.windowTypes[7] = "app";
  const gt = mkTab("https://refused.example.com/", { windowId: 7 });
  await H.pair(gt.id, "sess-C", "Chat C");
  check("a tab in a window that refuses groups still pairs and stays owned",
        (await H.owner(gt.id) || {}).chat === "Chat C", await H.owner(gt.id));
  const gC = H.groupsTitled("Muse · Chat C");
  check("...and it is moved to a window of its own and grouped there",
        gC.length === 1 && tabs.get(gt.id).windowId !== 7 && gC[0].windowId === tabs.get(gt.id).windowId
          && H.groupOf(gt.id) === gC[0].id,
        { groups: gC, tab: tabs.get(gt.id) });
  const sessC1 = (await F.sw(`local.get("sessions", {})`))["sess-C"];
  check("...and the session records the group under the new window, marked moved",
        !!(sessC1 && sessC1.groups && Number(sessC1.groups[String(tabs.get(gt.id).windowId)]) === gC[0].id
          && sessC1.groupMoved && sessC1.groupMoved[String(gt.id)]),
        sessC1);
  const movedC = (await auditLog()).find((a) => a.chat === "Chat C" && a.action === "tab moved");
  check("...and the event record says the tab was moved to its own window, with the refusal",
        !!movedC && /own window/.test(movedC.outcome) && /Grouping is not supported/.test(movedC.outcome), movedC);
  const stC = await chatState("sess-C");
  check("...and the panel state shows the chat grouped, with no group error",
        !!stC && stC.grouped === true && stC.groupMissing === false && stC.groupError === "", stC);
  // a stray group-related event runs the sync: it must not release it
  F.E.tabsAttached.fire(gt.id, { newWindowId: tabs.get(gt.id).windowId, newPosition: 0 });
  await tick(80);
  check("the membership sync does not release the moved tab",
        (await H.owner(gt.id) || {}).chat === "Chat C" && H.groupOf(gt.id) === gC[0].id, await H.owner(gt.id));

  /* ------------- refusal in a normal window (Daniel's live case) */
  // Window 4 is a normal window whose strip refuses group CREATION
  // ("Grouping is not supported by tabs in this window." — the error
  // from Daniel's vertical-tab window). The first tab moves out and
  // starts the group in its own window; the second tab joins that same
  // group instead of scattering into a window of its own.
  F.groupBox.hook = ({ tabIds, groupId }) => {
    const t = F.tabs.get(tabIds[0]);
    return groupId === undefined && t && t.windowId === 4
      ? new Error("Grouping is not supported by tabs in this window.") : null;
  };
  const e1 = mkTab("https://vert.example.com/", { windowId: 4 });
  await H.pair(e1.id, "sess-E", "Chat E");
  const gE = H.groupsTitled("Muse · Chat E");
  check("a tab in a normal-but-refusing window is moved out and grouped",
        (await H.owner(e1.id) || {}).chat === "Chat E" && gE.length === 1
          && tabs.get(e1.id).windowId !== 4 && H.groupOf(e1.id) === gE[0].id,
        { groups: gE, tab: tabs.get(e1.id) });
  const e2 = mkTab("https://vert2.example.com/", { windowId: 4 });
  await H.pair(e2.id, "sess-E", "Chat E", true);
  const gE2 = H.groupsTitled("Muse · Chat E");
  check("a second tab from the refusing window joins the same group (no scatter)",
        gE2.length === 1 && H.groupOf(e2.id) === gE[0].id && tabs.get(e2.id).windowId === tabs.get(e1.id).windowId,
        { groups: gE2, e2: tabs.get(e2.id) });
  const movedE = (await auditLog()).filter((a) => a.chat === "Chat E" && a.action === "tab moved");
  check("both moves are in the event record with their reasons",
        movedE.length === 2 && movedE.some((a) => /own window/.test(a.outcome))
          && movedE.some((a) => /another window/.test(a.outcome)), movedE);
  F.groupBox.hook = null;

  /* --------- transient failure: visible, no move, heals on use */
  // A transient refusal (the tab is mid-drag) must NOT move the tab.
  // The failure is recorded with Chrome's real text and carried in the
  // panel state; when Chrome accepts again, a lifecycle event (tab
  // activation) heals the tab in place.
  F.groupBox.hook = () => new Error("Tabs cannot be edited right now (user may be dragging a tab).");
  const d1 = mkTab("https://drag.example.com/", { windowId: 1 });
  await H.pair(d1.id, "sess-D", "Chat D");
  const sessD1 = (await F.sw(`local.get("sessions", {})`))["sess-D"];
  check("a transient grouping failure leaves the tab owned, groupless and unmoved",
        (await H.owner(d1.id) || {}).chat === "Chat D" && H.groupOf(d1.id) === -1 && tabs.get(d1.id).windowId === 1
          && !(sessD1 && sessD1.groupMoved && sessD1.groupMoved[String(d1.id)]),
        { tab: tabs.get(d1.id), sess: sessD1 });
  check("...and it is marked for retry",
        !!(sessD1 && sessD1.groupRetry && Number(sessD1.groupRetry[String(d1.id)]) >= 1), sessD1);
  const failD = (await auditLog()).find((a) => a.chat === "Chat D" && a.action === "tab group");
  check("...and the event record carries Chrome's real error text",
        !!failD && /cannot be edited right now/i.test(failD.detail), failD);
  const stD1 = await chatState("sess-D");
  check("...and the panel state shows the missing group with the error",
        !!stD1 && stD1.groupMissing === true && stD1.grouped === false && /cannot be edited/i.test(stD1.groupError), stD1);
  F.groupBox.hook = null;
  F.E.tabsActivated.fire({ tabId: d1.id, windowId: 1 });
  await tick(80);
  const gD = H.groupsTitled("Muse · Chat D");
  const stD2 = await chatState("sess-D");
  check("activating the tab retries grouping and heals it in place",
        gD.length === 1 && H.groupOf(d1.id) === gD[0].id && tabs.get(d1.id).windowId === 1, { groups: gD, tab: tabs.get(d1.id) });
  check("...and the panel state clears (grouped, no error)",
        !!stD2 && stD2.grouped === true && stD2.groupMissing === false && stD2.groupError === "", stD2);

  /* ------------------- retries bounded, and the bound is visible */
  F.groupBox.hook = () => new Error("Tabs cannot be edited right now (user may be dragging a tab).");
  const g1 = mkTab("https://stuck.example.com/", { windowId: 1 });
  await H.pair(g1.id, "sess-G", "Chat G");
  for (let i = 0; i < 10; i++) { F.E.tabsActivated.fire({ tabId: g1.id, windowId: 1 }); await tick(30); }
  const sessG = (await F.sw(`local.get("sessions", {})`))["sess-G"];
  const stG = await chatState("sess-G");
  check("retries stop at the bound (mark does not grow past it)",
        !!sessG && Number(sessG.groupRetry[String(g1.id)]) === 9, sessG && sessG.groupRetry);
  check("...and the panel state says the bridge stopped retrying",
        !!stG && stG.groupMissing === true && stG.groupStopped === true, stG);
  check("...and the tab is still owned throughout",
        (await H.owner(g1.id) || {}).chat === "Chat G", await H.owner(g1.id));
  F.groupBox.hook = null;

  /* -------------------- group-id rotation + orphan adoption */
  const f1 = mkTab("https://rot.example.com/", { windowId: 1 });
  await H.pair(f1.id, "sess-F", "Chat F");
  const gF1 = H.groupsTitled("Muse · Chat F")[0];
  // Chrome recreates the group under a new id (rotation): the tab lands
  // in a new group carrying the same title and the old one dies empty.
  const gF2 = mkGroup("Muse · Chat F", 1);
  setGroup(f1.id, gF2.id);
  await tick(80);
  const sessF1 = (await F.sw(`local.get("sessions", {})`))["sess-F"];
  check("a rotated group id is followed, not fought",
        !!sessF1 && Number(sessF1.groups["1"]) === gF2.id && H.groupOf(f1.id) === gF2.id
          && H.groupsTitled("Muse · Chat F").length === 1 && (await H.owner(f1.id) || {}).chat === "Chat F",
        { sess: sessF1 && sessF1.groups, groups: H.groupsTitled("Muse · Chat F") });
  const rotF = (await auditLog()).find((a) => a.chat === "Chat F" && a.action === "tab group" && /group id/.test(a.detail || ""));
  check("...and the id change leaves a trace in the event record",
        !!rotF && rotF.detail.includes(String(gF1.id)) && rotF.detail.includes(String(gF2.id)), rotF);
  // Orphan: the worker's cache loses the group entirely while the tab
  // still sits in the titled group. A lifecycle event reconciles: the
  // existing group is adopted again — no second group is created.
  await F.sw(`withState((st) => { delete st["sess-F"].groups; })`);
  F.E.tabsActivated.fire({ tabId: f1.id, windowId: 1 });
  await tick(80);
  const sessF2 = (await F.sw(`local.get("sessions", {})`))["sess-F"];
  check("an orphaned titled group is adopted back (cache rebuilt, no duplicate)",
        !!sessF2 && sessF2.groups && Number(sessF2.groups["1"]) === gF2.id
          && H.groupsTitled("Muse · Chat F").length === 1 && (await H.owner(f1.id) || {}).chat === "Chat F",
        { sess: sessF2 && sessF2.groups, groups: H.groupsTitled("Muse · Chat F") });

  console.log(`\n${passes}/${passes + failures} passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
