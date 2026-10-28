/* Muse Chrome Bridge v2 — service worker.
 *
 * One pairing = one chat = one tab group. A chat can act only on tabs in
 * its own group. Sharing a tab asks ONE confirmation in the side panel
 * that gives the chat full control of that tab; after it, actions inside
 * the tab are written to the panel's event record, never prompted
 * (v2.7). Input is real (chrome.debugger).
 * Independent open-source project; not a Meta or Anthropic product.
 *
 * What still gets checked before input reaches a page:
 *   - the tab belongs to the calling chat's group — isolation is a
 *     wall, not a prompt, and refuses outright;
 *   - the element a click or key press will ACTIVATE (the button, not
 *     the icon inside it), read through open shadow roots and
 *     same-origin frames, and cross-checked against Chrome's
 *     accessibility tree — the classification feeds the event record
 *     and the masking of secret values, never a question;
 *   - uploads of credential material are refused outright, no prompt.
 */
importScripts("policy.js");
const P = self.MBB;

const VERSION = "2.7.1";
const DEFAULT_RELAY = "ws://127.0.0.1:19822";
const APPROVAL_MS = 60000;      // longest a prompt waits
const MIN_ASK_MS = 5000;        // don't open a prompt with less time than this left
const DEFAULT_TTL_MS = 120000;  // if the relay does not say how long it will wait
const CDP_MS = 15000;
const DEBUGGER_IDLE_MS = 30000;
const LOAD_WAIT_MS = 15000;
const MAX_RESULT_BYTES = 12000000;  // relay drops messages over 16 MB
const SHOT_MAX_B64 = 6000000;
const SCROLL_SETTLE_MS = 900;   // longest wait for a smooth scroll to come to rest
const CAPTURE_EVERY_MS = 1500;  // live-view cadence while a chat is working a tab
const CAPTURE_TAIL_MS = 6000;   // keep the live view warm briefly after the last action
const COLORS = ["blue", "purple", "cyan", "green", "orange", "pink", "yellow", "red"];
const WORKER_ID = crypto.randomUUID();
const PROBE_SRC = P.pageProbe.toString();

/* ------------------------------------------------------------------ util */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(code, detail) { const e = new Error(code); e.code = code; e.detail = detail; return e; }
function withTimeout(p, ms, code) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(fail(code)), ms); })])
    .finally(() => clearTimeout(t));
}
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const own = (o, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
const local = {
  get: async (k, d) => { const v = (await chrome.storage.local.get(k))[k]; return v === undefined ? d : v; },
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
  remove: async (k) => { if (chrome.storage.local.remove) await chrome.storage.local.remove(k); },
};
const sess = {
  get: async (k, d) => { const v = (await chrome.storage.session.get(k))[k]; return v === undefined ? d : v; },
  set: (k, v) => chrome.storage.session.set({ [k]: v }),
};

// One queue per key, so read-modify-write on stored state never loses updates.
const chains = new Map();
function serial(key, fn) {
  const run = (chains.get(key) || Promise.resolve()).then(fn);
  chains.set(key, run.catch(() => {}));
  return run;
}
// Sessions and shares are kept in storage.local: an extension reload wipes
// storage.session, and that used to kill every connected chat and every
// code on screen. validateStored() checks them against the real tabs and
// groups before the first hello, so nothing stale is ever reused.
function withState(fn) {
  return serial("sessions", async () => {
    const sessions = await local.get("sessions", {});
    const out = await fn(sessions);
    await local.set("sessions", sessions);
    return out;
  });
}
function withShares(fn) {
  return serial("shares", async () => {
    const shares = await local.get("shares", {});
    const out = await fn(shares);
    await local.set("shares", shares);
    return out;
  });
}
const getSessions = () => local.get("sessions", {});

function audit(chat, action, detail, outcome) {
  return serial("audit", async () => {
    const log = await local.get("audit", []);
    log.push({ ts: Date.now(), chat: chat || "", action, detail: P.clip(detail, 200), outcome });
    await local.set("audit", log.slice(-300));
    notifyPanel();
  });
}
function notifyPanel() { chrome.runtime.sendMessage({ kind: "changed" }).catch(() => {}); }

/* -------------------------------------------------------------- identity */
async function identity() {
  let id = await local.get("identity", null);
  if (id) return id;
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  id = {
    deviceId: crypto.randomUUID(),
    privJwk: await crypto.subtle.exportKey("jwk", kp.privateKey),
    pubJwk: await crypto.subtle.exportKey("jwk", kp.publicKey),
  };
  await local.set("identity", id);
  return id;
}
// The hello signs the relay's per-connection challenge nonce, never a
// clock value: the relay sends {t:"challenge", nonce} when the socket
// opens and accepts only a signature over deviceId + ":" + that nonce,
// so a captured hello cannot be replayed on a new connection.
async function signHello(id, nonce) {
  const key = await crypto.subtle.importKey("jwk", id.privJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const data = new TextEncoder().encode(`${id.deviceId}:${nonce}`);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data));
  return btoa(String.fromCharCode(...sig));
}
// Enrollment proof for the relay's challenge: hex HMAC-SHA256 of
// "deviceId:nonce" keyed with the per-install secret. The secret itself is
// never sent; the key bytes are the secret string's UTF-8, exactly as the
// relay computes it from the secret file.
async function enrollProof(secret, deviceId, nonce) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${deviceId}:${nonce}`)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ----------------------------------------------------------------- relay */
let ws = null;
let wsReady = false;
let backoff = 2000;
let reconnectTimer = null;
let heartbeat = null;

// The relay is started by Chrome itself: native/relay_host.py is registered
// as native messaging host com.memyr.muse_bridge (installed by native/install_native_host.py),
// the standard native-messaging mechanism for local helpers.
const NATIVE_HOST = "com.memyr.muse_bridge";
let lastStartTry = 0;
async function startRelay(force) {
  if (!force && Date.now() - lastStartTry < 20000) return { ok: false, error: "tried_recently" };
  lastStartTry = Date.now();
  let r;
  try { r = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: "start" }); }
  catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  // The host's start answer carries the per-install enrollment secret (it
  // reads or creates the secret file whether or not the relay was already
  // running). Keep it for the relay's hello challenge. Take it from any
  // answer that carries it, not only ok ones: the host includes it in its
  // failure answers too, and dropping it there left the worker with no
  // secret to answer the next challenge with.
  if (r && typeof r.enrollSecret === "string" && r.enrollSecret) {
    await local.set("enrollSecret", r.enrollSecret);
  }
  // Every attempt is logged with its time: an unchanged error text was
  // indistinguishable from no attempt at all.
  const err = r && r.ok ? "" : (r && r.error) || "no answer from the relay starter";
  await local.set("relayStartError", err ? new Date().toLocaleTimeString() + " " + err : "");
  await audit("", "start relay", err || (r.started ? "started" : "already running"), err ? "failed" : "ok");
  if (r && r.ok) { backoff = 500; clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 200); }
  notifyPanel();
  return r || { ok: false };
}

let connecting = false; // set before the first await: two callers at once must not open two sockets
async function connect() {
  if (connecting || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
  connecting = true;
  let url;
  // Always the built-in default: a relayUrl left in storage by the removed
  // panel testing box must never redirect the worker, so drop it instead
  // of reading it.
  try { url = DEFAULT_RELAY; await local.remove("relayUrl"); } finally { connecting = false; }
  let sock;
  try { sock = new WebSocket(url.replace(/\/+$/, "") + "/device"); }
  catch (e) { scheduleReconnect(); return; }
  ws = sock;
  let opened = false;
  let helloStarted = false;
  const sendHello = async (nonce) => {
    // Set synchronously: exactly one hello goes out on this socket, in
    // answer to its challenge.
    if (helloStarted || ws !== sock || sock.readyState !== WebSocket.OPEN) return;
    helloStarted = true;
    // The hello must also prove the per-install enrollment secret
    // against this challenge (see the relay's hello checks). If we hold
    // no secret yet, ask the native host for it: its start answer
    // carries the secret even when the relay was already running. With
    // no secret anywhere the install is broken — fail loudly instead
    // of saying hello to a relay that would refuse it anyway.
    let secret = await local.get("enrollSecret", "");
    if (!secret) {
      await startRelay(true);
      secret = await local.get("enrollSecret", "");
    }
    if (!secret) {
      await local.set("relayError", "missing_enroll_secret");
      try { sock.close(); } catch (e) {}
      return;
    }
    const id0 = await identity();
    const proof = await enrollProof(secret, id0.deviceId, nonce);
    const id = await identity();
    const live = Object.keys(await getSessions());
    if (ws !== sock || sock.readyState !== WebSocket.OPEN) return;
    sock.send(JSON.stringify({ t: "hello", deviceId: id.deviceId, pubJwk: id.pubJwk,
                               sig: await signHello(id, nonce), version: VERSION, liveSessions: live,
                               proof }));
  };
  sock.onopen = () => {
    opened = true;
    // No hello yet: the relay's challenge comes first and the hello must
    // sign its nonce (see signHello). A relay that never challenges is
    // not spoken to — a hello it could accept would be replayable.
  };
  sock.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (ws !== sock || !msg || typeof msg !== "object") return;
    if (msg.t === "challenge") {
      // An empty nonce is not a challenge: the hello must sign a real one.
      if (!helloStarted && typeof msg.nonce === "string" && msg.nonce) sendHello(msg.nonce).catch((e) => console.warn("challenge", e));
      return;
    }
    onRelay(msg).catch((e) => console.warn("relay message", e));
  };
  sock.onclose = () => {
    // Could not reach the default local relay at all: ask Chrome to start it.
    if (!opened && url === DEFAULT_RELAY) startRelay(false);
    if (ws === sock) { ws = null; wsReady = false; }
    clearInterval(heartbeat);
    notifyPanel();
    scheduleReconnect();
  };
  sock.onerror = () => { try { sock.close(); } catch (e) {} };
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 5000); // wait at most 5 s between tries, so a relay started after Chrome is found soon
}
function relaySend(obj) {
  if (ws && wsReady && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(obj)); return true; }
  return false;
}

async function onRelay(msg) {
  switch (msg.t) {
    case "welcome":
      if (msg.ok) {
        wsReady = true; backoff = 2000;
        await local.set("relayError", "");
        clearInterval(heartbeat);
        heartbeat = setInterval(() => relaySend({ t: "heartbeat" }), 20000); // keeps the worker alive while connected
        await reconcile(msg);
      } else {
        await local.set("relayError", msg.error || "rejected");
      }
      notifyPanel();
      return;
    case "pair_code":
      await withShares((shares) => {
        const s = shares[msg.reqId];
        if (!s) return;
        s.code = String(msg.code || "");
        s.expires = Date.now() + clamp(Number(msg.expiresIn) || 300, 1, 600) * 1000;
      });
      notifyPanel();
      return;
    case "pair_error": {
      const s = await withShares((shares) => { const x = shares[msg.reqId]; delete shares[msg.reqId]; return x; });
      await audit("", "share", P.clip(msg.error, 60), "refused by relay");
      return;
    }
    case "paired": return onPaired(msg);
    case "revoked": return dropSession(msg.sessionId, { tellRelay: false, why: "ended by the chat" });
    case "cmd": return onCommand(msg);
    case "cancel": return cancelCommand(msg.id);
  }
}

// After every (re)connect, both sides agree on what exists.
async function reconcile(msg) {
  if (Array.isArray(msg.sessions)) {
    const keep = new Set(msg.sessions);
    for (const sid of Object.keys(await getSessions())) {
      if (!keep.has(sid)) await dropSession(sid, { tellRelay: false, why: "ended while the relay was offline" });
    }
  }
  const live = new Set(Array.isArray(msg.reqIds) ? msg.reqIds : []);
  const resend = [];
  await withShares((shares) => {
    for (const [rid, s] of Object.entries(shares)) {
      if (s.expires < Date.now()) { delete shares[rid]; continue; }
      if (live.has(rid)) continue;                   // the relay still holds this code: keep it
      if (s.code) delete shares[rid];               // the relay restarted: this code is dead
      else { resend.push(rid); s.created = Date.now(); } // never got a code: ask again
    }
  });
  for (const rid of resend) relaySend({ t: "pair_request", reqId: rid });
  // Commands a previous worker was running when it stopped: answer them now
  // instead of leaving the chat to wait for the relay's timeout. Kept in
  // storage.local: an extension reload wipes storage.session.
  const stale = await serial("inflight", async () => {
    const all = await local.get("inflight", {});
    const old = Object.keys(all).filter((id) => all[id] !== WORKER_ID);
    for (const id of old) delete all[id];
    await local.set("inflight", all);
    return old;
  });
  for (const id of stale) relaySend({ t: "result", id, ok: false, error: "worker_restarted", detail: "the extension restarted during this call; check the page, then retry" });
}

/* ------------------------------------------------ a chat's tabs + pill */
// Each chat owns a list of tabs: session.tabs = { "<tabId>": "<host>" }.
// A chat may act only on its own tabs. A tab belongs to at most one chat.
// Each chat also has a Chrome tab group, "Muse · <chat name>", one per
// window, and group membership IS the control set: a tab a chat owns is
// moved into its group, a tab Daniel moves into the group is adopted by
// that chat, and a tab moved out of the group is released (see
// DESIGN-GROUPS.md). Grouping follows Claude in Chrome's manager: the
// worker tracks each chat's groups itself and reconciles against live
// state; a window that refuses groups (Chrome's "grouping is not
// supported", or a non-normal window) is not retried in place — the
// tab moves to a window where the group can form; and a failure that
// leaves a tab ungrouped is recorded durably (event record + panel
// state with the real error), never silent. The tab stays the chat's,
// with its pill, grouped or not.
// The pill (pill.js) shows which tabs are shared.
const tabIdsOf = (s) => Object.keys((s && s.tabs) || {}).map(Number);
// In-memory mirror of tab ownership, updated synchronously at the moment
// a removal, transfer, or attach begins — before any await. Stored state
// is only ever read back asynchronously, so without this mirror an Allow
// delivered in the same tick as a tab's removal could settle a prompt
// before the removal's cancel pass (cancelIfNoTabs) had a chance to run.
// The mirror is (re)built from stored state by validateStored() at boot
// and by sessionCtx() the first time a chat sends a command.
const memTabs = new Map();  // sessionId -> Set<tabId>
const memOwner = new Map(); // tabId -> sessionId
function memSyncSession(sessionId, ids) {
  const old = memTabs.get(sessionId);
  if (old) for (const id of old) if (memOwner.get(id) === sessionId) memOwner.delete(id);
  const set = new Set(ids || []);
  memTabs.set(sessionId, set);
  for (const id of set) memOwner.set(id, sessionId);
}
function memAdd(sessionId, tabId) {
  tabId = Number(tabId);
  const prev = memOwner.get(tabId);
  if (prev && prev !== sessionId) { const s = memTabs.get(prev); if (s) s.delete(tabId); }
  memOwner.set(tabId, sessionId);
  let set = memTabs.get(sessionId);
  if (!set) { set = new Set(); memTabs.set(sessionId, set); }
  set.add(tabId);
}
function memRemove(tabId) {
  tabId = Number(tabId);
  const owner = memOwner.get(tabId) || null;
  if (owner) { memOwner.delete(tabId); const s = memTabs.get(owner); if (s) s.delete(tabId); }
  return owner;
}
function memDropSession(sessionId) {
  const set = memTabs.get(sessionId);
  if (set) for (const id of set) if (memOwner.get(id) === sessionId) memOwner.delete(id);
  memTabs.delete(sessionId);
}
async function ownerOf(tabId) {
  const all = await getSessions();
  for (const [sid, v] of Object.entries(all)) if (v.tabs && own(v.tabs, String(tabId))) return sid;
  return null;
}
async function inSession(ctx, tabId) {
  const v = (await getSessions())[ctx.sessionId];
  return !!(v && v.tabs && own(v.tabs, String(tabId)));
}
async function sessionTabs(sessionId) {
  const v = (await getSessions())[sessionId];
  const out = [];
  for (const id of tabIdsOf(v)) { const t = await chrome.tabs.get(id).catch(() => null); if (t) out.push(t); }
  return out;
}
// Give a tab to a chat (taking it from any other chat) and show the pill.
async function attachTab(sessionId, tab) {
  // Synchronous, before the first await: if the mirror knows this tab
  // belonged to another chat, that chat's claim ends now — cancel its
  // work on the tab (and, if this was its last tab, its tabless prompts)
  // in this same tick, so an Allow racing this transfer cannot win.
  const memPrev = memOwner.get(tab.id) || null;
  memAdd(sessionId, tab.id);
  if (memPrev && memPrev !== sessionId) { cancelTabWork(tab.id, sessionId); cancelIfSessionEmpty(memPrev); }
  let prevOwner = null;
  const chat = await withState((st) => {
    for (const [sid, v] of Object.entries(st)) if (v.tabs && own(v.tabs, String(tab.id))) {
      delete v.tabs[String(tab.id)];
      if (sid !== sessionId) prevOwner = sid;
    }
    if (!st[sessionId]) return null;
    st[sessionId].tabs = st[sessionId].tabs || {};
    st[sessionId].tabs[String(tab.id)] = P.hostOf(tab.url);
    return st[sessionId].chatName;
  });
  // A transfer ends the previous chat's claim on this tab at once: its
  // pending prompts for the tab are canceled and its in-flight commands
  // on the tab are marked canceled, so a late result is dropped.
  if (prevOwner) { cancelTabWork(tab.id, sessionId); await clearGroupRetry(prevOwner, tab.id); await clearGroupMoved(prevOwner, tab.id); await cancelIfNoTabs(prevOwner); await dropIfEmpty(prevOwner, "last tab taken by another chat"); }
  if (chat) { await groupTab(sessionId, tab); pill(tab.id, chat); }
  else memRemove(tab.id); // no such session: undo the mirror move above
  return chat;
}
async function releaseTab(tabId) {
  // Synchronous, before the first await: the tab leaves its chat now.
  // Cancel its work in this same tick (not after the state write), and
  // if it was the chat's last tab, settle the chat's tabless prompts
  // too — an Allow racing this removal must find nothing to answer.
  const memOwnerSid = memRemove(tabId);
  cancelTabWork(tabId, null);
  if (memOwnerSid) cancelIfSessionEmpty(memOwnerSid);
  let ownerSid = null;
  const chat = await withState((st) => {
    let name = null;
    for (const [sid, v] of Object.entries(st)) if (v.tabs && own(v.tabs, String(tabId))) { delete v.tabs[String(tabId)]; name = v.chatName; ownerSid = sid; }
    return name;
  });
  // Unsharing a tab cancels its pending prompts and in-flight commands
  // for the chat that held it, the same way a transfer does.
  if (chat) { cancelTabWork(tabId, null); await cancelIfNoTabs(ownerSid); }
  pill(tabId, null);
  void cursor(tabId, null); // an unshared tab keeps neither the pill nor the cursor
  forgetTabView(tabId);
  await ungroupTab(tabId, chat);
  await detach(tabId);
  if (ownerSid) { await clearGroupRetry(ownerSid, tabId); await clearGroupMoved(ownerSid, tabId); await dropIfEmpty(ownerSid, "last tab removed"); }
  return chat;
}
/* ------------------------------------------------------- tab groups */
// The group model (DESIGN-GROUPS.md): a session's group is titled
// "Muse · <chat name>"; there is one group per session per window.
// session.groups = { "<windowId>": <groupId> } is only a cache — the
// title is the identity, and a cached id is re-verified against the live
// group's window and title before every use.
const groupTitle = (s) => `Muse · ${s.chatName}`;
function groupColor(chatName) {
  let h = 0;
  for (const c of String(chatName || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
async function rememberGroup(sessionId, windowId, groupId) {
  let rotated = null;
  await withState((st) => {
    const s = st[sessionId];
    if (!s) return;
    s.groups = s.groups || {};
    const prev = Number(s.groups[String(windowId)]);
    // Group-id rotation is followed, never fought (Claude's
    // followRotatedGroupId): if the cache held a different id for this
    // window, the live one wins and the change leaves a trace.
    if (Number.isInteger(prev) && prev >= 0 && prev !== groupId) rotated = { chat: s.chatName, prev };
    if (prev !== groupId) s.groups[String(windowId)] = groupId;
  });
  if (rotated) await audit(rotated.chat, "tab group", "the group id for this window changed (" + rotated.prev + " → " + groupId + "); following the new id", "ok").catch(() => {});
}
// Grouping attempts are bounded by one mark per tab, shared by the
// membership sync and the lifecycle retries below.
const GROUP_RETRY_MAX = 8;
// The durable record of a grouping failure, per chat: the last error
// Chrome gave, the type of window it happened in, and when. The panel
// state carries it, so a missing group is visible for as long as it is
// missing — an audit line alone scrolls away under a busy chat and the
// failure went invisible (Daniel, 2026-10-28). Cleared the moment any
// tab of the chat is confirmed in the chat's group again.
async function noteGroupFailure(sessionId, text, windowType) {
  await withState((st) => { const v = st[sessionId]; if (!v) return; v.groupError = { text: String(text || ""), windowType: windowType || "", at: Date.now() }; }).catch(() => {});
}
// The error clears only when no tab of the chat still carries a retry
// mark — one tab healing must not hide a sibling's failure.
async function clearGroupError(sessionId) {
  await withState((st) => { const v = st[sessionId]; if (!v || !v.groupError) return; if (Object.keys(v.groupRetry || {}).length === 0) delete v.groupError; }).catch(() => {});
}
// A tab that was moved into a window of its own so its group could form
// is not moved again for the same chat: one move per tab per session.
async function markGroupMoved(sessionId, tabId) {
  await withState((st) => { const v = st[sessionId]; if (!v) return; v.groupMoved = v.groupMoved || {}; v.groupMoved[String(tabId)] = true; }).catch(() => {});
}
async function clearGroupMoved(sessionId, tabId) {
  await withState((st) => { const v = st[sessionId]; if (v && v.groupMoved) delete v.groupMoved[String(tabId)]; }).catch(() => {});
}
// Move a tab the session already owns into the session's group in the
// tab's window: reuse the verified cached group, else a group in that
// window already carrying the session's title, else a new group (titled
// and coloured here). Never throws. A window that refuses groups sends
// the tab to a window where the group can form (groupTabViaOwnWindow);
// any failure that still leaves the tab ungrouped is recorded durably —
// mark, session groupError, audit line with Chrome's real error text.
// Tabs whose grouping Chrome refused when they were shared (the tab was
// mid-drag, or its window declines tab groups). Such a tab never landed
// in its group, so being groupless is not "leaving": the membership sync
// must not release it (the release branch would drop a live shared tab
// on the first stray group event). Instead the sync and the lifecycle
// retries retry grouping; the mark counts the tries and bounds them.
// After the bound the tab simply stays shared and ungrouped — pill and
// panel still carry it, and the panel says the group is missing and why.
async function markGroupRetry(sessionId, tabId) {
  await withState((st) => { const v = st[sessionId]; if (!v) return; v.groupRetry = v.groupRetry || {}; const k = String(tabId); v.groupRetry[k] = (Number(v.groupRetry[k]) || 0) + 1; }).catch(() => {});
}
async function clearGroupRetry(sessionId, tabId) {
  await withState((st) => { const v = st[sessionId]; if (v && v.groupRetry) delete v.groupRetry[String(tabId)]; }).catch(() => {});
}

async function groupTab(sessionId, tab) {
  if (!tab || tab.windowId == null) return;
  let chat = "";
  try {
    const s = (await getSessions())[sessionId];
    if (!s) return;
    chat = s.chatName;
    const title = groupTitle(s);
    let gid = null;
    const stored = s.groups ? Number(s.groups[String(tab.windowId)]) : NaN;
    if (Number.isInteger(stored) && stored >= 0) {
      const g = await chrome.tabGroups.get(stored).catch(() => null);
      if (g && g.windowId === tab.windowId && g.title === title) gid = g.id;
    }
    if (gid == null) {
      const inWindow = await chrome.tabGroups.query({ windowId: tab.windowId }).catch(() => []);
      const hit = (inWindow || []).find((g) => g.title === title);
      if (hit) gid = hit.id;
    }
    if (gid != null && tab.groupId === gid) { await rememberGroup(sessionId, tab.windowId, gid); await clearGroupRetry(sessionId, tab.id); await clearGroupError(sessionId); return; }
    if (gid != null) await chrome.tabs.group({ groupId: gid, tabIds: [tab.id] });
    else {
      // Claude's groupTabInOwnWindow shape: name the tab's own window
      // explicitly when the group is created.
      gid = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
      await chrome.tabGroups.update(gid, { title, color: groupColor(s.chatName) });
    }
    await rememberGroup(sessionId, tab.windowId, gid);
    await clearGroupRetry(sessionId, tab.id);
    await clearGroupError(sessionId);
  } catch (e) {
    const msg = String((e && e.message) || e);
    let wtype = "";
    try { const w = await chrome.windows.get(tab.windowId); if (w && w.type) wtype = String(w.type); } catch (err) {}
    // Failure classification decides the response, as in Claude's
    // manager: a TRANSIENT refusal (the tab is being dragged, Chrome is
    // mid-edit) is recorded and retried later — nothing is moved. A
    // REFUSING window (not a normal window, or Chrome's "grouping is
    // not supported" for this window) is not sat in and retried: the
    // tab moves somewhere grouping works. Any other error is recorded
    // with its real text and retried by the lifecycle hooks.
    const transient = /drag|cannot be edited right now|may be editing/i.test(msg);
    const refusing = !transient && ((wtype !== "" && wtype !== "normal") || /not supported/i.test(msg));
    if (refusing && await groupTabViaOwnWindow(sessionId, tab, msg)) return;
    await markGroupRetry(sessionId, tab.id);
    await noteGroupFailure(sessionId, msg, wtype);
    await audit(chat, "tab group", P.clip(msg + (wtype ? " (window type: " + wtype + ")" : ""), 200),
      "grouping failed; the tab stays shared and ungrouped").catch(() => {});
  }
}
// Tabs with a window move in flight: the move's own detach/attach events
// must not be read by the membership sync as "groupless = left" while
// the tab is between windows.
const ownWindowMoves = new Set();
// The escape from a window that refuses groups (Claude's model: never
// sit retrying in a window that refuses). The tab joins the session's
// group in another window if one exists — grouping a tab into a group
// elsewhere moves the tab there — and otherwise gets a window of its
// own and starts the group there. Every move is written to the event
// record with the refusal that caused it: visible, never silent.
// Returns true when the tab ended up grouped.
async function groupTabViaOwnWindow(sessionId, tab, causeMsg) {
  if (ownWindowMoves.has(tab.id)) return false;
  const s0 = (await getSessions())[sessionId];
  if (!s0) return false;
  if (s0.groupMoved && s0.groupMoved[String(tab.id)]) return false; // one move per tab per session
  ownWindowMoves.add(tab.id);
  try {
    const title = groupTitle(s0);
    const host = P.hostOf(tab.url);
    let gid = null;
    for (const [w, id] of Object.entries(s0.groups || {})) {
      if (Number(w) === tab.windowId) continue;
      const g = await chrome.tabGroups.get(Number(id)).catch(() => null);
      if (g && g.title === title) { gid = g.id; break; }
    }
    if (gid == null) {
      const all = await chrome.tabGroups.query({ title }).catch(() => []);
      const hit = (all || []).find((g) => g.windowId !== tab.windowId);
      if (hit) gid = hit.id;
    }
    if (gid != null) {
      await chrome.tabs.group({ groupId: gid, tabIds: [tab.id] });
      const now = await chrome.tabs.get(tab.id).catch(() => null);
      if (now) await rememberGroup(sessionId, now.windowId, gid);
      await clearGroupRetry(sessionId, tab.id);
      await clearGroupError(sessionId);
      await markGroupMoved(sessionId, tab.id);
      await audit(s0.chatName, "tab moved", host,
        "moved into this chat's group in another window — this tab's window refused grouping (" + P.clip(causeMsg, 100) + ")").catch(() => {});
      notifyPanel();
      return true;
    }
    const win = await chrome.windows.create({ tabId: tab.id, type: "normal", focused: false });
    if (!win || win.id == null) return false;
    gid = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: win.id } });
    await chrome.tabGroups.update(gid, { title, color: groupColor(s0.chatName), collapsed: false });
    await rememberGroup(sessionId, win.id, gid);
    await clearGroupRetry(sessionId, tab.id);
    await clearGroupError(sessionId);
    await markGroupMoved(sessionId, tab.id);
    await audit(s0.chatName, "tab moved", host,
      "moved to its own window so Chrome can hold this chat's tab group — the old window refused grouping (" + P.clip(causeMsg, 100) + ")").catch(() => {});
    notifyPanel();
    return true;
  } catch (e) {
    return false;
  } finally {
    ownWindowMoves.delete(tab.id);
  }
}
// Take a tab out of its session's group (release paths). Only a group
// that still carries that chat's title is touched: a tab Daniel moved
// into a group of his own keeps that group when the session lets go.
async function ungroupTab(tabId, chatName) {
  try {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || t.groupId == null || t.groupId === -1) return;
    if (chatName) {
      const g = await chrome.tabGroups.get(t.groupId).catch(() => null);
      if (!g || g.title !== `Muse · ${chatName}`) return;
    }
    await chrome.tabs.ungroup(tabId);
  } catch (e) { /* the tab or its group is already gone */ }
}
// Re-evaluate one tab's group membership against live state: the single
// place drag-in adoption and drag-out release happen. Serialised on one
// chain so overlapping events (our own group/ungroup calls fire the same
// events) settle in order; an event that agrees with current state is a
// no-op, which is what makes listening to our own calls safe.
function syncTabGroupMembership(tabId) {
  return serial("groupSync", async () => {
    tabId = Number(tabId);
    // A tab between windows (its own-window move is in flight) reads as
    // groupless for a moment; that is not leaving, and not adoptable.
    if (ownWindowMoves.has(tabId)) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    const sessions = await getSessions();
    let groupSid = null;
    if (tab.groupId != null && tab.groupId !== -1) {
      const g = await chrome.tabGroups.get(tab.groupId).catch(() => null);
      if (g && g.windowId === tab.windowId) {
        for (const [sid, s] of Object.entries(sessions)) {
          if (s.groups && Number(s.groups[String(tab.windowId)]) === tab.groupId && groupTitle(s) === g.title) { groupSid = sid; break; }
        }
        if (!groupSid) for (const [sid, s] of Object.entries(sessions)) if (groupTitle(s) === g.title) { groupSid = sid; break; }
      }
    }
    const ownerSid = memOwner.get(tabId) || (await ownerOf(tabId));
    if (groupSid && groupSid !== ownerSid) {
      // Daniel moved this tab into a chat's group: adopt it, with the
      // same checks as the panel's Add tab (web page only, attachTab
      // transfer, the tab's site granted to the adopting chat).
      const s = sessions[groupSid];
      if (!s) return;
      if (!P.isWebUrl(tab.url)) {
        try { await chrome.tabs.ungroup(tab.id); } catch (e) {}
        await audit(s.chatName, "tab refused", P.hostOf(tab.url) || "a non-web page", "not a web page; taken back out of the group");
        return;
      }
      // Adoption must be verified, never assumed: a silent failure here
      // left a tab sitting in the group, unregistered, with no trace
      // (Daniel, 2026-10-18). Any failure now lands in the audit log.
      let adopted = false;
      try {
        await attachTab(groupSid, tab);
        adopted = (await ownerOf(tab.id)) === groupSid;
      } catch (e) {
        await audit(s.chatName, "tab refused", P.hostOf(tab.url) || "tab",
          "moved into the group but could not be taken over (" + ((e && e.name) || "error") + ")").catch(() => {});
        return;
      }
      if (!adopted) {
        await audit(s.chatName, "tab refused", P.hostOf(tab.url) || "tab",
          "moved into the group but the takeover did not hold").catch(() => {});
        return;
      }
      const host = P.hostOf(tab.url);
      await withState((st) => { if (st[groupSid]) st[groupSid].sites[host] = true; });
      await audit(s.chatName, "tab added", host, "moved into the group by you");
      notifyPanel();
    } else if (!groupSid && ownerSid) {
      const retryMark = sessions[ownerSid] && sessions[ownerSid].groupRetry
        ? Number(sessions[ownerSid].groupRetry[String(tabId)]) || 0 : 0;
      if (retryMark > 0) {
        // Grouping failed when this tab was shared, so it never landed
        // in its group: being groupless is not leaving. Never release
        // it for that; retry grouping instead (bounded by the mark),
        // so the tab heals itself once Chrome accepts the group (for
        // example after the tab is moved to a window that allows them).
        if (retryMark <= GROUP_RETRY_MAX) await groupTab(ownerSid, tab);
      } else {
        // The tab left its chat's group (ungrouped, moved to another
        // group, or moved to another window): the session loses it now.
        const chat = await releaseTab(tabId);
        if (chat) { await audit(chat, "tab removed", "left the group", "ok"); notifyPanel(); }
      }
    } else if (groupSid && groupSid === ownerSid) {
      await rememberGroup(groupSid, tab.windowId, tab.groupId);
      // Confirmed in its group (possibly put there by Daniel's own
      // drag): any recorded grouping failure for this chat is stale.
      await clearGroupRetry(groupSid, tabId);
      await clearGroupError(groupSid);
    }
  }).catch(() => {});
}
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info && info.groupId !== undefined) {
    syncTabGroupMembership(tabId);
    // Same late-state guard as onAttached: a drag can report a passing
    // groupId (or none) before the tab settles. Re-check shortly after;
    // the sync is idempotent.
    setTimeout(() => syncTabGroupMembership(tabId), 1200);
    setTimeout(() => syncTabGroupMembership(tabId), 4000);
  }
  if (info && info.status === "complete") retryGrouping(tabId).catch(() => {});
});
// Lifecycle reconciliation (Claude's manager reconciles its tracking
// against live Chrome state on change — not only on group-shaped
// events). Before v2.7.1 the ONLY retry driver was the membership sync,
// which fires on group events a never-grouped tab never produces: a tab
// that failed grouping at share time and then just sat there was never
// retried, and nothing anywhere said so. A failed tab now gets another
// try at the moments its window may have settled — activation, load
// complete (above), window focus — bounded by the same mark.
async function retryGrouping(tabId) {
  tabId = Number(tabId);
  if (ownWindowMoves.has(tabId)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const sid = memOwner.get(tabId) || (await ownerOf(tabId));
  if (!sid) return;
  const s = (await getSessions())[sid];
  if (!s) return;
  const mark = s.groupRetry ? Number(s.groupRetry[String(tabId)]) || 0 : 0;
  if (mark < 1) {
    // No failure on record: nothing to heal. A tab that sits in a group
    // still goes through the sync, which is what follows group-id
    // rotation and adopts an orphaned group carrying the chat's title
    // (one our cache lost) when an event was missed.
    if (tab.groupId != null && tab.groupId !== -1) syncTabGroupMembership(tabId);
    return;
  }
  if (mark > GROUP_RETRY_MAX) return; // bounded: stopped; the panel state says so
  if (tab.groupId != null && tab.groupId !== -1) {
    const g = await chrome.tabGroups.get(tab.groupId).catch(() => null);
    if (g && g.title === groupTitle(s)) {
      await rememberGroup(sid, tab.windowId, tab.groupId);
      await clearGroupRetry(sid, tabId);
      await clearGroupError(sid);
    }
    return; // in some other group: the sync's adopt/release rules own that case
  }
  await groupTab(sid, tab);
}
chrome.tabs.onActivated.addListener((info) => {
  if (info && info.tabId != null) retryGrouping(info.tabId).catch(() => {});
});
if (chrome.windows && chrome.windows.onFocusChanged) chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId == null || windowId < 0) return; // no window focused
  (async () => {
    const ts = await chrome.tabs.query({ windowId }).catch(() => []);
    for (const t of ts) await retryGrouping(t.id);
  })().catch(() => {});
});
if (chrome.tabs.onAttached) chrome.tabs.onAttached.addListener((tabId) => {
  syncTabGroupMembership(tabId);
  // A cross-window drag can land the tab in its new window before Chrome
  // reports the group id; the sync above then sees no group and does
  // nothing, and no second event may follow. Re-check shortly after —
  // the sync is idempotent, so a needless re-check costs nothing.
  setTimeout(() => syncTabGroupMembership(tabId), 1200);
  setTimeout(() => syncTabGroupMembership(tabId), 4000);
});
chrome.tabGroups.onUpdated.addListener(async (g) => {
  // A rename can make a group a session's group, or stop it being one:
  // re-evaluate every tab in it.
  const members = await chrome.tabs.query({ groupId: g.id }).catch(() => []);
  for (const t of members) await syncTabGroupMembership(t.id);
});
chrome.tabGroups.onRemoved.addListener(async (g) => {
  const sessions = await getSessions();
  for (const [sid, s] of Object.entries(sessions)) {
    if (!s.groups || !Object.values(s.groups).map(Number).includes(g.id)) continue;
    // Rotation race: Chrome may recreate a group under a new id and
    // remove the old one before the membership sync reads the cache —
    // the sync then follows the new id but rememberGroup finds no
    // previous id to trace. So: find the candidate first (a tab of this
    // chat already sitting in this window in a group carrying the
    // chat's title under a different id), then let the state write
    // below decide who traces it. Both writes ride the same serial
    // chain: if rememberGroup's overwrite landed first, this delete
    // finds nothing for this window and the sync's trace stands; if
    // this delete lands first, rememberGroup finds no previous id and
    // this trace stands. Exactly one, either way.
    let rotatedTo = null;
    for (const id of tabIdsOf(s)) {
      const t = await chrome.tabs.get(id).catch(() => null);
      if (!t || t.windowId !== g.windowId || t.groupId == null || t.groupId === -1 || t.groupId === g.id) continue;
      const ng = await chrome.tabGroups.get(t.groupId).catch(() => null);
      if (ng && ng.title === groupTitle(s)) { rotatedTo = t.groupId; break; }
    }
    const removedHere = await withState((st) => {
      const v = st[sid];
      let hit = false;
      if (v && v.groups) for (const w of Object.keys(v.groups)) if (Number(v.groups[w]) === g.id) { delete v.groups[w]; if (Number(w) === g.windowId) hit = true; }
      return hit;
    });
    if (rotatedTo != null && removedHere) {
      await audit(s.chatName, "tab group", "the group id for this window changed (" + g.id + " → " + rotatedTo + "); following the new id", "ok").catch(() => {});
    }
    for (const id of tabIdsOf(s)) syncTabGroupMembership(id);
  }
});
// At browser startup, re-adopt the tabs still sitting in a session's
// named group (see the onStartup handler below and DESIGN-GROUPS.md):
// the group and its title survive a restart even though tab ids do not.
// Site checks re-run: only a web page whose host is still one of the
// session's permitted sites comes back; anything else is taken out of
// the group, with an audit line, and nothing is granted here.
async function adoptGroupTabsAtStartup() {
  const sessions = await getSessions();
  for (const [sid, s] of Object.entries(sessions)) {
    const found = await chrome.tabGroups.query({ title: groupTitle(s) }).catch(() => []);
    for (const g of found || []) {
      const members = await chrome.tabs.query({ groupId: g.id }).catch(() => []);
      for (const tab of members) {
        const host = P.hostOf(tab.url);
        if (!P.isWebUrl(tab.url) || !own(s.sites, host)) {
          await ungroupTab(tab.id, s.chatName);
          await audit(s.chatName, "tab not restored", host || "a non-web page", "still in the group at startup, but its site is not permitted");
          continue;
        }
        await attachTab(sid, tab);
        await audit(s.chatName, "tab restored", host, "still in the group at startup");
      }
    }
  }
  notifyPanel();
}

// Show (chat name) or remove (null) the pill in a tab. Pages the extension
// cannot script (chrome://, the Web Store) just get no pill.
// The draw path asserts ownership itself: the tab must currently belong to
// a session whose chat name is the one the pill would show, so a caller
// bug cannot draw a pill on a tab no chat owns (or on another chat's tab).
// The assert runs before the first injection AND again after it resolves,
// immediately before the injection that actually draws the pill: ownership
// can be released while the first injection is in flight, and a single
// early check would let the stale draw land after that release's removal.
// The removal path (null) is exempt: callers remove the pill only after
// the tab has already been released, so it is unowned by then by design.
async function pill(tabId, chat) {
  try {
    if (chat) {
      const owned = async () => Object.values(await getSessions()).some(
        (v) => v.chatName === chat && v.tabs && own(v.tabs, String(tabId)));
      if (!(await owned())) return;
      await chrome.scripting.executeScript({ target: { tabId }, files: ["pill.js"] });
      if (!(await owned())) return;
    }
    await chrome.scripting.executeScript({ target: { tabId }, func: (n) => { if (window.__museBridgePill) window.__museBridgePill(n); }, args: [chat] });
    if (chat) void cursor(tabId, { op: "warm" }); // the cursor script rides along with the pill
  } catch (e) { /* not scriptable */ }
}

/* ------------------------------------------------------- on-page cursor */
// The visible hand of the bridge. Claude in Chrome is seen working: its
// cursor travels across the page, the page scrolls, then the click lands.
// This bridge used to act invisibly — a CDP press out of nowhere. The
// cursor script (cursor.js) lives beside the pill in the same overlay
// layer; the helpers below drive it. Presentation is best-effort by
// design: a page that refuses scripts, or a tab that went away mid-glide,
// simply gets no show — the action itself is never failed by it.
const cursorReady = new Map(); // tabId -> url the cursor script was injected into
async function cursor(tabId, cmd) {
  try {
    if (!cmd) { // removal needs no live tab record and no injection
      await chrome.scripting.executeScript({ target: { tabId },
        func: (c) => { if (window.__museBridgeCursor) return window.__museBridgeCursor(c); }, args: [null] }).catch(() => {});
      cursorReady.delete(tabId);
      return;
    }
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return;
    if (cursorReady.get(tabId) !== t.url) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["cursor.js"] });
      cursorReady.set(tabId, t.url);
    }
    await chrome.scripting.executeScript({ target: { tabId },
      func: (c) => { if (window.__museBridgeCursor) return window.__museBridgeCursor(c); }, args: [cmd] });
  } catch (e) { /* not scriptable: no show */ }
}
// Glide the cursor to a viewport point; pulse rings the point the way a
// click lands. Resolves when the glide has finished on screen, so callers
// fire the real action only after the user has seen the cursor arrive.
async function cursorGo(tabId, x, y, pulse) {
  await cursor(tabId, { op: "go", x: Math.round(x), y: Math.round(y), pulse: !!pulse });
}
// Keep each tab's recorded site current, and re-draw the pill after a page load.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!info.url && info.status !== "complete") return;
  const sid = await ownerOf(tabId);
  if (!sid) return;
  if (info.url) await withState((st) => { if (st[sid] && st[sid].tabs && own(st[sid].tabs, String(tabId))) st[sid].tabs[String(tabId)] = P.hostOf(info.url); });
  if (info.status === "complete") pill(tabId, (await getSessions())[sid].chatName);
});
// A new tab is auto-attached to a chat only when its opener is a tab that
// chat owns AND the new tab's initial host equals the opener tab's host: a
// same-host popup or target=_blank link from a shared tab joins that chat.
// Anything else — a cross-host popup, a popup from an unshared tab, a blank
// or non-web tab, or a new tab on a browser page (Ctrl+T, the + button) —
// stays unshared until the user shares it. It grants no site beyond the
// opener's host: a new site still asks.
const lastInput = new Map(); // tabId -> time the chat last clicked or typed there
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId == null) return;
  const u = tab.pendingUrl || tab.url || "";
  if (!P.isWebUrl(u)) return;
  const sid = await ownerOf(tab.openerTabId);
  if (!sid) return;
  const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
  const s = (await getSessions())[sid];
  const recorded = s && s.tabs ? s.tabs[String(tab.openerTabId)] : "";
  const openerHost = P.hostOf((opener && opener.url) || "") || recorded || "";
  if (!openerHost || P.hostOf(u) !== openerHost) return;
  await attachTab(sid, { ...tab, url: u });
});

async function shareableTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !P.isWebUrl(tab.url)) throw fail("not_shareable", "only http and https pages can be shared");
  return tab;
}

async function addTab(sessionId, tabId) {
  const s = own(await getSessions(), sessionId) ? (await getSessions())[sessionId] : null;
  if (!s) throw fail("session_not_found", "that chat is no longer connected");
  const tab = await shareableTab(tabId);
  // Already this chat's tab: nothing to share, and no confirmation —
  // the grant for it was given when it was first shared.
  if (own(s.tabs || {}, String(tabId))) return;
  // v2.7: the share completes only on the ONE full-control
  // confirmation. Until the user allows it, the tab is not shared.
  try { await confirmShare(sessionId, s.chatName, tab); }
  catch (e) {
    await audit(s.chatName, "tab not shared", P.hostOf(tab.url), "refused: " + ((e && e.code) || "canceled")).catch(() => {});
    return;
  }
  // The tab may have moved while the card was up: share what it is now
  // only if it is still on the site the card named.
  const now = await chrome.tabs.get(tabId).catch(() => null);
  if (!now || !P.isWebUrl(now.url) || P.hostOf(now.url) !== P.hostOf(tab.url)) {
    await audit(s.chatName, "tab not shared", P.hostOf(tab.url), "refused: page_changed").catch(() => {});
    return;
  }
  // Synchronous, before the next await: giving this tab to another chat
  // ends the previous chat's claim in this same tick (see attachTab) —
  // attachTab itself is only reached after awaits below, so an Allow
  // racing this transfer would otherwise settle first. The mirror is
  // moved by attachTab when the transfer actually happens.
  const memPrev = memOwner.get(Number(tabId)) || null;
  if (memPrev && memPrev !== sessionId) {
    cancelTabWork(Number(tabId), sessionId);
    const ps = memTabs.get(memPrev);
    if (ps && ps.size === 1 && ps.has(Number(tabId))) cancelSessionPrompts(memPrev);
  }
  const host = P.hostOf(now.url);
  await attachTab(sessionId, now);
  await withState((st) => { if (st[sessionId]) st[sessionId].sites[host] = true; });
  await audit(s.chatName, "tab added", host, "by you");
  notifyPanel();
}

/* --------------------------------------------------------------- pairing */
async function startShare(tabId) {
  const tab = await shareableTab(tabId);
  if (!wsReady) throw fail("relay_offline", "the extension is not connected to the relay");
  const reqId = crypto.randomUUID();
  const dropped = [];
  await withShares((shares) => {
    for (const [rid, s] of Object.entries(shares)) if (s.tabId === tabId || s.expires < Date.now()) { dropped.push(rid); delete shares[rid]; }
    shares[reqId] = { tabId, host: P.hostOf(tab.url), title: tab.title || "", code: "", created: Date.now(), expires: Date.now() + 300000 };
  });
  // A replaced code stops counting toward the relay's open-code limit.
  if (dropped.length) relaySend({ t: "pair_cancel", reqIds: dropped });
  if (!relaySend({ t: "pair_request", reqId })) {
    await withShares((shares) => { delete shares[reqId]; });
    throw fail("relay_offline");
  }
  notifyPanel();
  return reqId;
}

const pairingNow = new Map(); // sessionId -> promise resolved when that id's onPaired finishes

async function onPaired(msg) {
  // The relay waits for paired_ack before it reports pair success: without
  // this, a "paired" message lost to a half-open socket leaves a phantom
  // session the extension never recorded.
  // A bad id's nack must carry no session id at all: String(["sess-A"])
  // is "sess-A", so forwarding a coerced non-string id would send a nack
  // carrying a real session's id. This refusal runs before the pairingNow
  // wait below, so such a nack can arrive while that session's legitimate
  // pairing is still in flight — and at the relay any paired_nack for an
  // id settles that id's pending pair_ack as a failure, killing the
  // legitimate pairing before its ack. An empty id is ignored there
  // (_settle_pair_ack returns on a falsy id). The same applies to the
  // prototype keys below, which are likewise never a real session id.
  const badSessionId = typeof msg.sessionId !== "string" || !msg.sessionId ||
    msg.sessionId === "__proto__" || msg.sessionId === "constructor" || msg.sessionId === "prototype";
  const ack = (ok, error) => relaySend({ t: ok ? "paired_ack" : "paired_nack",
    sessionId: badSessionId ? "" : msg.sessionId, ...(error ? { error: String(error).slice(0, 160) } : {}) });
  // Refuse an id that can never be a real session key before any lookup.
  // A non-string id defeats own(): ["sess-A"] is not a string, so it is
  // never seen as a duplicate, yet s[msg.sessionId] coerces it to "sess-A"
  // and overwrites that live session. "__proto__" is never stored as a
  // key either: assigning it sets the sessions object's prototype instead,
  // and attachTab then writes the attacker's tabs onto Object.prototype.
  // Nack only: no share is consumed and no revoke is sent.
  if (badSessionId) {
    await audit(msg.chatName, "pair", "bad session id", "refused: bad_session_id").catch(() => {});
    ack(false, "bad_session_id: sessionId must be a non-empty string and not a prototype key");
    return;
  }
  // A duplicate that arrives while the original pairing for this id is
  // still in flight must not act yet: the session is not persisted yet, so
  // the checks below cannot see it, and its why/revoke branch would revoke
  // the relay session the original is creating (and its nack would settle
  // the original's pending pair_ack as a failure). Wait for the original
  // to finish, then run the normal checks: if it created the session this
  // is a duplicate and is nacked below; if it failed, this message is
  // judged on its own like any other pairing attempt.
  while (pairingNow.has(msg.sessionId)) await pairingNow.get(msg.sessionId);
  let finishPairing;
  pairingNow.set(msg.sessionId, new Promise((r) => { finishPairing = r; }));
  try {
    // Attach-on-redeem: the relay marks the message attach: true when the
    // chat that redeemed the code presented the token of a session that
    // already exists. The share's tab joins THAT session — through the
    // same attachTab transfer as any other give, so a tab owned by another
    // chat moves under the existing rules — and the session keeps its id,
    // its tabs and its name; only the new tab's site is added. If the
    // session does not exist here (the relay still holds it but this
    // browser lost it), fall through: the normal pairing below creates it
    // under the relay's id and the two sides agree again.
    if (msg.attach === true && own(await getSessions(), msg.sessionId)) {
      const share = await withShares((shares) => { const s = shares[msg.reqId]; delete shares[msg.reqId]; return s; });
      const tab = share && await chrome.tabs.get(share.tabId).catch(() => null);
      const why = !share ? "share_not_found: that code's Share was cancelled or replaced by a newer code. Ask the user for the code now shown in the side panel."
        : !tab ? "tab_closed: the shared tab was closed. Ask the user to share the page again."
        : P.hostOf(tab.url) !== share.host ? `page_changed: the shared tab moved from ${share.host} to ${P.hostOf(tab.url) || "a non-web page"}. Ask the user to share it again.`
        : "";
      if (why) {
        // No revoke: the session is the chat's own live one, not a new
        // session this message created. Only the attach is refused.
        await audit(msg.chatName, "tab attach", share ? share.host : "unknown code", "refused: " + why.split(":")[0]);
        ack(false, why);
        return;
      }
      // v2.7: the tab joins only on the ONE full-control confirmation.
      // The pair resolves after it — the relay's ack window covers the
      // wait (SHARE_CONFIRM_MS < the relay's pair-ack timeout).
      try { await confirmShare(msg.sessionId, (await getSessions())[msg.sessionId].chatName, tab); }
      catch (e) {
        await audit(msg.chatName, "tab attach", share.host, "refused: " + ((e && e.code) || "canceled"));
        ack(false, shareRefusal(e));
        return;
      }
      await withState((st) => { if (st[msg.sessionId]) st[msg.sessionId].sites[share.host] = true; });
      await attachTab(msg.sessionId, tab);
      await audit(msg.chatName, "tab added", share.host, "by code");
      ack(true);
      return;
    }
    // A replayed paired for a session that already exists must not replace
    // the live session: overwriting it would reset the chat and orphan its
    // tabs. Nack it and leave the original record, its tabs and sites alone.
    // No revoke here: that sessionId is the live session's, not a new one.
    if (own(await getSessions(), msg.sessionId)) {
      await audit(msg.chatName, "pair", "session already exists", "refused: session_exists");
      ack(false, "session_exists: a session with this id is already connected; refusing to replace it");
      return;
    }
    const share = await withShares((shares) => { const s = shares[msg.reqId]; delete shares[msg.reqId]; return s; });
    const tab = share && await chrome.tabs.get(share.tabId).catch(() => null);
    const why = !share ? "share_not_found: that code's Share was cancelled or replaced by a newer code. Ask the user for the code now shown in the side panel."
      : !tab ? "tab_closed: the shared tab was closed. Ask the user to share the page again."
      : P.hostOf(tab.url) !== share.host ? `page_changed: the shared tab moved from ${share.host} to ${P.hostOf(tab.url) || "a non-web page"}. Ask the user to share it again.`
      : "";
    if (why) {
      // Re-check before revoking: if this id's session now exists (created
      // by a pairing that was in flight when this message arrived), this is
      // a duplicate, not a fresh refusal — revoking would kill the live
      // session at the relay. Nack it as a duplicate and send no revoke.
      if (own(await getSessions(), msg.sessionId)) {
        await audit(msg.chatName, "pair", "session already exists", "refused: session_exists");
        ack(false, "session_exists: a session with this id is already connected; refusing to replace it");
        return;
      }
      relaySend({ t: "revoke", sessionId: msg.sessionId }); // refuse the pairing
      await audit(msg.chatName, "pair", share ? share.host : "unknown code", "refused: " + why.split(":")[0]);
      ack(false, why);
      return;
    }
    // v2.7: the pairing completes only on the ONE full-control
    // confirmation. Until the user allows it, no session is created
    // and the tab is not shared; the relay waits for this ack (its
    // pair-ack window covers the confirmation's 90 s).
    try { await confirmShare(msg.sessionId, P.clip(msg.chatName || "chat", 40), tab); }
    catch (e) {
      if (own(await getSessions(), msg.sessionId)) {
        await audit(msg.chatName, "pair", "session already exists", "refused: session_exists");
        ack(false, "session_exists: a session with this id is already connected; refusing to replace it");
        return;
      }
      relaySend({ t: "revoke", sessionId: msg.sessionId }); // refuse the pairing
      await audit(msg.chatName, "pair", share.host, "refused: " + ((e && e.code) || "canceled"));
      ack(false, shareRefusal(e));
      return;
    }
    const chatName = P.clip(msg.chatName || "chat", 40);
    let duplicate = false;
    await withState((s) => {
      if (own(s, msg.sessionId)) { duplicate = true; return; }
      s[msg.sessionId] = { chatName, tabs: {}, sites: { [share.host]: true }, created: Date.now() };
    });
    memSyncSession(msg.sessionId, []);
    if (duplicate) {
      await audit(msg.chatName, "pair", share.host, "refused: session_exists");
      ack(false, "session_exists: a session with this id is already connected; refusing to replace it");
      return;
    }
    await attachTab(msg.sessionId, tab);
    await audit(chatName, "paired", share.host, "connected");
    ack(true);
  } catch (e) {
    ack(false, "pair_failed: " + ((e && e.message) || e));
  } finally {
    // Release any duplicate waiting on this id only after everything
    // above (including the ack) has completed, so it re-checks against
    // the final state and its nack cannot settle this pairing at the relay.
    pairingNow.delete(msg.sessionId);
    finishPairing();
  }
}

async function dropSession(sessionId, { tellRelay, why }) {
  if (typeof sessionId !== "string") return;
  memDropSession(sessionId);
  const removed = await withState((s) => { const r = s[sessionId] || null; delete s[sessionId]; return r; });
  if (!removed) return;
  if (tellRelay) relaySend({ t: "revoke", sessionId }); // if offline, the next hello leaves it out and the relay drops it
  for (const [id, p] of pending) if (p.sessionId === sessionId) settle(id, false, "session_closed");
  for (const job of inflight.values()) if (job.sessionId === sessionId) job.canceled = true;
  liveViews.delete(sessionId); liveActivity.delete(sessionId);
  for (const id of tabIdsOf(removed)) { pill(id, null); void cursor(id, null); forgetTabView(id); await ungroupTab(id, removed.chatName); await detach(id); }
  await audit(removed.chatName, "disconnected", why || "", "ok");
}

// Daniel's rule (2026-10-18): a chat with no tabs is not connected. When a
// session's last tab goes — closed, removed, dragged out of its group, or
// taken by another chat — the session ends: the relay is told, the token
// dies, and the chat pairs again with a new code when it needs a tab.
// No 0-tab sessions linger in the panel.
async function dropIfEmpty(sessionId, why) {
  const s = (await getSessions())[sessionId];
  if (!s || tabIdsOf(s).length) return;
  await dropSession(sessionId, { tellRelay: true, why });
}


// A tab that is added to a chat's tab list by the user, or opened from
// one of the chat's tabs, grants NOTHING. Sites are
// permitted only by Share or by an explicit Allow in the side panel.

chrome.tabs.onRemoved.addListener((tabId) => {
  // A closed tab leaves its chat just like a panel removal: its pending
  // prompts are settled and its in-flight commands are marked canceled,
  // so a result that finishes after the close is dropped, not delivered.
  // (A command closing its own tabs — tabs_close — is exempt for the
  // tabs it is closing; see job.closing in cancelTabWork.)
  cancelTabWork(tabId, null);
  // Same tick, via the mirror: if this was the chat's last tab, settle
  // its tabless prompts now too — the state write below is async, and
  // an Allow racing the close must not beat it (see releaseTab).
  const memOwnerSid = memRemove(tabId);
  if (memOwnerSid) cancelIfSessionEmpty(memOwnerSid);
  detach(tabId); dropRefs(tabId); worlds.delete(tabId); forgetTabView(tabId);
  withState((st) => {
    const owners = [];
    for (const [sid, v] of Object.entries(st)) if (v.tabs && own(v.tabs, String(tabId))) { owners.push(sid); delete v.tabs[String(tabId)]; }
    return owners;
  }).then(async (owners) => { for (const sid of owners) { await cancelIfNoTabs(sid); await dropIfEmpty(sid, "last tab closed"); } }).catch(() => {});
});

/* -------------------------------------------------------------- commands */
const inflight = new Map(); // cmdId -> {id, sessionId, action, deadline, canceled, tabs:Set<tabId>}

// Record a tab a command is acting on, so removing or transferring that
// tab can cancel the command (cancelTabWork) and any prompt it opened.
function noteJobTab(ctx, tabId) {
  if (tabId == null || !Number.isFinite(Number(tabId))) return;
  tabId = Number(tabId);
  if (ctx) { ctx.tabId = tabId; noteActivity(ctx.sessionId, tabId); }
  if (ctx && ctx.job) (ctx.job.tabs || (ctx.job.tabs = new Set())).add(tabId);
}

function persistInflight() {
  return serial("inflight", async () => {
    const all = await local.get("inflight", {});
    for (const id of Object.keys(all)) if (all[id] === WORKER_ID && !inflight.has(id)) delete all[id];
    for (const id of inflight.keys()) all[id] = WORKER_ID;
    await local.set("inflight", all);
  }).catch(() => {});
}
function cancelCommand(id) {
  const job = inflight.get(id);
  if (!job) return;
  job.canceled = true;
  for (const [pid, p] of pending) if (p.cmdId === id) settle(pid, false, "canceled");
}
// Called before anything that changes the page, and after every prompt.
function checkLive(ctx) {
  if (!ctx.job) return;
  if (ctx.job.canceled) throw fail("canceled", "the relay stopped waiting for this call");
  if (Date.now() > ctx.job.deadline) throw fail("deadline_passed", "the relay has stopped waiting for this call");
}
function errOf(e) {
  const out = { ok: false, error: (e && e.code) || "error" };
  if (e && e.detail) out.detail = P.clip(e.detail, 300);
  else if (!(e && e.code)) out.detail = P.clip(e && e.message, 300);
  return out;
}

async function onCommand(msg) {
  const id = String(msg.id || "");
  const job = { id, sessionId: msg.sessionId, canceled: false,
                deadline: Date.now() + clamp(Number(msg.ttlMs) || DEFAULT_TTL_MS, 5000, 600000) - 1500 };
  const reply = (out) => {
    inflight.delete(id); persistInflight();
    relaySend({ t: "result", id, ...out });
  };
  msg.action = toolName(msg.action);
  if (!own(TOOLS, msg.action)) return reply(unknownTool(msg.action));
  job.action = msg.action; job.tabs = new Set();
  inflight.set(id, job); persistInflight();
  let ctx;
  try { ctx = await sessionCtx(msg.sessionId); }
  catch (e) { return reply(errOf(e)); }
  ctx.job = job;
  try {
    const data = await TOOLS[msg.action](ctx, msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {});
    // The tab (or the session) went away while this ran: the caller gets
    // a cancellation, never the data the command gathered.
    if (job.canceled) return reply({ ok: false, error: "canceled", detail: job.canceledByTab ? "the tab was removed or transferred, or the chat disconnected, while this call was running" : "the relay stopped waiting for this call" });
    const out = { ok: true, data };
    const s = JSON.stringify(out);
    if (s.length > MAX_RESULT_BYTES / 4 && new TextEncoder().encode(s).length > MAX_RESULT_BYTES) {
      return reply({ ok: false, error: "result_too_large", detail: "narrow it: max_chars, ref_id, a smaller zoom region, or fewer items per batch" });
    }
    reply(out);
  } catch (e) {
    const out = errOf(e);
    if (job.canceledByTab && out.error !== "session_closed") return reply({ ok: false, error: "canceled", detail: "the tab was removed or transferred, or the chat disconnected, while this call was running" });
    if (!["denied_by_user", "approval_timeout", "canceled"].includes(out.error)) console.warn(msg.action, out.error, out.detail || "");
    reply(out);
  }
}

/* ------------------------------------------------------------- approvals */
const pending = new Map(); // id -> {sessionId, cmdId, tabId, tabIds, hadTabs, chat, title, detail, url, created, expiresAt, resolve, timer}

// The tab(s) a pending prompt belongs to: the tabs its command has
// acted on so far, recorded by noteJobTab.
function promptTabs(p) {
  if (Array.isArray(p.tabIds) && p.tabIds.length) return p.tabIds;
  return p.tabId != null ? [p.tabId] : [];
}
// Cancel everything in flight for one tab: settle its pending prompts
// (so they disappear and a later Allow answers nothing) and mark its
// commands canceled (so onCommand drops a late result, and checkLive
// stops the work at its next step). Jobs of the chat receiving the tab
// (a transfer's destination) are spared. A job that is itself closing
// this tab (tabs_close, which records the tabs in job.closing just
// before chrome.tabs.remove) is spared for those tabs: its close is
// the action the user's chat asked for, not a removal from outside.
function cancelTabWork(tabId, exceptSessionId) {
  tabId = Number(tabId);
  for (const job of inflight.values()) {
    if (exceptSessionId && job.sessionId === exceptSessionId) continue;
    if (job.closing && job.closing.has(tabId)) continue;
    if (job.tabs && job.tabs.has(tabId)) { job.canceled = true; job.canceledByTab = true; }
  }
  for (const [pid, p] of [...pending]) {
    if (exceptSessionId && p.sessionId === exceptSessionId) continue;
    let hit = promptTabs(p).includes(tabId);
    if (!hit && p.cmdId) { const j = inflight.get(p.cmdId); if (j && j.tabs && j.tabs.has(tabId)) hit = true; }
    if (hit) {
      if (p.cmdId) { const j = inflight.get(p.cmdId); if (j) { j.canceled = true; j.canceledByTab = true; } }
      settle(pid, false, "canceled");
    }
  }
}
// Settle every prompt a chat still has open and mark the commands
// behind them canceled, so a late result is dropped.
function cancelSessionPrompts(sessionId) {
  for (const [pid, p] of [...pending]) {
    if (p.sessionId !== sessionId) continue;
    if (p.cmdId) { const j = inflight.get(p.cmdId); if (j) { j.canceled = true; j.canceledByTab = true; } }
    settle(pid, false, "canceled");
  }
}
// Synchronous form of the cancelIfNoTabs check below, judged from the
// in-memory mirror (memTabs) at the moment a removal or transfer begins:
// a chat the mirror shows has no tabs left loses its prompts in the
// same tick, so an Allow delivered alongside the removal finds nothing.
function cancelIfSessionEmpty(sessionId) {
  const set = memTabs.get(sessionId);
  if (set && !set.size) cancelSessionPrompts(sessionId);
}
// A chat left with no tabs at all has nothing a prompt can act through:
// settle every prompt it still has open and mark the commands behind
// them canceled, so a late result is dropped. This also catches prompts
// that name no tab yet — e.g. navigate with no tabId asking to permit a
// new site, whose Allow would mint the chat a fresh tab (newTabInGroup
// falls back to the user's window when the chat has none). Called after a
// removal, transfer, or close has been written to state.
async function cancelIfNoTabs(sessionId) {
  if (!sessionId) return;
  const s = (await getSessions())[sessionId];
  if (s && tabIdsOf(s).length) return;
  cancelSessionPrompts(sessionId);
}

function ask(ctx, title, detail, url, opts) {
  checkLive(ctx);
  // opts.ms (share confirmations) replaces the usual 60 s cap: a person
  // reading a full-control grant gets longer, and the relay's pair-ack
  // window is sized to match (see confirmShare).
  const cap = (opts && opts.ms) || APPROVAL_MS;
  const left = ctx.job ? ctx.job.deadline - Date.now() : cap;
  if (left < MIN_ASK_MS) return Promise.reject(fail("no_time_to_ask", "too little time left in this call for the user to answer; send it again"));
  const ms = Math.min(cap, left - 1000);
  let entry;
  const promise = new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => settle(id, false, "approval_timeout"), ms);
    const tabIds = [...new Set([...(ctx.job && ctx.job.tabs ? [...ctx.job.tabs] : []),
                                ...(ctx.tabId != null ? [Number(ctx.tabId)] : [])])];
    // For a prompt that names no tab, remember whether the chat held
    // any tab when the prompt opened (from the mirror). If it did and
    // it holds none by the time the prompt is answered or the command
    // resumes, the chat was unshared in between: settle() refuses the
    // Allow and navigate refuses to mint it a new tab.
    const memSet = memTabs.get(ctx.sessionId);
    const hadTabs = memSet ? memSet.size > 0 : null;
    if (ctx.job && !tabIds.length) ctx.job.tablessHadTabs = hadTabs;
    entry = { sessionId: ctx.sessionId, cmdId: ctx.job ? ctx.job.id : "", tabId: tabIds.length ? tabIds[0] : null, tabIds, hadTabs,
              chat: ctx.chat, title, detail, shareKey: (opts && opts.shareKey) || null,
              url: url || "", created: Date.now(), expiresAt: Date.now() + ms, timer,
              resolve: (ok, code) => (ok ? resolve() : reject(fail(code))) };
    pending.set(id, entry);
    chrome.action.setBadgeText({ text: String(pending.size) }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: "#d97706" }).catch(() => {});
    chrome.notifications.create("mbb-" + id, {
      type: "basic", iconUrl: "icons/icon48.png", priority: 2, requireInteraction: true,
      title: `Muse · ${ctx.chat} is asking`, message: `${title}\n${detail}`.slice(0, 300),
    }).catch(() => {});
    notifyPanel();
  }).then(() => checkLive(ctx));
  if (entry) entry.promise = promise;
  return promise;
}

/* ------------------------------------------------- v2.7: share = consent */
// Daniel's rule (2026-10-28): sharing a tab with a chat IS the consent
// for that tab. The share itself now carries ONE confirmation — the card
// below, in plain words — and after it, no action inside that tab asks
// again: clicks, typing (password fields included), Enter, submits,
// uploads and new sites all proceed. What used to prompt is written to
// the panel's event record instead (noteSharedAction): the record
// stays, the questions go. The walls are unchanged and never prompted
// anyway: per-chat isolation, read-side redaction, and the outright
// refusal of credential-store uploads.
const SHARE_CONFIRM_MS = 90000; // the relay waits 100 s for the pair ack
function confirmShare(sessionId, chat, tab) {
  // Exactly one card per share: a second landing for the same tab+chat
  // while a card is up joins the same answer instead of stacking cards.
  const key = sessionId + ":" + tab.id;
  for (const p of pending.values()) if (p.shareKey === key && p.promise) return p.promise;
  const host = P.hostOf(tab.url);
  return ask({ sessionId, chat, tabId: tab.id, job: null },
    `Give "${chat}" full control of this tab?`,
    `On ${host}, "${chat}" will be able to click, type (password fields included), press Enter, send and submit, take actions that may pay, order or delete, upload files, and open other sites in this tab — with no more questions in this tab. This lasts while the tab is shared; you can stop sharing at any time.`,
    tab.url, { ms: SHARE_CONFIRM_MS, shareKey: key });
}
// The nack text when a share's confirmation does not complete.
function shareRefusal(e) {
  const code = (e && e.code) || "canceled";
  if (code === "denied_by_user") return "denied_by_user: the user did not confirm giving this chat full control of the tab. Ask them to share the page again and tap Allow.";
  if (code === "approval_timeout") return "approval_timeout: the full-control confirmation in the side panel was not answered in time. Ask the user to share the page again.";
  return "share_not_confirmed: the full-control confirmation for this tab did not complete (" + code + "). Ask the user to share the page again.";
}
// An action that would once have opened a prompt is recorded in the
// panel's event log instead, with the same words the prompt would have
// used, and proceeds.
async function noteSharedAction(ctx, title, detail) {
  await audit(ctx.chat, title, detail, "no prompt: full control");
}
function settle(id, allow, code) {
  const p = pending.get(id);
  if (!p) return;
  // Last synchronous guard on an Allow: a tabless prompt that opened
  // while its chat still held a tab must not be answered into an action
  // once the mirror shows the chat holds no tab at all — its tabs were
  // unshared while the user was deciding, whatever order the removal and
  // this Allow arrived in. (A prompt that opened while the chat was
  // already tabless is the user's fresh decision and is left alone.)
  if (allow && !promptTabs(p).length && p.hadTabs === true) {
    const set = memTabs.get(p.sessionId);
    if (set && !set.size) {
      allow = false; code = "canceled";
      if (p.cmdId) { const j = inflight.get(p.cmdId); if (j) { j.canceled = true; j.canceledByTab = true; } }
    }
  }
  clearTimeout(p.timer);
  pending.delete(id);
  chrome.notifications.clear("mbb-" + id).catch(() => {});
  chrome.action.setBadgeText({ text: pending.size ? String(pending.size) : "" }).catch(() => {});
  audit(p.chat, "prompt: " + p.title, p.detail, allow ? "allowed" : code);
  p.resolve(allow, allow ? null : code || "denied_by_user");
  notifyPanel();
}
chrome.notifications.onClicked.addListener(async () => {
  const w = await chrome.windows.getLastFocused().catch(() => null);
  if (w) chrome.sidePanel.open({ windowId: w.id }).catch(() => {});
});

/* ----------------------------------------------------------- debugger/CDP */
const attached = new Map(); // tabId -> lastUse
const attaching = new Map();
const focusEmuTabs = new Set(); // tabIds where focus emulation is currently on
const bridgeClicks = new Map(); // tabId -> {x, y, at} of the last press the bridge itself made

async function attach(tabId) {
  if (attached.has(tabId)) return;
  if (!attaching.has(tabId)) {
    attaching.set(tabId, (async () => {
      try { await chrome.debugger.attach({ tabId }, "1.3"); }
      catch (e) { if (!/already attached/i.test(String(e && e.message))) throw fail("input_unavailable", String(e && e.message)); }
      attached.set(tabId, Date.now());
    })().finally(() => attaching.delete(tabId)));
  }
  return attaching.get(tabId);
}
async function detach(tabId) {
  worlds.delete(tabId);
  const hadEmu = focusEmuTabs.delete(tabId);
  bridgeClicks.delete(tabId);
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  // Claude's detach order: end focus emulation first, then detach.
  if (hadEmu) {
    await withTimeout(chrome.debugger.sendCommand({ tabId },
      "Emulation.setFocusEmulationEnabled", { enabled: false }), 3000, "cdp_timeout").catch(() => {});
  }
  await chrome.debugger.detach({ tabId }).catch(() => {});
}
chrome.debugger.onDetach.addListener(async (src, reason) => {
  attached.delete(src.tabId); worlds.delete(src.tabId);
  focusEmuTabs.delete(src.tabId); bridgeClicks.delete(src.tabId);
  if (reason !== "canceled_by_user") return;
  // The user pressed Cancel on Chrome's "being debugged" bar: stop that chat.
  const sid = await ownerOf(src.tabId);
  if (sid) await dropSession(sid, { tellRelay: true, why: "stopped from Chrome's debugging bar" });
});

// Allow-list of CDP methods: every method a current call site in this file
// passes to cdp(). Anything else (e.g. Runtime.evaluate, Network.*,
// Storage.*) is refused here, so no future or indirect caller can reach
// arbitrary DevTools protocol methods through this dispatcher.
const CDP_METHODS = new Set([
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "DOM.describeNode",
  "DOM.focus",
  "DOM.getDocument",
  "DOM.getContentQuads",
  "DOM.getNodeForLocation",
  "DOM.resolveNode",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.setFileInputFiles",
  "Emulation.setFocusEmulationEnabled",
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.insertText",
  "Page.captureScreenshot",
  "Page.createIsolatedWorld",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Runtime.callFunctionOn",
]);

async function cdp(tabId, method, params, ms) {
  if (!CDP_METHODS.has(method)) throw fail("cdp_method_not_allowed", String(method));
  await attach(tabId);
  attached.set(tabId, Date.now());
  try {
    return await withTimeout(chrome.debugger.sendCommand({ tabId }, method, params || {}), ms || CDP_MS, "cdp_timeout");
  } catch (e) {
    // Name the step that hung: a bare cdp_timeout does not say which step failed.
    if (e.code === "cdp_timeout" && !e.detail) e.detail = method + (params && params.type ? " " + params.type : "");
    if (e.code) throw e;
    throw fail("page_error", method + ": " + String(e && e.message));
  }
}

// Focus emulation is a property of the tab session, not of one call:
// Claude in Chrome's CDP wrapper enables it before Input commands and
// ends it only at detach (detach() above disables it first, then
// detaches — Claude's order). A tab that is not in front has no keyboard
// focus and Chrome drops typed text while the call succeeds, so every
// input path enables it once per tab and leaves it on for the session.
async function ensureFocusEmulation(tabId) {
  if (focusEmuTabs.has(tabId)) return;
  focusEmuTabs.add(tabId);
  await cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true })
    .catch(() => { focusEmuTabs.delete(tabId); });
}
// A press the bridge made itself, remembered per tab: the type path
// uses it to tell "the click I just made focused a field my probe
// cannot see into" apart from "nothing is focused at all".
const BRIDGE_CLICK_MS = 120000;
function noteBridgeClick(tabId, x, y) { bridgeClicks.set(tabId, { x, y, at: Date.now() }); }
function recentBridgeClick(tabId) {
  const c = bridgeClicks.get(tabId);
  return !!c && Date.now() - c.at <= BRIDGE_CLICK_MS;
}

// Code we run in the page runs in an isolated world: page scripts cannot
// change what it sees. One world per document, reused until it navigates.
const worlds = new Map(); // tabId -> {frameId, loaderId, contextId}
async function worldFor(tabId, fresh) {
  const { frameTree } = await cdp(tabId, "Page.getFrameTree");
  const f = frameTree.frame;
  const c = worlds.get(tabId);
  if (!fresh && c && c.frameId === f.id && c.loaderId === f.loaderId) return c.contextId;
  const { executionContextId } = await cdp(tabId, "Page.createIsolatedWorld", { frameId: f.id, worldName: "muse_bridge" });
  worlds.set(tabId, { frameId: f.id, loaderId: f.loaderId, contextId: executionContextId });
  return executionContextId;
}
// Call a function in our isolated world, on a node (this = the node) or on
// the page. A world Chrome has discarded is replaced once and retried.
async function runInWorld(tab, backendNodeId, functionDeclaration, args) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const contextId = await worldFor(tab.id, attempt > 0);
    const params = { functionDeclaration, arguments: (args || []).map((value) => ({ value })), returnByValue: true };
    if (backendNodeId != null) {
      const r = await cdp(tab.id, "DOM.resolveNode", { backendNodeId, executionContextId: contextId }).catch((e) => ({ err: e }));
      if (r.err || !r.object || !r.object.objectId) { lastErr = fail("target_changed", "that element is gone; read_page again"); continue; }
      params.objectId = r.object.objectId;
    } else {
      params.executionContextId = contextId;
    }
    const r = await cdp(tab.id, "Runtime.callFunctionOn", params).catch((e) => ({ err: e }));
    if (r.err) { lastErr = r.err; continue; }
    if (r.exceptionDetails) throw fail("page_error", r.exceptionDetails.text);
    return r.result && r.result.value;
  }
  throw lastErr;
}
// Run the page probe; the result must come from a document on `host`.
async function probe(tab, host, mode, args, backendNodeId) {
  const out = await runInWorld(tab, backendNodeId, PROBE_SRC, [mode, { ...P.PROBE_ARGS, ...(args || {}) }]);
  if (!out || typeof out !== "object") throw fail("page_error", "probe returned nothing");
  if (out.host !== host) throw fail("tab_navigated", `the page moved to ${out.host || "another page"}`);
  return out.v;
}
// After reading through CDP (tree, screenshot), make sure the document we
// read is still on the permitted host.
async function assertHost(tab, host) {
  const { frameTree } = await cdp(tab.id, "Page.getFrameTree");
  if (P.hostOf(frameTree.frame.url) !== host) throw fail("tab_navigated", "the page moved while it was being read");
}

/* ---------------------------------------------------------- tab resolution */
async function sessionCtx(sessionId) {
  const all = await getSessions();
  const s = own(all, sessionId) ? all[sessionId] : null;
  if (!s) throw fail("session_not_found", "this chat is not connected; ask the user to share a page again");
  // First sight of this chat in this worker: seed the ownership mirror
  // from stored state. If the mirror already knows the chat it is the
  // fresher copy (removals update it synchronously, storage only after
  // an await), so it is never overwritten from storage here.
  if (!memTabs.has(sessionId)) memSyncSession(sessionId, tabIdsOf(s));
  return { sessionId, chat: s.chatName, lastTab: s.lastTab };
}
async function sitePermitted(ctx, host) {
  const s = (await getSessions())[ctx.sessionId];
  return !!(s && own(s.sites, host));
}
async function permitSite(ctx, host, why) {
  if (await sitePermitted(ctx, host)) return;
  // v2.7: a shared tab reaching a new site no longer asks — the share's
  // one confirmation already covered it. The site is granted and the
  // first use is written to the event record.
  await withState((s) => { if (s[ctx.sessionId]) s[ctx.sessionId].sites[host] = true; });
  await audit(ctx.chat, "site allowed", `${host} — ${why}`, "no prompt: full control");
}

// The tab this chat last worked in (opened, read, clicked, typed). A call with
// no tabId goes there: navigate opens tabs in the background, so the group's
// active tab is usually the page the user shared. Kept in the session record so
// a worker restart does not send the chat back to the user's tab.
async function rememberTab(ctx, tabId) {
  noteJobTab(ctx, tabId);
  if (ctx.lastTab === tabId) return;
  ctx.lastTab = tabId;
  await withState((s) => { if (own(s, ctx.sessionId)) s[ctx.sessionId].lastTab = tabId; });
}

// The one gate every tab action passes through. Checked live, every call.
async function resolveTab(ctx, tabId, { needSite = true, allowNonWeb = false, why = "" } = {}) {
  let tab;
  if (tabId == null) {
    const tabs = await sessionTabs(ctx.sessionId);
    tab = tabs.find((t) => t.id === ctx.lastTab) || tabs.find((t) => t.active) || tabs[0];
    if (!tab) throw fail("no_tabs", "this chat has no tabs; open one with navigate, or ask the user to give it a tab");
  } else {
    tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
    if (!tab) throw fail("no_tab");
  }
  if (!(await inSession(ctx, tab.id))) throw fail("tab_not_shared", "that tab is not one of this chat's tabs");
  // Register the tab before the site grant below (permitSite), so
  // removing or transferring the tab cancels this command.
  noteJobTab(ctx, tab.id);
  // A navigation still committing (first load, or a move to another site):
  // wait for it (bounded) instead of acting on a document that is leaving.
  const deadline = Date.now() + 10000;
  while (tab.pendingUrl && (!tab.url || P.hostOf(tab.pendingUrl) !== P.hostOf(tab.url)) && Date.now() < deadline) {
    await sleep(200);
    tab = await chrome.tabs.get(tab.id).catch(() => null);
    if (!tab) throw fail("no_tab");
    if (!(await inSession(ctx, tab.id))) throw fail("tab_not_shared");
  }
  if (!tab.url || (tab.pendingUrl && P.hostOf(tab.pendingUrl) !== P.hostOf(tab.url))) throw fail("tab_loading", "try again in a moment");
  if (!P.isWebUrl(tab.url)) {
    if (needSite && !allowNonWeb) throw fail("restricted_page", "not a web page (about:blank, chrome://, file://); navigate it first");
    await rememberTab(ctx, tab.id);
    return tab;
  }
  if (needSite) {
    const host = P.hostOf(tab.url);
    if (!(await sitePermitted(ctx, host))) {
      await permitSite(ctx, host, why || `The tab is on ${host}, which this chat has not used before.`);
      tab = await chrome.tabs.get(tab.id).catch(() => null);
      if (!tab || !(await inSession(ctx, tab.id)) || P.hostOf(tab.url) !== host) throw fail("tab_navigated");
    }
  }
  await rememberTab(ctx, tab.id);
  return tab;
}
// Re-check right before acting (after any prompt, and between keys).
// The site grant is re-tested live, not just tab ownership and host: if
// The user removed this tab's site while a prompt was up or between keys,
// the continuation fails closed instead of acting on the revoked site.
async function recheck(ctx, tab) {
  checkLive(ctx);
  const now = await chrome.tabs.get(tab.id).catch(() => null);
  if (!now) throw fail("no_tab");
  if (!(await inSession(ctx, now.id))) throw fail("tab_not_shared");
  if (P.hostOf(now.url) !== P.hostOf(tab.url)) throw fail("tab_navigated");
  if (P.isWebUrl(now.url)) {
    const host = P.hostOf(now.url);
    if (host && !(await sitePermitted(ctx, host))) throw fail("site_revoked", `the user removed ${host} from this chat`);
  }
  return now;
}

/* ------------------------------------------------------------------ refs */
// Refs are unique across tabs and extension reloads (the counter is in
// storage.local: chats survive a reload and keep the refs they were given),
// so a ref always names one element on one tab. The same element keeps its ref while
// its role and name stay the same; if either changes it gets a new ref, and
// the old one answers target_changed.
const refs = new Map();      // "ref_N" -> {tabId, b, role, name} | framed hit (below)
const nodeRefs = new Map();  // tabId -> Map(backendNodeId -> "ref_N")
const frameRefs = new Map(); // tabId -> Map("frameId|entryIndex" -> "ref_N")
let refSeq = 0;
const refSeqReady = local.get("refSeq", 0).then((n) => { refSeq = Math.max(refSeq, Number(n) || 0); }).catch(() => {});
function dropRefs(tabId) {
  const m = nodeRefs.get(tabId);
  if (m) for (const r of m.values()) refs.delete(r);
  nodeRefs.delete(tabId);
  const fm = frameRefs.get(tabId);
  if (fm) for (const r of fm.values()) refs.delete(r);
  frameRefs.delete(tabId);
}
function refFor(tabId, b, role, name) {
  let m = nodeRefs.get(tabId);
  if (m && m.size > 50000) { dropRefs(tabId); m = null; }
  if (!m) { m = new Map(); nodeRefs.set(tabId, m); }
  const old = m.get(b);
  if (old) { const h = refs.get(old); if (h && h.role === role && h.name === name) return old; }
  const ref = "ref_" + (++refSeq);
  refs.set(ref, { tabId, b, role, name });
  m.set(b, ref);
  return ref;
}
// A ref for an element inside a frame, from the all-frames read below.
// It carries no backend node id — the root world cannot resolve framed
// nodes — so it carries everything the point-dispatch path needs
// instead: the frame it lives in, its index in that frame's tree build,
// its fingerprint (fp, from the probe's describe()), its classification
// facts, and the top-level point measured when it was read. The same
// element keeps its ref while frame, index and fingerprint hold.
function refForFramed(tabId, key, data) {
  let m = frameRefs.get(tabId);
  if (m && m.size > 50000) { dropRefs(tabId); m = null; }
  if (!m) { m = new Map(); frameRefs.set(tabId, m); }
  const old = m.get(key);
  if (old) {
    const h = refs.get(old);
    if (h && h.fp === data.fp && h.role === data.role && h.name === data.name) {
      h.point = data.point; h.buildId = data.buildId; h.idx = data.idx; h.facts = data.facts;
      return old;
    }
  }
  const ref = "ref_" + (++refSeq);
  refs.set(ref, { tabId, ...data });
  m.set(key, ref);
  return ref;
}
function refHit(ref) {
  const r = P.parseRef(ref);
  const hit = r && refs.get(r);
  if (!hit) throw fail("no_such_ref", "read_page or find again to get fresh refs");
  return hit;
}
// Tab for a tool that takes a ref: the ref's own tab.
function refTab(a) {
  if (a.ref == null) return a.tabId;
  const hit = refHit(a.ref);
  if (a.tabId != null && Number(a.tabId) !== hit.tabId) throw fail("ref_other_tab", `${a.ref} belongs to tab ${hit.tabId}`);
  return hit.tabId;
}

/* --------------------------------------------------------- page reading */
function axLine(n) {
  return { role: (n.role && n.role.value) || "", name: (n.name && n.name.value) || "" };
}

/* ------------------------------------------- all-frames reading (v2.6.0)
 * The CDP accessibility tree (buildTreeAX below) contains no framed
 * descendants in real Chrome: an iframe arrives as a bare node, so
 * read_page and find were blind inside every frame — the factory.8090.ai
 * shape, where the chat composer lives in an embedded frame. Claude in
 * Chrome's answer is to build the element tree INSIDE every frame (its
 * tree-builder content script is registered for all frames). The bridge
 * does the same with the machinery it already trusts: the page probe —
 * the protections' own classifier — runs in each frame's own document
 * through scripting, and the worker stitches the per-frame trees into
 * one, attaching each child frame's entries under the iframe element
 * that holds it. Framed entries get frame-aware refs (refForFramed):
 * they act through their measured top-level point, never through
 * root-world node resolution. When scripting or the frame inventory is
 * unavailable, buildTree falls back to the accessibility tree alone,
 * exactly as before. */
const frameTreeSeq = { n: 0 };

// The tab's frame inventory (SPEC: keep a webNavigation.getAllFrames
// map — it is the only reliable one). Null when the API is missing.
async function tabFrames(tabId) {
  if (!chrome.webNavigation || !chrome.webNavigation.getAllFrames) return null;
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
  if (!Array.isArray(frames) || !frames.length) return null;
  const out = frames.filter((f) => f && typeof f.frameId === "number" && !f.errorOccurred);
  return out.length ? out : null;
}

// Run the page probe inside ONE frame of the tab, addressed to that
// frame's own document. Returns the probe's {host, v}, or null when the
// frame cannot be scripted (restricted, gone, timed out).
async function runInFrame(tabId, frameId, mode, args, ms) {
  if (!chrome.scripting || !chrome.scripting.executeScript) return null;
  const res = await withTimeout(chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: P.pageProbe,
    args: [mode, { ...P.PROBE_ARGS, ...(args || {}) }],
  }), ms || 6000, "script_timeout").catch(() => null);
  const out = res && res[0] && res[0].result;
  if (!out || typeof out !== "object" || out.v == null) return null;
  return out;
}

// The probe result must come from the document the frame inventory
// says is there. Frames with no host of their own (about:, data:,
// blob:) report the embedder's host and are taken as they come.
function frameHostOk(frame, out) {
  if (!out) return false;
  const want = P.hostOf(frame.url);
  return !want || out.host === want;
}

// A point inside `frameId`'s viewport, moved to top-level viewport
// coordinates: walk the frame chain adding each iframe element's rect
// origin and border (left + clientLeft, top + clientTop) — the same
// accumulation measureNode does from inside the page, done here frame
// by frame because no single document can see across a cross-origin
// boundary. Sibling frames with the same URL are matched to iframe
// elements by occurrence; when no src matches at all, document order
// against frame order is the fallback. Null when a hop cannot be read.
async function frameOffsetPoint(tab, frames, frameId, cx, cy, rectsCache) {
  let x = cx, y = cy;
  let cur = frames.find((f) => f.frameId === frameId);
  let hops = 0;
  while (cur && cur.frameId !== 0) {
    if (++hops > 10) return null;
    let list = rectsCache && rectsCache.get(cur.parentFrameId);
    if (!list) {
      const out = await runInFrame(tab.id, cur.parentFrameId, "frames", {});
      if (!out || !Array.isArray(out.v)) return null;
      list = out.v;
      if (rectsCache) rectsCache.set(cur.parentFrameId, list);
    }
    const sibs = frames.filter((s) => s.parentFrameId === cur.parentFrameId);
    const sameUrl = sibs.filter((s) => s.url === cur.url);
    const occ = Math.max(0, sameUrl.indexOf(cur));
    const bySrc = list.filter((r) => r.src && r.src === cur.url);
    const el = bySrc[occ] || bySrc[0] || list[Math.max(0, sibs.indexOf(cur))];
    if (!el) return null;
    x += el.left + (el.clientLeft || 0);
    y += el.top + (el.clientTop || 0);
    cur = frames.find((f) => f.frameId === cur.parentFrameId);
  }
  return cur ? { x, y } : null;
}

// The resolved src of each Iframe node in the accessibility tree, so a
// child frame can be attached under the element that actually holds it.
async function axIframeSrcs(tab, nodes) {
  const out = new Map();
  for (const n of nodes) {
    if (axLine(n).role !== "Iframe" || n.backendDOMNodeId == null) continue;
    let src = "";
    try {
      const { node } = await cdp(tab.id, "DOM.describeNode", { backendNodeId: n.backendDOMNodeId });
      const arr = (node && node.attributes) || [];
      const at = {};
      for (let i = 0; i + 1 < arr.length; i += 2) at[String(arr[i]).toLowerCase()] = arr[i + 1];
      if (at.src) src = new URL(at.src, tab.url).href;
    } catch (e) { /* the order fallback in the caller covers it */ }
    out.set(n.nodeId, src);
  }
  return out;
}

async function buildTreeMerged(tab, host, frames, { filter = "all", depth = 15, refId = null, maxChars = 50000 }) {
  await refSeqReady;
  // The top frame is read exactly as the AX-only build reads it, so
  // top-frame refs keep their backend node ids and every behavior that
  // hangs off them (form_input's DOM path, file_upload) is unchanged.
  const { nodes } = await cdp(tab.id, "Accessibility.getFullAXTree", {});
  await assertHost(tab, host);
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const refOf = new Map();
  for (const n of nodes) {
    if (n.ignored || n.backendDOMNodeId == null) continue;
    const { role, name } = axLine(n);
    if (P.INTERACTIVE_ROLES.has(role) || name) refOf.set(n.nodeId, refFor(tab.id, n.backendDOMNodeId, role, name));
  }
  // One tree build per child frame, in that frame's own document.
  const buildId = tab.id + ":" + (++frameTreeSeq.n);
  const childData = new Map(); // frameId -> {frame, entries}
  for (const f of frames) {
    if (f.frameId === 0) continue;
    const out = await runInFrame(tab.id, f.frameId, "tree", { filter, depth: 15, build: buildId });
    if (!frameHostOk(f, out)) continue;
    childData.set(f.frameId, { frame: f, entries: Array.isArray(out.v.entries) ? out.v.entries : [] });
  }
  if (!childData.size) return null; // scripting reached no frame: AX fallback
  local.set("refSeq", refSeq).catch(() => {});
  // Iframe rects per document, for the build-time points on framed refs.
  const rectsCache = new Map();
  for (const f of frames) {
    const out = await runInFrame(tab.id, f.frameId, "frames", {});
    if (out && Array.isArray(out.v)) rectsCache.set(f.frameId, out.v);
  }
  // Assemble one node tree: {ref, role, name, children}. AX nodes with
  // no ref print no line and add no depth (the AX-only walk's rule), so
  // they are flattened away here; their ref'd descendants rise.
  const nodeByRef = new Map();
  const mkNode = (ref, role, name, flatExtra) => {
    const nd = { ref, role, name, children: [], flatExtra: flatExtra || null };
    if (ref) nodeByRef.set(ref, nd);
    return nd;
  };
  const axChildren = (axNode) => {
    const out = [];
    for (const cid of axNode.childIds || []) {
      const cn = byId.get(cid);
      if (!cn) continue;
      const ref = refOf.get(cn.nodeId);
      if (ref && !cn.ignored) {
        const { role, name } = axLine(cn);
        const nd = mkNode(ref, role, name);
        nd.axNodeId = cn.nodeId;
        nd.children = axChildren(cn);
        out.push(nd);
      } else out.push(...axChildren(cn));
    }
    return out;
  };
  const vroot = { ref: null, role: "", name: "", children: [] };
  const axRoot = nodes.find((n) => !n.parentId);
  if (axRoot) {
    const rref = refOf.get(axRoot.nodeId);
    if (rref && !axRoot.ignored) {
      const { role, name } = axLine(axRoot);
      const nd = mkNode(rref, role, name);
      nd.axNodeId = axRoot.nodeId;
      nd.children = axChildren(axRoot);
      vroot.children.push(nd);
    } else vroot.children = axChildren(axRoot);
  }
  // Framed entries -> nodes, nested by their in-frame depth.
  const frameNodes = new Map();   // frameId -> [root nodes]
  const frameIframes = new Map(); // frameId -> [{node, src, used}]
  for (const [fid, { frame, entries }] of childData) {
    const roots = [], stack = [], iframes = [];
    for (const e of entries) {
      const point = await frameOffsetPoint(tab, frames, fid, e.cx, e.cy, rectsCache).catch(() => null);
      const ref = refForFramed(tab.id, fid + "|" + e.i, {
        framed: true, frameId: fid, parentFrameId: frame.parentFrameId,
        frameUrl: frame.url, frameHost: P.hostOf(frame.url), buildId,
        idx: e.i, fp: e.fp, role: e.role, name: e.name, facts: e, point,
      });
      const nd = mkNode(ref, e.role, e.name, { frameUrl: frame.url });
      nd.entry = e;
      while (stack.length && stack[stack.length - 1].depth >= e.depth) stack.pop();
      if (stack.length) stack[stack.length - 1].node.children.push(nd); else roots.push(nd);
      stack.push({ depth: e.depth, node: nd });
      if (e.src !== undefined) iframes.push({ node: nd, src: e.src || "", used: false });
    }
    frameNodes.set(fid, roots);
    frameIframes.set(fid, iframes);
  }
  // Attach each frame's roots under the iframe element that holds it:
  // parents before children, src match first, order as the fallback. A
  // frame whose holder cannot be identified keeps its roots at the end
  // of the tree — visible, with working refs, honestly unplaced.
  const chainDepth = (f) => {
    let d = 0, cur = f;
    while (cur && cur.frameId !== 0 && d <= 10) { d++; cur = frames.find((x) => x.frameId === cur.parentFrameId); }
    return d;
  };
  const axSrcs = await axIframeSrcs(tab, nodes);
  const usedAx = new Set();
  const ordered = [...childData.values()].sort((a, b) => chainDepth(a.frame) - chainDepth(b.frame));
  for (const { frame } of ordered) {
    const roots = frameNodes.get(frame.frameId);
    if (!roots || !roots.length) continue;
    let attached = false;
    if (frame.parentFrameId === 0) {
      const cands = nodes.filter((n) => axLine(n).role === "Iframe" && refOf.has(n.nodeId) && !usedAx.has(n.nodeId));
      const target = cands.find((n) => axSrcs.get(n.nodeId) && axSrcs.get(n.nodeId) === frame.url)
        || cands.find((n) => !axSrcs.get(n.nodeId)) || cands[0];
      const nd = target && nodeByRef.get(refOf.get(target.nodeId));
      if (nd) { nd.children.push(...roots); usedAx.add(target.nodeId); attached = true; }
    } else {
      const sibs = (frameIframes.get(frame.parentFrameId) || []).filter((x) => !x.used);
      const hit = sibs.find((x) => x.src && x.src === frame.url) || sibs[0];
      if (hit) { hit.node.children.push(...roots); hit.used = true; attached = true; }
    }
    if (!attached) vroot.children.push(...roots);
  }
  // Render, with read_page's line shape and truncation rule.
  const lines = [], flat = [];
  let chars = 0, truncated = false;
  const render = (nd, indent, d) => {
    if (truncated || d > depth) return;
    let next = indent;
    if (nd.ref && (filter !== "interactive" || P.INTERACTIVE_ROLES.has(nd.role))) {
      const line = `${"  ".repeat(indent)}${nd.role}${nd.name ? ` "${P.clip(nd.name, 100)}"` : ""} [${nd.ref}]`;
      if (chars + line.length + 1 > maxChars) { truncated = true; return; }
      lines.push(line); chars += line.length + 1; next = indent + 1;
      flat.push({ ref: nd.ref, role: nd.role, name: nd.name, ...(nd.flatExtra || {}) });
    }
    for (const c of nd.children) render(c, next, d + 1);
  };
  if (refId) {
    const rootNode = nodeByRef.get(refId);
    if (!rootNode) throw fail("no_such_ref", "that ref is not on this page now; read_page again");
    render(rootNode, 0, 0);
  } else for (const c of vroot.children) render(c, 0, 0);
  return { text: lines.join("\n") + (truncated ? `\n[truncated at ${maxChars} chars — use ref_id or depth to narrow]` : ""), flat };
}

async function buildTree(tab, host, opts) {
  const frames = await tabFrames(tab.id).catch(() => null);
  if (frames && frames.some((f) => f.frameId !== 0)) {
    const merged = await buildTreeMerged(tab, host, frames, opts || {}).catch(() => null);
    if (merged) return merged;
  }
  return buildTreeAX(tab, host, opts || {});
}

// The framed element a ref names, located fresh in its own frame: the
// stashed build is re-measured (scrolling it into view first), and if
// that build is gone — the frame navigated, the stash was dropped —
// the frame's tree is rebuilt and the same element found again by
// fingerprint. Anything else is target_changed, exactly as a stale
// backend ref is.
async function locateFramedEntry(tab, hit) {
  const frames = await tabFrames(tab.id);
  if (!frames) throw fail("target_changed", "that element's frame is gone; read_page again");
  const fr = frames.find((f) => f.frameId === hit.frameId);
  if (!fr) throw fail("target_changed", "that element's frame is gone; read_page again");
  let m = await runInFrame(tab.id, hit.frameId, "measure", { build: hit.buildId, i: hit.idx });
  if (!m || !m.v || !m.v.d || m.v.d.fp !== hit.fp) {
    const buildId = tab.id + ":" + (++frameTreeSeq.n);
    const out = await runInFrame(tab.id, hit.frameId, "tree", { filter: "all", depth: 15, build: buildId });
    if (!frameHostOk(fr, out)) throw fail("target_changed", "that element's frame could not be read again; read_page again");
    const entries = Array.isArray(out.v.entries) ? out.v.entries : [];
    const idx = entries[hit.idx] && entries[hit.idx].fp === hit.fp ? hit.idx : entries.findIndex((e) => e && e.fp === hit.fp);
    if (idx < 0) throw fail("target_changed", "that element is gone; read_page again");
    hit.buildId = buildId; hit.idx = idx;
    m = await runInFrame(tab.id, hit.frameId, "measure", { build: buildId, i: idx });
    if (!m || !m.v || !m.v.d || m.v.d.fp !== hit.fp) throw fail("target_changed", "that element is gone; read_page again");
  }
  return { frames, frame: fr, entry: m.v };
}

// A framed ref's point at action time: located fresh (which scrolls it
// into view inside its frame — that scroll also brings the frame
// itself into view in its ancestors), settled briefly, re-measured,
// then moved to top-level coordinates by the frame chain.
async function framedPoint(tab, hit) {
  await locateFramedEntry(tab, hit);
  await sleep(120);
  const loc = await locateFramedEntry(tab, hit);
  const p = await frameOffsetPoint(tab, loc.frames, hit.frameId, loc.entry.cx, loc.entry.cy, null).catch(() => null);
  if (p) return { x: p.x, y: p.y, entry: loc.entry };
  if (hit.point) return { x: hit.point.x, y: hit.point.y, entry: loc.entry };
  throw fail("not_visible", "that element is inside a frame and its position could not be measured; read_page again");
}

async function buildTreeAX(tab, host, { filter = "all", depth = 15, refId = null, maxChars = 50000 }) {
  await refSeqReady;
  const { nodes } = await cdp(tab.id, "Accessibility.getFullAXTree", {});
  await assertHost(tab, host);
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const refOf = new Map();
  for (const n of nodes) {
    if (n.ignored || n.backendDOMNodeId == null) continue;
    const { role, name } = axLine(n);
    if (P.INTERACTIVE_ROLES.has(role) || name) refOf.set(n.nodeId, refFor(tab.id, n.backendDOMNodeId, role, name));
  }
  local.set("refSeq", refSeq).catch(() => {});
  const lines = [];
  const flat = [];
  let chars = 0;
  let truncated = false;
  const root = refId ? nodes.find((n) => refOf.get(n.nodeId) === refId) : nodes.find((n) => !n.parentId);
  if (!root) throw fail("no_such_ref", "that ref is not on this page now; read_page again");
  const walk = (n, d, indent) => {
    if (truncated || d > depth) return;
    const { role, name } = axLine(n);
    const ref = refOf.get(n.nodeId);
    let next = indent;
    if (!n.ignored && ref && (filter !== "interactive" || P.INTERACTIVE_ROLES.has(role))) {
      const line = `${"  ".repeat(indent)}${role}${name ? ` "${P.clip(name, 100)}"` : ""} [${ref}]`;
      if (chars + line.length + 1 > maxChars) { truncated = true; return; }
      lines.push(line); chars += line.length + 1; next = indent + 1;
      flat.push({ ref, role, name });
    }
    for (const c of n.childIds || []) { const cn = byId.get(c); if (cn) walk(cn, d + 1, next); }
  };
  walk(root, 0, 0);
  return { text: lines.join("\n") + (truncated ? `\n[truncated at ${maxChars} chars — use ref_id or depth to narrow]` : ""), flat };
}

// The ref's element, checked: still there, still the same role and name.
async function nodeForRef(tab, ref) {
  const hit = refHit(ref);
  if (hit.tabId !== tab.id) throw fail("ref_other_tab", `${ref} belongs to tab ${hit.tabId}`);
  let now;
  try {
    const { nodes } = await cdp(tab.id, "Accessibility.getPartialAXTree", { backendNodeId: hit.b, fetchRelatives: false });
    now = nodes.find((x) => x.backendDOMNodeId === hit.b);
  } catch (e) { throw fail("target_changed", "that element is gone; read_page again"); }
  if (!now) throw fail("target_changed", "that element is gone; read_page again");
  const cur = axLine(now);
  if (cur.role !== hit.role || cur.name !== hit.name) throw fail("target_changed", "that element changed; read_page again");
  return hit.b;
}

/* ------------------------------------------------- visible scrolling */
// pointForNode() below scrolls with DOM.scrollIntoViewIfNeeded: instant,
// so a click on an element below the fold used to teleport the page. These
// helpers scroll the way a person watching expects — animated — and wait
// for the element to come to rest before its point is read.
const SMOOTH_NODE_SRC = `function () {
  try { this.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }); return true; }
  catch (e) { return false; }
}`;
const SMOOTH_WIN_SRC = `function (dx, dy) {
  try { window.scrollBy({ left: dx, top: dy, behavior: "smooth" }); return true; }
  catch (e) { return false; }
}`;
// Claude's way to an element's point: measure it in the page. The
// centre of the element's bounding rect, in TOP-LEVEL viewport
// coordinates: start from the rect in the element's own document, then
// walk up the frame chain adding each frame element's rect origin and
// border (clientLeft/clientTop) — same-origin frames only. A hop that
// cannot be read (a cross-origin frame in the chain) makes the whole
// measurement null: the caller then falls back, it does not guess.
const MEASURE_NODE_SRC = `function () {
  try {
    if (!this || typeof this.getBoundingClientRect !== "function") return null;
    const r = this.getBoundingClientRect();
    if (!r) return null;
    let x = r.left + r.width / 2, y = r.top + r.height / 2, hops = 0;
    let doc = this.ownerDocument;
    while (doc && doc.defaultView && doc.defaultView.frameElement) {
      const fe = doc.defaultView.frameElement;
      const fr = typeof fe.getBoundingClientRect === "function" ? fe.getBoundingClientRect() : null;
      if (!fr) return null;
      x += fr.left + (fe.clientLeft || 0);
      y += fr.top + (fe.clientTop || 0);
      doc = fe.ownerDocument;
      if (++hops > 10) return null;
    }
    return { x, y, w: r.width, h: r.height, framed: hops > 0 };
  } catch (e) { return null; }
}`;
// The node's point measured in the page, or null when the page cannot
// measure it from the root world (no layout access, or a cross-origin
// frame in the chain).
async function measureNode(tab, backendNodeId) {
  const m = await runInWorld(tab, backendNodeId, MEASURE_NODE_SRC, []).catch(() => null);
  if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return null;
  return m;
}

async function quadsCenter(tabId, backendNodeId) {
  const { quads } = await cdp(tabId, "DOM.getContentQuads", { backendNodeId });
  if (!quads || !quads.length) return null;
  const q = quads[0];
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

// Bring a node into view with an animated scroll and return its centre in
// viewport coordinates once it rests. Already on screen: its centre at
// once, no scroll. No box at all: null (callers fall back to
// pointForNode, which refuses with not_visible as before).
async function smoothShowNode(tab, backendNodeId) {
  const v = await viewport(tab.id);
  const onScreen = (c) => c && c.x >= -4 && c.y >= -4 && c.x <= v.w + 4 && c.y <= v.h + 4;
  // In-page measurement first (above): for a node inside a same-origin
  // frame it is the only read whose coordinates are known to be
  // top-level viewport coordinates. CDP content quads are the fallback
  // for nodes the page cannot measure; their space is the root page's.
  let read = () => measureNode(tab, backendNodeId);
  let c = await read();
  if (!c) { read = () => quadsCenter(tab.id, backendNodeId).catch(() => null); c = await read(); }
  if (!c || onScreen(c)) return c;
  await runInWorld(tab, backendNodeId, SMOOTH_NODE_SRC, []).catch(() => false);
  // Settled means: the element first MOVED (an animated scroll takes a
  // beat to start, and two identical reads before that mean "not yet",
  // not "done"), then stopped moving. A scroll that never moves anything
  // (the page refused, or the element was already as shown as it gets)
  // is given a short grace, not the whole wait.
  const start = c, end = Date.now() + SCROLL_SETTLE_MS;
  let prev = c, stable = 0, moved = false;
  while (Date.now() < end) {
    await sleep(50);
    const n = await read();
    if (!n) return null;
    c = n;
    if (Math.abs(n.x - start.x) > 1 || Math.abs(n.y - start.y) > 1) moved = true;
    if (moved) {
      if (Math.abs(n.x - prev.x) < 1 && Math.abs(n.y - prev.y) < 1) { if (++stable >= 1) break; }
      else stable = 0;
    } else if (Date.now() > end - SCROLL_SETTLE_MS + 350) break;
    prev = n;
  }
  return c;
}

// The same for a bare viewport point outside the visible area (an agent
// clicking coordinates taken from an earlier, taller view of the page):
// scroll the window smoothly until the point is in view and hand back the
// point's new viewport coordinates.
async function smoothShowPoint(tab, x, y) {
  const v = await viewport(tab.id);
  if (x >= 0 && y >= 0 && x < v.w && y < v.h) return { x, y };
  const dx = x < 0 ? x - 40 : x >= v.w ? x - v.w + 40 : 0;
  const dy = y < 0 ? y - 40 : y >= v.h ? y - v.h + 40 : 0;
  await runInWorld(tab, null, SMOOTH_WIN_SRC, [Math.round(dx), Math.round(dy)]).catch(() => false);
  await sleep(450);
  const v2 = await viewport(tab.id);
  return { x: x - (v2.x - v.x), y: y - (v2.y - v.y) };
}

async function pointForNode(tabId, backendNodeId) {
  await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
  const { quads } = await cdp(tabId, "DOM.getContentQuads", { backendNodeId });
  if (!quads || !quads.length) throw fail("not_visible", "the element has no size on screen");
  const q = quads[0];
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

async function viewport(tabId) {
  const m = await cdp(tabId, "Page.getLayoutMetrics");
  const v = m.cssVisualViewport || m.visualViewport;
  return { x: v.pageX, y: v.pageY, w: v.clientWidth, h: v.clientHeight };
}

// Chrome's accessibility view of what a node belongs to: the nearest
// ancestor with an action role (button, link, …) and its computed name.
// This sees through closed shadow roots and aria-labels on icon buttons.
async function axActionable(tabId, backendNodeId) {
  const { nodes } = await cdp(tabId, "Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: true });
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  let n = nodes.find((x) => x.backendDOMNodeId === backendNodeId) || nodes[0];
  const leaf = n ? axLine(n) : { role: "", name: "" };
  for (let i = 0; n && i < 40; i++) {
    const l = axLine(n);
    if (P.ACTION_ROLES.has(l.role)) return { axRole: l.role, axName: l.name };
    n = n.parentId ? byId.get(n.parentId) : null;
  }
  return { axRole: "", axName: leaf.role === "StaticText" || leaf.role === "image" ? leaf.name : "" };
}
// DOM.getNodeForLocation takes page coordinates: add the scroll offset.
async function axAt(tabId, x, y) {
  const v = await viewport(tabId);
  const { backendNodeId } = await cdp(tabId, "DOM.getNodeForLocation",
    { x: Math.round(x + v.x), y: Math.round(y + v.y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false });
  return axActionable(tabId, backendNodeId);
}
// What a press at (x, y) will activate. With a ref, also says whether the
// point is covered by some other element.
async function analyzePoint(tab, host, x, y, refBackend) {
  const d = await probe(tab, host, refBackend != null ? "refpoint" : "point", { x, y }, refBackend);
  if (!d) throw fail("nothing_there");
  if (d.offscreen) throw fail("offscreen", "that point is outside the visible page; scroll first");
  if (!d.crossOriginFrame) {
    const ax = await axAt(tab.id, x, y).catch(() => null);
    if (ax) Object.assign(d, ax);
  }
  d.fp2 = `${d.fp}|${d.axRole || ""}|${d.axName || ""}`;
  return d;
}
// The focused element, with the same rules. Custom elements that hide focus
// in a closed shadow root are resolved through the accessibility tree, and
// ordinary elements get the same accessibility cross-check a click gets in
// analyzePoint(): a control named only in that tree (an icon button, a
// closed-shadow button) or nested in an actionable accessibility ancestor
// must classify for Enter/Space exactly as it would for a click. Without
// this, pressing Enter on a focused "Pay" button whose name lives only in
// the accessibility tree was dispatched with no prompt.
async function focusInfo(tab, host) {
  let f = await probe(tab, host, "focus");
  if (f.kind === "opaque") {
    const ax = await axFocused(tab.id).catch(() => null);
    if (!ax) f = { kind: "unknown", fp: "unknown" };
    else {
      const fieldRole = ["textbox", "searchbox", "combobox", "textfield"].includes(ax.axRole);
      Object.assign(f, ax, { kind: "element", isField: fieldRole, isPassword: f.isPassword || ax.isPassword,
                              actionable: P.ACTION_ROLES.has(ax.axRole) && !fieldRole });
      delete f.backendNodeId;
    }
  } else if (f.kind === "element") {
    const ax = await axFocused(tab.id).catch(() => null);
    if (ax) {
      if (ax.isPassword) f.isPassword = true;
      const anc = ax.backendNodeId != null ? await axActionable(tab.id, ax.backendNodeId).catch(() => null) : null;
      const role = (anc && anc.axRole) || ax.axRole || "";
      const name = (anc && anc.axName) || ax.axName || "";
      if (role) f.axRole = role;
      if (name) f.axName = name;
      const fieldRole = ["textbox", "searchbox", "combobox", "textfield"].includes(role);
      // An accessibility field role alone does not make a field: a
      // non-editable div with role="textbox" is a disguised control, and
      // giving it the field exemption let Enter reach it unclassified
      // while a click on it was classified. Only a genuine field keeps
      // the exemption — the probe's isField, which means input/textarea/
      // select or contenteditable — and any other field-role element is
      // actionable instead (those roles are all in ACTION_ROLES).
      const genuineField = !!f.isField || !!f.isContentEditable ||
        ["input", "textarea", "select"].includes(String(f.tag || "").toLowerCase());
      if (fieldRole && genuineField) f.isField = true;
      else if (role && P.ACTION_ROLES.has(role)) f.actionable = true;
    }
  }
  f.fp2 = `${f.fp}|${f.axRole || ""}|${f.axName || ""}`;
  return f;
}
async function axFocused(tabId) {
  const { nodes } = await cdp(tabId, "Accessibility.getFullAXTree", {});
  const focused = nodes.filter((n) => (n.properties || []).some((p) => p.name === "focused" && p.value && p.value.value));
  const n = focused[focused.length - 1];
  if (!n || n.backendDOMNodeId == null) return null;
  const { node } = await cdp(tabId, "DOM.describeNode", { backendNodeId: n.backendDOMNodeId });
  const at = {};
  for (let i = 0; i + 1 < (node.attributes || []).length; i += 2) at[node.attributes[i].toLowerCase()] = node.attributes[i + 1];
  const l = axLine(n);
  return { axRole: l.role, axName: l.name, backendNodeId: n.backendDOMNodeId,
           isPassword: String(at.type || "").toLowerCase() === "password" || /password|one-time-code/i.test(at.autocomplete || "") };
}

/* ------------------------------------------------------------------ input */
async function mouse(tabId, type, x, y, extra) {
  await ensureFocusEmulation(tabId);
  await cdp(tabId, "Input.dispatchMouseEvent", { type, x, y, ...extra });
}
const BUTTON_BITS = { left: 1, middle: 4, right: 2 };
// A click, Claude's sequence on the tab session: focus emulation is
// already on (mouse() ensures it); a beat after the cursor arrives,
// mouseMoved, then per click mousePressed (buttons bitmask, clickCount,
// force while held) → a short pause → mouseReleased (buttons 0), with
// 100 ms between repeated clicks. Coordinates are viewport CSS pixels,
// rounded; the browser hit-tests the press into whichever frame sits
// under the point and focuses that frame's field — no in-page focus
// call exists in this path, by design.
async function clickAt(tabId, x, y, button, count, modifiers) {
  lastInput.set(tabId, Date.now());
  x = Math.round(x); y = Math.round(y);
  await sleep(50);
  await mouse(tabId, "mouseMoved", x, y, { modifiers });
  for (let i = 1; i <= count; i++) {
    if (i > 1) await sleep(100);
    await mouse(tabId, "mousePressed", x, y,
      { button, buttons: BUTTON_BITS[button] || 1, clickCount: i, modifiers, force: 0.5 });
    await sleep(12);
    await mouse(tabId, "mouseReleased", x, y, { button, buttons: 0, clickCount: i, modifiers });
  }
  noteBridgeClick(tabId, x, y);
}
function modMask(s) {
  let m = 0;
  for (const p of String(s || "").toLowerCase().split("+").filter(Boolean)) {
    m |= { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, win: 4, windows: 4, shift: 8 }[p] || 0;
  }
  return m;
}
async function sendKey(tabId, k) {
  lastInput.set(tabId, Date.now());
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: k.modifiers };
  await ensureFocusEmulation(tabId);
  await cdp(tabId, "Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", text: k.text || undefined, ...base });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
const isPaste = (k) => (k.key.toLowerCase() === "v" && (k.modifiers & (2 | 4))) || (k.key === "Insert" && (k.modifiers & 8));

// A mouse press at (x, y), classified by what it will activate. v2.7:
// a risky classification is written to the event record and the press
// proceeds — the tab is shared, and the share was the consent. The
// covered-target refusal is not a prompt and stays.
async function gatedPress(ctx, tab, host, x, y, refBackend, what, count, run) {
  const d = await analyzePoint(tab, host, x, y, refBackend);
  if (d.covered) throw fail("target_covered", "another element covers that one at its centre; scroll, close the overlay, or use a coordinate");
  const c = P.classifyTarget(d);
  if (c.ask) await noteSharedAction(ctx, count > 1 ? `${what} (${count} times)` : what, `${P.describeTarget(d)} on ${host}. ${c.reason}`);
  checkLive(ctx);
  await run();
  return d;
}

// Typing classification for the paths below. P.classifyTyping covers
// password fields and blind spots; payment fields get the same treatment.
// The page probe's isPay() result reaches the worker as f.isPayField
// (f.isPay is accepted too, for probe-shaped callers that use that name).
// The classification marks the secret fields: callers mask the typed
// value in the event record and the audit line when it is set. (v2.7:
// the classification no longer opens a prompt; it feeds the record and
// the masking, which are unchanged.)
function classifyTypingPaid(f) {
  const c = P.classifyTyping(f);
  if (c.ask || !f) return c;
  if (f.isPayField || f.isPay) return { ask: true, password: true, reason: "It is a payment field." };
  return c;
}
const isPayFocus = (f) => !!(f && (f.isPayField || f.isPay));

// Key presses, classified one by one: Enter/Space on whatever has focus
// at that moment, printable keys into password fields, paste. v2.7: a
// classification that would once have asked is written to the event
// record (once per kind+focus per call, as the prompts were deduped)
// and the key proceeds.
async function pressKeysGated(ctx, tab, host, spec, repeat) {
  const keys = P.parseKeys(spec);
  const reps = clamp(Number(repeat) || 1, 1, 100);
  const seq = [];
  for (let r = 0; r < reps; r++) seq.push(...keys);
  const times = (pred) => seq.filter(pred).length;
  const typed = seq.filter(P.isTypingKey).map((k) => k.text).join("");
  const noted = new Set();
  for (const k of seq) {
    await recheck(ctx, tab);
    const act = P.isActivationKey(k), typ = P.isTypingKey(k), paste = isPaste(k);
    if (act || typ || paste) {
      const f = await focusInfo(tab, host);
      const notes = [];
      if (paste) notes.push(["paste", "Paste from your clipboard", "Your clipboard may hold a password or other private text."]);
      if (act) {
        const c = P.classifyActivation(f, P.keyName(k));
        const n = times((x) => x.key === k.key);
        if (c.ask) notes.push(["act:" + k.key, `Press ${P.keyName(k)}${n > 1 ? ` (${n} times in this call)` : ""}`, c.reason]);
      }
      if (typ && !paste) {
        const c = classifyTypingPaid(f);
        if (c.ask) notes.push(["type", f.isPassword ? "Type into a password field" : isPayFocus(f) ? "Type into a payment field" : "Type where Muse cannot see the field", `${P.shownTyping(typed, true)}. ${c.reason}`]);
      }
      for (const [kind, title, reason] of notes) {
        const key = kind + "|" + f.fp2;
        if (noted.has(key)) continue;
        await noteSharedAction(ctx, title, `${P.describeTarget(f)} on ${host}. ${reason}`);
        noted.add(key);
      }
    }
    checkLive(ctx);
    await sendKey(tab.id, k);
  }
  return seq.length;
}

/* ---------------------------------------------------------------- tools */
// No prototype: "constructor", "toString", "__proto__" are not tools.
// Scrolls the nearest scrollable element under (x, y) by (dx, dy) in the
// extension's isolated world; returns whether anything moved.
const SCROLL_SRC = `function (x, y, dx, dy) {
  const scrollable = (e) => { const s = getComputedStyle(e);
    return (dy && /(auto|scroll|overlay)/.test(s.overflowY) && e.scrollHeight > e.clientHeight) ||
           (dx && /(auto|scroll|overlay)/.test(s.overflowX) && e.scrollWidth > e.clientWidth); };
  let el = document.elementFromPoint(x, y);
  while (el && el !== document.body && el !== document.documentElement && !scrollable(el)) el = el.parentElement;
  const t = el && el !== document.body && el !== document.documentElement ? el : (document.scrollingElement || document.documentElement);
  const before = t.scrollLeft + "," + t.scrollTop;
  t.scrollBy(dx, dy);
  return t.scrollLeft + "," + t.scrollTop !== before;
}`;
const TOOLS = Object.create(null);
// Names other agents use for the same tools (kept as aliases).
const TOOL_ALIAS = { tabs_list: "tabs_context", list_tabs: "tabs_context", tabs_context_mcp: "tabs_context",
                     tabs_create_mcp: "tabs_create", tabs_close_mcp: "tabs_close" };
const toolName = (n) => { n = String(n || ""); return own(TOOL_ALIAS, n) ? TOOL_ALIAS[n] : n; };
const unknownTool = (n) => ({ ok: false, error: "unknown_action",
                              detail: P.clip(n, 60) + ". Tools: " + Object.keys(TOOLS).filter((t) => t !== "browser_batch").join(", ") + ", browser_batch" });

TOOLS.tabs_context = async (ctx) => {
  const tabs = await sessionTabs(ctx.sessionId);
  const s = (await getSessions())[ctx.sessionId];
  return {
    chat: ctx.chat,
    tabs: tabs.map((t) => {
      const web = P.isWebUrl(t.url), host = P.hostOf(t.url);
      if (web && own(s.sites, host)) return { tabId: t.id, title: t.title, url: t.url, active: t.active };
      // Not permitted for this chat: only enough to ask the user about it.
      return { tabId: t.id, active: t.active, permitted: false,
               site: web ? host : (!t.url || t.url === "about:blank") ? "about:blank" : "(browser page)" };
    }),
    permittedSites: Object.keys(s.sites),
  };
};

// A window for a chat's new tab: the window of its last tab, else any of its
// tabs, else the user's last focused normal window.
async function chatWindow(ctx) {
  const tabs = await sessionTabs(ctx.sessionId);
  const t = tabs.find((x) => x.id === ctx.lastTab) || tabs[0];
  if (t) return t.windowId;
  const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  return w ? w.id : undefined;
}
async function newTabInGroup(ctx, url, active) {
  // Open directly on the URL; the site was permitted before this call, and
  // any later hop to another site asks again. attachTab moves the new tab
  // into the chat's group in this window (groupTab), so a created tab is
  // born in the group.
  const tab = await chrome.tabs.create({ windowId: await chatWindow(ctx), url: url || "about:blank", active: !!active });
  await attachTab(ctx.sessionId, tab);
  await rememberTab(ctx, tab.id);
  return tab;
}
// Wait until the tab has actually moved to a new document (not the old URL,
// not the about:blank placeholder), then until it committed; with full=true
// until it finished loading. Bounded by LOAD_WAIT_MS.
async function waitCommitted(tabId, full, prevUrl) {
  const end = Date.now() + LOAD_WAIT_MS;
  let started = false;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw fail("no_tab");
    if (!started) started = !!t.pendingUrl || t.status === "loading" || (t.url && t.url !== prevUrl && t.url !== "about:blank");
    if (started && t.url && t.url !== "about:blank" && !t.pendingUrl && (!full || t.status === "complete")) return t;
    await sleep(150);
  }
  return chrome.tabs.get(tabId);
}

TOOLS.tabs_create = async (ctx) => {
  checkLive(ctx);
  const t = await newTabInGroup(ctx, "about:blank", false);
  await audit(ctx.chat, "tabs_create", "blank tab", "ok");
  return { tabId: t.id };
};
TOOLS.tabs_close = async (ctx, a) => {
  const ids = (Array.isArray(a.tabIds) ? a.tabIds : [a.tabId]).map(Number);
  if (!ids.length || ids.some((id) => !Number.isInteger(id))) throw fail("bad_request", "tabIds: [numbers]");
  for (const id of ids) noteJobTab(ctx, id);
  const s = (await getSessions())[ctx.sessionId];
  const ungranted = [];
  for (const id of ids) {
    const t = await chrome.tabs.get(id).catch(() => null);
    if (!t || !(await inSession(ctx, t.id))) throw fail("tab_not_shared");
    const blank = !t.url || t.url === "about:blank";
    if (!blank && !(P.isWebUrl(t.url) && own(s.sites, P.hostOf(t.url)))) ungranted.push(P.isWebUrl(t.url) ? P.hostOf(t.url) : "a browser page");
  }
  // v2.7: closing one of the chat's own tabs never asks, even on a site
  // it reached by drift; the close is recorded like any other.
  if (ungranted.length) {
    await noteSharedAction(ctx, `Close ${ungranted.length === 1 ? "a tab" : ungranted.length + " tabs"} on a site this chat was not given`, ungranted.join(", "));
  }
  checkLive(ctx);
  const still = [];
  for (const id of ids) { const t = await chrome.tabs.get(id).catch(() => null); if (t && (await inSession(ctx, t.id))) still.push(t); }
  // This command closes these tabs itself: record them so the
  // chrome.tabs.onRemoved handler does not cancel this job for its own
  // closes. Other commands acting on the same tabs are still canceled.
  if (ctx.job && still.length) { ctx.job.closing = ctx.job.closing || new Set(); for (const t of still) ctx.job.closing.add(t.id); }
  if (still.length) await chrome.tabs.remove(still.map((t) => t.id));
  await audit(ctx.chat, "tabs_close", still.map((t) => P.isWebUrl(t.url) ? P.hostOf(t.url) : "blank").join(", "), "ok");
  return { closed: still.length };
};

// Same page: same origin, path (ignoring a trailing slash) and query. The
// #fragment is ignored too: changing only it never needs a reload.
function sameUrl(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    const path = (u) => u.pathname.replace(/\/+$/, "") || "/";
    return x.origin === y.origin && path(x) === path(y) && x.search === y.search;
  } catch (e) { return false; }
}

TOOLS.navigate = async (ctx, a) => {
  const url = String(a.url || "");
  if (url === "back" || url === "forward") {
    const tab = await resolveTab(ctx, a.tabId, { allowNonWeb: true, why: "The chat wants to move this tab through its history." });
    const hist = await cdp(tab.id, "Page.getNavigationHistory");
    const entry = hist.entries[hist.currentIndex + (url === "back" ? -1 : 1)];
    if (!entry) throw fail("no_history");
    // Check where history leads BEFORE going there.
    if (P.isWebUrl(entry.url)) await permitSite(ctx, P.hostOf(entry.url), `Go ${url} to ${P.clip(entry.url, 120)}`);
    else if (entry.url !== "about:blank") throw fail("restricted_page", "history leads to a browser page");
    await recheck(ctx, tab);
    await cdp(tab.id, "Page.navigateToHistoryEntry", { entryId: entry.id });
    const t = await waitCommitted(tab.id, false, tab.url);
    await resolveTab(ctx, t.id, { allowNonWeb: true, why: `History redirected to ${P.hostOf(t.url)}.` });
    await audit(ctx.chat, "navigate " + url, P.isWebUrl(t.url) ? P.hostOf(t.url) : "blank", "ok");
    return { tabId: t.id, url: t.url, title: t.title };
  }
  const full = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : "https://" + url;
  if (!P.isWebUrl(full)) throw fail("bad_url", "only http and https");
  const host = P.hostOf(full);
  if (!host) throw fail("bad_url");
  // Register the tab being navigated before the site grant below, so
  // removing that tab cancels this command.
  if (a.tabId != null) noteJobTab(ctx, Number(a.tabId));
  await permitSite(ctx, host, `Open ${P.clip(full, 120)}`);
  let tabId, prev = "about:blank";
  if (a.tabId != null) {
    // Replacing the page in a tab counts as acting on it: its current site
    // must be permitted too (or it is blank / a browser page).
    const tab = await resolveTab(ctx, a.tabId, { allowNonWeb: true, why: "The chat wants to replace the page in this tab." });
    checkLive(ctx);
    // The tab is already on this page: never reload it (a reload loses
    // in-memory page state). With active:true only bring it to
    // the front of its window.
    if (sameUrl(tab.url, full)) {
      if (a.active) await chrome.tabs.update(tab.id, { active: true });
      await rememberTab(ctx, tab.id);
      return { tabId: tab.id, url: tab.url, title: tab.title, reloaded: false, active: !!(a.active || tab.active) };
    }
    prev = tab.url;
    await chrome.tabs.update(tab.id, a.active ? { url: full, active: true } : { url: full });
    tabId = tab.id;
  } else {
    checkLive(ctx);
    // Prompt-era guard, kept as a fail-closed net: a tabless site
    // prompt for this call was just answered, the chat held a tab when
    // the prompt opened and holds none now — do not mint it a fresh
    // tab. Under v2.7 no tabless prompt opens (permitSite grants and
    // records), so tablessHadTabs is never set and this is inert; it
    // stays in case a tabless prompt ever returns. Judged from the
    // mirror first (it moves synchronously with a removal); stored
    // state is the fallback when the mirror never knew this chat.
    if (ctx.job && ctx.job.tablessHadTabs === true) {
      const set = memTabs.get(ctx.sessionId);
      const left = set ? set.size : tabIdsOf((await getSessions())[ctx.sessionId]).length;
      if (!left) throw fail("canceled", "the chat's tabs were removed while this call was waiting for approval");
    }
    tabId = (await newTabInGroup(ctx, full, a.active)).id;
  }
  const t = await waitCommitted(tabId, a.waitUntil === "load", prev);
  await audit(ctx.chat, "navigate", full, "ok");
  return { tabId, url: t.url, title: t.title, redirectedToOtherSite: P.hostOf(t.url) !== host };
};

TOOLS.read_page = async (ctx, a) => {
  const tab = await resolveTab(ctx, a.tabId);
  const host = P.hostOf(tab.url);
  const { text } = await buildTree(tab, host, { filter: a.filter === "interactive" ? "interactive" : "all",
    depth: clamp(Number(a.depth) || 15, 1, 50), refId: a.ref_id ? P.parseRef(a.ref_id) : null,
    maxChars: clamp(Number(a.max_chars) || 50000, 1000, 200000) });
  await audit(ctx.chat, "read_page", `${host} (${text.length} chars)`, "ok");
  return { tabId: tab.id, url: tab.url, title: tab.title, tree: text };
};

TOOLS.find = async (ctx, a) => {
  const tab = await resolveTab(ctx, a.tabId);
  const host = P.hostOf(tab.url);
  const { flat } = await buildTree(tab, host, { maxChars: 1e9, depth: 60 });
  const hits = P.rankForQuery(flat, a.query);
  const matches = hits.map((h) => ({ ref: h.ref, role: h.role, name: h.name, ...(h.frameUrl ? { frame: h.frameUrl } : {}) }));
  await audit(ctx.chat, "find", `${host} (${JSON.stringify(matches).length} chars)`, "ok");
  return { tabId: tab.id, matches };
};

TOOLS.get_page_text = async (ctx, a) => {
  const tab = await resolveTab(ctx, a.tabId);
  const host = P.hostOf(tab.url);
  const raw = await probe(tab, host, "text");
  const { text, redactions } = P.redactText(raw);
  await audit(ctx.chat, "get_page_text", `${host} (${typeof text === "string" ? text.length : 0} chars)`, "ok");
  return { tabId: tab.id, url: tab.url, title: tab.title, text, redactions };
};

TOOLS.get_form_values = async (ctx, a) => {
  const tab = await resolveTab(ctx, a.tabId);
  const raw = await probe(tab, P.hostOf(tab.url), "fields");
  // Second filter at the tool boundary: the probe masks these fields, but
  // a hidden, payment or OTP value that still arrives here never leaves.
  // Only name and type are available at this layer, so the name check is
  // the probe's payment pattern plus OTP, applied to the field name.
  const SENSITIVE_NAME = /cc[-_]|cc[-_ ]?(number|num|csc|cvc|exp)|card|cvv|cvc|csc|iban|account.?number|routing|expir|exp[-_ ]?(date|month|year)|security.?code|one-time-code|otp/i;
  const fields = Array.isArray(raw) ? raw.map((f) => {
    if (!f || typeof f !== "object" || f.value === "(hidden)") return f;
    const hidden = String(f.type || "").toLowerCase() === "hidden" || SENSITIVE_NAME.test(String(f.name || ""));
    return hidden ? { ...f, value: "(hidden)" } : f;
  }) : raw;
  await audit(ctx.chat, "get_form_values", `${host} (${JSON.stringify(fields || []).length} chars)`, "ok");
  return { tabId: tab.id, fields };
};

// A screenshot photographs everything visible on the page, including
// whatever is typed into a password or payment field: on a page that holds
// such a field, capturing asks first, through the same ask() as every other
// risky action. Detection must use the probe's OWN classification, not a
// re-guess from field names in the worker: policy.js isPay()/isPwd() see
// autocomplete, placeholder and aria-label, which a name-only check cannot.
// Three sources are merged, all fail-closed except where noted:
//   1. the "shotcheck" probe mode: isPwd()/isPay() computed in-page over
//      EVERY field (no count cap, so padding fields cannot hide a sensitive
//      one), walking open shadow roots and same-origin frame documents,
//      plus a flag for a visible cross-origin frame, whose fields no
//      in-page check can see at all (hosted payment frames);
//   2. the "fields" probe list, whose entries now carry the probe's own
//      isPassword/isPayField booleans and autocomplete value (shotFieldFlags
//      below also keeps its name heuristics for robustness);
//   3. a CDP DOM scan (DOM.getDocument, pierce:true), which is the only
//      source that sees inside CLOSED shadow roots — fields there, and
//      frames there whose documents CDP did not inline.
// A null/empty answer from (1) or (3) — e.g. a test double that only
// implements some probe modes — contributes nothing; a thrown probe error
// aborts the capture (fail closed), as before.
const SHOT_PAY_RE = /(^|[^a-z])(cc-?(number|num|csc|cvc|exp)|card.?(number|num|no)|cardnumber|cvv|cvc|csc|security.?code|iban|account.?number|routing|expir)/i;
const SHOT_PWD_RE = /pass(word|wd|code)?|pwd|(^|[^a-z])(pin|otp)([^a-z]|$)/i;
function shotFieldFlags(fields) {
  let password = false, payment = false;
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || typeof f !== "object") continue;
    const names = [f.name, f.id, f.autocomplete, f.placeholder, f.label, f.ariaLabel, f["aria-label"]].filter(Boolean).join(" ");
    if (f.isPassword || String(f.type || "").toLowerCase() === "password" ||
        f.value === "(hidden)" || SHOT_PWD_RE.test(names)) password = true;
    if (f.isPayField || f.isPay || SHOT_PAY_RE.test(names) ||
        String(f.autocomplete || "").toLowerCase().startsWith("cc-")) payment = true;
  }
  return { password, payment };
}

// Closed shadow roots are invisible to page JS. The CDP DOM tree pierces
// them, so scan it for field attributes and classify them with the same
// patterns. Only attributes are read, never field values. Two of the
// probe's own rules need care here, because this scan is their only
// detector inside a closed root:
//   - isPwd()'s CSS branch: an input whose text is masked by
//     -webkit-text-security (any value but "none") is a password field.
//     Page stylesheets cannot cross a shadow boundary, so inside a root
//     the mask can only come from the input's own style attribute or a
//     <style> element in the same root; both are in this tree.
//   - A frame whose document CDP did not inline (no contentDocument) is
//     one whose fields no source can read — cross-origin, e.g. a hosted
//     payment frame. A visible one is reported, mirroring the probe's
//     crossOriginFrame rule; the "frame" key is set only when flagged.
async function shotDomFlags(tab) {
  let root = null;
  try { ({ root } = await cdp(tab.id, "DOM.getDocument", { depth: -1, pierce: true })); } catch (e) { return {}; }
  if (!root || typeof root !== "object") return {};
  let password = false, payment = false, frame = false;
  const maskedCss = (css) => {
    const m = /-webkit-text-security\s*:\s*([a-z-]+)/i.exec(String(css || ""));
    return !!m && m[1].toLowerCase() !== "none";
  };
  const attrsOf = (n) => {
    const at = {};
    const arr = Array.isArray(n.attributes) ? n.attributes : [];
    for (let i = 0; i + 1 < arr.length; i += 2) at[String(arr[i]).toLowerCase()] = String(arr[i + 1]);
    return at;
  };
  const textOf = (n) => {
    let s = n && n.nodeValue ? String(n.nodeValue) : "";
    for (const c of Array.isArray(n && n.children) ? n.children : []) s += textOf(c);
    return s;
  };
  const fields = [];
  const maskedScopes = new Set();
  const walk = (n, scope) => {
    if (!n || typeof n !== "object") return;
    const tag = String(n.nodeName || "").toUpperCase();
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) fields.push({ tag, at: attrsOf(n), scope });
    else if (tag === "STYLE") { if (maskedCss(textOf(n))) maskedScopes.add(scope); }
    else if (/^(IFRAME|FRAME)$/.test(tag) && !n.contentDocument) {
      const at = attrsOf(n);
      const st = String(at.style || "").replace(/\s+/g, "").toLowerCase();
      if (!("hidden" in at) && !st.includes("display:none") && !st.includes("visibility:hidden")) frame = true;
    }
    for (const k of ["children", "shadowRoots", "contentDocument", "pseudoElements", "templateContent"]) {
      const c = n[k];
      const inner = k === "shadowRoots" || k === "contentDocument";
      if (Array.isArray(c)) for (const ch of c) walk(ch, inner ? ch : scope);
      else if (c && typeof c === "object") walk(c, inner ? c : scope);
    }
  };
  walk(root, root);
  for (const f of fields) {
    const at = f.at;
    const names = [at.name, at.id, at.placeholder, at["aria-label"]].filter(Boolean).join(" ");
    const type = String(at.type || "").toLowerCase();
    if (type === "password" || /password|one-time-code/i.test(at.autocomplete || "") ||
        SHOT_PWD_RE.test(names)) password = true;
    // isPwd() excludes these types outright, so the CSS-mask branch must
    // too; masking applies to text-like INPUTs only.
    else if (f.tag === "INPUT" &&
        !["hidden", "checkbox", "radio", "submit", "button", "reset", "image", "file", "range", "color"].includes(type) &&
        (maskedCss(at.style) || maskedScopes.has(f.scope))) password = true;
    if (SHOT_PAY_RE.test(names) || String(at.autocomplete || "").toLowerCase().startsWith("cc-")) payment = true;
  }
  const out = { password, payment };
  if (frame) out.frame = true;
  return out;
}

// One merged sensitivity reading of the page right now.
async function shotProbeSens(tab, host) {
  const fromFields = shotFieldFlags(await probe(tab, host, "fields"));
  const shot = await probe(tab, host, "shotcheck");
  const fromDom = await shotDomFlags(tab);
  return {
    password: !!(fromFields.password || (shot && shot.password) || fromDom.password),
    payment: !!(fromFields.payment || (shot && shot.payment) || fromDom.payment),
    frame: !!((shot && shot.crossOriginFrame) || fromDom.frame),
  };
}
// The event-record phrase for a sensitivity reading; "" when clean.
// Single-flag phrases keep their historic wording exactly.
function shotKind(sens) {
  const parts = [];
  if (sens.password && sens.payment) parts.push("password and payment fields");
  else if (sens.password) parts.push("a password field");
  else if (sens.payment) parts.push("a payment field");
  if (sens.frame) parts.push("a frame from another site, whose fields Muse cannot see");
  return parts.join(" and ");
}

async function shoot(ctx, a, region, via) {
  const tab = await resolveTab(ctx, a.tabId);
  const host = P.hostOf(tab.url);
  // Viewport and region are settled BEFORE the sensitivity probe, so
  // the probe (below) is the last page read before capture.
  const v = await viewport(tab.id);
  let scale = clamp(Number(a.scale) || 1, 0.1, region ? 3 : 1);
  if (region && !(region.every(Number.isFinite) && region[2] > region[0] && region[3] > region[1])) throw fail("bad_region", "[x0, y0, x1, y1] with x1 > x0 and y1 > y0");
  const clip = region
    ? { x: v.x + region[0], y: v.y + region[1], width: region[2] - region[0], height: region[3] - region[1] }
    : { x: v.x, y: v.y, width: v.w, height: v.h };
  // Sensitivity reading: the page is probed once, immediately before
  // capture. v2.7: a sensitive reading no longer asks — the screenshot
  // proceeds and the reading is written to the event record, so the
  // trail of what was captured survives. (The panel's live view still
  // hides sensitive pages outright; that is not a prompt and is
  // unchanged.)
  const kind = shotKind(await shotProbeSens(tab, host));
  if (kind) await noteSharedAction(ctx, "Screenshot a page with " + kind,
    `The page on ${host} has ${kind}. A screenshot shows everything visible on the page, including what is typed into those fields.`);
  // Chrome draws only the tab in front of each window. A background tab never
  // produces a frame, so its capture would hang: give up quickly and say why.
  const background = !tab.active;
  const capture = (format) => cdp(tab.id, "Page.captureScreenshot",
    { format, ...(format === "jpeg" ? { quality: 80 } : {}), clip: { ...clip, scale }, fromSurface: true },
    background ? 3000 : undefined).catch((e) => {
      if (background && e.code === "cdp_timeout") throw fail("tab_not_visible", "this tab is in the background and Chrome does not draw it. Use read_page or get_page_text for it, or ask the user to switch to it.");
      throw e;
    });
  let format = "png";
  let r = await capture(format);
  // Keep the reply well under the relay's 16 MB message limit.
  if (r.data.length > SHOT_MAX_B64) { format = "jpeg"; r = await capture(format); }
  while (r.data.length > SHOT_MAX_B64 && scale > 0.15) { scale = Math.round(scale * 60) / 100; r = await capture(format); }
  if (r.data.length > SHOT_MAX_B64) throw fail("result_too_large", "use zoom on a smaller region");
  await assertHost(tab, host);
  const image = `data:image/${format};base64,` + r.data;
  await audit(ctx.chat, region ? "zoom" : "screenshot", via ? `${via} @ ${host} (${image.length} chars)` : `${host} (${image.length} chars)`, "ok");
  return { tabId: tab.id, image, viewport: { width: v.w, height: v.h },
           scroll: { x: v.x, y: v.y }, scale, note: "click coordinates are viewport CSS pixels (full resolution)" };
}
TOOLS.screenshot = (ctx, a) => shoot(ctx, a, null);

TOOLS.computer = async (ctx, a) => {
  // Names other agents use for the same actions (kept as aliases).
  const ALIAS = { press_key: "key", key_press: "key", keypress: "key", press: "key", click: "left_click", type_text: "type" };
  const action = own(ALIAS, String(a.action || "")) ? ALIAS[a.action] : String(a.action || "");
  if (action === "wait") { await sleep(clamp(Number(a.duration) || 1, 0, 10) * 1000); return {}; }
  if (action === "screenshot") return shoot(ctx, a, null, "computer screenshot");
  if (action === "zoom") {
    if (!Array.isArray(a.region) || a.region.length !== 4) throw fail("bad_region", "[x0, y0, x1, y1]");
    return shoot(ctx, a, a.region.map(Number), "computer zoom");
  }
  const tab = await resolveTab(ctx, refTab(a));
  const host = P.hostOf(tab.url);
  const mods = modMask(a.modifiers);

  // Where. A ref resolves to the centre of its element. Pointer actions
  // first bring their target into view with a visible, animated scroll, so
  // the point read afterwards is the rested on-screen position and the
  // user sees the page move before anything is pressed.
  const POINTED = ["left_click", "right_click", "double_click", "triple_click", "hover", "scroll_to", "left_click_drag"];
  let x, y, backend = null, framedHit = null;
  if (a.ref != null) {
    const hit = refHit(a.ref);
    if (hit.framed) {
      // A ref from the all-frames read: the element lives in a frame
      // the root world cannot resolve, so it is acted on by its
      // measured top-level point — the point-dispatch path — never by
      // node resolution. The press is still gated on what sits at that
      // point (analyzePoint, via gatedPress), exactly like a
      // coordinate click.
      framedHit = hit;
      if (POINTED.includes(action)) {
        const p = await framedPoint(tab, hit).catch((e) => { if (e && e.code) throw e; return null; });
        if (p) { x = p.x; y = p.y; }
      }
      if (x == null && Array.isArray(a.coordinate)) {
        const [cx, cy] = a.coordinate.map(Number);
        if (Number.isFinite(cx) && Number.isFinite(cy)) { x = cx; y = cy; }
      }
      if (x == null && POINTED.includes(action)) {
        throw fail("not_visible", "that element is inside a frame and its position could not be measured; read_page again");
      }
    } else {
      backend = await nodeForRef(tab, a.ref);
      if (POINTED.includes(action)) {
        const c = await smoothShowNode(tab, backend).catch(() => null);
        if (c) { x = c.x; y = c.y; }
      }
      if (x == null && Array.isArray(a.coordinate)) {
        // No in-page measurement can reach the target (it lives in a
        // cross-origin frame): the caller's point — read off a
        // screenshot — is the contract, and is dispatched unchanged.
        // Framed elements are reached by coordinates.
        const [cx, cy] = a.coordinate.map(Number);
        if (Number.isFinite(cx) && Number.isFinite(cy)) { x = cx; y = cy; }
      }
      if (x == null) ({ x, y } = await pointForNode(tab.id, backend));
    }
  } else if (Array.isArray(a.coordinate)) {
    [x, y] = a.coordinate.map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw fail("bad_coordinate");
    if (POINTED.includes(action)) ({ x, y } = await smoothShowPoint(tab, x, y));
  }

  switch (action) {
    case "left_click": case "right_click": case "double_click": case "triple_click": {
      if (x == null) throw fail("need_coordinate_or_ref");
      const count = { left_click: 1, right_click: 1, double_click: 2, triple_click: 3 }[action];
      const button = action === "right_click" ? "right" : "left";
      const d = await gatedPress(ctx, tab, host, x, y, backend, action === "right_click" ? "Right-click" : "Click", count,
        async () => { await cursorGo(tab.id, x, y, true); await clickAt(tab.id, x, y, button, count, mods); });
      await audit(ctx.chat, action, P.describeTarget(d) + " @ " + host, "ok");
      return { clicked: P.describeTarget(d) };
    }
    case "hover":
      if (x == null) throw fail("need_coordinate_or_ref");
      checkLive(ctx);
      await cursorGo(tab.id, x, y, false);
      await mouse(tab.id, "mouseMoved", x, y, { modifiers: mods });
      return {};
    case "scroll": {
      const v = await viewport(tab.id);
      const px = x == null ? v.w / 2 : x, py = y == null ? v.h / 2 : y;
      const n = clamp(Number(a.scroll_amount) || 3, 1, 10) * 100;
      const dir = String(a.scroll_direction || "down");
      const dx = dir === "left" ? -n : dir === "right" ? n : 0;
      const dy = dir === "up" ? -n : dir === "down" ? n : 0;
      checkLive(ctx);
      await cursorGo(tab.id, px, py, false); // the hand arrives before the page moves
      // Chrome sometimes never answers a wheel event: a scroll on a foreground
      // tab can hit the 15 s cdp_timeout.
      // Wait 3 s for the wheel; if Chrome does not answer, scroll the element
      // under the point directly. A tab not in front goes straight to that.
      // The fallback is a continuation after a long await (the wheel timeout,
      // or no wait at all on an inactive tab): re-check first, as every other
      // post-await continuation does, so a revoke or cancel that landed while
      // the wheel was hanging cannot still scroll the removed site.
      const direct = async () => { await recheck(ctx, tab); return { scrolled: await runInWorld(tab, null, SCROLL_SRC, [px, py, dx, dy]), via: "direct" }; };
      if (!tab.active) return direct();
      try {
        await ensureFocusEmulation(tab.id);
        await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseWheel", x: px, y: py, deltaX: dx, deltaY: dy }, 3000);
      } catch (e) {
        if (e.code !== "cdp_timeout") throw e;
        return direct();
      }
      return {};
    }
    case "scroll_to": {
      if (framedHit) {
        // Locating the framed element scrolls it into view inside its
        // frame (and the frame into view in its ancestors).
        const p = await framedPoint(tab, framedHit);
        await cursorGo(tab.id, p.x, p.y, false);
        return {};
      }
      if (backend == null) throw fail("need_ref");
      // Visible, animated — not the instant jump this used to make.
      const c = await smoothShowNode(tab, backend).catch(() => null);
      if (!c) await cdp(tab.id, "DOM.scrollIntoViewIfNeeded", { backendNodeId: backend });
      else await cursorGo(tab.id, c.x, c.y, false);
      return {};
    }
    case "left_click_drag": {
      if (!Array.isArray(a.start_coordinate) || x == null) throw fail("need_coordinates", "start_coordinate and coordinate");
      const [sx, sy] = a.start_coordinate.map(Number);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) throw fail("bad_coordinate");
      if (Math.hypot(x - sx, y - sy) < 5) {
        // A drag that barely moves is a click, and is checked as one.
        const d = await gatedPress(ctx, tab, host, x, y, null, "Click", 1,
          async () => { await cursorGo(tab.id, x, y, true); await clickAt(tab.id, x, y, "left", 1, 0); });
        await audit(ctx.chat, "left_click_drag (a click)", P.describeTarget(d) + " @ " + host, "ok");
        return { clicked: P.describeTarget(d) };
      }
      // The press and the release can each activate something (a click fires
      // on what both share), so both ends are checked.
      const ds = await analyzePoint(tab, host, sx, sy, null);
      const de = await analyzePoint(tab, host, x, y, null);
      const cs = P.classifyTarget(ds), ce = P.classifyTarget(de);
      if (cs.ask || ce.ask) {
        await noteSharedAction(ctx, "Drag", `From ${P.describeTarget(ds)} to ${P.describeTarget(de)} on ${host}. ${(cs.ask ? cs : ce).reason}`);
      }
      checkLive(ctx);
      await cursorGo(tab.id, sx, sy, false);
      await mouse(tab.id, "mouseMoved", sx, sy, {});
      await recheck(ctx, tab);
      await mouse(tab.id, "mousePressed", sx, sy, { button: "left", clickCount: 1 });
      // Moves carry buttons:1 but no button field: this is the shape that works
      // for script-driven drags (sliders, lists, canvas) in live Chromium.
      // Each move is a separate CDP round-trip, so re-check between moves: a
      // revoke or cancel landing mid-drag must stop the remaining moves and
      // the release instead of letting them land on the removed site.
      for (let i = 1; i <= 10; i++) { await recheck(ctx, tab); await mouse(tab.id, "mouseMoved", sx + ((x - sx) * i) / 10, sy + ((y - sy) * i) / 10, { buttons: 1 }); }
      await recheck(ctx, tab);
      await cursorGo(tab.id, x, y, false); // the hand carries the drag to its end
      await mouse(tab.id, "mouseReleased", x, y, { button: "left", clickCount: 1 });
      await audit(ctx.chat, "left_click_drag", `${P.describeTarget(ds)} → ${P.describeTarget(de)} @ ${host}`, "ok");
      return { from: P.describeTarget(ds), to: P.describeTarget(de) };
    }
    case "type": {
      const text = String(a.text == null ? "" : a.text);
      const f = await focusInfo(tab, host);
      // Type targets focus, never a node (Claude's model). The probe
      // reads focus from the root document, so a field inside a frame
      // can hold the browser's real focus while the probe reports
      // "none" — the frame's focus is not visible from the root world.
      // When the bridge's own click just landed on this tab, that
      // click is what put focus there: send the text and let it land
      // where the click put it, with no human pre-click. With no
      // bridge click and no focus at all, say so honestly instead of
      // inserting into the void.
      const blindAfterClick = f.kind === "none" && recentBridgeClick(tab.id);
      if (f.kind === "none" && !blindAfterClick) {
        throw fail("not_focused", "nothing on this page has keyboard focus, so the text would go nowhere. Click the field first, then type.");
      }
      const c = blindAfterClick ? { ask: false } : classifyTypingPaid(f);
      if (c.ask) {
        // v2.7: typing into a password or payment field proceeds like
        // everything else in a shared tab — and is recorded, with the
        // value masked to its length exactly as the prompt showed it.
        await noteSharedAction(ctx, f.isPassword ? "Type into a password field" : isPayFocus(f) ? "Type into a payment field" : "Type where Muse cannot see the field", `${P.shownTyping(text, true)} into ${P.describeTarget(f)} on ${host}. ${c.reason}`);
      }
      checkLive(ctx);
      await ensureFocusEmulation(tab.id);
      await cdp(tab.id, "Input.insertText", { text });
      if (!blindAfterClick && text && f.isField && typeof f.len === "number") {
        const f3 = await focusInfo(tab, host).catch(() => null);
        if (f3 && f3.fp === f.fp && f3.len === f.len) {
          await audit(ctx.chat, "type", P.shownTyping(text, c.ask || f.isPassword) + " @ " + host, "not_typed");
          throw fail("not_typed", "the text did not reach the field (it did not change). Click the field first, then type again");
        }
      }
      await audit(ctx.chat, "type", P.shownTyping(text, c.ask || f.isPassword) + " @ " + host, "ok");
      return {};
    }
    case "key": {
      const n = await pressKeysGated(ctx, tab, host, a.text, a.repeat);
      await audit(ctx.chat, "key", P.clip(a.text, 60) + (n > 1 ? ` (${n} presses)` : "") + " @ " + host, "ok");
      return { pressed: n };
    }
    default:
      throw fail("unknown_action", "computer." + P.clip(action, 40) + ". Use one of: left_click, right_click, double_click, triple_click, left_click_drag, hover, scroll, scroll_to, type, key, screenshot, zoom, wait");
  }
};

// form_input for a ref from the all-frames read. The field is
// classified from the probe's own describe() facts, measured fresh in
// its frame (locateFramedEntry), and set through the point-dispatch
// path — a real press at its top-level point focuses it in its frame,
// and the value follows focus — never through root-world node
// resolution. Classification mirrors TOOLS.form_input's root-world
// path, fact for fact; v2.7 records a sensitive classification as an
// event instead of prompting, in both paths.
async function formInputFramed(ctx, tab, host, hit, a) {
  const loc = await locateFramedEntry(tab, hit);
  const d = loc.entry.d;
  if (!d || !d.isField) throw fail("not_a_field", "form_input sets text fields, checkboxes, radios and selects; click buttons with computer");
  if (!d.role && hit.role) d.role = hit.role;
  if (!d.name && hit.name) d.name = hit.name;
  d.frameHost = hit.frameHost || "";
  const cls = P.classifyFormInput(d);
  const secret = cls.secret;
  if (cls.ask) {
    const title = d.isPassword ? "Fill a password field" : d.isPayField ? "Fill a payment field" : "Fill a field in a sensitive form";
    await noteSharedAction(ctx, title, `${P.shownTyping(a.value, secret)} into ${P.describeTarget(d)} on ${host}. ${cls.reason}`);
  }
  checkLive(ctx);
  const kind = d.tag === "select" ? "select" : (d.type === "checkbox" || d.type === "radio") ? "check" : "text";
  if (kind === "select") {
    // A native select's options cannot be chosen by a point press with
    // any reliability; say so rather than fake a set.
    throw fail("unsupported_in_frame", "a select inside a frame cannot be set directly; click it and choose the option");
  }
  const p = await framedPoint(tab, hit);
  await cursorGo(tab.id, p.x, p.y, true);
  if (kind === "text") {
    const v = String(a.value == null ? "" : a.value);
    await clickAt(tab.id, p.x, p.y, "left", 1, 0); // the press focuses the framed field
    // Replace, do not append: form_input SETS the value. Select-all
    // first, the way the root-world path selects before inserting.
    await sendKey(tab.id, P.parseKeys("ctrl+a")[0]);
    if (v) {
      await ensureFocusEmulation(tab.id);
      await cdp(tab.id, "Input.insertText", { text: v });
    } else await sendKey(tab.id, P.parseKeys("Delete")[0]);
  } else {
    const on = a.value === true || a.value === 1 || /^(true|1|on|yes|checked)$/i.test(String(a.value).trim());
    if (loc.entry.checked !== on) {
      await clickAt(tab.id, p.x, p.y, "left", 1, 0); // a press toggles it
      const after = await locateFramedEntry(tab, hit).catch(() => null);
      if (!after || after.entry.checked !== on) throw fail("page_error", "the press did not change that control");
    }
  }
  await audit(ctx.chat, "form_input", P.describeTarget(d) + " = " + P.shownTyping(a.value, secret) + " @ " + host, "ok");
  return { set: P.describeTarget(d) };
}

TOOLS.form_input = async (ctx, a) => {
  const tab = await resolveTab(ctx, refTab(a));
  const host = P.hostOf(tab.url);
  const hit0 = a.ref != null ? refHit(a.ref) : null;
  if (hit0 && hit0.framed) return formInputFramed(ctx, tab, host, hit0, a);
  const backend = await nodeForRef(tab, a.ref);
  const d = await probe(tab, host, "node", {}, backend);
  if (!d || !d.isField) throw fail("not_a_field", "form_input sets text fields, checkboxes, radios and selects; click buttons with computer");
  // The node probe has no accessibility merge (clicks get one via
  // analyzePoint): Chrome's computed name for a field comes from its
  // <label>, so a field identified only by that label is invisible to the
  // probe. Merge it, and let it raise the same flags the probe would.
  const mergeAxName = async (dd) => {
    const ax = await axActionable(tab.id, backend).catch(() => null);
    if (!ax || !ax.axName) return dd;
    dd.axRole = ax.axRole || dd.axRole; dd.axName = ax.axName;
    if (/(card|cvv|cvc|csc|security.?code|iban|account.?number|routing|expir)/i.test(ax.axName)) dd.isPayField = true;
    if (/pass(word|wd|code)?|pwd|(^|[^a-z])(pin|otp)([^a-z]|$)/i.test(ax.axName)) dd.isPassword = true;
    return dd;
  };
  await mergeAxName(d);
  const cls = P.classifyFormInput(d);
  const secret = cls.secret;
  if (cls.ask) {
    // v2.7: a sensitive form classification is recorded, not asked;
    // the value stays masked in the record for secret fields.
    const title = d.isPassword ? "Fill a password field" : d.isPayField ? "Fill a payment field" : "Fill a field in a sensitive form";
    await noteSharedAction(ctx, title, `${P.shownTyping(a.value, secret)} into ${P.describeTarget(d)} on ${host}. ${cls.reason}`);
  }
  checkLive(ctx);
  // Seen, like every other action: the field is scrolled into view and
  // the cursor travels to it before anything is set.
  const fc = await smoothShowNode(tab, backend).catch(() => null);
  if (fc) await cursorGo(tab.id, fc.x, fc.y, false);
  const kind = d.tag === "select" ? "select" : (d.type === "checkbox" || d.type === "radio") ? "check" : "text";
  if (kind === "text") {
    const v = String(a.value == null ? "" : a.value);
    let rooted = true;
    try {
      await cdp(tab.id, "DOM.focus", { backendNodeId: backend });
      await runInWorld(tab, backend,
        "function () { if (this.select) this.select(); else { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }");
    } catch (e) { rooted = false; }
    if (!rooted) {
      // The field is not resolvable in the root world — it lives in a
      // frame. Focus it the way Claude in Chrome does: a real press at
      // its measured point, which the browser routes into the frame
      // and focuses there; the text then follows focus. (This press is
      // a focus click inside an operation already classified above —
      // the same footing as the DOM.focus it replaces, not a new
      // activation.)
      if (!fc) throw fail("target_changed", "that element is gone; read_page again");
      await cursorGo(tab.id, fc.x, fc.y, true);
      await clickAt(tab.id, fc.x, fc.y, "left", 1, 0);
    }
    if (v) {
      await ensureFocusEmulation(tab.id);
      await cdp(tab.id, "Input.insertText", { text: v });
    }
    else await sendKey(tab.id, P.parseKeys("Delete")[0]);
  } else {
    const res = await runInWorld(tab, backend, `function (v) {
        if (this.tagName === "SELECT") {
          const o = [...this.options].find(o => o.value == v || o.text.trim() == String(v).trim());
          if (!o) return "no_option"; this.value = o.value;
        } else {
          const on = v === true || v === 1 || /^(true|1|on|yes|checked)$/i.test(String(v).trim());
          if (this.checked === on) return "ok";
          this.checked = on;
        }
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return "ok";
      }`, [a.value]);
    if (res !== "ok") throw fail(res || "page_error");
  }
  await audit(ctx.chat, "form_input", P.describeTarget(d) + " = " + P.shownTyping(a.value, secret) + " @ " + host, "ok");
  return { set: P.describeTarget(d) };
};

/* ---------------------------------------------------------- file_upload */
// Paths that point at credential material are refused outright, before any
// prompt (including the site-permission prompt resolveTab may raise): a
// single Allow click must never be enough to exfiltrate the bridge token,
// SSH keys, or a browser profile (cookies, Login Data, sessions).
// The service worker cannot stat a local file, so the size shown in the
// prompt is the size the caller supplies with the call (see SKILL.md:
// `sizes`, aligned with `paths`, or a per-entry {path, size}); when no
// size is supplied the prompt says so instead of inventing one.
function uploadPathSegs(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (/^file:/i.test(s)) {
    s = s.replace(/^file:\/+/i, "");
    // Decode repeatedly: a doubly-encoded %252e must still match as ".".
    for (let i = 0; i < 3; i++) {
      try { const d = decodeURIComponent(s); if (d === s) break; s = d; } catch (e) { break; }
    }
  }
  s = s.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return s.toLowerCase().split("/").map((seg) => {
    // Match the name the OS would actually open: Windows drops an NTFS
    // alternate-data-stream suffix (":..." — ".muse-bridge-token::$DATA"
    // is the token file itself) and strips trailing dots and spaces from
    // every component (".ssh." and "User Data." are the real directories).
    let x = seg.trim().split(":")[0];
    x = x.replace(/[. ]+$/, "").trim();
    return x;
  }).filter(Boolean);
}
function blockedUploadReason(raw) {
  const segs = uploadPathSegs(raw);
  if (!segs.length) return null;
  const hasSeq = (...seq) => segs.some((_, i) => seq.every((w, j) => segs[i + j] === w));
  if (segs.some((s) => s.startsWith(".muse-bridge-token"))) {
    return "it is a Muse Bridge token file (.muse-bridge-token)";
  }
  if (segs.includes(".muse-bridge")) return "it is inside a .muse-bridge directory";
  if (segs.includes(".ssh")) return "it is inside an .ssh directory";
  // "userda~1" is the 8.3 short name of the "User Data" profile directory.
  if (segs.includes("user data") || segs.includes("userda~1")) return "it is inside a browser profile directory (User Data)";
  if (segs.includes(".mozilla") || hasSeq("mozilla", "firefox", "profiles") || hasSeq("firefox", "profiles") ||
      // Channel variants (google-chrome-beta, microsoft-edge-dev, ...) are
      // profile directories: prefix match, but only on directory segments —
      // a document merely named "google-chrome-notes.pdf" is not a profile.
      segs.slice(0, -1).some((s) => s.startsWith("google-chrome") || s.startsWith("microsoft-edge")) ||
      hasSeq(".config", "chromium") || hasSeq(".config", "brave-browser") || hasSeq(".config", "bravesoftware") ||
      hasSeq(".config", "mozilla") || hasSeq(".config", "vivaldi") || hasSeq("snap", "chromium") ||
      hasSeq("application support", "google", "chrome") || hasSeq("application support", "chromium") ||
      hasSeq("application support", "bravesoftware") || hasSeq("application support", "microsoft edge") ||
      hasSeq("application support", "firefox") || hasSeq("application support", "mozilla") ||
      hasSeq("application support", "vivaldi") || hasSeq("application support", "arc") ||
      hasSeq("library", "safari") || hasSeq("library", "cookies") ||
      hasSeq("opera software", "opera stable") || hasSeq("opera software", "opera gx stable")) {
    return "it is inside a browser profile directory";
  }
  return null;
}
// The prompt (and the audit log) must show the path the user is approving,
// not text the path smuggles in: control characters, newlines and bidi
// overrides in a path string are shown as � instead of being rendered.
function displayPath(p) {
  return String(p).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "\uFFFD");
}
function formatUploadSize(n) {
  if (n == null || !Number.isFinite(n) || n < 0) return "size unknown";
  if (n < 1024) return `${n} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n, u = -1;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${n} bytes (${v.toFixed(1)} ${units[u]})`;
}

TOOLS.file_upload = async (ctx, a) => {
  const entries = (Array.isArray(a.paths) ? a.paths : []).map((e) => {
    if (e && typeof e === "object") return { path: String(e.path || e.file || ""), size: e.size };
    return { path: String(e == null ? "" : e), size: undefined };
  }).filter((e) => e.path);
  const paths = entries.map((e) => e.path);
  if (!paths.length) throw fail("no_files");
  const listed = Array.isArray(a.sizes) ? a.sizes
    : (a.sizes && typeof a.sizes === "object" ? paths.map((p) => a.sizes[p]) : []);
  const sizes = entries.map((e, i) => {
    const v = e.size !== undefined ? e.size : (listed[i] !== undefined ? listed[i] : (paths.length === 1 ? a.size : undefined));
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  });
  // Refuse credential material before any prompt of any kind.
  for (const p of paths) {
    const reason = blockedUploadReason(p);
    if (reason) {
      await audit(ctx.chat, "file_upload", `${displayPath(p)} — refused: ${reason}`, "refused").catch(() => {});
      throw fail("upload_blocked", `${p}: ${reason}; uploads of credential material are refused without a prompt`);
    }
  }
  const tab = await resolveTab(ctx, refTab(a));
  const host = P.hostOf(tab.url);
  const hitU = a.ref != null ? refHit(a.ref) : null;
  if (hitU && hitU.framed) throw fail("not_a_file_input", "that element is inside a frame; uploads into framed file inputs are not supported");
  const backend = await nodeForRef(tab, a.ref);
  const d = await probe(tab, host, "node", {}, backend);
  if (!d || d.tag !== "input" || d.type !== "file") throw fail("not_a_file_input");
  const shown = paths.map((p, i) => `${displayPath(p)} (${formatUploadSize(sizes[i])})`).join(", ");
  // v2.7: an ordinary upload proceeds; it is recorded with the same
  // paths and sizes the prompt would have shown. (Credential-store
  // paths were refused outright above, before this point, as always.)
  await noteSharedAction(ctx, "Upload files", `${shown} to ${host}`);
  await recheck(ctx, tab);
  await cdp(tab.id, "DOM.setFileInputFiles", { files: paths, backendNodeId: backend });
  await audit(ctx.chat, "file_upload", paths.map(displayPath).join(", ") + " @ " + host, "ok");
  return { uploaded: paths.length };
};

TOOLS.browser_batch = async (ctx, a) => {
  const actions = Array.isArray(a.actions) ? a.actions : [];
  if (actions.length > 50) throw fail("bad_request", "at most 50 actions per batch");
  // Register every tab this batch names up front, not lazily per step:
  // a step's tab that is removed while an earlier step is still running
  // must cancel the whole batch, even if no step has touched it yet.
  // Only tabs this chat actually owns are registered (the same check
  // resolveTab makes when a step runs).
  const ownedNow = new Set(tabIdsOf((await getSessions())[ctx.sessionId]));
  for (const item of actions) {
    const input = item && item.input && typeof item.input === "object" && !Array.isArray(item.input) ? item.input : {};
    const named = [...(input.tabId != null ? [Number(input.tabId)] : []),
                   ...(Array.isArray(input.tabIds) ? input.tabIds.map(Number) : [])];
    if (input.ref != null) { const hit = refs.get(P.parseRef(input.ref) || ""); if (hit) named.push(hit.tabId); }
    for (const id of named) if (ownedNow.has(id)) noteJobTab(ctx, id);
  }
  const results = [];
  let used = 0;
  for (const item of actions) {
    const name = toolName(item && item.name);
    if (!own(TOOLS, name) || name === "browser_batch") { results.push(unknownTool(name)); break; }
    try {
      checkLive(ctx);
      const input = item.input && typeof item.input === "object" && !Array.isArray(item.input) ? item.input : {};
      const data = await TOOLS[name](ctx, input);
      const size = JSON.stringify(data || {}).length;
      if (used + size > MAX_RESULT_BYTES - 2000000) results.push({ ok: true, data: { omitted: "result_too_large", note: "this step ran; its output was too big to return in a batch" } });
      else { used += size; results.push({ ok: true, data }); }
    } catch (e) { results.push(errOf(e)); break; }
  }
  return { results };
};

/* ------------------------------------------------------------ live view */
// While a chat works, the side panel shows what its tab looks like right
// now — the "watch it work" picture. Captures run only while a command
// for the chat is in flight (plus a few seconds' tail after the last
// action), only of the tab that command is acting on, and only while
// that tab is the one in front of its window (captureVisibleTab can only
// photograph the visible tab, and naming another tab's picture as this
// chat's would be a lie). The sensitivity gate is the screenshot gate:
// a page with a password or payment field, or a frame Muse cannot see
// into, hides the view instead of being photographed. The image lives
// only in this worker's memory and goes only to the side panel — never
// to the relay, never into a command result, never to storage.
const liveViews = new Map();     // sessionId -> {tabId, at, image} | {tabId, at, blocked}
const liveActivity = new Map();  // sessionId -> {tabId, at}
let captureTimer = null, captureBusy = false, lastCaptureAt = 0;

function noteActivity(sessionId, tabId) {
  if (!sessionId || !Number.isFinite(tabId)) return;
  liveActivity.set(sessionId, { tabId, at: Date.now() });
  if (captureTimer == null) {
    captureTimer = setInterval(() => { captureTick().catch(() => {}); }, 500);
    if (captureTimer && typeof captureTimer.unref === "function") captureTimer.unref();
  }
}
function forgetTabView(tabId) {
  cursorReady.delete(tabId);
  for (const [sid, a] of liveActivity) if (a.tabId === tabId) liveActivity.delete(sid);
  for (const [sid, v] of liveViews) if (v.tabId === tabId) liveViews.delete(sid);
}
async function captureTick() {
  if (captureBusy) return;
  const now = Date.now();
  const targets = new Map(); // sessionId -> tabId being worked right now
  for (const job of inflight.values()) {
    if (job.canceled) continue;
    for (const t of job.tabs || []) targets.set(job.sessionId, t);
  }
  for (const [sid, a] of liveActivity) {
    if (now - a.at > 30000) { liveActivity.delete(sid); continue; }
    if (now - a.at <= CAPTURE_TAIL_MS && !targets.has(sid)) targets.set(sid, a.tabId);
  }
  if (!targets.size) { clearInterval(captureTimer); captureTimer = null; return; }
  if (now - lastCaptureAt < CAPTURE_EVERY_MS) return;
  const [sid, tabId] = targets.entries().next().value;
  captureBusy = true;
  try { await captureLiveView(sid, tabId); } catch (e) { /* the view is best-effort */ }
  finally { captureBusy = false; }
}
// One capture for the panel. Returns false (and changes nothing) when the
// tab is not this chat's, not in front, or not a web page.
async function captureLiveView(sessionId, tabId) {
  lastCaptureAt = Date.now();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.active || memOwner.get(tabId) !== sessionId || !P.isWebUrl(tab.url)) return false;
  const host = P.hostOf(tab.url);
  const kind = shotKind(await shotProbeSens(tab, host));
  if (kind) {
    liveViews.set(sessionId, { tabId, at: Date.now(), blocked: kind });
    notifyPanel();
    return true;
  }
  const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 50 });
  // The page may have moved or been given to another chat while the shot
  // was taken: never show one page under another page's name.
  const after = await chrome.tabs.get(tabId).catch(() => null);
  if (!after || P.hostOf(after.url) !== host || memOwner.get(tabId) !== sessionId) return false;
  liveViews.set(sessionId, { tabId, at: Date.now(), image });
  notifyPanel();
  return true;
}

/* ------------------------------------------------------------ side panel */
// Only this extension's own pages (side panel) may talk to the worker.
// Approvals are accepted from nowhere else.
function fromOurPage(sender) {
  // sender.url is the sending document's URL. Web pages and content scripts
  // report the web page's URL; only this extension's own pages (side panel,
  // or the same page opened in a tab) have a chrome-extension://<our id>/ URL.
  // No web_accessible_resources are declared, so no website can load them.
  return !!sender && sender.id === chrome.runtime.id &&
         typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  // The pill in a shared tab may only ask to stop sharing its own tab.
  if (msg && msg.kind === "pill_remove" && sender && sender.id === chrome.runtime.id && sender.tab && sender.frameId === 0) {
    releaseTab(sender.tab.id).then(async (chat) => {
      if (chat) await audit(chat, "tab removed", "by you (pill ✕)", "ok");
      notifyPanel(); respond({ ok: true });
    }, () => respond({ ok: false }));
    return true;
  }
  if (!fromOurPage(sender) || !msg || typeof msg !== "object") { respond({ ok: false, error: "forbidden" }); return false; }
  (async () => {
    switch (msg.kind) {
      case "state": {
        // The panel is open and the relay is down: retry now, not after the
        // backoff (up to 30 s), so a relay the user just started shows at once.
        if (!ws && !(await local.get("relayError", ""))) connect();
        // The panel passes its own window id: lastFocusedWindow alone made
        // every window's panel describe the last-touched window (with the
        // Muse chat window open, panels in other windows showed muse.ai).
        const [w] = await chrome.tabs.query(typeof msg.windowId === "number"
          ? { active: true, windowId: msg.windowId }
          : { active: true, lastFocusedWindow: true });
        const sessions = await getSessions();
        const shares = await local.get("shares", {});
        const win = w ? await chrome.windows.get(w.windowId).catch(() => null) : null;
        const current = w ? { tabId: w.id, title: w.title, url: w.url, host: P.hostOf(w.url),
                              shareable: P.isWebUrl(w.url),
                              appWindow: !!win && win.type !== "normal",
                              sharedWith: Object.values(sessions).find((s) => s.tabs && own(s.tabs, String(w.id)))?.chatName || "" } : null;
        // A code is shown only while the tab is still on the site it was made
        // for: after the tab moves to another site that code is refused
        // (page_changed), so the panel offers Share for the new page instead.
        const share = current && Object.entries(shares).find(([, s]) => s.tabId === current.tabId && s.expires > Date.now() && s.host === current.host);
        const chats = [];
        for (const [sid, s] of Object.entries(sessions)) {
          const tids = await sessionTabs(sid);
          const tabsHere = typeof msg.windowId === "number" ? tids.filter((t) => t.windowId === msg.windowId).length : null;
          const tabsList = tids.map((t) => ({ tabId: t.id, host: P.hostOf(t.url), title: t.title || "",
            windowId: t.windowId, here: typeof msg.windowId === "number" ? t.windowId === msg.windowId : null }));
          const view = liveViews.get(sid);
          // Group state, computed live: a chat's tabs are "grouped" only
          // when every one of them sits in a group carrying the chat's
          // title. The last grouping failure (error text + window type)
          // rides along from the session record, so a missing group is
          // visible in the panel for as long as it is missing.
          const title = groupTitle(s);
          const ownGroup = new Map();
          for (const t of tids) {
            if (t.groupId == null || t.groupId === -1 || ownGroup.has(t.groupId)) continue;
            const g = await chrome.tabGroups.get(t.groupId).catch(() => null);
            ownGroup.set(t.groupId, !!(g && g.title === title));
          }
          const grouped = tids.length > 0 && tids.every((t) => t.groupId != null && t.groupId !== -1 && ownGroup.get(t.groupId));
          const groupStopped = tids.some((t) => (t.groupId == null || t.groupId === -1)
            && s.groupRetry && Number(s.groupRetry[String(t.id)]) > GROUP_RETRY_MAX);
          chats.push({ sessionId: sid, chatName: s.chatName, tabs: tids.length, tabsHere, tabsList, sites: Object.keys(s.sites),
            grouped, groupMissing: tids.length > 0 && !grouped,
            groupError: s.groupError ? String(s.groupError.text || "") : "",
            groupWindowType: s.groupError ? String(s.groupError.windowType || "") : "",
            groupStopped,
            view: view ? { tabId: view.tabId, at: view.at, image: view.image || null, blocked: view.blocked || null } : null });
        }
        return { ok: true, relay: { connected: wsReady, url: DEFAULT_RELAY, error: await local.get("relayError", ""),
                                    startError: await local.get("relayStartError", "") },
                 current,
                 share: share ? { reqId: share[0], code: share[1].code, expires: share[1].expires,
                                  stalled: !share[1].code && Date.now() - (share[1].created || 0) > 10000 } : null,
                 chats, prompts: [...pending].map(([id, p]) => ({ id, chat: p.chat, title: p.title, detail: p.detail, url: p.url, created: p.created, expiresAt: p.expiresAt })),
                 audit: (await local.get("audit", [])).slice(-40).reverse() };
      }
      case "share": return { ok: true, reqId: await startShare(Number(msg.tabId)) };
      case "add_tab": await addTab(String(msg.sessionId || ""), Number(msg.tabId)); return { ok: true };
      case "remove_tab": {
        const chat = await releaseTab(Number(msg.tabId));
        if (chat) await audit(chat, "tab removed", "by you", "ok");
        notifyPanel();
        return { ok: true };
      }
      case "start_relay": return await startRelay(true);
      case "cancel_share":
        await withShares((shares) => { delete shares[msg.reqId]; });
        relaySend({ t: "pair_cancel", reqIds: [String(msg.reqId)] });
        return { ok: true };
      case "approve": settle(msg.id, true); return { ok: true };
      case "deny": settle(msg.id, false, "denied_by_user"); return { ok: true };
      case "disconnect": await dropSession(msg.sessionId, { tellRelay: true, why: "disconnected by you" }); return { ok: true };
      case "revoke_site": {
        const host = String(msg.host || "");
        if (!host) return { ok: false, error: "bad_host" };
        const sessionId = String(msg.sessionId || "");
        let chatName = "";
        const removed = await withState((s) => {
          const sess = own(s, sessionId) ? s[sessionId] : null;
          if (!sess || !sess.sites || !own(sess.sites, host)) return false;
          delete sess.sites[host];
          chatName = sess.chatName;
          return true;
        });
        if (!removed) return { ok: false, error: "not_found" };
        // Removing the grant must also disarm work already armed for this
        // session, as dropSession does for disconnect: a prompt left pending
        // from before the revoke must not still be approvable into an action
        // on the removed site, and in-flight jobs must stop at their next
        // checkLive/recheck instead of running to completion on it.
        for (const [id, p] of pending) if (p.sessionId === sessionId) settle(id, false, "site_revoked");
        for (const job of inflight.values()) if (job.sessionId === sessionId) job.canceled = true;
        await audit(chatName, "site removed", host, "by you");
        notifyPanel();
        return { ok: true };
      }
      case "set_relay": {
        const url = String(msg.url || "").trim();
        if (!/^wss?:\/\//.test(url)) return { ok: false, error: "bad_url" };
        await local.set("relayUrl", url);
        backoff = 2000; try { ws && ws.close(); } catch (e) {}
        connect();
        return { ok: true };
      }
      default: return { ok: false, error: "unknown" };
    }
  })().then(respond, (e) => respond({ ok: false, error: e.code || String(e.message || e), detail: e.detail || "" }));
  return true;
});

/* ------------------------------------------------------------------ boot */
// Detach the debugger from tabs idle for DEBUGGER_IDLE_MS (Chrome's bar goes
// away), unless a command is running.
async function sweepIdle() {
  if (inflight.size) return;
  const now = Date.now();
  for (const [tabId, last] of [...attached]) if (now - last > DEBUGGER_IDLE_MS) await detach(tabId);
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "mbb-keepalive") { if (!ws) connect(); }
  if (a.name === "mbb-idle") sweepIdle();
});
// A new worker starts with nothing in memory: clear what the old one left
// on screen (badge, prompt notifications) and any debugger sessions it had.
async function cleanupAfterRestart() {
  chrome.action.setBadgeText({ text: "" }).catch(() => {});
  try {
    const all = await chrome.notifications.getAll();
    for (const id of Object.keys(all || {})) if (id.startsWith("mbb-")) chrome.notifications.clear(id).catch(() => {});
  } catch (e) {}
  try {
    const sessions = await getSessions();
    const ours = new Set(Object.values(sessions).flatMap(tabIdsOf));
    for (const t of await chrome.debugger.getTargets()) {
      if (t.attached && t.tabId != null && ours.has(t.tabId)) await chrome.debugger.detach({ tabId: t.tabId }).catch(() => {});
    }
  } catch (e) {}
}
function setup() {
  // Clear any relayUrl stored before the panel testing box was removed.
  local.remove("relayUrl").catch(() => {});
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create("mbb-keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.create("mbb-idle", { periodInMinutes: 0.5 });
}
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
// Browser restarts: tab ids are reassigned by Chrome, so stored tab
// ownership starts empty. Tabs still sitting in a chat's named group are
// re-adopted by that chat (the B040 extension in DESIGN-GROUPS.md),
// because the group and its title survive the restart even though tab
// ids do not; a re-adopted tab's site is re-checked against the chat's
// permitted sites. After that, Daniel's no-tabs-no-connection rule
// (2026-10-18) applies: a session the restart left with no tabs at all
// is ended, not kept as a 0-tab zombie. Service-worker restarts do not
// fire onStartup, so this never fires mid-session.
chrome.runtime.onStartup.addListener(async () => {
  memTabs.clear(); memOwner.clear();
  await withState((s) => { for (const v of Object.values(s)) { v.tabs = {}; v.groups = {}; delete v.groupError; delete v.groupMoved; delete v.groupRetry; } });
  await adoptGroupTabsAtStartup();
  for (const sid of Object.keys(await getSessions())) await dropIfEmpty(sid, "browser restarted with no tabs in the group");
});
// Stored tab ids are also pruned by
// validateStored() below; Disconnect is the way a chat is ended.
setup();
// Before the first hello: keep only stored tabs that still exist on the site
// recorded for them, and shares whose tab is still on the same site. After a
// browser restart tab ids are new, so a chat keeps no stale tab.
async function validateStored() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const tabHost = new Map(tabs.map((t) => [t.id, P.hostOf(t.url)]));
  await withState((s) => {
    for (const v of Object.values(s)) {
      if (v.groupId !== undefined && !v.tabs) v.tabs = {}; // legacy stored shape without a tab list: its tabs are not known
      for (const [id, host] of Object.entries(v.tabs || {})) if (tabHost.get(Number(id)) !== host) delete v.tabs[id];
    }
  });
  for (const [sid, v] of Object.entries(await getSessions())) memSyncSession(sid, tabIdsOf(v));
  for (const v of Object.values(await getSessions())) for (const id of tabIdsOf(v)) pill(id, v.chatName);
  await withShares((shares) => {
    for (const [rid, v] of Object.entries(shares)) if (v.expires < Date.now() || tabHost.get(v.tabId) !== v.host) delete shares[rid];
  });
}
validateStored().catch(() => {}).then(cleanupAfterRestart).finally(connect);

if (typeof module !== "undefined") module.exports = { TOOLS, resolveTab, fromOurPage, onCommand, withState, getSessions };
