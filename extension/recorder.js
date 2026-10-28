/* Muse Chrome Bridge — workflow recorder (v2.8, FULL-GAP §12).
 *
 * Injected into ONE tab when the user presses "Record workflow" in
 * the panel. It watches the USER's own clicks and field edits
 * (capture phase) and reports each as a step to the worker, which
 * stores them and, on stop, saves the list as a saved prompt.
 *
 * Privacy shape: a step names the element ("Click button 'Save'",
 * "Type into field 'Email'") — typed VALUES are never recorded.
 */
(function () {
  if (window.__museBridgeRecorder) return;
  window.__museBridgeRecorder = true;

  function clip(s, n) { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function labelOf(e) {
    if (!e || !e.getAttribute) return "";
    return clip(e.getAttribute("aria-label") || e.getAttribute("name") || e.id ||
                e.getAttribute("placeholder") || e.getAttribute("title") || "", 60);
  }
  function textOf(e) { return clip(e && (e.innerText || e.textContent) || "", 60); }
  function send(step) {
    try { var p = chrome.runtime.sendMessage({ kind: "wf_step", step }); if (p && p.catch) p.catch(function () {}); } catch (err) {}
  }
  function describeClick(e) {
    var tag = (e.tagName || "").toLowerCase();
    var label = labelOf(e) || textOf(e);
    if (tag === "button" || (e.getAttribute && e.getAttribute("role") === "button")) return "Click button" + (label ? " '" + label + "'" : "");
    if (tag === "a") return "Click link" + (label ? " '" + label + "'" : "");
    if (tag === "input") {
      var t = (e.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return "Toggle " + t + (label ? " '" + label + "'" : "");
      if (t === "submit" || t === "button") return "Click button" + (label ? " '" + (labelOf(e) || e.value || "") + "'" : "");
      return "Click field" + (label ? " '" + label + "'" : "");
    }
    if (tag === "select" || tag === "textarea") return "Click field" + (label ? " '" + label + "'" : "");
    return "Click " + (tag || "element") + (label ? " '" + label + "'" : "");
  }

  document.addEventListener("click", function (ev) {
    if (!ev.target || !ev.target.tagName) return;
    send({ kind: "click", desc: describeClick(ev.target), url: location.href });
  }, true);

  // One step per field per burst of typing (the value is never sent).
  var pending = new Map();
  document.addEventListener("input", function (ev) {
    var e = ev.target;
    if (!e || !e.tagName) return;
    var tag = e.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea" && !e.isContentEditable) return;
    if (tag === "input" && /^(checkbox|radio|submit|button|file|hidden)$/.test((e.getAttribute("type") || "").toLowerCase())) return;
    var key = e;
    if (pending.has(key)) clearTimeout(pending.get(key));
    pending.set(key, setTimeout(function () {
      pending.delete(key);
      var label = labelOf(e);
      send({ kind: "input", desc: "Type into field" + (label ? " '" + label + "'" : ""), url: location.href });
    }, 800));
  }, true);
})();
