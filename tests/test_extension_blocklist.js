/* v2.8 stage F: site blocklist (FULL-GAP §3) — the MECHANISM at
 * Claude parity, with the data empty by design.
 *  - the pattern matcher is their Nt, ported exactly;
 *  - managed blockedUrlPatterns (chrome.storage.managed) refuse a
 *    site: the command fails site_blocked and the tab is sent to
 *    the blocked page; a navigation onto one is redirected as soon
 *    as it is seen;
 *  - a local category map (storage.local "siteCategories") refuses
 *    hosts in category 1 or 2 the same way;
 *  - with both empty (the shipped state), nothing is blocked.
 *
 *   node test_extension_blocklist.js     exit 0 = all passed
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
const { tabs, sent, E, mkTab, setUrl, FakeWS, panel, managedStore } = F;

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
const isBlockedPage = (tabId) => (tabs.get(tabId).url || "").includes("blocked.html");

(async () => {
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = sent.find((m) => m.t === "hello"); }
  FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);

  /* ---- the matcher, against their semantics ---- */
  const M = (u, p) => F.sw(`P.matchBlockedPattern(${JSON.stringify(u)}, ${JSON.stringify(p)})`);
  check("matcher: a bare domain covers its whole site, www and case aside",
        M("https://www.Example.com/Admin/", "example.com") === true && M("https://example.com", "https://example.com/") === true);
  check("matcher: a bare domain does NOT cover subdomains or lookalike hosts",
        M("https://sub.example.com/x", "example.com") === false && M("https://example.com.evil.com/", "example.com") === false);
  check("matcher: wildcards cross path segments; a path pattern anchors the path",
        M("https://example.com/a/b/c", "example.com/a/*") === true && M("https://example.com/b", "example.com/a/*") === false);
  check("matcher: a trailing dot on the host is ignored on both sides",
        M("https://example.com./x", "example.com.") === true);

  const A = await pair("https://shop.example.com/form", "Chat A");
  const T = A.tab.id;

  /* ---- shipped state: nothing is blocked ---- */
  let r = await cmd(A.sid, "navigate", { url: "https://freely.example.com/page" });
  check("with the shipped (empty) lists, any site navigates normally", r.ok && !isBlockedPage(r.data.tabId), r);
  const T2 = r.data.tabId;

  /* ---- managed pattern enforcement ---- */
  managedStore.blockedUrlPatterns = ["evil.example.net"];
  await F.sw(`managedPatternsCache = null`);
  r = await cmd(A.sid, "navigate", { url: "https://shop.example.com/home" });
  const T3 = r.data.tabId;
  setUrl(T3, "https://evil.example.net/landing");
  await tick(40);
  check("a navigation onto a managed-pattern site is redirected to the blocked page at once",
        isBlockedPage(T3), tabs.get(T3).url);
  r = await cmd(A.sid, "get_page_text", { tabId: T3 });
  check("the blocked page itself is not a readable web page for the chat", !r.ok, r);
  // Direct enforcement at command time: put the tab on the blocked
  // URL without firing a navigation event, so only resolveTab's own
  // check can refuse it.
  managedStore.blockedUrlPatterns = ["shop.example.com/home"];
  await F.sw(`managedPatternsCache = null`);
  tabs.get(T3).url = "https://shop.example.com/home";
  r = await cmd(A.sid, "get_page_text", { tabId: T3 });
  check("a command on a pattern-blocked page fails site_blocked and redirects the tab",
        !r.ok && r.error === "site_blocked" && isBlockedPage(T3), { r, url: tabs.get(T3).url });
  managedStore.blockedUrlPatterns = [];
  await F.sw(`managedPatternsCache = null`);

  /* ---- category enforcement ---- */
  await F.sw(`local.set("siteCategories", { "bad.example.org": 1, "worse.example.org": 2, "fine.example.org": 3 })`);
  r = await cmd(A.sid, "navigate", { url: "https://shop.example.com/start" });
  const T4 = r.data.tabId;
  setUrl(T4, "https://bad.example.org/");
  await tick(40);
  check("a category 1 host is redirected on sight", isBlockedPage(T4), tabs.get(T4).url);
  tabs.get(T4).url = "https://worse.example.org/deep"; // no event: command-time check only
  r = await cmd(A.sid, "get_page_text", { tabId: T4 });
  check("a category 2 host fails commands with site_blocked", !r.ok && r.error === "site_blocked" && isBlockedPage(T4), { r, url: tabs.get(T4).url });
  setUrl(T4, "https://fine.example.org/");
  await tick(40);
  r = await cmd(A.sid, "get_page_text", { tabId: T4 });
  check("a category 3 host is NOT blocked (only 1 and 2 refuse)", r.ok && !isBlockedPage(T4), r);
  await F.sw(`local.set("siteCategories", {})`);

  /* ---- the refusal is in the event record ---- */
  const st = await panel("state");
  check("blocked refusals are written to the event record",
        st.audit.some((e) => /site blocked/i.test(e.action || "")), st.audit.slice(0, 4).map((e) => e.action));

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
