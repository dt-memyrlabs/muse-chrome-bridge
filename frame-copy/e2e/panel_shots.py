#!/usr/bin/env python3
"""Panel before/after screenshots for the v2.10.0 review gate.

Loads a given extension tree into the rig's Chromium (same relay +
origins as run_e2e.py), opens the side panel as a page at side-panel
width, and captures two states:
  * unshared  — the parent tab, not shared: Generate a code
  * connected — after pairing: the chat list + (v2.10) Connection area

Usage: /tmp/relayvenv/bin/python panel_shots.py <extension_dir> <tag>
Writes panel-<tag>-unshared.png and panel-<tag>-connected.png here.
"""
import json
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
SECRET = run_e2e.SECRET
WS_PORT, HTTP_PORT = run_e2e.WS_PORT, run_e2e.HTTP_PORT
PARENT_URL = run_e2e.PARENT_URL


def shot(cdp, session, path):
    r = cdp.call("Page.captureScreenshot", {"format": "png"}, session)
    import base64
    with open(path, "wb") as f:
        f.write(base64.b64decode(r["data"]))
    print("wrote", path)


def main():
    ext_path = os.path.abspath(sys.argv[1])
    tag = sys.argv[2]
    tmp = tempfile.mkdtemp(prefix="panel-shots-")
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
        panel = Panel(cdp, panel_sess)
        cdp.call("Emulation.setDeviceMetricsOverride",
                 {"width": 420, "height": 1000, "deviceScaleFactor": 1, "mobile": False}, panel_sess)
        panel.set_enroll_secret(SECRET)
        tabs = wait_for(lambda: [t for t in panel.tabs() if ":8971" in (t.get("url") or "")], 20, "parent tab")
        tab_id, window_id = tabs[0]["id"], tabs[0]["windowId"]
        wait_for(lambda: (lambda s: s if s.get("relay", {}).get("connected") else None)(
            panel.send("state", {"windowId": window_id})), 40, "relay connection")

        # --- unshared state: parent tab active, panel describing it
        cdp.call("Target.activateTarget", {"targetId": parent_target})
        time.sleep(2.0)
        shot(cdp, panel_sess, os.path.join(HERE, f"panel-{tag}-unshared.png"))

        # --- pair, then connected state
        approved = {"done": False}

        def approve_pump():
            st = panel.send("state", {"windowId": window_id})
            for p in (st or {}).get("prompts", []):
                panel.send("approve", {"id": p["id"]})
                approved["done"] = True

        panel.send("share", {"tabId": tab_id})

        def code_ready():
            approve_pump()
            s = panel.send("state", {"windowId": window_id})
            return (s.get("share") or {}).get("code") or None
        code = wait_for(code_ready, 30, "pairing code")
        rc, out = client(chatdir, "pair", code, "--chat", run_e2e.CHAT_NAME)
        if not out.get("ok"):
            raise RuntimeError(f"pair failed: {out}")
        time.sleep(2.0)
        cdp.call("Target.activateTarget", {"targetId": parent_target})
        time.sleep(1.5)
        shot(cdp, panel_sess, os.path.join(HERE, f"panel-{tag}-connected.png"))
        print("paired as", out.get("chatName"))
    finally:
        chrome.terminate()
        relay.terminate()


if __name__ == "__main__":
    main()
