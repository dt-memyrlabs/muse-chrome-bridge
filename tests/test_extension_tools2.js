/* v2.8 stage C: read / utility tools at Claude in Chrome parity.
 *  - per-tab console + network capture (bounded, reset on domain
 *    change), read back with pattern / errors-only filters;
 *  - resize_window with Claude's bounds;
 *  - upload_image: captured screenshots dropped back onto the page
 *    by id; local paths go through the file_upload machinery;
 *  - update_plan records the plan and permits its domains;
 *  - shortcuts_list / shortcuts_execute over the saved-prompt store;
 *  - javascript_tool present but DISABLED until enabled in the panel.
 *
 *   node test_extension_tools2.js     exit 0 = all passed
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
const { tabs, sent, inputs, cdpLog, E, mkTab, setUrl, FakeWS, panel, evalBox, windowSizes } = F;

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
const dbg = (tabId, method, params) => E.dbgEvent.fire({ tabId }, method, params);

(async () => {
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = sent.find((m) => m.t === "hello"); }
  FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);

  const A = await pair("https://shop.example.com/form", "Chat A");
  const T = A.tab.id;

  /* ---- console capture ---- */
  let r;
  dbg(T, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "hello" }, { value: "world" }], timestamp: 1000 });
  dbg(T, "Runtime.consoleAPICalled", { type: "error", args: [{ description: "boom happened" }], timestamp: 900 });
  dbg(T, "Runtime.exceptionThrown", { timestamp: 1100, exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: x is null" }, url: "https://shop.example.com/app.js", lineNumber: 12 } });
  await tick(30);
  r = await cmd(A.sid, "read_console_messages", { tabId: T });
  check("console messages are captured with joined argument text",
        r.ok && r.data.messages.length === 3 && r.data.messages[0].text === "hello world", r.data);
  check("console timestamps never run backwards (clamped monotonic)",
        r.ok && r.data.messages[1].timestamp >= r.data.messages[0].timestamp, r.data && r.data.messages.map((m) => m.timestamp));
  check("an exception is captured with its source position",
        r.ok && r.data.messages[2].type === "exception" && /TypeError/.test(r.data.messages[2].text) && r.data.messages[2].lineNumber === 12, r.data && r.data.messages[2]);
  r = await cmd(A.sid, "read_console_messages", { tabId: T, errors_only: true });
  check("errors_only keeps errors and exceptions, drops logs",
        r.ok && r.data.messages.length === 2 && r.data.messages.every((m) => m.type === "error" || m.type === "exception"), r.data);
  r = await cmd(A.sid, "read_console_messages", { tabId: T, pattern: "boom|hello" });
  check("a pattern filters by regular expression", r.ok && r.data.messages.length === 2, r.data);
  r = await cmd(A.sid, "read_console_messages", { tabId: T, pattern: "boom (" });
  check("an invalid pattern falls back to plain text instead of failing", r.ok && r.data.messages.length === 0, r);
  setUrl(T, "https://other.example.org/page");
  dbg(T, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "fresh domain" }], timestamp: 2000 });
  await tick(30);
  r = await cmd(A.sid, "read_console_messages", { tabId: T });
  check("the console buffer resets when the tab's domain changes",
        r.ok && r.data.messages.length === 1 && r.data.messages[0].text === "fresh domain", r.data);
  setUrl(T, "https://shop.example.com/form");

  /* ---- network capture ---- */
  dbg(T, "Network.requestWillBeSent", { requestId: "r1", request: { url: "https://shop.example.com/api/items", method: "GET" }, timestamp: 5 });
  dbg(T, "Network.responseReceived", { requestId: "r1", response: { status: 200, mimeType: "application/json" } });
  dbg(T, "Network.requestWillBeSent", { requestId: "r2", request: { url: "https://shop.example.com/api/save", method: "POST" }, timestamp: 6 });
  dbg(T, "Network.loadingFailed", { requestId: "r2", errorText: "net::ERR_FAILED" });
  await tick(30);
  r = await cmd(A.sid, "read_network_requests", { tabId: T });
  check("network requests are captured with method and final status",
        r.ok && r.data.requests.length === 2 && r.data.requests[0].status === 200 && r.data.requests[0].method === "GET", r.data);
  check("a failed load is recorded as status 503 (Claude's convention)",
        r.ok && r.data.requests[1].status === 503, r.data && r.data.requests[1]);
  r = await cmd(A.sid, "read_network_requests", { tabId: T, url_pattern: "/api/save" });
  check("url_pattern filters the request list", r.ok && r.data.requests.length === 1 && /save/.test(r.data.requests[0].url), r.data);

  /* ---- resize_window ---- */
  r = await cmd(A.sid, "resize_window", { tabId: T, width: 1024.7, height: 700 });
  check("resize_window floors and applies the size",
        r.ok && r.data.width === 1024 && windowSizes[1] && windowSizes[1].width === 1024 && windowSizes[1].height === 700, { r, windowSizes });
  r = await cmd(A.sid, "resize_window", { tabId: T, width: 0, height: 700 });
  check("resize_window refuses a non-positive size", !r.ok && r.error === "bad_size", r);
  r = await cmd(A.sid, "resize_window", { tabId: T, width: 8000, height: 700 });
  check("resize_window refuses beyond 8K", !r.ok && r.error === "bad_size", r);

  /* ---- javascript_tool: disabled by default ---- */
  r = await cmd(A.sid, "javascript_tool", { action: "javascript_exec", text: "1+1", tabId: T });
  check("javascript_tool refuses with javascript_disabled by default", !r.ok && r.error === "javascript_disabled", r);
  check("a disabled javascript_tool never reaches Runtime.evaluate",
        !cdpLog.some((c) => c.method === "Runtime.evaluate"), cdpLog.map((c) => c.method));
  await F.sw(`local.set("javascriptEnabled", true)`);
  evalBox.result = { result: { value: 42 } };
  r = await cmd(A.sid, "javascript_tool", { action: "javascript_exec", text: "6*7", tabId: T });
  check("once enabled in the panel, javascript_tool returns the value", r.ok && r.data.output === "42", r);
  evalBox.result = { exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: nope is not defined" } } };
  r = await cmd(A.sid, "javascript_tool", { action: "javascript_exec", text: "nope", tabId: T });
  check("a page exception comes back as javascript_error", !r.ok && r.error === "javascript_error" && /ReferenceError/.test(r.detail || ""), r);
  evalBox.result = null;
  await F.sw(`local.set("javascriptEnabled", false)`);

  /* ---- update_plan ---- */
  r = await cmd(A.sid, "update_plan", { domains: "github.com" });
  check("update_plan validates its arrays", !r.ok && r.error === "bad_plan", r);
  r = await cmd(A.sid, "update_plan", { domains: ["github.com", "docs.example.com"], approach: ["Read the issue", "Fix it"] });
  const st = await panel("state");
  const chat = st.chats.find((c) => c.sessionId === A.sid);
  check("update_plan is recorded and its domains become permitted sites",
        r.ok && r.data.recorded === true && chat && chat.plan && chat.plan.domains.length === 2 &&
        chat.sites.includes("github.com") && chat.sites.includes("docs.example.com"),
        { r, plan: chat && chat.plan, sites: chat && chat.sites });

  /* ---- shortcuts over the saved-prompt store ---- */
  await F.sw(`setSavedPrompts([{ id: "prompt_1", name: "Daily check", prompt: "Check the dashboard and report.", command: "daily", createdAt: 1, usageCount: 0, lastUsedAt: null, url: "https://shop.example.com/", repeatType: "none" }])`);
  r = await cmd(A.sid, "shortcuts_list", {});
  check("shortcuts_list shows the saved prompts",
        r.ok && r.data.shortcuts.length === 1 && r.data.shortcuts[0].command === "daily", r.data);
  r = await cmd(A.sid, "shortcuts_execute", { command: "/daily" });
  check("shortcuts_execute hands the prompt text to the calling chat",
        r.ok && r.data.prompt === "Check the dashboard and report." && r.data.command === "daily", r);
  r = await cmd(A.sid, "shortcuts_list", {});
  check("executing records the usage", r.ok && r.data.shortcuts[0].usageCount === 1 && !!r.data.shortcuts[0].lastUsedAt, r.data);
  r = await cmd(A.sid, "shortcuts_execute", { shortcutId: "prompt_nope" });
  check("an unknown shortcut answers no_such_shortcut", !r.ok && r.error === "no_such_shortcut", r);
  await F.sw(`setSavedPrompts([])`);

  /* ---- upload_image ---- */
  r = await cmd(A.sid, "screenshot", { tabId: T });
  check("attach enables Runtime and Network on the debugger session",
        cdpLog.some((c) => c.tabId === T && c.method === "Runtime.enable") &&
        cdpLog.some((c) => c.tabId === T && c.method === "Network.enable"),
        cdpLog.filter((c) => c.tabId === T).map((c) => c.method));
  const imageId = r.ok && r.data.imageId;
  check("a screenshot result carries an imageId for upload_image", !!imageId, r.data && Object.keys(r.data));
  inputs.length = 0;
  r = await cmd(A.sid, "upload_image", { imageId, coordinate: [30, 40], tabId: T });
  const drags = inputs.filter((i) => i.method === "Input.dispatchDragEvent");
  check("upload_image drops the captured image at the point (enter / over / drop)",
        r.ok && drags.map((d) => d.params.type).join() === "dragEnter,dragOver,drop" &&
        drags[2].params.data.items[0].mimeType === "image/png" && typeof drags[2].params.data.items[0].data === "string",
        { r, drags: drags.map((d) => d.params.type) });
  r = await cmd(A.sid, "upload_image", { imageId: "img_9999", coordinate: [1, 1], tabId: T });
  check("an unknown imageId answers no_such_image", !r.ok && r.error === "no_such_image", r);
  r = await cmd(A.sid, "upload_image", { filePath: "C:\\Users\\danie\\.ssh\\id_rsa", ref: "e1", tabId: T });
  check("upload_image with a credential path is refused by the upload wall", !r.ok && r.error === "upload_blocked", r);
  r = await cmd(A.sid, "upload_image", { filePath: "C:\\pics\\cat.png", tabId: T });
  check("upload_image with a path but no target answers no_target", !r.ok && r.error === "no_target", r);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
