/* Muse Chrome Bridge — the agent layer (v2.8, FULL-GAP §8).
 *
 * Injected into shared tabs and driven by the worker through
 * window.__museBridgeAgentUI(cmd), the same pattern as the pill and
 * the cursor. It draws what Claude in Chrome draws while it works:
 *
 *   - a pulsing glow border around the page while a command runs;
 *   - a "Stop Muse" button (bottom centre) that asks the worker to
 *     cancel the in-flight work on this tab — if no answer comes
 *     within 1.5 s it reports the drop and shows the fallback toast,
 *     exactly as Claude's does;
 *   - a static pill ("Muse is active in this tab group") on the
 *     chat's other tabs, with Open chat and Dismiss, kept honest by a
 *     5 s heartbeat: if the worker stops answering, the pill removes
 *     itself;
 *   - a silent audio keep-alive while working, so the page is not
 *     throttled as a background page mid-task.
 *
 * Everything is pointer-events:none except the two buttons. The
 * worker hides this layer before every screenshot
 * (hideForCapture / showAfterCapture).
 */
(function () {
  if (window.__museBridgeAgentUI) return;

  var state = { working: false, statik: false };
  var captureHidden = false;
  var stopTimer = 0, heartbeatTimer = 0;
  var audioCtx = null, root = null, glow = null, stopBtn = null, pill = null, toast = null;

  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  function build() {
    if (root) return;
    var style = document.createElement("style");
    style.textContent =
      "@keyframes muse-agent-pulse { 0%,100% { box-shadow: inset 0 0 0 3px rgba(37,99,235,.85), inset 0 0 22px rgba(37,99,235,.35); }" +
      " 50% { box-shadow: inset 0 0 0 3px rgba(37,99,235,.35), inset 0 0 8px rgba(37,99,235,.12); } }";
    document.documentElement.appendChild(style);
    root = el("div", "position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-family:system-ui,-apple-system,sans-serif;");
    glow = el("div", "position:absolute;inset:0;display:none;animation:muse-agent-pulse 2s ease-in-out infinite;");
    stopBtn = el("button",
      "position:absolute;left:50%;bottom:26px;transform:translateX(-50%);display:none;pointer-events:auto;" +
      "background:#b91c1c;color:#fff;border:0;border-radius:999px;padding:9px 20px;font-size:14px;font-weight:600;" +
      "cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.35);", "■ Stop Muse");
    stopBtn.addEventListener("click", onStop);
    pill = el("div",
      "position:absolute;left:16px;bottom:16px;display:none;align-items:center;gap:8px;pointer-events:auto;" +
      "background:rgba(17,24,39,.92);color:#f3f4f6;border-radius:999px;padding:7px 8px 7px 14px;font-size:13px;" +
      "box-shadow:0 4px 18px rgba(0,0,0,.3);");
    pill.appendChild(el("span", "", "Muse is active in this tab group"));
    var open = el("button",
      "background:#2563eb;color:#fff;border:0;border-radius:999px;padding:4px 12px;font-size:12px;font-weight:600;cursor:pointer;", "Open chat");
    open.addEventListener("click", function () { send({ kind: "agent_open_chat" }); });
    var dismiss = el("button",
      "background:transparent;color:#d1d5db;border:1px solid #4b5563;border-radius:999px;padding:4px 10px;font-size:12px;cursor:pointer;", "Dismiss");
    dismiss.addEventListener("click", function () {
      state.statik = false; render();
      send({ kind: "agent_dismiss_static" });
    });
    pill.appendChild(open); pill.appendChild(dismiss);
    toast = el("div",
      "position:absolute;left:50%;bottom:76px;transform:translateX(-50%);display:none;max-width:80%;" +
      "background:rgba(17,24,39,.95);color:#fff;border-radius:10px;padding:10px 16px;font-size:13px;text-align:center;" +
      "box-shadow:0 4px 18px rgba(0,0,0,.35);");
    root.appendChild(glow); root.appendChild(stopBtn); root.appendChild(pill); root.appendChild(toast);
    document.documentElement.appendChild(root);
  }

  function send(msg) {
    try {
      var p = chrome.runtime.sendMessage(msg);
      if (p && p.catch) p.catch(function () {});
      return p;
    } catch (e) { return null; }
  }

  function onStop() {
    send({ kind: "agent_stop" });
    // Claude's dropped-stop detection: if the worker does not take
    // the working layer down within 1.5 s, the stop did not land.
    clearTimeout(stopTimer);
    stopTimer = setTimeout(function () {
      if (!state.working) return;
      send({ kind: "agent_stop_dropped" });
      showToast("Stop didn't reach Muse — close the side panel to stop.");
    }, 1500);
  }

  function showToast(text) {
    build();
    toast.textContent = text;
    toast.style.display = "block";
    setTimeout(function () { toast.style.display = "none"; }, 5000);
  }

  function ensureAudio() {
    // A running (even silent) AudioContext keeps the page classed as
    // audible so timers and rendering are not throttled mid-task.
    try {
      if (!audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        audioCtx = new AC();
        var gain = audioCtx.createGain(); gain.gain.value = 0;
        var src = audioCtx.createConstantSource ? audioCtx.createConstantSource() : audioCtx.createOscillator();
        src.connect(gain); gain.connect(audioCtx.destination); src.start();
      }
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) { /* best effort */ }
  }
  function dropAudio() {
    try { if (audioCtx) { audioCtx.close(); audioCtx = null; } } catch (e) { audioCtx = null; }
  }

  function heartbeat() {
    var p = send({ kind: "agent_heartbeat" });
    if (!p || !p.then) return;
    p.then(function (r) {
      if (!r || !r.active) { state.statik = false; render(); }
    }, function () { state.statik = false; render(); });
  }

  function render() {
    build();
    var showWork = state.working && !captureHidden;
    var showPill = state.statik && !state.working && !captureHidden;
    glow.style.display = showWork ? "block" : "none";
    stopBtn.style.display = showWork ? "block" : "none";
    pill.style.display = showPill ? "flex" : "none";
    if (state.working) ensureAudio(); else dropAudio();
    if (!state.working) clearTimeout(stopTimer);
    if (showPill && !heartbeatTimer) { heartbeat(); heartbeatTimer = setInterval(heartbeat, 5000); }
    if (!showPill && heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = 0; }
  }

  window.__museBridgeAgentUI = function (cmd) {
    if (!cmd) { // removal: take everything down and keep it down
      state = { working: false, statik: false };
      clearInterval(heartbeatTimer); heartbeatTimer = 0;
      clearTimeout(stopTimer); dropAudio();
      if (root) { root.remove(); root = null; glow = stopBtn = pill = toast = null; }
      return;
    }
    if (cmd.op === "hideForCapture") { captureHidden = true; render(); return; }
    if (cmd.op === "showAfterCapture") { captureHidden = false; render(); return; }
    if (typeof cmd.working === "boolean") state.working = cmd.working;
    if (typeof cmd.static === "boolean") state.statik = cmd.static;
    render();
  };
})();
