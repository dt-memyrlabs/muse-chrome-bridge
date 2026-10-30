/* Tab groups at browser startup (DESIGN-GROUPS.md, the B040 extension):
 * ownership of stored tabs is dropped as always, then tabs still sitting
 * in a session's named group are re-adopted by that session — with the
 * site check re-run. A group tab whose site is no longer permitted is
 * not re-adopted and is taken out of the group; a controlled tab that is
 * in no group is dropped, exactly as before. Kept in its own file
 * because the fake-chrome harness supports one install per process.
 *
 *   node test_extension_groups_startup.js     exit 0 = all passed
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
  const { tabs, sent, mkTab, panel, FakeWS } = F;
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = sent.find((m) => m.t === "hello"); }
  FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);

  async function owner(tabId) {
    const all = await F.sw(`local.get("sessions", {})`);
    for (const v of Object.values(all)) if (v.tabs && Object.prototype.hasOwnProperty.call(v.tabs, String(tabId))) return v.chatName;
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
    const reqsBefore = sent.filter((m) => m.t === "pair_request").length;
    await panel("share", { tabId });
    await approveShare(); // v2.9: the ONE confirmation is asked at code generation, before any code exists
    for (let i = 0; i < 200; i++) { if (sent.filter((m) => m.t === "pair_request").length > reqsBefore) break; await tick(5); }
    const req = sent.filter((m) => m.t === "pair_request").pop();
    FakeWS.last.deliver({ t: "pair_code", reqId: req.reqId, code: "ABCD2345", expiresIn: 300 });
    await tick(10);
    FakeWS.last.deliver({ t: "paired", reqId: req.reqId, sessionId: sid, chatName: name, ...(attach ? { attach: true } : {}) });
    await approveShare();
    await tick(40);
  }

  const s1 = mkTab("https://shop.example.com/admin", { active: true });
  await pair(s1.id, "sess-A", "Chat A");
  const s2 = mkTab("https://crm.example.com/", { active: true });
  await pair(s2.id, "sess-A", "Chat A", true);
  const s3 = mkTab("https://mail.example.org/", { active: true });
  await pair(s3.id, "sess-B", "Chat B");
  // an app-window tab: grouping is refused there, so it is owned but
  // ungrouped (the fallback in DESIGN-GROUPS.md)
  F.windowTypes[7] = "app";
  const s4 = mkTab("https://pwa.example.com/app", { windowId: 7 });
  await pair(s4.id, "sess-A", "Chat A", true);
  check("setup: the app-window tab is owned but in no group",
        (await owner(s4.id)) === "Chat A" && tabs.get(s4.id).groupId === -1,
        { owner: await owner(s4.id), tab: tabs.get(s4.id) });
  // revoke crm's site grant while its tab stays owned and grouped: at
  // startup the site check must refuse to bring that tab back
  await panel("revoke_site", { sessionId: "sess-A", host: "crm.example.com" });
  await tick(20);
  check("setup: both chats hold their grouped tabs before the restart",
        (await owner(s1.id)) === "Chat A" && (await owner(s3.id)) === "Chat B");
  // a third chat whose only tab sits in NO group at the restart: the
  // restart leaves it with no tabs, so its session ends (Daniel's rule)
  const s5 = mkTab("https://solo.example.com/", { active: true });
  await pair(s5.id, "sess-C", "Chat C");
  tabs.get(s5.id).groupId = -1; // silently ungrouped before the restart

  await Promise.all(F.E.startup.fire());
  await tick(60);
  check("startup re-adopts a tab still in the session's group (site still permitted)",
        (await owner(s1.id)) === "Chat A" && F.pillOf[s1.id] === "Chat A", await owner(s1.id));
  check("startup re-adopts the other chat's group tab too",
        (await owner(s3.id)) === "Chat B");
  check("startup does NOT re-adopt a group tab whose site is no longer permitted...",
        !(await owner(s2.id)));
  check("...and that tab is taken out of the group",
        tabs.get(s2.id).groupId === -1);
  check("startup drops a controlled tab that is in no group (old B040 rule)",
        !(await owner(s4.id)));
  const allS = await F.sw(`local.get("sessions", {})`);
  check("startup ends a session the restart left with no tabs",
        !allS["sess-C"] && !!allS["sess-A"] && !!allS["sess-B"], Object.keys(allS));

  console.log(`\n${passes}/${passes + failures} passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
