/* Whole-stack test: real relay.py + real sw.js (fake chrome, REAL websocket)
 * + real agent/client.py. Proves the three speak the same protocol end to
 * end. Only chrome.* is faked; CDP input is covered by the live suite.
 *
 *   node test_stack.js      exit 0 = all passed
 */
"use strict";
const fs = require("fs");
const path = require("path");
const net = require("net");
const os = require("os");
const { spawn } = require("child_process");
const { install } = require("./fake_chrome");

const ROOT = path.join(__dirname, "..");
let passes = 0, failures = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log("PASS " + name); }
  else { failures++; console.log("FAIL " + name + (detail !== undefined ? "  -- " + JSON.stringify(detail).slice(0, 400) : "")); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

// STAGING-ONLY adaptations (as in MERGE-REPORT): the venv python stands in
// for the Windows `py -3` launcher, and the relay runs on the default ports
// because the merged worker always uses its built-in relay address.
const PY = process.env.MBB_PY || "/home/hatch/workspace/mbb-test/venv/bin/python";

(async () => {
  const wsPort = 19822, httpPort = 20822;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mbb-"));
  const relay = spawn(PY, [path.join(ROOT, "relay", "relay.py"), "--ws-port", String(wsPort),
                              "--http-port", String(httpPort), "--state", path.join(tmp, "state.json")], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((r) => { const c = net.connect(httpPort, "127.0.0.1", () => { c.end(); r(true); }); c.on("error", () => r(false)); });
    if (up) break; await tick(100);
  }
  const env = { ...process.env, MBB_RELAY: `http://127.0.0.1:${httpPort}` };
  delete env.MBB_TOKEN_FILE;
  // Each chat runs the client in its own working folder: that is where its token lives.
  const chatDir = (name) => { const d = path.join(tmp, "chats", name.replace(/\W+/g, "_")); fs.mkdirSync(d, { recursive: true }); return d; };
  const run = (cwd, args) => new Promise((resolve) => {
    const p = spawn(PY, [path.join(ROOT, "agent", "client.py"), ...args], { env, cwd });
    let out = ""; p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => { let j; try { j = JSON.parse(out.trim().split("\n").pop()); } catch (e) { j = { raw: out }; } j._exit = code; resolve(j); });
  });
  const as = (name, ...args) => run(chatDir(name), args);

  try {
    const F = install({ relayUrl: `ws://127.0.0.1:${wsPort}`, fakeSocket: false });
    const { tabs, mkTab, panel, page } = F;
    const owner = async (tabId) => {
      const all = await F.sw(`local.get("sessions", {})`);
      for (const v of Object.values(all)) if (v.tabs && Object.prototype.hasOwnProperty.call(v.tabs, String(tabId))) return v.chatName;
      return null;
    };

    let st;
    for (let i = 0; i < 100; i++) { st = await panel("state"); if (st.relay.connected) break; await tick(100); }
    check("extension connects to the real relay and is accepted", st.relay.connected, st.relay);

    const shareCode = async (url) => {
      const t = mkTab(url); for (const x of tabs.values()) x.active = x.id === t.id;
      const r = await panel("share", { tabId: t.id });
      let s; for (let i = 0; i < 100; i++) { s = await panel("state"); if (s.share && s.share.code) break; await tick(50); }
      return { tab: t, ok: r.ok, code: s.share && s.share.code };
    };

    // v2.7: a pair completes only on the ONE full-control confirmation
    // in the side panel — the relay waits for the extension's ack,
    // which follows the user's Allow. Drive it the way the user does.
    const confirmShare = async () => {
      for (let i = 0; i < 200; i++) {
        const sp = ((await panel("state")).prompts || []).find((p) => /full control/i.test(p.title));
        if (sp) { await panel("approve", { id: sp.id }); return true; }
        await tick(50);
      }
      return false;
    };
    const pairFlow = (name, code) => { const p = as(name, "pair", code, "--chat", name); return confirmShare().then(() => p); };

    const A = await shareCode("https://shop.example.com/admin");
    check("Share gets an 8-character code from the relay", A.ok && /^[A-Z2-9]{8}$/.test(A.code || ""), A);

    let r = await pairFlow("Chat A", A.code);
    check("chat pairs with the code through the client", r.ok === true && r._exit === 0, r);
    const sidA = r.sessionId;
    check("the token is saved in the chat's own working folder", fs.existsSync(path.join(chatDir("Chat A"), ".muse-bridge-token")));
    await tick(200);
    check("the paired page is the chat's tab, with its pill", (await owner(A.tab.id)) === "Chat A" && F.pillOf[A.tab.id] === "Chat A");

    r = await as("Chat X", "pair", A.code, "--chat", "Chat X");
    check("the same code cannot pair a second chat", r.ok === false && r.error === "bad_or_expired_code" && r._exit === 1, r);

    r = await as("Chat A", "tabs_context", "{}");
    check("chat A's command reaches the extension and returns its tab", r.ok && r.data.tabs.length === 1 && r.data.tabs[0].tabId === A.tab.id, r);

    const B = await shareCode("https://mail.example.org/");
    await pairFlow("Chat B", B.code);
    await tick(200);
    r = await as("Chat A", "get_page_text", JSON.stringify({ tabId: B.tab.id }));
    check("chat A cannot reach chat B's tab through the real relay", r.ok === false && r.error === "tab_not_shared", r);
    r = await as("Chat A", "get_page_text", JSON.stringify({ tabId: B.tab.id }), "--chat", "Chat B");
    check("naming another chat with --chat does not pick its token", r.ok === false && r.error === "tab_not_shared", r);
    r = await as("Chat B", "get_page_text", JSON.stringify({ tabId: B.tab.id }));
    check("chat B reads its own tab", r.ok && r.data.text === "page text here", r);

    // Attach-on-redeem (this replaces the shipped assertion "pairing into a
    // folder that already holds a live token is refused": that behaviour is
    // the one this change removes). A connected chat handed a fresh code
    // gets the tab added to its EXISTING session; token file untouched.
    const C = await shareCode("https://crm.example.com/");
    const tokFileA = path.join(chatDir("Chat A"), ".muse-bridge-token");
    const tokBefore = fs.readFileSync(tokFileA, "utf8");
    r = await pairFlow("Chat A", C.code);
    check("a connected chat redeeming a new code attaches to its session",
          r.ok === true && r.attached === true && r.sessionId === sidA && r._exit === 0, r);
    check("...its token file is unchanged", fs.readFileSync(tokFileA, "utf8") === tokBefore);
    await tick(200);
    check("...the new tab is Chat A's, with its pill", (await owner(C.tab.id)) === "Chat A" && F.pillOf[C.tab.id] === "Chat A");
    r = await as("Chat A", "tabs_context", "{}");
    check("...and the one session now holds both tabs",
          r.ok && r.data.tabs.length === 2 && r.data.tabs.some((t) => t.tabId === C.tab.id), r);
    r = await as("Chat B", "get_page_text", JSON.stringify({ tabId: C.tab.id }));
    check("...while chat B still cannot reach the attached tab", r.ok === false && r.error === "tab_not_shared", r);
    r = await as("Chat A", "pair", C.code, "--chat", "Chat A");
    check("the attached code is single-use too", r.ok === false && r.error === "bad_or_expired_code", r);
    const D = await shareCode("https://wiki.example.net/");
    const dP = run(chatDir("Chat A"), ["pair", D.code, "--chat", "Chat C", "--token-file", path.join(chatDir("Chat A"), "c.token")]);
    await confirmShare();
    r = await dP;
    check("...a chat can still pair fresh into its own --token-file", r.ok === true && !r.attached, r);

    r = await as("Chat A", "set_policy", JSON.stringify({ host: "x", policy: "allow" }));
    check("no policy backdoor through the whole stack", r.ok === false && r.error === "unknown_action", r);
    r = await as("Chat A", "computer", JSON.stringify({ action: "key", text: "nokey+x" }));
    check("error details reach the chat (bad_key: nokey+x)", r.ok === false && r.error === "bad_key" && /nokey/.test(r.detail || ""), r);
    r = await as("Chat A", "read_page", "{not json");
    check("bad JSON arguments -> bad_json, exit 2", r.error === "bad_json" && r._exit === 2, r);

    // new site: under v2.7 the chat does NOT wait on a side-panel
    // answer — the share was the consent. The navigate completes at
    // once, in a tab of the chat's own, and the site's first use is
    // written to the panel's event record.
    r = await as("Chat A", "navigate", JSON.stringify({ url: "https://docs.example.io/" }));
    check("a new site opens with no prompt in the side panel", r.ok && (await panel("state")).prompts.length === 0, r);
    check("the chat's navigate completes in a tab of its own", r.ok && (await owner(r.data.tabId)) === "Chat A", r);
    const navEv = (await panel("state")).audit.filter((x) => x.action === "site allowed" && /docs\.example\.io/.test(x.detail));
    check("...and the new site's first use is in the event record",
          navEv.length === 1 && navEv[0].outcome === "no prompt: full control", navEv);

    // screenshots become files, each with its own name, also inside a batch
    r = await as("Chat A", "screenshot", JSON.stringify({ tabId: A.tab.id }));
    const r2 = await as("Chat A", "browser_batch", JSON.stringify({ actions: [
      { name: "screenshot", input: { tabId: A.tab.id } }, { name: "screenshot", input: { tabId: A.tab.id } }] }));
    const files = [r.data && r.data.image, ...((r2.data && r2.data.results) || []).map((x) => x.data && x.data.image)];
    check("every screenshot is saved to its own file, inside a batch too",
          files.length === 3 && files.every((f) => f && fs.existsSync(f)) && new Set(files).size === 3, files);

    // long answers go to a file, never cut mid-JSON
    page.text = () => "word ".repeat(30000);
    r = await as("Chat A", "get_page_text", JSON.stringify({ tabId: A.tab.id }));
    const full = r.outputFile && JSON.parse(fs.readFileSync(r.outputFile, "utf8"));
    check("a long answer is written whole to a file", r.ok && full && full.data.text.length === 150000, r);
    page.text = () => "page text here";

    r = await as("Chat A", "status");
    check("status shows the chat's own session, device online", r.ok && r.chatName === "Chat A" && r.deviceOnline === true, r);

    r = await as("Chat A", "disconnect");
    await tick(200);
    check("chat disconnects itself", r.ok === true);
    check("its tabs are released and lose the pill", !(await owner(A.tab.id)) && !F.pillOf[A.tab.id]);
    r = await as("Chat A", "tabs_context", "{}");
    check("a disconnected chat has no token left", r.ok === false && r.error === "not_paired" && r._exit === 1, r);
    r = await as("Chat A", "status");
    check("status without a token exits 1", r._exit === 1, r);
    r = await as("Chat B", "tabs_context", "{}");
    check("the other chat keeps working", r.ok && r.data.tabs.length === 1, r);
  } finally {
    relay.kill();
  }
  console.log(`\n${passes}/${passes + failures} passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
