/* A fake chrome.* for running the real extension/sw.js in Node.
 * Shared by test_extension.js (fake WebSocket) and test_stack.js (real
 * WebSocket to a real relay). CDP is faked: the page probe answers from
 * `page` (what a test says is on the page), and any other function the
 * worker runs in the page is executed for real against a fake element. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const EXT = path.join(__dirname, "..", "extension");

function event() {
  const ls = [];
  return { addListener: (f) => ls.push(f), fire: (...a) => ls.map((f) => f(...a)) };
}
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch (e) { return ""; } };

// STAGING-ONLY (attach-on-redeem verification; not part of the shipped tree):
// the merged protocol makes the worker wait for the relay's challenge and
// prove an enroll secret before its hello. The harness seeds a test secret
// and stubs the native host that would normally hand it over.
const TEST_SECRET = "0123456789abcdef".repeat(4);
const TEST_NONCE = "testnonce".repeat(8);

function install({ relayUrl, fakeSocket = true } = {}) {
  const tabs = new Map();
  const groups = new Map();
  let nextTab = 100, nextGroup = 1, ctxSeq = 0;
  const localStore = { enrollSecret: TEST_SECRET, ...(relayUrl ? { relayUrl } : {}) };
  const sessionStore = {};
  const sent = [];      // messages the worker sent over the fake socket
  const cdpLog = [];    // every CDP call: {tabId, method, params}
  const inputs = [];    // Input.* calls only
  const notifications = new Set();
  const windowTypes = {}; // windowId -> "normal" | "app" | "popup"
  let lastFocusedWindowId = 1;
  const E = {
    tabsUpdated: event(), tabsRemoved: event(), groupsRemoved: event(), groupsUpdated: event(),
    runtimeMsg: event(), tabsAttached: event(), tabsDetached: event(),
    alarm: event(), installed: event(), startup: event(), notifClicked: event(), dbgDetach: event(),
    tabsCreated: event(), tabsActivated: event(), winFocus: event(), dbgEvent: event(),
  };
  // Test knob for chrome.tabs.group failures beyond the window-type
  // refusal below: a function ({tabIds, groupId, createProperties}) that
  // returns an Error to throw, or null to let the call proceed.
  const groupBox = { hook: null };
  // Test knob for CDP failures (v2.7.2 transport tests): a function
  // ({tabId, method, params}) that returns an Error to throw from
  // chrome.debugger.sendCommand, or null to let the call proceed.
  const cdpBox = { hook: null };
  const dbgAttach = { count: 0 }; // chrome.debugger.attach calls seen
  // Ordered record of the visual layer, for hide-for-capture sequence
  // assertions: {kind:"cursor"|"pill", tabId, arg} for every scripting
  // call that drives an indicator, {kind:"capture", tabId} for every
  // Page.captureScreenshot, {kind:"captureView", windowId} for every
  // captureVisibleTab.
  const visualLog = [];
  let nextOwnWindow = 5000; // windows created around an existing tab
  const pillOf = {};   // tabId -> chat name the pill shows (set through chrome.scripting)
  const cursorOf = {}; // tabId -> last cursor command the worker sent (through chrome.scripting)
  const captures = []; // every captureVisibleTab call: {windowId, at}
  // What the page looks like to the probe. Tests change these.
  const page = {
    text: () => "page text here",
    fields: () => [],
    point: () => ({ tag: "div", text: "", fp: "div|plain" }),
    focus: () => ({ kind: "none", fp: "none" }),
    node: () => ({ tag: "input", type: "text", isField: true, fp: "input|text" }),
    axAtPoint: [],                 // partial AX tree returned for a hit-test node
    ax: {},                        // tabId -> full AX tree nodes
    elements: {},                  // backendNodeId -> fake element for non-probe functions
    history: {},                   // tabId -> {currentIndex, entries}
    shot: "iVBORw0KGgo=",
  };
  const store = (obj) => ({
    get: async (k) => ({ [k]: obj[k] === undefined ? undefined : JSON.parse(JSON.stringify(obj[k])) }),
    set: async (o) => { for (const [k, v] of Object.entries(o)) obj[k] = JSON.parse(JSON.stringify(v)); },
  });
  function mkTab(url, extra) {
    const t = { id: nextTab++, url, pendingUrl: undefined, title: url, groupId: -1, windowId: 1,
                active: false, openerTabId: undefined, status: "complete", ...extra };
    tabs.set(t.id, t);
    E.tabsCreated.fire({ ...t });
    return t;
  }
  function setGroup(tabId, groupId) {
    const t = tabs.get(tabId);
    const old = t.groupId;
    if (groupId !== -1 && !groups.has(groupId)) {
      groups.set(groupId, { id: groupId, title: "", color: "grey", windowId: t.windowId, collapsed: false });
    }
    t.groupId = groupId;
    E.tabsUpdated.fire(tabId, { groupId }, { ...t });
    // Chrome deletes a group when its last tab leaves, and says so.
    if (old !== -1 && old !== groupId && groups.has(old) && ![...tabs.values()].some((x) => x.groupId === old)) {
      const g = groups.get(old);
      groups.delete(old);
      E.groupsRemoved.fire({ ...g });
    }
  }
  function mkGroup(title, windowId = 1, color = "grey") {
    const g = { id: nextGroup++, title, color, windowId, collapsed: false };
    groups.set(g.id, g);
    return { ...g };
  }
  // Drag a tab to another window: Chrome ungroups it on the way, fires
  // detached/attached, and the tab lands ungrouped in the new window.
  function moveToWindow(tabId, windowId) {
    const t = tabs.get(tabId);
    const oldWindowId = t.windowId;
    E.tabsDetached.fire(tabId, { oldWindowId, oldPosition: 0 });
    t.windowId = windowId;
    if (t.groupId !== -1) setGroup(tabId, -1);
    E.tabsAttached.fire(tabId, { newWindowId: windowId, newPosition: 0 });
    return t;
  }
  function setUrl(tabId, url) {
    const t = tabs.get(tabId);
    t.url = url; t.title = url;
    E.tabsUpdated.fire(tabId, { url }, { ...t });
  }

  let PROBE_SRC = null;
  async function sendCommand(target, method, params = {}) {
    const t = tabs.get(target.tabId);
    cdpLog.push({ tabId: target.tabId, method, params });
    if (method === "Page.captureScreenshot") visualLog.push({ kind: "capture", tabId: target.tabId });
    if (cdpBox.hook) { const err = cdpBox.hook({ tabId: target.tabId, method, params }); if (err) throw err; }
    switch (method) {
      case "Page.getFrameTree": return { frameTree: { frame: { id: "f" + target.tabId, loaderId: "L:" + (t && t.url), url: t && t.url } } };
      case "Page.createIsolatedWorld": return { executionContextId: ++ctxSeq };
      case "Page.getLayoutMetrics": return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
      case "Page.getNavigationHistory": return page.history[target.tabId] || { currentIndex: 0, entries: [{ id: 1, url: t.url }] };
      case "Page.navigateToHistoryEntry": {
        const h = page.history[target.tabId];
        const e = h && h.entries.find((x) => x.id === params.entryId);
        if (e) { h.currentIndex = h.entries.indexOf(e); setUrl(target.tabId, e.url); }
        return {};
      }
      case "Page.captureScreenshot": return { data: typeof page.shot === "function" ? page.shot(params) : page.shot };
      case "DOM.getNodeForLocation": return { backendNodeId: 900 };
      case "DOM.resolveNode": return { object: { objectId: "obj:" + params.backendNodeId } };
      case "DOM.describeNode": return { node: typeof page.describeNode === "function" ? page.describeNode(params.backendNodeId) : { attributes: [] } };
      case "DOM.getDocument": return { root: typeof page.domTree === "function" ? page.domTree(params) : (page.domTree || null) };
      case "DOM.getContentQuads": return { quads: typeof page.quads === "function" ? page.quads(target.tabId, params) : (page.quads || [[10, 10, 30, 10, 30, 30, 10, 30]]) };
      case "Accessibility.getFullAXTree":
        return { nodes: page.ax[target.tabId] || [{ nodeId: "1", role: { value: "RootWebArea" }, name: { value: "" }, backendDOMNodeId: 1 }] };
      case "Accessibility.getPartialAXTree": {
        const all = page.ax[target.tabId] || [];
        const n = all.find((x) => x.backendDOMNodeId === params.backendNodeId);
        if (n) return { nodes: [n] };
        return { nodes: params.backendNodeId === 900 ? page.axAtPoint : [] };
      }
      case "Runtime.callFunctionOn": {
        const src = params.functionDeclaration;
        const args = (params.arguments || []).map((a) => a.value);
        if (src.includes("scrollBy")) return { result: { value: !!page.scrollMoves } };
        if (src === PROBE_SRC) {
          const mode = args[0];
          const f = page[mode === "refpoint" ? "point" : mode];
          const v = typeof f === "function" ? f(t, args[1], params.objectId) : null;
          return { result: { value: { host: hostOf(t && t.url), v } } };
        }
        const b = Number(String(params.objectId || "").split(":")[1]);
        const el = page.elements[b] || {};
        const fn = new Function("return (" + src + ")")();
        return { result: { value: fn.apply(el, args) } };
      }
      case "Input.dispatchMouseEvent": case "Input.dispatchKeyEvent": case "Input.insertText":
        // page.hangWheel: Chrome never answers a wheel event (seen on WhatsApp 2026-09-28)
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseWheel" && page.hangWheel) return new Promise(() => {});
        inputs.push({ tabId: target.tabId, method, params });
        return {};
      default: return {};
    }
  }

  global.chrome = {
    runtime: {
      id: "extid", getURL: (p) => "chrome-extension://extid/" + p,
      sendNativeMessage: async () => ({ ok: true, started: false, running: true, enrollSecret: TEST_SECRET }),
      sendMessage: async () => {}, onMessage: { addListener: (f) => E.runtimeMsg.addListener(f) },
      onInstalled: { addListener: (f) => E.installed.addListener(f) },
      onStartup: { addListener: (f) => E.startup.addListener(f) },
    },
    storage: { local: store(localStore), session: store(sessionStore) },
    tabs: {
      get: async (id) => { const t = tabs.get(Number(id)); if (!t) throw new Error("No tab"); return { ...t }; },
      query: async (q) => [...tabs.values()].filter((t) =>
        (q.groupId === undefined || t.groupId === q.groupId) && (q.active === undefined || t.active === q.active) &&
        (q.windowId === undefined || t.windowId === q.windowId) &&
        (q.lastFocusedWindow === undefined || !q.lastFocusedWindow || t.windowId === lastFocusedWindowId)).map((t) => ({ ...t })),
      create: async ({ url, windowId, active }) => ({ ...mkTab(url || "about:blank", { windowId, active: !!active }) }),
      update: async (id, { url }) => { setUrl(id, url); return { ...tabs.get(id) }; },
      group: async ({ tabIds, groupId, createProperties }) => {
        if (groupBox.hook) { const err = groupBox.hook({ tabIds, groupId, createProperties }); if (err) throw err; }
        for (const id of tabIds) {
          const t = tabs.get(id);
          if (t && (windowTypes[t.windowId] || "normal") !== "normal") throw new Error("Grouping is not supported by tabs in this window.");
        }
        let gid = groupId;
        if (gid !== undefined && gid !== null) {
          const g = groups.get(gid);
          if (!g) throw new Error("No group with id: " + gid);
          // Real Chrome moves a tab into the group's window when it is
          // grouped into a group that lives in another window.
          for (const id of tabIds) {
            const t = tabs.get(id);
            if (t && t.windowId !== g.windowId) t.windowId = g.windowId;
          }
        } else {
          gid = nextGroup++;
          const first = tabs.get(tabIds[0]);
          const winId = createProperties && createProperties.windowId !== undefined
            ? createProperties.windowId : (first ? first.windowId : 1);
          groups.set(gid, { id: gid, title: "", color: "grey", windowId: winId, collapsed: false });
          for (const id of tabIds) { const t = tabs.get(id); if (t) t.windowId = winId; }
        }
        for (const id of tabIds) setGroup(id, gid);
        return gid;
      },
      ungroup: async (ids) => { for (const id of [].concat(ids)) setGroup(id, -1); },
      remove: async (ids) => { for (const id of [].concat(ids)) { tabs.delete(id); E.tabsRemoved.fire(id); } },
      goBack: async () => {}, goForward: async () => {},
      captureVisibleTab: async (windowId, opts) => {
        captures.push({ windowId, at: Date.now() });
        visualLog.push({ kind: "captureView", windowId });
        if (typeof page.captureView === "function") return page.captureView(windowId, opts);
        return "data:image/jpeg;base64," + page.shot;
      },
      onUpdated: { addListener: (f) => E.tabsUpdated.addListener(f) },
      onActivated: { addListener: (f) => E.tabsActivated.addListener(f) },
      onCreated: { addListener: (f) => E.tabsCreated.addListener(f) },
      onRemoved: { addListener: (f) => E.tabsRemoved.addListener(f) },
      onAttached: { addListener: (f) => E.tabsAttached.addListener(f) },
      onDetached: { addListener: (f) => E.tabsDetached.addListener(f) },
    },
    tabGroups: {
      get: async (id) => { const g = groups.get(id); if (!g) throw new Error("No group"); return { ...g }; },
      update: async (id, p) => { const g = groups.get(id); if (!g) throw new Error("No group"); Object.assign(g, p); E.groupsUpdated.fire({ ...g }); return { ...g }; },
      query: async (q = {}) => [...groups.values()]
        .filter((g) => (q.title === undefined || g.title === q.title) && (q.windowId === undefined || g.windowId === q.windowId))
        .map((g) => ({ ...g })),
      onRemoved: { addListener: (f) => E.groupsRemoved.addListener(f) },
      onUpdated: { addListener: (f) => E.groupsUpdated.addListener(f) },
    },
    debugger: {
      attach: async () => { dbgAttach.count++; }, detach: async () => {}, sendCommand, getTargets: async () => [],
      onDetach: { addListener: (f) => E.dbgDetach.addListener(f) },
      onEvent: { addListener: (f) => E.dbgEvent.addListener(f) },
    },
    webNavigation: {
      // The tab's frame inventory. Tests set page.frames (an array, or a
      // map tabId -> array, or a function of the tab); by default the tab
      // is a single top frame, which keeps the worker on its AX-only
      // read path exactly as before.
      getAllFrames: async ({ tabId }) => {
        const t = tabs.get(Number(tabId));
        if (!t) throw new Error("No tab with id: " + tabId);
        if (typeof page.frames === "function") return page.frames(t);
        if (page.frames && page.frames[t.id]) return page.frames[t.id];
        return [{ frameId: 0, parentFrameId: -1, url: t.url, errorOccurred: false }];
      },
    },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        if (!tabs.has(target.tabId)) throw new Error("No tab with id: " + target.tabId);
        if (func && PROBE_SRC && String(func) === PROBE_SRC) {
          // The worker is running the page probe inside one frame (the
          // all-frames read). The test answers for the frame through
          // page.frameProbe(tab, frameId, mode, args) -> the probe's v.
          const t = tabs.get(target.tabId);
          const frameId = target.frameIds && target.frameIds.length ? target.frameIds[0] : 0;
          const frames = (typeof page.frames === "function" ? page.frames(t)
            : (page.frames && page.frames[t.id])) || [{ frameId: 0, url: t.url }];
          const fr = frames.find((f) => f.frameId === frameId) || frames[0];
          const v = typeof page.frameProbe === "function" ? page.frameProbe(t, frameId, args[0], args[1]) : null;
          return [{ result: { host: hostOf(fr && fr.url), v } }];
        }
        if (func) {
          // The pill and the cursor are driven the same way; tell them apart
          // by the page-global each func drives, as the real page would.
          if (String(func).includes("__museBridgeCursor")) { cursorOf[target.tabId] = args && args[0]; visualLog.push({ kind: "cursor", tabId: target.tabId, arg: args && args[0] }); }
          else { pillOf[target.tabId] = args && args[0]; visualLog.push({ kind: "pill", tabId: target.tabId, arg: args && args[0] }); }
        }
        return [{ result: null }];
      },
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    notifications: {
      create: async (id) => { notifications.add(id); }, clear: async (id) => { notifications.delete(id); },
      getAll: async () => Object.fromEntries([...notifications].map((id) => [id, true])),
      onClicked: { addListener: (f) => E.notifClicked.addListener(f) },
    },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    alarms: { create: () => {}, onAlarm: { addListener: (f) => E.alarm.addListener(f) } },
    windows: {
      getLastFocused: async () => ({ id: lastFocusedWindowId }),
      getCurrent: async () => ({ id: lastFocusedWindowId }),
      get: async (id) => ({ id, type: windowTypes[id] || "normal", incognito: false }),
      getAll: async () => [...new Set([1, ...[...tabs.values()].map((t) => t.windowId)])]
        .filter((id) => (windowTypes[id] || "normal") === "normal").map((id) => ({ id, type: "normal", incognito: false })),
      create: async ({ url, tabId, type }) => {
        if (tabId !== undefined && tabId !== null) {
          // chrome.windows.create({tabId}): the tab moves into a window
          // of its own — detached from the old window, ungrouped on the
          // way (as any cross-window move), attached to the new one.
          const t = tabs.get(Number(tabId));
          if (!t) throw new Error("No tab with id: " + tabId);
          const wid = ++nextOwnWindow;
          windowTypes[wid] = type || "normal";
          const oldWindowId = t.windowId;
          E.tabsDetached.fire(t.id, { oldWindowId, oldPosition: 0 });
          t.windowId = wid;
          if (t.groupId !== -1) setGroup(t.id, -1);
          E.tabsAttached.fire(t.id, { newWindowId: wid, newPosition: 0 });
          return { id: wid, type: windowTypes[wid], tabs: [{ ...t }] };
        }
        const w = 900 + nextGroup; const t = mkTab(url, { windowId: w }); return { id: w, tabs: [{ ...t }] };
      },
      onFocusChanged: { addListener: (f) => E.winFocus.addListener(f) },
    },
  };

  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 0; FakeWS.last = this; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); this.deliver({ t: "challenge", nonce: TEST_NONCE }); }, 0); }
    send(s) { sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; this.onclose && this.onclose(); }
    deliver(obj) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }); }
  }
  FakeWS.OPEN = 1; FakeWS.CONNECTING = 0;
  if (fakeSocket) global.WebSocket = FakeWS;
  global.self = global;
  global.importScripts = (f) => vm.runInThisContext(fs.readFileSync(path.join(EXT, f), "utf8"), { filename: f });

  vm.runInThisContext(fs.readFileSync(path.join(EXT, "sw.js"), "utf8"), { filename: "sw.js" });
  PROBE_SRC = vm.runInThisContext("PROBE_SRC");

  const PANEL = { id: "extid", url: "chrome-extension://extid/sidepanel.html" };
  const panel = (kind, extra, sender = PANEL) => new Promise((resolve) => {
    E.runtimeMsg.fire({ kind, ...(extra || {}) }, sender, resolve);
  });
  return { tabs, groups, sent, cdpLog, inputs, notifications, windowTypes, pillOf, cursorOf, captures, E, page, mkTab, setGroup, setUrl, mkGroup, moveToWindow, FakeWS, groupBox, cdpBox, dbgAttach, visualLog,
           setLastFocusedWindow: (id) => { lastFocusedWindowId = id; },
           panel, sessionStore, localStore, sw: (expr) => vm.runInThisContext(expr) };
}

module.exports = { install, hostOf };
