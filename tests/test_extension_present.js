/* The visible-behavior layer: an on-page cursor that glides and pulses
 * before a press, animated scrolling that brings an off-screen target
 * into view before its point is read, and the side panel's live view of
 * the tab a chat is working — captured only while it works, only of its
 * own tab in front, and never of a page the screenshot gate calls
 * sensitive. Also: unsharing a tab takes the cursor away with the pill,
 * and no cursor ever lands on a tab the chat does not own.
 *
 *   node test_extension_present.js     exit 0 = all passed
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
const { tabs, sent, inputs, cdpLog, page, mkTab, FakeWS, panel } = F;
const cursorOf = (id) => F.cursorOf[id];
const presses = () => inputs.filter((i) => i.method === "Input.dispatchMouseEvent" && i.params.type === "mousePressed");

let cmdSeq = 0;
function cmdStart(sessionId, action, args) {
  const id = "c" + (++cmdSeq);
  FakeWS.last.deliver({ t: "cmd", id, sessionId, action, args: args || {}, ttlMs: 120000 });
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
const cmd = (sid, action, args) => result(cmdStart(sid, action, args));
async function share(tabId) {
  await panel("share", { tabId });
  const req = sent.filter((m) => m.t === "pair_request").pop();
  FakeWS.last.deliver({ t: "pair_code", reqId: req.reqId, code: "ABCD2345", expiresIn: 300 });
  await tick(10);
  return req.reqId;
}
// v2.7: a share lands only on the ONE full-control confirmation.
async function approveShare() {
  for (let i = 0; i < 200; i++) {
    const sp = ((await panel("state")).prompts || []).find((p) => /full control/i.test(p.title));
    if (sp) { await panel("approve", { id: sp.id }); return; }
    await tick(5);
  }
}
async function pair(tabId, sid, name) {
  const req = await share(tabId);
  FakeWS.last.deliver({ t: "paired", reqId: req, sessionId: sid, chatName: name });
  await approveShare();
  await tick(30);
}
const chatState = async (sid) => (await panel("state")).chats.find((c) => c.sessionId === sid);

(async () => {
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = sent.find((m) => m.t === "hello"); }
  check("worker connects (challenge answered, hello sent)", !!hello);
  FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);

  const T = mkTab("https://shop.example.com/admin", { active: true }).id;
  await pair(T, "sess-A", "Chat A");
  check("the cursor script rides in with the pill (warmed, nothing shown yet)",
        !!cursorOf(T) && cursorOf(T).op === "warm" && F.pillOf[T] === "Chat A", cursorOf(T));

  // a plain coordinate click: cursor glides there and pulses, then the press
  let r = await cmd("sess-A", "computer", { action: "left_click", coordinate: [100, 120], tabId: T });
  const go = cursorOf(T);
  check("a click sends the cursor to the point with a pulse",
        r.ok && !!go && go.op === "go" && go.x === 100 && go.y === 120 && go.pulse === true, { r, go });
  check("...and the press itself still lands at the point",
        presses().some((p) => p.tabId === T && p.params.x === 100 && p.params.y === 120), presses());

  // hover: the hand travels, no pulse
  r = await cmd("sess-A", "computer", { action: "hover", coordinate: [40, 50], tabId: T });
  const hov = cursorOf(T);
  check("a hover glides the cursor without a pulse",
        r.ok && !!hov && hov.op === "go" && hov.x === 40 && hov.y === 50 && hov.pulse === false, { r, hov });

  // the live view: while the chat works, the panel gains a picture of its tab
  let view = null;
  for (let i = 0; i < 160 && !view; i++) { const c = await chatState("sess-A"); if (c && c.view && c.view.image) view = c.view; else await tick(25); }
  check("the panel's live view shows the working tab's picture",
        !!view && view.tabId === T && /^data:image\/jpeg;base64,/.test(view.image) && F.captures.length >= 1,
        view ? { ...view, image: String(view.image).slice(0, 30) } : view);

  // a page with a password field is never photographed for the view
  page.fields = () => [{ name: "pw", type: "password", value: "(hidden)", isPassword: true, autocomplete: "current-password" }];
  const capBefore = F.captures.length;
  const didBlock = await F.sw(`captureLiveView("sess-A", ${T})`);
  const blockedState = await chatState("sess-A");
  check("a password page blocks the live view instead of being photographed",
        didBlock === true && F.captures.length === capBefore &&
        !!blockedState.view && blockedState.view.blocked === "a password field" && !blockedState.view.image,
        blockedState && blockedState.view);
  page.fields = () => [];

  // capture refuses a tab in the background and a tab owned by another chat
  tabs.get(T).active = false;
  check("no capture of a background tab", (await F.sw(`captureLiveView("sess-A", ${T})`)) === false);
  tabs.get(T).active = true;
  const T2 = mkTab("https://crm.example.com/", { active: true }).id;
  await pair(T2, "sess-B", "Chat B");
  check("no capture of another chat's tab", (await F.sw(`captureLiveView("sess-A", ${T2})`)) === false);

  // an unshared tab never gets a cursor, and a command against it is refused
  const T3 = mkTab("https://elsewhere.example.com/", { active: true }).id;
  r = await cmd("sess-A", "computer", { action: "left_click", coordinate: [10, 10], tabId: T3 });
  check("a click on an unshared tab is refused and shows no cursor there",
        !r.ok && cursorOf(T3) === undefined, { r, c: cursorOf(T3) });

  // an off-screen element: the page scrolls (animated) BEFORE the click,
  // and the press lands at the element's rested centre on screen
  page.ax[T] = [{ nodeId: "1", role: { value: "RootWebArea" }, name: { value: "" }, childIds: ["2"], backendDOMNodeId: 1 },
                { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Save" }, backendDOMNodeId: 2 }];
  r = await cmd("sess-A", "read_page", { tabId: T });
  const saveRef = r.ok && (r.data.tree.match(/button "Save" \[(ref_\d+)\]/) || [])[1];
  check("setup: read_page gives the button a ref", !!saveRef, r.data && r.data.tree);
  const OFF = [[10, 900, 30, 900, 30, 920, 10, 920]];   // centre (20, 910): below the 600px fold
  const ON = [[10, 10, 30, 10, 30, 30, 10, 30]];        // centre (20, 20)
  page.quads = () => OFF;
  setTimeout(() => { page.quads = () => ON; }, 200);    // the animated scroll lands
  const smoothAt = cdpLog.length, pressAt = presses().length;
  r = await cmd("sess-A", "computer", { action: "left_click", ref: saveRef });
  const smooth = cdpLog.slice(smoothAt).filter((c) => c.method === "Runtime.callFunctionOn" &&
    String(c.params.functionDeclaration).includes("scrollIntoView") && String(c.params.functionDeclaration).includes("smooth"));
  const newPresses = presses().slice(pressAt);
  const goAfterScroll = cursorOf(T);
  check("an off-screen click scrolls smoothly before pressing",
        r.ok && smooth.length >= 1, { r, smooth: smooth.length });
  check("...and the press lands at the rested on-screen centre",
        newPresses.length === 1 && newPresses[0].params.x === 20 && newPresses[0].params.y === 20, newPresses);
  check("...with the cursor arriving at that same centre, pulsing",
        !!goAfterScroll && goAfterScroll.op === "go" && goAfterScroll.x === 20 && goAfterScroll.y === 20 && goAfterScroll.pulse === true,
        goAfterScroll);

  // scroll_to is the same visible scroll, not the old instant jump
  page.quads = () => OFF;
  setTimeout(() => { page.quads = () => ON; }, 200);
  const smoothAt2 = cdpLog.length;
  r = await cmd("sess-A", "computer", { action: "scroll_to", ref: saveRef });
  const smooth2 = cdpLog.slice(smoothAt2).filter((c) => c.method === "Runtime.callFunctionOn" &&
    String(c.params.functionDeclaration).includes("scrollIntoView") && String(c.params.functionDeclaration).includes("smooth"));
  const instant = cdpLog.slice(smoothAt2).filter((c) => c.method === "DOM.scrollIntoViewIfNeeded");
  check("scroll_to scrolls smoothly and leaves the cursor on the element",
        r.ok && smooth2.length >= 1 && instant.length === 0 &&
        !!cursorOf(T) && cursorOf(T).op === "go" && cursorOf(T).x === 20 && cursorOf(T).y === 20 && cursorOf(T).pulse === false,
        { r, smooth: smooth2.length, instant: instant.length, c: cursorOf(T) });
  page.quads = null;

  // unsharing the tab takes the cursor away with the pill
  await panel("remove_tab", { tabId: T });
  await tick(20);
  check("unsharing removes the cursor as well as the pill",
        cursorOf(T) === null && (F.pillOf[T] === null || F.pillOf[T] === undefined),
        { c: cursorOf(T), p: F.pillOf[T] });

  console.log(`\n${passes}/${passes + failures} passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
