/* Attach-on-redeem at the extension: a "paired" message marked attach: true
 * for a session that already exists adds the share's tab to THAT session
 * (no new session, no session_exists refusal). If the share's tab moved,
 * the attach is nacked and the session is untouched. If the session does
 * not exist locally, the message falls through to the normal pairing, so a
 * session the relay still holds is healed under the relay's id.
 *
 *   node test_extension_attach.js     exit 0 = all passed
 */
"use strict";
const { install } = require("./fake_chrome");

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("PASS " + name); }
  else { failures++; console.log("FAIL " + name + (detail !== undefined ? "  -- " + JSON.stringify(detail).slice(0, 400) : "")); }
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const F = install({ fakeSocket: true });
const { tabs, sent, mkTab, setUrl, FakeWS, panel } = F;

async function owner(tabId) {
  const all = await F.sw(`local.get("sessions", {})`);
  for (const v of Object.values(all)) if (v.tabs && Object.prototype.hasOwnProperty.call(v.tabs, String(tabId))) return v.chatName;
  return null;
}
async function share(tabId) {
  await panel("share", { tabId });
  const req = sent.filter((m) => m.t === "pair_request").pop();
  FakeWS.last.deliver({ t: "pair_code", reqId: req.reqId, code: "ABCD2345", expiresIn: 300 });
  await tick(10);
  return req.reqId;
}
const acks = (since, sid) => sent.slice(since).filter((m) => (m.t === "paired_ack" || m.t === "paired_nack") && m.sessionId === sid);
// v2.7: a share (fresh pair or attach) lands only on the ONE
// full-control confirmation in the panel.
async function approveShare() {
  for (let i = 0; i < 200; i++) {
    const sp = ((await panel("state")).prompts || []).find((p) => /full control/i.test(p.title));
    if (sp) { await panel("approve", { id: sp.id }); return; }
    await tick(5);
  }
}

(async () => {
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = sent.find((m) => m.t === "hello"); }
  check("worker connects (challenge answered, hello sent)", !!hello);
  FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);

  // a normal pairing creates Chat A's session with tab 1
  const t1 = mkTab("https://shop.example.com/admin", { active: true });
  const req1 = await share(t1.id);
  FakeWS.last.deliver({ t: "paired", reqId: req1, sessionId: "sess-A", chatName: "Chat A" });
  await approveShare();
  await tick(30);
  check("fresh pairing owns tab 1", (await owner(t1.id)) === "Chat A");

  // attach: a second share's tab joins the SAME session
  const t2 = mkTab("https://crm.example.com/", { active: true });
  const req2 = await share(t2.id);
  let sn = sent.length;
  FakeWS.last.deliver({ t: "paired", reqId: req2, sessionId: "sess-A", chatName: "Chat A", attach: true });
  await approveShare();
  await tick(30);
  check("attach acks true (not session_exists)", acks(sn, "sess-A").some((m) => m.t === "paired_ack"), acks(sn, "sess-A"));
  check("the attached tab belongs to Chat A, with its pill", (await owner(t2.id)) === "Chat A" && F.pillOf[t2.id] === "Chat A");
  const sessA = (await F.sw(`local.get("sessions", {})`))["sess-A"];
  check("the session holds both tabs and both sites",
        sessA && Object.keys(sessA.tabs).length === 2 && sessA.sites["shop.example.com"] && sessA.sites["crm.example.com"], sessA);

  // attach refused when the tab moved: nack, session untouched, no revoke
  const t3 = mkTab("https://a.example.com/", { active: true });
  const req3 = await share(t3.id);
  setUrl(t3.id, "https://b.example.com/");
  sn = sent.length;
  FakeWS.last.deliver({ t: "paired", reqId: req3, sessionId: "sess-A", chatName: "Chat A", attach: true });
  await tick(30);
  const nack = acks(sn, "sess-A").find((m) => m.t === "paired_nack");
  check("attach to a moved tab is nacked with page_changed", !!nack && /^page_changed/.test(nack.error), nack);
  check("...the tab stays unshared and the session keeps its two tabs",
        !(await owner(t3.id)) && Object.keys((await F.sw(`local.get("sessions", {})`))["sess-A"].tabs).length === 2);
  check("...and no revoke for the live session was sent",
        !sent.slice(sn).some((m) => m.t === "revoke" && m.sessionId === "sess-A"));

  // attach naming a session this browser lost: falls through to a normal
  // pairing under the relay's id
  const t4 = mkTab("https://wiki.example.net/", { active: true });
  const req4 = await share(t4.id);
  sn = sent.length;
  FakeWS.last.deliver({ t: "paired", reqId: req4, sessionId: "sess-Z", chatName: "Chat Z", attach: true });
  await approveShare();
  await tick(30);
  check("attach for an unknown session heals as a fresh pairing under the relay's id",
        acks(sn, "sess-Z").some((m) => m.t === "paired_ack") && (await owner(t4.id)) === "Chat Z");

  // a NON-attach duplicate is still refused, exactly as before (SEC-22)
  const t5 = mkTab("https://dupe.example.com/", { active: true });
  const req5 = await share(t5.id);
  sn = sent.length;
  FakeWS.last.deliver({ t: "paired", reqId: req5, sessionId: "sess-A", chatName: "Chat A" });
  await tick(30);
  const dnack = acks(sn, "sess-A").find((m) => m.t === "paired_nack");
  check("a replayed paired without attach is still session_exists",
        !!dnack && /session_exists/.test(dnack.error) && !(await owner(t5.id)), dnack);

  // attach moves a tab OUT of another session under the existing transfer
  // rules: Daniel generated the code on Chat B's tab and gave it to Chat A.
  const t6 = mkTab("https://erp.example.com/", { active: true });
  const req6 = await share(t6.id);
  FakeWS.last.deliver({ t: "paired", reqId: req6, sessionId: "sess-B", chatName: "Chat B" });
  await approveShare();
  await tick(30);
  check("setup: tab 6 belongs to Chat B", (await owner(t6.id)) === "Chat B");
  const req7 = await share(t6.id);
  sn = sent.length;
  FakeWS.last.deliver({ t: "paired", reqId: req7, sessionId: "sess-A", chatName: "Chat A", attach: true });
  await approveShare();
  await tick(30);
  const sessB = (await F.sw(`local.get("sessions", {})`))["sess-B"];
  check("attaching a tab another chat owns transfers it (one tab, one session)",
        acks(sn, "sess-A").some((m) => m.t === "paired_ack") && (await owner(t6.id)) === "Chat A"
        && !sessB && F.pillOf[t6.id] === "Chat A",
        { owner: await owner(t6.id), sessB });
  check("...and the chat that lost its last tab is ended, not left at 0 tabs", !sessB, sessB);

  console.log(`\n${passes}/${passes + failures} passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
