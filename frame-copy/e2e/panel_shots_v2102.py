#!/usr/bin/env python3
"""Panel screenshots + layout/DOM assertions for the v2.10.2 review gate.

Same rig shape as panel_shots_v2101.py (real relay + origins, the
staging extension loaded unpacked, the side panel opened as a page at
side-panel width). Captures with v2102- prefixes:
  * v2102-unshared.png  — parent tab, not shared, AFTER an unpaired
                          Check connection run (steps visible)
  * v2102-card.png      — the generation confirmation card, unanswered
  * v2102-code.png      — after Allow: the code state, live countdown
  * v2102-connected.png — after pairing AND a completed Check
                          connection run in the connected state, so the
                          results shown belong to the state shown

Asserts the v2.10.2 fix facts in the live DOM:
  1. STALE RESULTS: steps run while unshared are GONE in the connected
     state (no .steps block, and the words "not shared with any chat"
     appear nowhere in the This tab section).
  2. NOT-CHECKED MARKS: in the unshared run, steps whose detail says
     "not checked" render with class step-skip and the neutral "–"
     mark; the genuinely failed step keeps step-fail + "✗"; the passed
     step keeps step-ok + "✓".
  3. EXIT VERBS: the chat-level button reads "Disconnect chat"; the
     site-row × carries title "Stop sharing this tab".
  4. CODE COUNTDOWN: the code state's expiry line matches
     "Expires in M:SS" and the value ticks down between two reads.
  5. BUTTON WRAP: every Connection button's label sits on ONE line
     (its text range has exactly one client rect) in both states.

Usage: /tmp/relayvenv/bin/python panel_shots_v2102.py
"""
import os
import re
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


def parse_left(text):
    m = re.search(r"Expires in (\d+):(\d{2})", text or "")
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def main():
    ext_path = os.path.abspath(EXT)
    tmp = tempfile.mkdtemp(prefix="panel-shots-2102-")
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

        ONELINE_JS = """(b) => { const r = document.createRange();
          r.selectNodeContents(b); return r.getClientRects().length; }"""

        # ---------- UNSHARED ----------
        info = ev("""(() => {
          const conn = document.querySelector('#page .conn');
          return {
            connExists: !!conn,
            helper: conn ? conn.querySelector('p').textContent : null,
            connButtons: conn ? [...conn.querySelectorAll('button')].map(b => b.textContent) : [],
            pageButtons: [...document.querySelectorAll('#page button')].map(b => b.textContent),
            connLines: conn ? [...conn.querySelectorAll('button')].map(%s) : [],
          }; })()""" % ONELINE_JS)
        print("UNSHARED DOM:", info)
        assert info["connExists"], "no Connection area in unshared state"
        assert info["connButtons"] == ["Check connection", "Copy debug report"], info["connButtons"]
        assert "Refresh connection" not in info["pageButtons"], info["pageButtons"]
        assert info["helper"] == HELPER_UNSHARED, repr(info["helper"])
        assert all(n == 1 for n in info["connLines"]), ("unshared Connection labels wrap", info["connLines"])

        # unpaired debug report at protocol level (the second-PC case)
        r = panel.send("debug_report", {"tabId": tab_id, "ua": "shots-2102", "check": []})
        txt = (r or {}).get("text") or ""
        assert r and r.get("ok") and "2.10.2" in txt and "Chat controlling this tab: none" in txt, txt[:300]
        print("UNPAIRED DEBUG REPORT ok: version 2.10.2, chat none")

        # unpaired Check connection, clicked in the panel itself
        ev("""(() => { const b = [...document.querySelectorAll('#page .conn button')]
               .find(x => x.textContent === 'Check connection'); if (b) b.click(); return !!b; })()""")
        steps = wait_for(lambda: ev("""(() => { const s = document.querySelector('#page .conn .steps');
            return s && s.children.length >= 4
              ? [...s.children].map(d => ({cls: d.className, text: d.textContent})) : null; })()"""),
                         20, "unpaired check steps render in panel")
        print("UNPAIRED CHECK STEPS:", steps)
        by_name = {s["text"]: s for s in steps}
        relay_step = next(s for s in steps if "Relay reachable" in s["text"])
        assert relay_step["cls"] == "step-ok" and relay_step["text"].startswith("✓"), relay_step
        fail_step = next(s for s in steps if "not shared with any chat" in s["text"])
        assert fail_step["cls"] == "step-fail" and fail_step["text"].startswith("✗"), fail_step
        skips = [s for s in steps if "not checked" in s["text"]]
        assert len(skips) == 2, skips
        for s in skips:
            assert s["cls"] == "step-skip" and s["text"].startswith("–"), s
        print("FIX 2 OK: not-checked steps render neutral (–, step-skip); pass ✓ / fail ✗ unchanged")
        shot(cdp, panel_sess, os.path.join(HERE, "v2102-unshared.png"))

        # ---------- CARD (generation confirmation, unanswered) ----------
        panel.send("share", {"tabId": tab_id})
        wait_for(lambda: (lambda s: s if (s.get("prompts") or []) else None)(
            panel.send("state", {"windowId": window_id})), 20, "generation confirmation card")
        time.sleep(1.5)
        shot(cdp, panel_sess, os.path.join(HERE, "v2102-card.png"))

        # ---------- CODE (after Allow): live countdown ----------
        st = panel.send("state", {"windowId": window_id})
        pid = st["prompts"][0]["id"]
        panel.send("approve", {"id": pid})
        code = wait_for(lambda: (lambda s: (s.get("share") or {}).get("code") or None)(
            panel.send("state", {"windowId": window_id})), 20, "pairing code")

        def expiry_text():
            return ev("""(() => { const ps = [...document.querySelectorAll('#page p')];
              const p = ps.find(x => x.textContent.includes('Expires in'));
              return p ? p.textContent : null; })()""")
        t1 = wait_for(lambda: expiry_text() if parse_left(expiry_text()) is not None else None,
                      15, "code expiry line with M:SS countdown")
        v1 = parse_left(t1)
        time.sleep(2.3)
        t2 = expiry_text()
        v2 = parse_left(t2)
        print("CODE EXPIRY TICKS:", repr(t1), "->", repr(t2))
        assert v1 is not None and v2 is not None, (t1, t2)
        assert 1 <= (v1 - v2) <= 5, (v1, v2)
        print(f"FIX 4 OK: code countdown is live ({v1}s -> {v2}s left)")
        shot(cdp, panel_sess, os.path.join(HERE, "v2102-code.png"))

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
          const xBtn = document.querySelector('#chats button.site-remove');
          const disc = [...document.querySelectorAll('#chats button')].map(b => b.textContent);
          return {
            connButtons: conn ? [...conn.querySelectorAll('button')].map(b => b.textContent) : [],
            connLines: conn ? [...conn.querySelectorAll('button')].map(%s) : [],
            helper: conn ? conn.querySelector('p').textContent : null,
            headerText: page.textContent,
            stepsPresent: !!page.querySelector('.conn .steps'),
            tabRowButtons: outsideRows.length ? [...outsideRows[0].querySelectorAll('button')].map(b => b.textContent) : [],
            xTitle: xBtn ? xBtn.title : null,
            chatButtons: disc,
          }; })()""" % ONELINE_JS)
        print("CONNECTED DOM:", info2)
        assert info2["connButtons"] == ["Check connection", "Refresh connection", "Copy debug report"], info2["connButtons"]
        assert info2["tabRowButtons"] == ["Stop sharing this tab"], info2["tabRowButtons"]
        assert info2["helper"] == HELPER_SHARED, repr(info2["helper"])
        # FIX 1: the unshared run's results must not survive into this state
        assert info2["stepsPresent"] is False, "stale check results still visible in connected state"
        assert "not shared with any chat" not in info2["headerText"], info2["headerText"][:300]
        assert "Shared with " + run_e2e.CHAT_NAME in info2["headerText"], info2["headerText"][:300]
        print("FIX 1 OK: check results cleared on the unshared -> shared change")
        # FIX 3: exit verbs
        assert "Disconnect chat" in info2["chatButtons"], info2["chatButtons"]
        assert "Disconnect" not in [b for b in info2["chatButtons"] if b == "Disconnect"], info2["chatButtons"]
        assert info2["xTitle"] == "Stop sharing this tab", info2["xTitle"]
        print("FIX 3 OK: 'Disconnect chat' + x title 'Stop sharing this tab'")
        # FIX 5: one-line labels, connected state
        assert all(n == 1 for n in info2["connLines"]), ("connected Connection labels wrap", info2["connLines"])
        print("FIX 5 OK: Connection labels on one line in both states")

        # a completed check IN the connected state, then the screenshot —
        # the results in the shot belong to the state in the shot
        ev("""(() => { const b = [...document.querySelectorAll('#page .conn button')]
               .find(x => x.textContent === 'Check connection'); if (b) b.click(); return !!b; })()""")
        steps2 = wait_for(lambda: ev("""(() => { const s = document.querySelector('#page .conn .steps');
            return s && s.children.length >= 4
              ? [...s.children].map(d => ({cls: d.className, text: d.textContent})) : null; })()"""),
                          25, "connected check steps render in panel")
        print("CONNECTED CHECK STEPS:", steps2)
        assert all(s["cls"] == "step-ok" for s in steps2), steps2
        shot(cdp, panel_sess, os.path.join(HERE, "v2102-connected.png"))
        print("ALL PANEL ASSERTIONS PASSED")
    finally:
        chrome.terminate()
        relay.terminate()


if __name__ == "__main__":
    main()
