/* Muse Chrome Bridge — the cursor shown on a tab while a Muse chat works it.
 * Injected by the worker (chrome.scripting) into connected tabs only, in the
 * same isolated world and overlay layer as the pill. It draws into a closed
 * shadow root and never intercepts pointer events (the host is
 * pointer-events:none), so the page cannot be disturbed by it and cannot
 * read it. The worker calls window.__museBridgeCursor(cmd):
 *   { op: "go", x, y, pulse } — glide to the viewport point (x, y); with
 *       pulse, ring the point the way a click lands. Returns a promise that
 *       resolves when the glide (and pulse) has finished on screen, so the
 *       action it announces fires only after the user has seen it arrive.
 *   { op: "warm" } — the script is loaded; show nothing.
 *   { op: "hide" } — fade out. (null) removes the cursor at once.
 *   { op: "hideForCapture" } / { op: "showAfterCapture" } — hide before a
 *       screenshot and restore after it, so a capture never contains the
 *       cursor (Claude in Chrome's HIDE_FOR_TOOL_USE / SHOW_AFTER_TOOL_USE).
 *       A safety timer restores the cursor after 5 s if the show never
 *       arrives, exactly as theirs does.
 * An idle cursor fades out on its own after a few seconds. */
(() => {
  if (window.top !== window || window.__museBridgeCursor) return;
  const MAX_TRAVEL_MS = 340;  // longest glide across the screen
  const PULSE_MS = 380;
  const IDLE_MS = 4000;
  let host = null, cur = null, ring = null;
  let pos = null;             // last point shown {x, y}; null while never shown
  let idleTimer = null;
  let chain = Promise.resolve();
  let capHidden = false, capWasShown = false, capTimer = null;

  function build() {
    host = document.createElement("muse-bridge-cursor");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial;position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      .cur{position:fixed;left:0;top:0;width:26px;height:26px;opacity:0;pointer-events:none;
        transition-property:transform,opacity;transition-timing-function:cubic-bezier(.25,.8,.35,1),ease;
        filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));will-change:transform}
      .ring{position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;
        border:2.5px solid #2563eb;opacity:0;pointer-events:none}
    </style>
    <div class="cur"><svg width="26" height="26" viewBox="0 0 24 24">
      <path d="M5 3 L19 12 L12.6 13.4 L15.5 20 L12.8 21.2 L10 14.8 L5.8 18.6 Z"
        fill="#fff" stroke="#1f2937" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="19.5" cy="4.5" r="2.4" fill="#2563eb"/>
    </svg></div><div class="ring"></div>`;
    cur = root.querySelector(".cur");
    ring = root.querySelector(".ring");
    (document.documentElement || document).append(host);
  }

  function teardown() {
    if (host) host.remove();
    host = null; cur = null; ring = null; pos = null;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (capTimer) { clearTimeout(capTimer); capTimer = null; }
    capHidden = false; capWasShown = false;
  }

  // Hide for a screenshot: remember whether the cursor was on screen,
  // take it off, and restore it when told — or after 5 s on our own,
  // so a lost "show" can never leave the cursor hidden for good.
  function hideForCapture() {
    if (capHidden) return;
    capHidden = true;
    capWasShown = !!(cur && cur.style.opacity === "1");
    if (cur) cur.style.opacity = "0";
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    capTimer = setTimeout(showAfterCapture, 5000);
  }
  function showAfterCapture() {
    if (capTimer) { clearTimeout(capTimer); capTimer = null; }
    if (!capHidden) return;
    capHidden = false;
    if (capWasShown && cur) { cur.style.opacity = "1"; armIdle(); }
    capWasShown = false;
  }

  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (cur) cur.style.opacity = "0"; pos = null; }, IDLE_MS);
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function go(x, y, pulse) {
    // Earlier loads of this file (extension reloads) can leave a cursor
    // behind; the page DOM is shared, so remove every one but ours.
    for (const n of document.querySelectorAll("muse-bridge-cursor")) if (n !== host) n.remove();
    if (!host || !host.isConnected) { build(); pos = null; }
    const tx = Math.max(0, Math.min(x, innerWidth - 4));
    const ty = Math.max(0, Math.min(y, innerHeight - 4));
    let ms = 0;
    if (pos === null) {
      // First appearance: fade in a short approach away from the target,
      // then glide the rest of the way, so the eye can follow it in.
      const sx = Math.max(0, Math.min(tx - 150, innerWidth - 30));
      const sy = Math.max(0, Math.min(ty - 110, innerHeight - 30));
      cur.style.transitionDuration = "0ms, 160ms";
      cur.style.transform = `translate(${sx}px, ${sy}px)`;
      cur.style.opacity = "1";
      pos = { x: sx, y: sy };
      await wait(30);
    }
    const dist = Math.hypot(tx - pos.x, ty - pos.y);
    if (dist > 2) {
      ms = Math.round(Math.max(130, Math.min(MAX_TRAVEL_MS, 110 + dist * 0.28)));
      cur.style.transitionDuration = ms + "ms, 160ms";
      cur.style.transform = `translate(${tx}px, ${ty}px)`;
      cur.style.opacity = "1";
      pos = { x: tx, y: ty };
      await wait(ms);
    } else {
      cur.style.opacity = "1";
      pos = { x: tx, y: ty };
    }
    if (pulse) {
      ring.style.transform = `translate(${tx}px, ${ty}px)`;
      const anim = ring.animate(
        [{ transform: `translate(${tx}px, ${ty}px) scale(.35)`, opacity: .85 },
         { transform: `translate(${tx}px, ${ty}px) scale(1.5)`, opacity: 0 }],
        { duration: PULSE_MS, easing: "ease-out" });
      cur.animate([{ transform: `translate(${tx}px, ${ty}px) scale(1)` },
                   { transform: `translate(${tx}px, ${ty}px) scale(.82)`, offset: .35 },
                   { transform: `translate(${tx}px, ${ty}px) scale(1)` }],
                  { duration: 220, easing: "ease-in-out" }).catch(() => {});
      await anim.finished.catch(() => {});
    }
    armIdle();
  }

  window.__museBridgeCursor = (cmd) => {
    if (!cmd) { teardown(); return Promise.resolve(true); }
    if (cmd.op === "warm") return Promise.resolve(true);
    if (cmd.op === "hide") {
      if (cur) cur.style.opacity = "0";
      pos = null;
      return Promise.resolve(true);
    }
    if (cmd.op === "hideForCapture") { hideForCapture(); return Promise.resolve(true); }
    if (cmd.op === "showAfterCapture") { showAfterCapture(); return Promise.resolve(true); }
    if (cmd.op === "go" && Number.isFinite(cmd.x) && Number.isFinite(cmd.y)) {
      // Serialize: a glide asked for while one is running waits its turn,
      // so the cursor never teleports between two announced actions.
      chain = chain.then(() => go(cmd.x, cmd.y, !!cmd.pulse)).catch(() => {});
      return chain.then(() => true);
    }
    return Promise.resolve(false);
  };
})();
