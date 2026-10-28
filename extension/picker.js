/* Muse Chrome Bridge — element picker (v2.8, FULL-GAP §12).
 *
 * Injected into a tab when the user presses "Pick an element" in the
 * panel. Hovering outlines the element under the pointer; a click
 * captures its facts and sends them to the worker (which shows them
 * in the panel, ready to drop into a prompt); Esc cancels. One shot:
 * after a pick or a cancel the listeners come off.
 */
(function () {
  if (window.__museBridgePicker) return;

  var outlined = null, savedOutline = "";
  function restore() {
    if (outlined) { outlined.style.outline = savedOutline; outlined = null; }
  }
  function cleanup() {
    restore();
    document.removeEventListener("mouseover", onOver, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    window.__museBridgePicker = false;
  }
  function send(msg) {
    try { var p = chrome.runtime.sendMessage(msg); if (p && p.catch) p.catch(function () {}); } catch (e) {}
  }
  function onOver(ev) {
    if (!ev.target || !ev.target.style) return;
    restore();
    outlined = ev.target;
    savedOutline = outlined.style.outline || "";
    outlined.style.outline = "2px solid #2563eb";
  }
  function onClick(ev) {
    var e = ev.target;
    if (!e || !e.getBoundingClientRect) return;
    ev.preventDefault(); ev.stopPropagation();
    var r = e.getBoundingClientRect();
    var text = "";
    try { text = String(e.innerText || e.textContent || e.value || "").replace(/\s+/g, " ").trim().slice(0, 80); } catch (err) {}
    var pick = {
      tag: (e.tagName || "").toLowerCase(),
      id: e.id || "",
      className: String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className || "").slice(0, 80),
      text,
      name: e.getAttribute ? (e.getAttribute("name") || "") : "",
      type: e.getAttribute ? (e.getAttribute("type") || "") : "",
      ariaLabel: e.getAttribute ? (e.getAttribute("aria-label") || "") : "",
      href: e.getAttribute ? (e.getAttribute("href") || "") : "",
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      url: location.href,
    };
    cleanup();
    send({ kind: "pick_result", pick });
  }
  function onKey(ev) {
    if (ev.key === "Escape") { cleanup(); send({ kind: "pick_cancel" }); }
  }
  window.__museBridgePicker = true;
  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
})();
