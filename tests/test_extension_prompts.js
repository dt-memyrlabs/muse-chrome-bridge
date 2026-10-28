/* v2.8 stage H: saved prompts + scheduled runs (FULL-GAP §6).
 *  - panel CRUD over the local store, with their rule that a
 *    /command is unique ("already in use");
 *  - schedules are one-shot alarms named by prompt id, recomputed
 *    on save / update / delete / fire; next-run math clamps the day
 *    to the month, as theirs does;
 *  - a run opens its own window and prepares a pairing; when a chat
 *    pairs with that code the run is delivered and usage recorded;
 *  - editing the prompt TEXT revokes its approval: the next run
 *    first asks the ONE full-control confirmation; denying skips
 *    the run, allowing re-approves the text.
 *
 *   node test_extension_prompts.js     exit 0 = all passed
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
const { tabs, sent, E, mkTab, FakeWS, panel, alarms } = F;

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
const state = () => panel("state");
const savedList = async () => (await state()).savedPrompts;

(async () => {
  let hello;
  for (let i = 0; i < 200 && !hello; i++) { await tick(10); hello = sent.find((m) => m.t === "hello"); }
  FakeWS.last.deliver({ t: "welcome", ok: true });
  await tick(10);
  await pair("https://shop.example.com/form", "Chat A");

  /* ---- next-run math ---- */
  const NR = (p, now) => F.sw(`nextRunFor(${JSON.stringify(p)}, ${now})`);
  const feb10 = new Date(2026, 1, 10, 10, 0, 0).getTime();
  check("monthly day 31 clamps to February's last day",
        NR({ repeatType: "monthly", dayOfMonth: 31, specificTime: "09:00" }, feb10) === new Date(2026, 1, 28, 9, 0, 0).getTime(),
        NR({ repeatType: "monthly", dayOfMonth: 31, specificTime: "09:00" }, feb10));
  check("daily at a time already past rolls to tomorrow",
        NR({ repeatType: "daily", specificTime: "09:00" }, feb10) === new Date(2026, 1, 11, 9, 0, 0).getTime());
  const dow = new Date(2026, 1, 10).getDay();
  check("weekly on today's weekday at a future time is today",
        NR({ repeatType: "weekly", dayOfWeek: dow, specificTime: "23:00" }, feb10) === new Date(2026, 1, 10, 23, 0, 0).getTime());
  check("weekly on today's weekday at a past time is next week",
        NR({ repeatType: "weekly", dayOfWeek: dow, specificTime: "08:00" }, feb10) === new Date(2026, 1, 17, 8, 0, 0).getTime());
  check("once in the past has no next run; once in the future is that date",
        NR({ repeatType: "once", specificDate: "2026-02-01", specificTime: "09:00" }, feb10) === null &&
        NR({ repeatType: "once", specificDate: "2026-03-01", specificTime: "09:00" }, feb10) === new Date(2026, 2, 1, 9, 0, 0).getTime());
  check("annually clamps Feb 29 to Feb 28 in a non-leap year",
        NR({ repeatType: "annually", monthAndDay: "02-29", specificTime: "09:00" }, new Date(2026, 0, 1).getTime()) === new Date(2026, 1, 28, 9, 0, 0).getTime());

  /* ---- CRUD + command uniqueness + alarms ---- */
  let r = await panel("prompt_save", { name: "", prompt: "x" });
  check("saving without a name is refused", r && r.ok === false && r.error === "name_and_prompt_required", r);
  r = await panel("prompt_save", { name: "Morning check", prompt: "Check the dashboard.", command: "morning",
    repeatType: "daily", specificTime: "08:30", url: "https://shop.example.com/dash" });
  const pid = r && r.id;
  let list = await savedList();
  const savedP = list.find((p) => p.id === pid);
  check("a saved prompt is stored with its schedule and starts approved",
        !!savedP && savedP.command === "morning" && savedP.repeatType === "daily" && !!savedP.approvedTextHash, { r, savedP });
  check("a daily schedule arms a one-shot alarm in the next 24h",
        !!alarms[pid] && alarms[pid].when > Date.now() && alarms[pid].when <= Date.now() + 86400000, alarms[pid]);
  r = await panel("prompt_save", { name: "Copycat", prompt: "Other.", command: "/morning" });
  check("a taken /command is refused (already in use)", r && r.ok === false && r.error === "command_taken", r);
  r = await panel("prompt_save", { name: "Derived name", prompt: "No command given." });
  list = await savedList();
  check("a missing command is derived from the name",
        r && r.ok === true && list.some((p) => p.id === r.id && p.command === "derived-name"), list.map((p) => p.command));
  const derivedId = r.id;
  r = await panel("prompt_update", { id: pid, repeatType: "none" });
  check("clearing the schedule clears the alarm", r && r.ok === true && !(pid in alarms), { r, alarms });
  await panel("prompt_update", { id: pid, repeatType: "daily", specificTime: "08:30" });
  check("restoring the schedule re-arms the alarm", pid in alarms, alarms);

  /* ---- a run: window, pairing, delivery, usage ---- */
  r = await panel("prompt_run_now", { id: pid });
  const run = r && r.run;
  let st = await state();
  const runRow = st.promptRuns.find((x) => x.id === (run && run.id));
  check("running an approved prompt opens its window and awaits a chat",
        !!run && /^awaiting chat/.test(run.status) && !!runRow && runRow.tabId === run.tabId,
        { run, runRow });
  const req = sent.filter((m) => m.t === "pair_request").pop();
  FakeWS.last.deliver({ t: "pair_code", reqId: req.reqId, code: "WXYZ9876", expiresIn: 300 });
  await tick(20);
  st = await state();
  const coded = st.promptRuns.find((x) => x.id === run.id);
  check("the run shows its pairing code in the panel state", !!coded && coded.code === "WXYZ9876", coded);
  FakeWS.last.deliver({ t: "paired", reqId: req.reqId, sessionId: "sess-Runner", chatName: "Runner" });
  await approveShare();
  await tick(40);
  st = await state();
  const delivered = st.promptRuns.find((x) => x.id === run.id);
  list = await savedList();
  check("pairing delivers the run and records the usage",
        !!delivered && delivered.status === "delivered to Runner" &&
        list.find((p) => p.id === pid).usageCount === 1, { delivered, usage: list.find((p) => p.id === pid) });

  /* ---- alarm fire runs the prompt ---- */
  const before = (await state()).promptRuns.length;
  E.alarm.fire({ name: pid });
  await tick(60);
  st = await state();
  check("the schedule alarm firing starts a run",
        st.promptRuns.length > before && st.promptRuns.some((x) => x.promptId === pid && x.id !== run.id), st.promptRuns.map((x) => x.status));

  /* ---- changed text re-asks the one confirmation ---- */
  await panel("prompt_update", { id: pid, prompt: "Check the dashboard AND the orders." });
  const runP = panel("prompt_run_now", { id: pid });
  let card = null;
  for (let i = 0; i < 200 && !card; i++) { card = (await pendingPrompts()).find((p) => /scheduled prompt/i.test(p.title)); if (!card) await tick(5); }
  check("a changed prompt's run first asks the one confirmation", !!card, card && card.title);
  await panel("deny", { id: card.id });
  r = await runP;
  check("denying skips the run, recorded as skipped",
        r && r.ok === true && /skipped/.test(r.run.status), r);
  const runP2 = panel("prompt_run_now", { id: pid });
  card = null;
  for (let i = 0; i < 200 && !card; i++) { card = (await pendingPrompts()).find((p) => /scheduled prompt/i.test(p.title)); if (!card) await tick(5); }
  await panel("approve", { id: card.id });
  r = await runP2;
  check("allowing runs the changed prompt", r && r.ok === true && /^awaiting chat/.test(r.run.status), r);
  r = await panel("prompt_run_now", { id: pid });
  check("the approval sticks: the next run asks nothing", r && r.ok === true && /^awaiting chat/.test(r.run.status), r);

  /* ---- delete ---- */
  r = await panel("prompt_delete", { id: pid });
  list = await savedList();
  check("deleting removes the prompt and clears its alarm",
        r && r.ok === true && !list.some((p) => p.id === pid) && !(pid in alarms), { r, alarms });
  await panel("prompt_delete", { id: derivedId });

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
