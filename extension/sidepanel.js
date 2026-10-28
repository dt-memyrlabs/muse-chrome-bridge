/* Muse Chrome Bridge v2 — side panel. The only place the user shares a page,
 * answers a prompt, or disconnects a chat. Everything is rendered with
 * textContent (never innerHTML) so page titles and chat names cannot inject. */
const $ = (id) => document.getElementById(id);
const send = (kind, extra) => chrome.runtime.sendMessage({ kind, ...(extra || {}) });
/* This panel lives in one window. The worker used to answer "state" with
 * the last focused window's active tab, so with the Muse chat window and a
 * work window open, the panel in the work window described the chat window
 * (muse.ai — "nothing to share"). The panel now reports its own window. */
let myWindowId = null;
try { chrome.windows.getCurrent((w) => { if (w && typeof w.id === "number") myWindowId = w.id; }); } catch (e) { /* older Chrome: fall back */ }
const ARM_MS = 700; // a new or moved prompt's buttons wait this long before they work

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e[k] = v;
  }
  for (const k of kids) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

/* Prompts are keyed by id: a card is built once and only its countdown
 * changes. When a card appears, or moves because one above it went away,
 * its buttons are disabled for ARM_MS, so a double-click can never land on
 * a prompt the user has not seen in place. */
const cards = new Map(); // id -> {card, secs, buttons, armTimer}
function arm(c) {
  for (const b of c.buttons) b.disabled = true;
  clearTimeout(c.armTimer);
  c.armTimer = setTimeout(() => { for (const b of c.buttons) b.disabled = false; }, ARM_MS);
}
function renderPrompts(prompts) {
  const box = $("prompts");
  $("promptsSection").hidden = !prompts.length;
  const ids = new Set(prompts.map((p) => p.id));
  let moved = false;
  for (const [id, c] of cards) if (!ids.has(id)) { clearTimeout(c.armTimer); c.card.remove(); cards.delete(id); moved = true; }
  for (const p of prompts) {
    let c = cards.get(p.id);
    if (!c) {
      const secs = el("span", { class: "muted" });
      const allow = el("button", { class: "primary", onclick: () => { disableAll(); send("approve", { id: p.id }).then(refresh); } }, "Allow");
      const deny = el("button", { onclick: () => { disableAll(); send("deny", { id: p.id }).then(refresh); } }, "Deny");
      const card = el("div", { class: "prompt" },
        el("div", { class: "who" }, "Muse · " + p.chat),
        el("div", { class: "title" }, p.title),
        el("div", { class: "detail" }, p.detail),
        el("div", { class: "row" }, allow, deny, secs));
      c = { card, secs, buttons: [allow, deny], armTimer: null };
      cards.set(p.id, c);
      box.append(card);
      arm(c);
    }
    c.secs.textContent = `${Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000))}s left`;
  }
  if (moved) for (const c of cards.values()) arm(c);
}
// After any answer, every remaining card waits again before it accepts a click.
function disableAll() { for (const c of cards.values()) arm(c); }

const copied = {}; // reqId -> note shown under a code (the fallback flow)
// The panel is code-first; there is no More options toggle.

function copyText(text) {
  return navigator.clipboard.writeText(text).catch(() => {
    const t = document.createElement("textarea");
    t.value = text; document.body.append(t); t.select();
    const ok = document.execCommand("copy");
    t.remove();
    if (!ok) throw new Error("copy failed");
  });
}

let lastJson = "";
async function refresh() {
  let st;
  try { st = await send("state", myWindowId === null ? undefined : { windowId: myWindowId }); } catch (e) { return; }
  if (!st || !st.ok) return;
  renderPrompts(st.prompts);
  if (st.share && st.share.code && !copied[st.share.reqId]) {
    copied[st.share.reqId] = "Copying…";
    copyText(st.share.code).then(() => { copied[st.share.reqId] = "Copied. Paste it into the Muse chat."; },
                                 () => { copied[st.share.reqId] = "Click Copy, then paste it into the Muse chat."; })
      .finally(() => { lastJson = ""; refresh(); });
  }
  const { prompts, ...rest } = st;
  const json = JSON.stringify(rest);
  if (json === lastJson) return; // no flicker, no lost button focus
  lastJson = json;

  $("dot").className = "dot" + (st.relay.connected ? " on" : "");
  $("relayState").textContent = st.relay.connected ? "relay online" : (st.relay.error ? "relay rejected: " + st.relay.error : "relay offline");

  // This page
  const pg = $("page"); pg.replaceChildren();
  const c = st.current;
  const again = () => { lastJson = ""; refresh(); };
  if (!st.relay.connected) {
    const start = el("button", { class: "primary" }, "Start relay");
    start.addEventListener("click", async () => {
      start.disabled = true; start.textContent = "Starting…";
      const r = await send("start_relay");
      start.disabled = false; start.textContent = "Start relay";
      if (!r || !r.ok) $("startErr").textContent = "Could not start it: " + ((r && r.error) || "no answer");
      again();
    });
    pg.append(el("p", { class: "muted" }, "The relay is not running, so no Muse chat can reach this browser."),
              el("div", { class: "row" }, start),
              el("p", { class: "muted", id: "startErr" }, st.relay.startError ? "Last start attempt: " + st.relay.startError : ""));
    renderRest(st);
    return;
  }
  const cancel = () => el("button", { onclick: () => send("cancel_share", { reqId: st.share.reqId }).then(() => { lastJson = ""; refresh(); }) }, "Cancel");
  if (!c) {
    pg.append(el("p", { class: "empty" }, "No active tab."));
  } else if (c.sharedWith) {
    const stop = el("button", {}, "Stop sharing this tab");
    stop.addEventListener("click", async () => { stop.disabled = true; await send("remove_tab", { tabId: c.tabId }); again(); });
    pg.append(el("div", { class: "site" }, c.host), el("p", { class: "muted" }, "Shared with " + c.sharedWith + "."), el("div", { class: "row" }, stop));
  } else if (!c.shareable) {
    pg.append(el("p", { class: "empty" }, "This page can't be shared (only http and https pages)."));
  } else if (st.share && st.share.viaChat) {
    pg.append(el("div", { class: "site" }, c.host),
      el("p", { class: "muted" }, st.share.stalled ? `No answer from the relay. Cancel and try again.` : `Giving this tab to ${st.share.viaChat}…`),
      el("div", { class: "row" }, cancel()));
  } else if (st.share && st.share.code) {
    const mins = Math.max(0, Math.round((st.share.expires - Date.now()) / 60000));
    pg.append(
      el("div", { class: "site" }, c.host),
      el("p", { class: "muted" }, "Paste this code into the Muse chat that should control this page:"),
      el("div", { class: "code" }, st.share.code.slice(0, 4) + "-" + st.share.code.slice(4)),
      el("p", { class: "copied" }, copied[st.share.reqId] || ""),
      el("p", { class: "muted" }, "Using this code lets that chat take control of this tab — after you confirm once, here in this panel, that it gets full control. Stop sharing to end it."),
      el("p", { class: "muted" }, `Works once. Expires in about ${mins} min. Not connected until the chat uses it.`),
      el("div", { class: "row" },
        el("button", { onclick: () => copyText(st.share.code).then(() => { copied[st.share.reqId] = "Copied. Paste it into the Muse chat."; lastJson = ""; refresh(); }, () => {}) }, "Copy"),
        cancel()));
  } else if (st.share) {
    pg.append(el("div", { class: "site" }, c.host),
      el("p", { class: "muted" }, st.share.stalled ? "No code came back from the relay. Cancel and try again." : "Getting a code…"),
      el("div", { class: "row" }, cancel()));
  } else if (c.host === "muse.ai" || (c.host || "").endsWith(".muse.ai")) {
    // This tab IS Muse. Offering to hand it to another chat was the main
    // source of confusion in the old panel ("it's already connected — why
    // give it again?"), so: no buttons here at all.
    pg.append(el("div", { class: "site" }, c.host), el("p", { class: "muted" }, c.title || ""),
      el("p", { class: "muted" }, "This is Muse itself — there's nothing to share here. Switch to the page you want to share, then open this panel."));
  } else {
    // Sharing flow: open the panel on a tab, click "Generate a code",
    // give the code to a Muse chat. When the chat uses it, this tab
    // is connected to that chat and shows its pill. Nothing else belongs
    // in this section — no waiting-chat buttons,
    // no more-options toggle.
    const err = el("p", { class: "muted" });
    const gen = el("button", { class: "primary" }, "Generate a code");
    gen.addEventListener("click", async () => {
      gen.disabled = true;
      const r = await send("share", { tabId: c.tabId });
      if (!r || !r.ok) { err.textContent = "Couldn't: " + ((r && (r.detail || r.error)) || "error"); gen.disabled = false; return; }
      again();
    });
    pg.append(el("div", { class: "site" }, c.host), el("p", { class: "muted" }, c.title || ""),
      el("p", { class: "muted" }, "Not shared. Generate a code and paste it into the Muse chat that should control this tab."),
      el("div", { class: "row" }, gen), err);
  }
  renderRest(st);
}

// Ending a chat takes two clicks: the first only asks. A single stray click
// (the panel re-draws when a pairing completes, so buttons move under the
// pointer) must never end a chat, so a second, deliberate click is required
// to confirm the disconnect.
function disconnectButton(x) {
  const b = el("button", { class: "danger" }, "Disconnect");
  let armed = null;
  b.addEventListener("click", () => {
    if (!armed) {
      b.textContent = "Click again to end this chat";
      armed = setTimeout(() => { armed = null; b.textContent = "Disconnect"; }, 4000);
      return;
    }
    clearTimeout(armed); armed = null; b.disabled = true;
    send("disconnect", { sessionId: x.sessionId }).then(() => { lastJson = ""; refresh(); });
  });
  return b;
}

// Where a chat's tabs are, from this window's point of view. A chat whose
// tabs are all in another window must not read as "connected" here: its
// pill is on its tab, in that window (Daniel, 2026-10-18).
function whereText(x) {
  if (!x.tabs) return "no tabs";
  if (typeof x.tabsHere !== "number") return `${x.tabs} tab${x.tabs === 1 ? "" : "s"}`;
  if (x.tabsHere === 0) return "tabs in another window";
  if (x.tabsHere === x.tabs) return `${x.tabs} tab${x.tabs === 1 ? "" : "s"} here`;
  return `${x.tabsHere} here · ${x.tabs - x.tabsHere} in another window`;
}

function renderRest(st) {

  // Chats
  const ch = $("chats"); ch.replaceChildren();
  if (!st.chats.length) ch.append(el("p", { class: "empty" }, "None yet."));
  for (const x of st.chats) {
    const sites = Array.isArray(x.sites) ? x.sites : [];
    const block = el("div", { class: "chat" });
    block.style.flexDirection = "column";
    block.style.alignItems = "stretch";
    const head = el("div", { class: "chat-head" },
      el("span", { class: "name" }, "Muse · " + x.chatName),
      el("span", { class: "muted" }, `${whereText(x)} · ${sites.length} site${sites.length === 1 ? "" : "s"}`),
      disconnectButton(x));
    head.style.display = "flex";
    head.style.alignItems = "center";
    head.style.gap = "8px";
    block.append(head);
    // The live view: what this chat's tab looks like while it works. On a
    // page the screenshot gate calls sensitive there is no picture at
    // all — the note says why instead.
    if (x.view && x.view.image) {
      block.append(el("img", { class: "liveview", src: x.view.image, alt: "Live view of the tab this chat is working" }),
        el("div", { class: "muted" }, "Live view \u00b7 " + new Date(x.view.at).toLocaleTimeString()));
    } else if (x.view && x.view.blocked) {
      block.append(el("p", { class: "muted" }, "Live view hidden: this page has " + x.view.blocked + "."));
    }
    if (Array.isArray(x.tabsList) && x.tabsList.length) {
      const tl = el("div", { class: "sites" });
      for (const t of x.tabsList) tl.append(el("div", { class: "muted" }, "• " + (t.title || t.host) + (t.here === false ? " — another window" : "")));
      block.append(tl);
    }
    if (sites.length) {
      const list = el("div", { class: "sites" });
      for (const host of sites) {
        const rm = el("button", { class: "site-remove", onclick: () => { const r = send("revoke_site", { sessionId: x.sessionId, host }); if (r && r.then) r.then(() => { lastJson = ""; refresh(); }); } }, "×");
        rm.setAttribute("aria-label", "Remove " + host);
        rm.setAttribute("data-host", host);
        rm.title = "Remove " + host;
        list.append(el("div", { class: "site-row" }, el("span", { class: "site-name" }, host), rm));
      }
      block.append(list);
    }
    ch.append(block);
  }

  // Log
  const lg = $("log"); lg.replaceChildren();
  if (!st.audit.length) lg.append(el("div", { class: "empty" }, "Nothing yet."));
  for (const a of st.audit) {
    lg.append(el("div", {}, `${new Date(a.ts).toLocaleTimeString()} · ${a.chat ? a.chat + " · " : ""}${a.action} · ${a.detail} · ${a.outcome}`));
  }
}

chrome.runtime.onMessage.addListener((m) => { if (m && m.kind === "changed") refresh(); });
chrome.tabs.onActivated.addListener((info) => { if (myWindowId !== null && info && info.windowId !== myWindowId) return; lastJson = ""; refresh(); });
chrome.tabs.onUpdated.addListener((tabId, info, tab) => { if (myWindowId !== null && tab && tab.windowId !== myWindowId) return; refresh(); });
setInterval(() => refresh(), 1000); // countdowns; the page section redraws only when its data changes
setInterval(() => { lastJson = ""; }, 30000); // the code's "expires in" minutes
refresh();
