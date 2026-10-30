/* v2.8 stage B: input primitives at Claude in Chrome parity.
 *  - type sends one real keyDown/keyUp pair per mappable character
 *    (shift state included), Enter for newlines, and falls back to
 *    Input.insertText only for a character with no key;
 *  - computer gains hold_key, mouse_move, left_mouse_down /
 *    left_mouse_up, middle_click and cursor_position;
 *  - focus emulation mutes a background tab it works on (and only a
 *    tab we muted is ever unmuted: on activation, on detach).
 *
 *   node test_extension_input2.js     exit 0 = all passed
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
const { tabs, sent, inputs, E, page, mkTab, FakeWS, panel } = F;

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
const delivered = () => inputs.reduce((n, i) => n +
  (i.method === "Input.insertText" ? (i.params.text || "").length
   : i.method === "Input.dispatchKeyEvent" && i.params.type !== "keyUp" ? (i.params.text || "").length : 0), 0);
const keyEvents = () => inputs.filter((i) => i.method === "Input.dispatchKeyEvent");
const mouseEvents = () => inputs.filter((i) => i.method === "Input.dispatchMouseEvent");

(async () => {
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = sent.find((m) => m.t === "hello"); }
  FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);

  const A = await pair("https://shop.example.com/form", "Chat A");
  const T = A.tab.id;
  page.focus = () => ({ kind: "element", tag: "input", isField: true, fp: "input|q", len: delivered() });

  /* ---- per-character typing ---- */
  inputs.length = 0;
  let r = await cmd(A.sid, "computer", { action: "type", text: "Hi!", tabId: T });
  let ke = keyEvents();
  check("type 'Hi!' succeeds", r.ok, r);
  check("type sends a keyDown+keyUp pair per character, no insertText for mappable characters",
        ke.length === 6 && inputs.every((i) => i.method !== "Input.insertText"), ke.map((i) => [i.params.type, i.params.key]));
  check("an uppercase character carries the shift modifier and its Key code",
        ke[0].params.key === "H" && ke[0].params.code === "KeyH" && ke[0].params.modifiers === 8 && ke[0].params.text === "H", ke[0] && ke[0].params);
  check("a lowercase character carries no modifier",
        ke[2].params.key === "i" && ke[2].params.modifiers === 0, ke[2] && ke[2].params);
  check("'!' rides the Digit1 key with shift",
        ke[4].params.code === "Digit1" && ke[4].params.modifiers === 8 && ke[4].params.text === "!", ke[4] && ke[4].params);

  inputs.length = 0;
  r = await cmd(A.sid, "computer", { action: "type", text: "a b\tc\nd", tabId: T });
  ke = keyEvents();
  check("space types as the Space key, Tab as a raw key, newline as Enter",
        r.ok && ke.some((i) => i.params.code === "Space" && i.params.text === " ") &&
        ke.some((i) => i.params.code === "Tab" && i.params.type === "rawKeyDown") &&
        ke.some((i) => i.params.code === "Enter"), ke.map((i) => [i.params.type, i.params.code]));

  inputs.length = 0;
  r = await cmd(A.sid, "computer", { action: "type", text: "→", tabId: T });
  check("a character with no key falls back to insertText for that character only",
        r.ok && inputs.length === 1 && inputs[0].method === "Input.insertText" && inputs[0].params.text === "→", inputs);

  /* ---- hold_key ---- */
  inputs.length = 0;
  const t0 = Date.now();
  r = await cmd(A.sid, "computer", { action: "hold_key", text: "Shift", duration: 0.3, tabId: T });
  const heldMs = Date.now() - t0;
  ke = keyEvents();
  check("hold_key presses, waits, then releases",
        r.ok && ke.length === 2 && ke[0].params.type !== "keyUp" && ke[1].params.type === "keyUp" && heldMs >= 250, { r, heldMs, ke: ke.map((i) => i.params.type) });
  inputs.length = 0;
  r = await cmd(A.sid, "computer", { action: "hold_key", text: "ctrl+a", duration: 0.1, tabId: T });
  ke = keyEvents();
  check("hold_key with a chord holds the key with its modifier mask",
        r.ok && ke.some((i) => i.params.key === "a" && (i.params.modifiers & 2)), ke.map((i) => i.params));

  /* ---- mouse primitives ---- */
  inputs.length = 0;
  r = await cmd(A.sid, "computer", { action: "cursor_position", tabId: T });
  check("cursor_position before any move answers no_cursor_position", !r.ok && r.error === "no_cursor_position", r);
  r = await cmd(A.sid, "computer", { action: "mouse_move", coordinate: [40, 50], tabId: T });
  check("mouse_move sends a move and no press",
        r.ok && mouseEvents().length === 1 && mouseEvents()[0].params.type === "mouseMoved", mouseEvents().map((i) => i.params.type));
  r = await cmd(A.sid, "computer", { action: "cursor_position", tabId: T });
  check("cursor_position reports the last point", r.ok && r.data.x === 40 && r.data.y === 50, r);
  inputs.length = 0;
  page.point = () => ({ tag: "div", text: "", fp: "div|plain" });
  r = await cmd(A.sid, "computer", { action: "left_mouse_down", coordinate: [10, 10], tabId: T });
  const downOk = r.ok && mouseEvents().some((i) => i.params.type === "mousePressed" && i.params.buttons === 1) &&
                 !mouseEvents().some((i) => i.params.type === "mouseReleased");
  r = await cmd(A.sid, "computer", { action: "left_mouse_up", coordinate: [10, 10], tabId: T });
  check("left_mouse_down and left_mouse_up are separate primitives",
        downOk && r.ok && mouseEvents().some((i) => i.params.type === "mouseReleased" && i.params.buttons === 0), mouseEvents().map((i) => i.params.type));
  inputs.length = 0;
  r = await cmd(A.sid, "computer", { action: "middle_click", coordinate: [10, 10], tabId: T });
  check("middle_click presses the middle button",
        r.ok && mouseEvents().some((i) => i.params.type === "mousePressed" && i.params.button === "middle"), mouseEvents().map((i) => i.params));

  /* ---- focus-emulation mute parity ---- */
  // Foreground tab: never muted.
  check("the foreground tab is not muted by focus emulation", tabs.get(T).mutedInfo.muted === false, tabs.get(T).mutedInfo);
  // A background tab the chat types into gets muted by us...
  let r2 = await cmd(A.sid, "navigate", { url: "https://shop.example.com/other" });
  const bg = r2.data.tabId;
  tabs.get(bg).active = false;
  page.focus = () => ({ kind: "element", tag: "input", isField: true, fp: "input|q", len: delivered() });
  r = await cmd(A.sid, "computer", { action: "type", text: "x", tabId: bg });
  await tick(20);
  check("a background tab worked under focus emulation is muted by the bridge",
        r.ok && tabs.get(bg).mutedInfo.muted === true, { r, muted: tabs.get(bg).mutedInfo });
  // ...and activating it (the user looking at it) lifts our mute.
  E.tabsActivated.fire({ tabId: bg, windowId: 1 });
  await tick(20);
  check("activating the tab lifts the bridge's mute", tabs.get(bg).mutedInfo.muted === false, tabs.get(bg).mutedInfo);
  // A tab the USER muted is never unmuted or re-muted by us.
  tabs.get(bg).mutedInfo.muted = true;
  tabs.get(bg).active = false;
  r = await cmd(A.sid, "computer", { action: "type", text: "y", tabId: bg });
  await tick(20);
  E.tabsActivated.fire({ tabId: bg, windowId: 1 });
  await tick(20);
  check("a user-muted tab stays muted (we only lift our own mute)",
        r.ok && tabs.get(bg).mutedInfo.muted === true, tabs.get(bg).mutedInfo);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
