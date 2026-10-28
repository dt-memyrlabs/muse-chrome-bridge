/* Muse Chrome Bridge — the pill shown on every tab a Muse chat controls.
 * Injected by the worker (chrome.scripting) into connected tabs only. It runs
 * in the extension's isolated world and draws into a closed shadow root, so
 * the page cannot read or change its text. The page CAN hide, remove or cover
 * it: the pill is a hint, the side panel is the true list. Drag it anywhere; ✕ stops sharing
 * this tab with the chat. The worker calls window.__museBridgePill(name) to
 * show it (name) or remove it (null), and with {op:"hideForCapture"} /
 * {op:"showAfterCapture"} to take it off screen around a screenshot and
 * restore it after (Claude in Chrome's HIDE_FOR_TOOL_USE /
 * SHOW_AFTER_TOOL_USE; a 5 s safety timer restores it if the show never
 * arrives). */
(() => {
  if (window.top !== window || window.__museBridgePill) return;
  let host = null, nameEl = null;
  let capHidden = false, capTimer = null;

  function hideForCapture() {
    if (!host || capHidden) return;
    capHidden = true;
    host.style.display = "none";
    capTimer = setTimeout(showAfterCapture, 5000);
  }
  function showAfterCapture() {
    if (capTimer) { clearTimeout(capTimer); capTimer = null; }
    if (!capHidden) return;
    capHidden = false;
    if (host) host.style.display = "";
  }

  function build() {
    host = document.createElement("muse-bridge-pill");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:12px;right:12px;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      .pill{display:flex;align-items:center;gap:8px;padding:6px 8px 6px 12px;border-radius:999px;
        background:#1f2937;color:#fff;font:600 13px/1.2 system-ui,"Segoe UI",sans-serif;
        box-shadow:0 2px 10px rgba(0,0,0,.35);cursor:grab;user-select:none;white-space:nowrap}
      .pill:active{cursor:grabbing}
      .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;flex:none}
      .x{all:unset;cursor:pointer;width:20px;height:20px;border-radius:50%;text-align:center;line-height:20px;
        font-size:12px;color:#d1d5db}
      .x:hover{background:#374151;color:#fff}
    </style><div class="pill"><span class="dot"></span><span class="name"></span>
      <button class="x" title="Stop sharing this tab with this chat" tabindex="-1">✕</button></div>`;
    const pill = root.querySelector(".pill");
    nameEl = root.querySelector(".name");
    root.querySelector(".x").addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      e.stopPropagation();
      chrome.runtime.sendMessage({ kind: "pill_remove" }).catch(() => {});
    });
    // Drag anywhere; the spot is remembered for every connected tab.
    let drag = null;
    pill.addEventListener("pointerdown", (e) => {
      if (e.target.closest && e.target.closest(".x")) return;
      const r = host.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      pill.setPointerCapture(e.pointerId);
    });
    pill.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const x = Math.min(Math.max(0, e.clientX - drag.dx), innerWidth - host.offsetWidth);
      const y = Math.min(Math.max(0, e.clientY - drag.dy), innerHeight - host.offsetHeight);
      host.style.left = x + "px"; host.style.top = y + "px"; host.style.right = "auto";
    });
    pill.addEventListener("pointerup", () => {
      if (!drag) return;
      drag = null;
      const r = host.getBoundingClientRect();
      chrome.storage.local.set({ pillPos: { x: r.left / innerWidth, y: r.top / innerHeight } }).catch(() => {});
    });
    chrome.storage.local.get("pillPos").then(({ pillPos }) => {
      if (!pillPos || !host) return;
      host.style.left = Math.round(pillPos.x * innerWidth) + "px";
      host.style.top = Math.round(pillPos.y * innerHeight) + "px";
      host.style.right = "auto";
    }).catch(() => {});
    (document.documentElement || document).append(host);
  }

  window.__museBridgePill = (name) => {
    if (name && typeof name === "object") {
      if (name.op === "hideForCapture") hideForCapture();
      else if (name.op === "showAfterCapture") showAfterCapture();
      return;
    }
    // Each extension reload runs this file in a fresh world, and the pills
    // drawn by earlier loads stay in the page, so duplicates can accumulate.
    // The page's DOM is shared, so remove every pill but ours.
    for (const n of document.querySelectorAll("muse-bridge-pill")) if (n !== host) n.remove();
    if (!name) { if (host) host.remove(); host = null; return; }
    if (!host || !host.isConnected) build();
    nameEl.textContent = "Muse · " + name;
  };
})();
