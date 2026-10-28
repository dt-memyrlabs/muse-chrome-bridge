/* v2.8 stage I: GIF recording (FULL-GAP §7).
 *  - while a chat records, its computer / navigate / screenshot
 *    actions each leave a frame (the first at start, the last at
 *    stop), capped at 50;
 *  - frames carry the action that made them (type + coordinates) for
 *    the exporter's overlays;
 *  - export hands the frames to the offscreen GENERATE_GIF encoder
 *    and returns its data URL; clear empties the take.
 *  (Real gif.js encoding is exercised in real Chrome, not the fake:
 *  the harness answers GENERATE_GIF with a canned encoder reply.)
 *
 *   node test_extension_gif.js     exit 0 = all passed
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
const { tabs, sent, page, mkTab, FakeWS, panel, gifBox } = F;

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

(async () => {
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = sent.find((m) => m.t === "hello"); }
  FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);

  const A = await pair("https://shop.example.com/form", "Chat A");
  const T = A.tab.id;
  page.point = () => ({ tag: "div", text: "", fp: "div|plain" });

  let r = await cmd(A.sid, "gif_creator", { action: "export" });
  check("export with nothing recorded fails no_frames", !r.ok && r.error === "no_frames", r);
  r = await cmd(A.sid, "gif_creator", { action: "bogus" });
  check("an unknown gif action is refused", !r.ok && r.error === "unknown_action", r);

  r = await cmd(A.sid, "gif_creator", { action: "start_recording", tabId: T });
  check("start_recording takes an initial frame", r.ok && r.data.recording === true && r.data.frames === 1, r);
  r = await cmd(A.sid, "computer", { action: "left_click", coordinate: [40, 50], tabId: T });
  check("the click itself still works while recording", r.ok, r);
  r = await cmd(A.sid, "computer", { action: "left_click_drag", start_coordinate: [10, 10], coordinate: [90, 90], tabId: T });
  check("a drag works while recording", r.ok, r);
  r = await cmd(A.sid, "screenshot", { tabId: T });
  check("a screenshot works while recording", r.ok, r);
  r = await cmd(A.sid, "tabs_context", {});
  check("unframed tools (tabs_context) do not add frames — verified at export below", r.ok, r);
  r = await cmd(A.sid, "gif_creator", { action: "stop_recording", tabId: T });
  check("stop_recording adds a final frame: 1 start + click + drag + screenshot + 1 stop = 5",
        r.ok && r.data.recording === false && r.data.frames === 5, r);

  r = await cmd(A.sid, "gif_creator", { action: "export" });
  const msg = gifBox.lastMsg;
  check("export returns the encoder's GIF data URL",
        r.ok && /^data:image\/gif;base64,/.test(r.data.gif || "") && r.data.frames === 5, r.data && Object.keys(r.data));
  check("the encoder was handed every frame with its action for the overlays",
        !!msg && msg.frames.length === 5 &&
        msg.frames[1].action.type === "left_click" && msg.frames[1].action.coordinate.join() === "40,50" &&
        msg.frames[2].action.start_coordinate.join() === "10,10",
        msg && msg.frames.map((f) => f.action));
  r = await cmd(A.sid, "computer", { action: "left_click", coordinate: [1, 1], tabId: T });
  r = await cmd(A.sid, "gif_creator", { action: "export" });
  check("frames stay at 5 after recording stopped", r.ok && r.data.frames === 5, r.data);

  /* ---- other chats do not record into this take ---- */
  const B = await pair("https://news.example.net/", "Chat B");
  r = await cmd(B.sid, "gif_creator", { action: "export" });
  check("recording is per chat: the other chat has no frames", !r.ok && r.error === "no_frames", r);

  /* ---- clear ---- */
  r = await cmd(A.sid, "gif_creator", { action: "clear" });
  check("clear empties the take", r.ok && r.data.frames === 0, r);
  r = await cmd(A.sid, "gif_creator", { action: "export" });
  check("after clear, export fails no_frames again", !r.ok && r.error === "no_frames", r);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
