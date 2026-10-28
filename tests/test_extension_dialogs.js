/* v2.7.2 — the three parity gaps from the full-coverage read, copied
 * from Claude in Chrome's mechanics:
 *   1. Page dialogs: Page.javascriptDialogOpening is answered from a
 *      per-tab beforeunload policy the navigate tool arms (accept only
 *      with force, dismiss otherwise / when nothing is armed);
 *      alert/confirm/prompt are answered at once and recorded.
 *   2. Hide-for-capture: the cursor and the pill are hidden before a
 *      screenshot (tool capture and the panel live view) and restored
 *      after — a capture never contains the bridge's own indicators.
 *   3. Transport: a CDP call whose debugger session dropped is
 *      reattached once and retried once; a command result that finishes
 *      while the relay link is down is buffered (8, 120 s, successes
 *      only) and redelivered on reconnect.
 *
 *   node test_extension_dialogs.js     exit 0 = all passed
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
const { tabs, sent, cdpLog, visualLog, cdpBox, dbgAttach, page, mkTab, FakeWS, panel, E } = F;

let cmdSeq = 0;
function cmdStart(sessionId, action, args) {
  const id = "c" + (++cmdSeq);
  FakeWS.last.deliver({ t: "cmd", id, sessionId, action, args: args || {}, ttlMs: 120000 });
  return id;
}
async function result(id, ms = 8000) {
  for (let i = 0; i < ms / 5; i++) {
    const r = sent.find((m) => m.t === "result" && m.id === id);
    if (r) return r;
    await tick(5);
  }
  return { ok: false, error: "TEST_TIMEOUT" };
}
const cmd = (sid, action, args) => result(cmdStart(sid, action, args));
async function pendingPrompts() { return (await panel("state")).prompts; }
async function approveShare() {
  for (let i = 0; i < 200; i++) {
    const sp = (await pendingPrompts()).find((p) => /full control/i.test(p.title));
    if (sp) { await panel("approve", { id: sp.id }); return sp; }
    await tick(5);
  }
  return null;
}
async function pair(tabId, sid, name) {
  await panel("share", { tabId });
  const req = sent.filter((m) => m.t === "pair_request").pop();
  FakeWS.last.deliver({ t: "pair_code", reqId: req.reqId, code: "ABCD2345", expiresIn: 300 });
  await tick(10);
  FakeWS.last.deliver({ t: "paired", reqId: req.reqId, sessionId: sid, chatName: name });
  await approveShare();
  await tick(30);
}
const dialogAnswers = (tabId) => cdpLog.filter((c) => c.tabId === tabId && c.method === "Page.handleJavaScriptDialog");
const fireDialog = (tabId, params) => E.dbgEvent.fire({ tabId }, "Page.javascriptDialogOpening", params);
async function auditHas(action, outcomeRe) {
  for (let i = 0; i < 100; i++) {
    const a = (await panel("state")).audit;
    const hit = a.find((x) => x.action === action && (!outcomeRe || outcomeRe.test(x.outcome)));
    if (hit) return hit;
    await tick(5);
  }
  return null;
}
// Poll (1 ms) until cond() is true — used to fire a dialog the moment a
// navigation has been triggered, inside the wrapper's outcome window.
async function until(cond, ms = 4000) {
  for (let i = 0; i < ms; i++) { if (cond()) return true; await tick(1); }
  return false;
}

(async () => {
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = sent.find((m) => m.t === "hello"); }
  check("worker connects (hello sent)", !!hello);
  FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);

  const tabObj = mkTab("https://example.com/form", { active: true });
  const T = tabObj.id;
  await pair(T, "sess-A", "Chat A");

  /* -------- 1a. beforeunload during navigate, no force: dismissed,
   * navigation reported blocked, dialog answered + recorded -------- */
  {
    const id = cmdStart("sess-A", "navigate", { tabId: T, url: "https://example.com/away" });
    check("nav 1a: navigation triggered", await until(() => tabObj.url === "https://example.com/away"));
    fireDialog(T, { type: "beforeunload", url: "https://example.com/form" });
    const r = await result(id);
    check("nav 1a: dismissed dialog blocks the navigation", !r.ok && r.error === "navigation_blocked", r);
    check("nav 1a: block message offers force: true", /force: true/.test(r.detail || ""), r.detail);
    const a = dialogAnswers(T);
    check("nav 1a: dialog answered with accept:false", a.length === 1 && a[0].params.accept === false, a);
    check("nav 1a: outcome in the event record", !!(await auditHas("Leave site? dialog", /dismissed/)));
  }

  /* -------- 1b. beforeunload during navigate with force: accepted,
   * navigation completes and reports the discarded dialog -------- */
  {
    const id = cmdStart("sess-A", "navigate", { tabId: T, url: "https://example.com/final", force: true });
    check("nav 1b: navigation triggered", await until(() => tabObj.url === "https://example.com/final"));
    fireDialog(T, { type: "beforeunload", url: "https://example.com/away" });
    const r = await result(id);
    check("nav 1b: forced navigation completes", r.ok === true, r);
    check("nav 1b: result reports the discarded dialog", /discarded a "Leave site\?" dialog/.test((r.data && r.data.note) || ""), r.data);
    const a = dialogAnswers(T);
    check("nav 1b: dialog answered with accept:true", a.length === 2 && a[1].params.accept === true, a);
    check("nav 1b: outcome in the event record", !!(await auditHas("Leave site? dialog", /accepted/)));
  }

  /* -------- 1c. history navigation is under the same policy -------- */
  {
    page.history[T] = { currentIndex: 1, entries: [
      { id: 1, url: "https://example.com/form" }, { id: 2, url: "https://example.com/final" }] };
    const before = cdpLog.length;
    const id = cmdStart("sess-A", "navigate", { tabId: T, url: "back" });
    check("nav 1c: history move triggered",
      await until(() => cdpLog.slice(before).some((c) => c.method === "Page.navigateToHistoryEntry")));
    fireDialog(T, { type: "beforeunload", url: "https://example.com/final" });
    const r = await result(id);
    check("nav 1c: dismissed dialog blocks history navigation", !r.ok && r.error === "navigation_blocked", r);
    const a = dialogAnswers(T);
    check("nav 1c: dialog answered with accept:false", a.length === 3 && a[2].params.accept === false, a);
    page.history[T] = undefined;
  }

  /* -------- 1d. dialogs during other commands: answered at once from
   * the (unarmed) default policy; the command is never hung -------- */
  {
    const id = cmdStart("sess-A", "get_page_text", { tabId: T });
    fireDialog(T, { type: "confirm", message: "Delete this draft?", url: "https://example.com/final" });
    const r = await result(id);
    check("dialog 1d: command completes despite the confirm", r.ok === true, r);
    const a = dialogAnswers(T);
    check("dialog 1d: confirm declined (accept:false)", a.length === 4 && a[3].params.accept === false, a);
    check("dialog 1d: confirm in the event record", !!(await auditHas("confirm dialog", /dismissed/)));
  }
  {
    const id = cmdStart("sess-A", "get_page_text", { tabId: T });
    fireDialog(T, { type: "alert", message: "Saved.", url: "https://example.com/final" });
    const r = await result(id);
    check("dialog 1d: command completes despite the alert", r.ok === true, r);
    const a = dialogAnswers(T);
    check("dialog 1d: alert accepted (accept:true — it has only OK)", a.length === 5 && a[4].params.accept === true, a);
  }
  {
    const id = cmdStart("sess-A", "screenshot", { tabId: T });
    fireDialog(T, { type: "beforeunload", url: "https://example.com/final" });
    const r = await result(id);
    check("dialog 1d: screenshot completes despite a stray beforeunload", r.ok === true, r);
    const a = dialogAnswers(T);
    check("dialog 1d: stray beforeunload dismissed (no policy armed)", a.length === 6 && a[5].params.accept === false, a);
  }

  /* -------- 2a. hide-for-capture: tool screenshot ------------------ */
  {
    // Put the cursor on the page first: the indicators are "visible".
    const rc = await cmd("sess-A", "computer", { action: "left_click", coordinate: [100, 100], tabId: T });
    check("capture 2a: setup click ok", rc.ok === true, rc);
    const mark = visualLog.length;
    const r = await cmd("sess-A", "screenshot", { tabId: T });
    check("capture 2a: screenshot ok", r.ok === true, r);
    const slice = visualLog.slice(mark);
    const ci = slice.findIndex((v) => v.kind === "capture");
    check("capture 2a: a capture happened", ci > 0, slice);
    const isOp = (v, kind, op) => v.kind === kind && v.arg && v.arg.op === op;
    const lastIdx = (pred, upto) => { for (let i = upto - 1; i >= 0; i--) if (pred(slice[i])) return i; return -1; };
    const hc = lastIdx((v) => isOp(v, "cursor", "hideForCapture"), ci);
    const hp = lastIdx((v) => isOp(v, "pill", "hideForCapture"), ci);
    check("capture 2a: cursor hidden before the capture", hc >= 0 && !slice.slice(hc, ci).some((v) => isOp(v, "cursor", "showAfterCapture")), slice);
    check("capture 2a: pill hidden before the capture", hp >= 0 && !slice.slice(hp, ci).some((v) => isOp(v, "pill", "showAfterCapture")), slice);
    check("capture 2a: cursor restored after the capture", slice.slice(ci + 1).some((v) => isOp(v, "cursor", "showAfterCapture")), slice);
    check("capture 2a: pill restored after the capture", slice.slice(ci + 1).some((v) => isOp(v, "pill", "showAfterCapture")), slice);
  }

  /* -------- 2b. hide-for-capture: the panel live view -------------- */
  {
    const mark = visualLog.length;
    await F.sw(`captureLiveView("sess-A", ${T})`);
    const slice = visualLog.slice(mark);
    const ci = slice.findIndex((v) => v.kind === "captureView");
    check("capture 2b: live view captured", ci > 0, slice);
    const isOp = (v, kind, op) => v.kind === kind && v.arg && v.arg.op === op;
    check("capture 2b: indicators hidden before the live capture",
      slice.slice(0, ci).some((v) => isOp(v, "cursor", "hideForCapture")) &&
      slice.slice(0, ci).some((v) => isOp(v, "pill", "hideForCapture")), slice);
    check("capture 2b: indicators restored after the live capture",
      slice.slice(ci + 1).some((v) => isOp(v, "cursor", "showAfterCapture")) &&
      slice.slice(ci + 1).some((v) => isOp(v, "pill", "showAfterCapture")), slice);
  }

  /* -------- 3a. CDP session drop mid-command: reattach + one retry - */
  {
    let fails = 1;
    cdpBox.hook = ({ method }) => (method === "Page.getLayoutMetrics" && fails-- > 0)
      ? new Error("Detached while handling command") : null;
    const attach0 = dbgAttach.count, log0 = cdpLog.length;
    const r = await cmd("sess-A", "screenshot", { tabId: T });
    cdpBox.hook = null;
    check("cdp 3a: command succeeds after reattach + retry", r.ok === true, r);
    check("cdp 3a: the failed call was retried exactly once",
      cdpLog.slice(log0).filter((c) => c.method === "Page.getLayoutMetrics").length === 2);
    check("cdp 3a: the debugger was reattached", dbgAttach.count === attach0 + 1, dbgAttach.count - attach0);
  }
  {
    // The cross-extension message counts only when really detached —
    // the fake's getTargets reports nothing attached, so it retries.
    let fails = 1;
    cdpBox.hook = ({ method }) => (method === "Page.getLayoutMetrics" && fails-- > 0)
      ? new Error("Cannot access a chrome-extension:// URL of different extension") : null;
    const log0 = cdpLog.length;
    const r = await cmd("sess-A", "screenshot", { tabId: T });
    cdpBox.hook = null;
    check("cdp 3a: cross-extension drop also reattaches + retries", r.ok === true, r);
    check("cdp 3a: retried exactly once",
      cdpLog.slice(log0).filter((c) => c.method === "Page.getLayoutMetrics").length === 2);
  }
  {
    // A second failure is the answer: no loop, the real error surfaces.
    cdpBox.hook = ({ method }) => (method === "Page.getLayoutMetrics")
      ? new Error("Detached while handling command") : null;
    const log0 = cdpLog.length;
    const r = await cmd("sess-A", "screenshot", { tabId: T });
    cdpBox.hook = null;
    check("cdp 3a: second failure surfaces as the result", !r.ok && r.error === "page_error" && /Detached while handling command/.test(r.detail || ""), r);
    check("cdp 3a: exactly one retry was attempted",
      cdpLog.slice(log0).filter((c) => c.method === "Page.getLayoutMetrics").length === 2);
  }
  {
    // A non-detach error is never retried.
    let fails = 1;
    cdpBox.hook = ({ method }) => (method === "Page.getLayoutMetrics" && fails-- > 0)
      ? new Error("kaboom in the page") : null;
    const log0 = cdpLog.length;
    const r = await cmd("sess-A", "screenshot", { tabId: T });
    cdpBox.hook = null;
    check("cdp 3a: non-detach error is not retried", !r.ok &&
      cdpLog.slice(log0).filter((c) => c.method === "Page.getLayoutMetrics").length === 1, r);
  }

  /* -------- 3b. results buffered while the link is down ------------ */
  {
    const hellos0 = sent.filter((m) => m.t === "hello").length;
    const idW = cmdStart("sess-A", "computer", { action: "wait", duration: 2 });
    check("buffer 3b: slow command running", await until(() => F.sw("inflight.size") >= 1, 2000));
    FakeWS.last.close();
    check("buffer 3b: command finished while the link was down",
      await until(() => F.sw("inflight.size") === 0, 6000));
    check("buffer 3b: its result was not delivered", !sent.some((m) => m.t === "result" && m.id === idW));
    check("buffer 3b: worker reconnected", await until(() => sent.filter((m) => m.t === "hello").length > hellos0, 8000));
    FakeWS.last.deliver({ t: "welcome", ok: true, sessions: ["sess-A"], reqIds: [] });
    const rw = await result(idW);
    check("buffer 3b: buffered result redelivered on reconnect", rw.ok === true, rw);
  }
  {
    FakeWS.last.close();
    await tick(30);
    check("buffer 3b: link is down (send refused)", F.sw("relaySend({t:'ping'})") === false);
    F.sw("sendResult({ t: 'result', id: 'buf-err', ok: false, error: 'boom' })");
    check("buffer 3b: error results are not buffered", F.sw("resultBuffer.length") === 0, F.sw("resultBuffer.length"));
    for (let i = 0; i < 10; i++) F.sw(`sendResult({ t: 'result', id: 'buf-${i}', ok: true, data: {} })`);
    check("buffer 3b: buffer caps at 8, newest kept",
      F.sw("resultBuffer.length") === 8 && F.sw("resultBuffer[0].id") === "buf-2",
      F.sw("resultBuffer.map(b => b.id).join(',')"));
    F.sw("resultBuffer.push({ id: 'buf-old', msg: { t: 'result', id: 'buf-old', ok: true }, expiresAt: Date.now() - 1 })");
    const hellos0 = sent.filter((m) => m.t === "hello").length;
    check("buffer 3b: worker reconnected again", await until(() => sent.filter((m) => m.t === "hello").length > hellos0, 8000));
    FakeWS.last.deliver({ t: "welcome", ok: true, sessions: ["sess-A"], reqIds: [] });
    await tick(80);
    check("buffer 3b: all 8 buffered results redelivered",
      [2, 3, 4, 5, 6, 7, 8, 9].every((i) => sent.some((m) => m.t === "result" && m.id === "buf-" + i)));
    check("buffer 3b: the two evicted results never arrive",
      !sent.some((m) => m.t === "result" && (m.id === "buf-0" || m.id === "buf-1")));
    check("buffer 3b: the expired result is dropped, not delivered",
      !sent.some((m) => m.t === "result" && m.id === "buf-old"));
    check("buffer 3b: the error result never arrives",
      !sent.some((m) => m.t === "result" && m.id === "buf-err"));
  }

  console.log(`\n${passes}/${passes + failures} passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("SUITE ERROR", e); process.exit(1); });
