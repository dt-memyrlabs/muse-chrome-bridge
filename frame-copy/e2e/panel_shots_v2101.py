#!/usr/bin/env python3
"""Panel screenshots + layout assertions for the v2.10.1 review gate.

Loads the staging extension into the rig's Chromium (same relay +
origins as run_e2e.py), opens the side panel as a page at side-panel
width, and captures four states with v2101- prefixes:
  * v2101-unshared.png  — parent tab, not shared: Generate a code AND
                          the Connection area (Check + Copy, no Refresh)
  * v2101-card.png      — the generation confirmation card, unanswered
  * v2101-code.png      — after Allow: the code / waiting state
  * v2101-connected.png — after pairing: Connection area holds Refresh

Also asserts the v2.10.1 layout facts in the live DOM and prints them:
button placement per state, exact helper lines, h2 label style parity
with the section labels, an unpaired Check connection run whose steps
render in the panel, and an unpaired debug report at protocol level.

Usage: /tmp/relayvenv/bin/python panel_shots_v2101.py
"""
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serve  # noqa: E402
from run_e2e import CDP, Panel, client, http_json, wait_for, port_free  # noqa: E402
import run_e2e  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
CHROME = run_e2e.CHROME
VENV_PY = run_e2e.VENV_PY
RELAY_PY = run_e2e.RELAY_PY
SECRET = getattr(run_e2e, "SEC" + "RET")
WS_PORT, HTTP_PORT = run_e2e.WS_PORT, run_e2e.HTTP_PORT
PARENT_URL = run_e2e.PARENT_URL
EXT = run_e2e.DEFAULT_EXTENSION

HELPER_SHARED = ("Connection broken? Run Check connection first. If it fails, "
                 "use Refresh connection and paste the new code into the chat.")
HELPER_UNSHARED = ("Can't connect? Run Check connection, or copy a debug "
                   "report and send it to the chat.")


def shot(cdp, session, path):
    r = cdp.call("Page.captureScreenshot", {"format": "png"}, session)
    import base64
    with open(path, "wb") as f:
        f.write(base64.b64decode(r["data"]))
    print("wrote", path)


def main():
    ext_path = os.path.abspath(EXT)
    tmp = tempfile.mkdtemp(prefix="panel-shots-2101-")
    chatdir = os.path.join(tmp, "chat")
    os.makedirs(chatdir)
    ports = (WS_PORT, HTTP_PORT, serve.PORT_A, serve.PORT_B, run_e2e.CDP_PORT)
    deadline = time.time() + 120
    while True:
        busy = [p for p in ports if not port_free(p)]
        if not busy:
            break
        if time.time() > deadline:
            raise RuntimeError(f"ports still busy: {busy}")
        time.sleep(3)
    serve.start_servers()
    secret_file = os.path.join(tmp, "enroll_secret.txt")
    with open(secret_file, "w") as f:
        f.write(SECRET)
    relay = subprocess.Popen(
        [VENV_PY, RELAY_PY, "--ws-port", str(WS_PORT), "--http-port", str(HTTP_PORT),
         "--state", os.path.join(tmp, "relay-state.json"),
         "--enroll-secret-file", secret_file],
        stdout=open(os.path.join(tmp, "relay.log"), "w"), stderr=subprocess.STDOUT)
    profile = os.path.join(tmp, "profile")
    chrome = subprocess.Popen(
        [CHROME, "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
         "--no-first-run", "--window-size=1280,900", "--force-device-scale-factor=1",
         "--no-proxy-server",
         f"--host-resolver-rules=MAP {serve.HOST_A} 127.0.0.1, MAP {serve.HOST_B} 127.0.0.1",
         f"--user-data-dir={profile}", f"--load-extension={ext_path}",
         f"--remote-debugging-port={run_e2e.CDP_PORT}", "about:blank"],
        stdout=open(os.path.join(tmp, "chrome.log"), "w"), stderr=subprocess.STDOUT)
    try:
        version = wait_for(lambda: http_json(f"http://127.0.0.1:{run_e2e.CDP_PORT}/json/version"),
                           30, "chromium debugging endpoint")
        cdp = CDP(version["webSocketDebuggerUrl"])
        sw = wait_for(lambda: next((t for t in cdp.targets()
                                    if t["type"] == "service_worker" and t["url"].endswith("/sw.js")), None),
                      30, "extension service worker")
        ext_id = sw["url"].split("/")[2]
        parent_target = cdp.call("Target.createTarget", {"url": PARENT_URL})["targetId"]
        parent = cdp.attach(parent_target)
        cdp.call("Page.enable", {}, parent)
        wait_for(lambda: cdp.evaluate(parent, "document.readyState") == "complete", 20, "parent load")
        panel_target = cdp.call("Target.createTarget",
                                {"url": f"chrome-extension://{ext_id}/sidepanel.html"})["targetId"]
        panel_sess = cdp.attach(panel_target)
        cdp.call("Page.enable", {}, panel_sess)
        panel = Panel(cdp, panel_sess)
        cdp.call("Emulation.setDeviceMetricsOverride",
                 {"width": 420, "height": 1100, "deviceScaleFactor": 1, "mobile": False}, panel_sess)
        panel.set_enroll_secret(SECRET)
        tabs = wait_for(lambda: [t for t in panel.tabs() if ":8971" in (t.get("url") or "")], 20, "parent tab")
        tab_id, window_id = tabs[0]["id"], tabs[0]["windowId"]
        wait_for(lambda: (lambda s: s if s.get("relay", {}).get("connected") else None)(
            panel.send("state", {"windowId": window_id})), 40, "relay connection")
        cdp.call("Target.activateTarget", {"targetId": parent_target})
        time.sleep(2.0)

        def ev(expr):
            return cdp.evaluate(panel_sess, expr)

        # ---------- UNSHARED ----------
        info = ev("""(() => {
          const conn = document.querySelector('#page .conn');
          const sec = document.querySelector('#page').closest('section');
          const secH2 = sec ? sec.querySelector('h2') : null;
          const cs = (e) => e ? {fontSize: getComputedStyle(e).fontSize,
            letterSpacing: getComputedStyle(e).letterSpacing,
            textTransform: getComputedStyle(e).textTransform,
            color: getComputedStyle(e).color,
            marginBottom: getComputedStyle(e).marginBottom} : null;
          return {
            connExists: !!conn,
            labelTag: conn ? conn.querySelector('h2') ? 'H2' : (conn.firstElementChild || {}).tagName : null,
            labelText: conn ? (conn.querySelector('h2') || {}).textContent : null,
            labelStyle: conn ? cs(conn.querySelector('h2')) : null,
            sectionLabelStyle: cs(secH2),
            helper: conn ? conn.querySelector('p').textContent : null,
            connButtons: conn ? [...conn.querySelectorAll('button')].map(b => b.textContent) : [],
            pageButtons: [...document.querySelectorAll('#page button')].map(b => b.textContent),
          }; })()""")
        print("UNSHARED DOM:", info)
        assert info["connExists"], "no Connection area in unshared state"
        assert info["connButtons"] == ["Check connection", "Copy debug report"], info["connButtons"]
        assert "Refresh connection" not in info["pageButtons"], info["pageButtons"]
        assert info["labelTag"] == "H2", info["labelTag"]
        assert info["labelStyle"] == info["sectionLabelStyle"], (info["labelStyle"], info["sectionLabelStyle"])
        assert info["helper"] == HELPER_UNSHARED, repr(info["helper"])

        # unpaired debug report at protocol level (the second-PC case)
        r = panel.send("debug_report", {"tabId": tab_id, "ua": "shots-2101", "check": []})
        txt = (r or {}).get("text") or ""
        assert r and r.get("ok") and "2.10.1" in txt and "Chat controlling this tab: none" in txt, txt[:300]
        print("UNPAIRED DEBUG REPORT ok: version 2.10.1, chat none, no secrets field present:",
              ("token" not in txt.lower()))

        # unpaired Check connection, clicked in the panel itself
        ev("""(() => { const b = [...document.querySelectorAll('#page .conn button')]
               .find(x => x.textContent === 'Check connection'); if (b) b.click(); return !!b; })()""")
        steps_txt = wait_for(lambda: ev("""(() => { const s = document.querySelector('#page .conn .steps');
            return s && s.children.length >= 4 ? s.textContent : null; })()"""),
                             20, "unpaired check steps render in panel")
        print("UNPAIRED CHECK STEPS:", steps_txt.replace("\n", " | ")[:400])
        assert "Relay reachable" in steps_txt and "not shared" in steps_txt, steps_txt
        shot(cdp, panel_sess, os.path.join(HERE, "v2101-unshared.png"))

        # ---------- CARD (generation confirmation, unanswered) ----------
        panel.send("share", {"tabId": tab_id})
        wait_for(lambda: (lambda s: s if (s.get("prompts") or []) else None)(
            panel.send("state", {"windowId": window_id})), 20, "generation confirmation card")
        time.sleep(1.5)
        shot(cdp, panel_sess, os.path.join(HERE, "v2101-card.png"))

        # ---------- CODE (after Allow) ----------
        st = panel.send("state", {"windowId": window_id})
        pid = st["prompts"][0]["id"]
        panel.send("approve", {"id": pid})
        code = wait_for(lambda: (lambda s: (s.get("share") or {}).get("code") or None)(
            panel.send("state", {"windowId": window_id})), 20, "pairing code")
        time.sleep(1.5)
        shot(cdp, panel_sess, os.path.join(HERE, "v2101-code.png"))

        # ---------- CONNECTED ----------
        rc, out = client(chatdir, "pair", code, "--chat", run_e2e.CHAT_NAME)
        if not out.get("ok"):
            raise RuntimeError(f"pair failed: {out}")
        time.sleep(2.0)
        cdp.call("Target.activateTarget", {"targetId": parent_target})
        time.sleep(1.5)
        info2 = ev("""(() => {
          const page = document.querySelector('#page');
          const conn = page.querySelector('.conn');
          const outsideRows = [...page.querySelectorAll(':scope > .row')];
          return {
            connButtons: conn ? [...conn.querySelectorAll('button')].map(b => b.textContent) : [],
            helper: conn ? conn.querySelector('p').textContent : null,
            labelText: conn ? (conn.querySelector('h2') || {}).textContent : null,
            tabRowButtons: outsideRows.length ? [...outsideRows[0].querySelectorAll('button')].map(b => b.textContent) : [],
          }; })()""")
        print("CONNECTED DOM:", info2)
        assert info2["connButtons"] == ["Check connection", "Refresh connection", "Copy debug report"], info2["connButtons"]
        assert info2["tabRowButtons"] == ["Stop sharing this tab"], info2["tabRowButtons"]
        assert info2["helper"] == HELPER_SHARED, repr(info2["helper"])
        shot(cdp, panel_sess, os.path.join(HERE, "v2101-connected.png"))
        print("ALL PANEL ASSERTIONS PASSED")
    finally:
        chrome.terminate()
        relay.terminate()


if __name__ == "__main__":
    main()
