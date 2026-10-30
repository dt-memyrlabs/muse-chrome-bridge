#!/usr/bin/env python3
"""Frame-copy acceptance rig for the Muse Chrome Bridge.

Proves (or disproves) the exact factory.8090.ai failure shape: a chat page
inside a CROSS-ORIGIN iframe, and a bridge chat that must click the framed
composer, type, click Send, and read the framed message list back — with no
human click anywhere. A control case (a plain textarea on the parent page)
runs alongside.

What the rig does, end to end, with the REAL pieces:
  * two static origins (serve.py): A serves a parent page embedding an
    <iframe> from B; B serves the chat page.
  * the REAL relay (attach-on-redeem/relay/relay.py) on the production ports
    (ws 19822 / http 20822), gated with an enroll-secret file, exactly as
    the native host runs it.
  * the REAL extension, loaded unpacked into the VM's headless Chromium.
    The rig stands in for the native host in one respect only: it writes
    the same enroll secret into the extension's storage (that is how a real
    install provisions it). Everything else goes through the product's own
    surfaces: the side-panel message protocol for Share/Approve, and the
    real agent client (agent/client.py) for pairing and every command.
  * permission prompts the extension raises are approved by the rig through
    the panel protocol (the rig plays the user's Allow click on the PANEL —
    never a click inside the page). Every approval is logged.

PASS/FAIL per case is decided by ground truth read straight from the framed
page's DOM over the harness's own CDP connection, plus the bridge's own
read-back (the frame reports its state to the parent page, and the chat
reads the parent tab's text). A tool call returning "ok" is never enough.

Usage:
    /tmp/relayvenv/bin/python run_e2e.py [--extension PATH] [--keep]

Exit code: 0 = every case passed, 1 = at least one case failed,
2 = the rig itself could not be set up.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serve  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.normpath(os.path.join(HERE, "..", "..", "attach-on-redeem"))
CLIENT = os.path.join(BRIDGE, "agent", "client.py")
RELAY_PY = os.path.join(BRIDGE, "relay", "relay.py")
DEFAULT_EXTENSION = os.path.join(BRIDGE, "extension")
CHROME = os.path.expanduser("~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome")
VENV_PY = "/tmp/relayvenv/bin/python"
# Local test fixture only (the relay requires >= 32 chars; the native host
# generates 64 hex chars on a real install).
SECRET = "frame-rig-test-secret-" + "0123456789abcdef" * 3
CHAT_NAME = "Frame Rig"
CDP_PORT = 9229
WS_PORT, HTTP_PORT = 19822, 20822
ORIGIN_A = serve.ORIGIN_A
ORIGIN_B = serve.ORIGIN_B
PARENT_URL = ORIGIN_A + "/parent.html"

TEXT_COMPOSER = "alpha-composer-123"
TEXT_NOTE = "bravo-textarea-456"
TEXT_CONTROL = "charlie-control-789"
TEXT_SAME_COMPOSER = "delta-sameorigin-000"
TEXT_FORM = "echo-forminput-111"
TEXT_BG = "foxtrot-background-222"
TEXT_REFCROSS = "golf-refcross-333"

TRANSCRIPT = []


def log(line):
    print(line, flush=True)
    TRANSCRIPT.append(line)


def wait_for(fn, timeout, what, interval=0.25):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:  # noqa: BLE001 - polling helper
            last = e
        time.sleep(interval)
    raise TimeoutError(f"timed out waiting for {what}; last={last!r}")


# --------------------------------------------------------------------------
# Minimal CDP client over the browser websocket (flatten sessions).
# Used ONLY for harness duties: launching targets, reading ground truth,
# and speaking the extension's own side-panel protocol from an extension
# page. The bridge itself is driven exclusively through client.py.
# --------------------------------------------------------------------------
class CDP:
    def __init__(self, ws_url):
        from websockets.sync.client import connect as ws_connect
        self.ws = ws_connect(ws_url, max_size=64 * 1024 * 1024)
        self._id = 0
        self._lock = threading.Lock()

    def call(self, method, params=None, session_id=None, timeout=30):
        with self._lock:
            self._id += 1
            mid = self._id
            msg = {"id": mid, "method": method, "params": params or {}}
            if session_id:
                msg["sessionId"] = session_id
            self.ws.send(json.dumps(msg))
            deadline = time.time() + timeout
            while True:
                left = deadline - time.time()
                if left <= 0:
                    raise TimeoutError(f"CDP {method} timed out")
                m = json.loads(self.ws.recv(timeout=left))
                if m.get("id") == mid:
                    if "error" in m:
                        raise RuntimeError(f"CDP {method}: {m['error']}")
                    return m.get("result", {})

    def attach(self, target_id):
        return self.call("Target.attachToTarget",
                         {"targetId": target_id, "flatten": True})["sessionId"]

    def evaluate(self, session_id, expr, timeout=30):
        r = self.call("Runtime.evaluate",
                      {"expression": expr, "returnByValue": True, "awaitPromise": True},
                      session_id, timeout)
        if r.get("exceptionDetails"):
            raise RuntimeError(f"evaluate failed: {json.dumps(r['exceptionDetails'])[:400]}")
        return r.get("result", {}).get("value")

    def targets(self):
        return self.call("Target.getTargets")["targetInfos"]


def http_json(url, timeout=5):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read())


# --------------------------------------------------------------------------
# Panel protocol, spoken from the extension's own sidepanel page — the same
# chrome.runtime messages the real side panel sends (see sidepanel.js).
# --------------------------------------------------------------------------
class Panel:
    def __init__(self, cdp, session_id):
        self.cdp = cdp
        self.session = session_id

    def send(self, kind, extra=None):
        payload = {"kind": kind, **(extra or {})}
        expr = (f"chrome.runtime.sendMessage({json.dumps(payload)})"
                f".then(r => JSON.stringify(r))"
                f".catch(e => JSON.stringify({{ok:false, error:'sendMessage: ' + e.message}}))")
        raw = self.cdp.evaluate(self.session, expr)
        try:
            return json.loads(raw)
        except Exception:
            return {"ok": False, "error": f"unparsable panel reply: {raw!r}"}

    def tabs(self):
        expr = ("chrome.tabs.query({})"
                ".then(ts => JSON.stringify(ts.map(t => ({id: t.id, url: t.url,"
                " windowId: t.windowId, active: t.active}))))"
                ".catch(e => '[]')")
        return json.loads(self.cdp.evaluate(self.session, expr))

    def set_enroll_secret(self, secret):
        expr = (f"chrome.storage.local.set({{enrollSecret: {json.dumps(secret)}}})"
                f".then(() => 'set').catch(e => 'ERR ' + e.message)")
        return self.cdp.evaluate(self.session, expr)


class PromptPump(threading.Thread):
    """Approves panel permission prompts as they appear, logging each one.

    This is the rig playing the user at the PANEL (the product's designed
    human gate). It never touches the page itself.
    """

    def __init__(self, panel, window_id):
        super().__init__(daemon=True)
        self.panel = panel
        self.window_id = window_id
        self.stop_flag = False
        self.approved = []

    def run(self):
        seen = set()
        while not self.stop_flag:
            try:
                st = self.panel.send("state", {"windowId": self.window_id})
                # v2.9 evidence: record whether a pairing code already
                # existed at the moment each card was approved. The one
                # card of a code share must be approved BEFORE any code
                # exists (it is the generation confirmation).
                code_now = ((st or {}).get("share") or {}).get("code") or None
                for p in (st or {}).get("prompts", []):
                    if p["id"] in seen:
                        continue
                    seen.add(p["id"])
                    r = self.panel.send("approve", {"id": p["id"]})
                    self.approved.append({**p, "_codeAtApproval": code_now})
                    log(f"  [panel] APPROVED prompt: {p.get('title')!r} -- {p.get('detail')!r} -> {r} (code at approval: {code_now!r})")
            except Exception as e:  # noqa: BLE001 - keep pumping
                log(f"  [panel] pump hiccup: {e}")
            time.sleep(0.25)


# --------------------------------------------------------------------------
# The real agent client, run exactly as a chat runs it.
# --------------------------------------------------------------------------
def client(chatdir, *args, timeout=115):
    env = {**os.environ, "MBB_RELAY": f"http://127.0.0.1:{HTTP_PORT}"}
    env.pop("MBB_TOKEN_FILE", None)
    p = subprocess.run([VENV_PY, CLIENT, *args], cwd=chatdir, env=env,
                       capture_output=True, text=True, timeout=timeout)
    tail = p.stdout.strip().split("\n")[-1] if p.stdout.strip() else ""
    try:
        out = json.loads(tail)
    except Exception:
        out = {"raw": (p.stdout + p.stderr)[-500:]}
    log(f"  client {' '.join(str(a) for a in args)[:120]} -> exit {p.returncode}: {json.dumps(out)[:300]}")
    return p.returncode, out


def port_free(port):
    import socket
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extension", default=DEFAULT_EXTENSION,
                    help="unpacked extension directory to load")
    ap.add_argument("--keep", action="store_true",
                    help="leave Chromium and the relay running afterwards")
    ap.add_argument("--dump-tree", action="store_true",
                    help="after pairing, print read_page/find output for the "
                         "rig page and exit (diagnostic for ref visibility)")
    ap.add_argument("--bg-experiment", action="store_true",
                    help="during the background case only: enable focus "
                         "emulation on the child frame's own CDP target "
                         "(flatten attach, harness-side) to test whether "
                         "per-frame focus emulation is what the background "
                         "case is missing")
    args = ap.parse_args()
    ext_path = os.path.abspath(args.extension)

    if not os.path.isfile(VENV_PY):
        log(f"SETUP FAIL: {VENV_PY} is missing. Create it with:\n"
            f"  python3 -m venv /tmp/relayvenv && "
            f"/tmp/relayvenv/bin/pip install websockets cryptography")
        return 2
    if not os.path.isfile(CHROME):
        log(f"SETUP FAIL: Chromium not found at {CHROME}")
        return 2
    if not os.path.isfile(os.path.join(ext_path, "manifest.json")):
        log(f"SETUP FAIL: no manifest.json in extension path {ext_path}")
        return 2
    # Other test suites on this VM use the same production ports in bursts;
    # wait for a quiet window instead of failing on a transient holder.
    ports = (WS_PORT, HTTP_PORT, serve.PORT_A, serve.PORT_B, CDP_PORT)
    deadline = time.time() + 120
    while True:
        busy = [p for p in ports if not port_free(p)]
        if not busy:
            break
        if time.time() > deadline:
            log(f"SETUP FAIL: ports still in use after 120 s: {busy}")
            return 2
        log(f"ports busy ({busy}); waiting for them to free up...")
        time.sleep(3)

    tmp = tempfile.mkdtemp(prefix="frame-rig-")
    chatdir = os.path.join(tmp, "chat")
    os.makedirs(chatdir)
    results = {}
    probes = {}
    relay = chrome = None
    pump = None
    log(f"rig tmp dir: {tmp}")
    log(f"extension under test: {ext_path}")

    try:
        # ---- origins ------------------------------------------------------
        serve.start_servers()
        log(f"origins up: A={ORIGIN_A} B={ORIGIN_B}")

        # ---- relay (production shape: enroll-secret gated) -----------------
        secret_file = os.path.join(tmp, "enroll_secret.txt")
        with open(secret_file, "w", encoding="utf-8") as f:
            f.write(SECRET)
        relay_log_path = os.path.join(HERE, "last-relay.log")
        for attempt in (1, 2, 3, 4, 5):
            relay = subprocess.Popen(
                [VENV_PY, RELAY_PY, "--ws-port", str(WS_PORT), "--http-port", str(HTTP_PORT),
                 "--state", os.path.join(tmp, "relay-state.json"),
                 "--enroll-secret-file", secret_file],
                stdout=open(relay_log_path, "w"),
                stderr=subprocess.STDOUT)
            try:
                wait_for(lambda: relay.poll() is not None or not port_free(HTTP_PORT),
                         20, "relay http port to listen")
            except TimeoutError:
                pass
            if not port_free(HTTP_PORT) and relay.poll() is None:
                break
            tail = ""
            try:
                with open(relay_log_path) as f:
                    tail = f.read()[-600:]
            except OSError:
                pass
            log(f"relay start attempt {attempt} failed (exit={relay.poll()}); log tail:\n{tail}")
            relay.terminate()
            time.sleep(5)
            wait_for(lambda: port_free(WS_PORT) and port_free(HTTP_PORT), 30,
                     "relay ports to free up between attempts", interval=1)
        else:
            raise RuntimeError("relay would not start after 5 attempts")
        log("relay up (enroll-secret gated)")

        # ---- Chromium with the extension ----------------------------------
        profile = os.path.join(tmp, "profile")
        chrome = subprocess.Popen(
            [CHROME, "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
             "--no-first-run", "--window-size=1280,900", "--force-device-scale-factor=1",
             # This VM exports http(s)_proxy; Chromium would send the .test
             # hostnames to that proxy (only IP/localhost literals bypass it)
             # and every page would die with ERR_EMPTY_RESPONSE.
             "--no-proxy-server",
             # frame-a.test / frame-b.test are different SITES (unlike two
             # ports on 127.0.0.1, which are one site): the cross-site frame
             # is site-isolated into an out-of-process iframe, the process
             # model of the real factory.8090.ai failure.
             f"--host-resolver-rules=MAP {serve.HOST_A} 127.0.0.1, MAP {serve.HOST_B} 127.0.0.1",
             f"--user-data-dir={profile}", f"--load-extension={ext_path}",
             f"--remote-debugging-port={CDP_PORT}", "about:blank"],
            stdout=open(os.path.join(tmp, "chrome.log"), "w"),
            stderr=subprocess.STDOUT)
        version = wait_for(lambda: http_json(f"http://127.0.0.1:{CDP_PORT}/json/version"),
                           30, "chromium debugging endpoint")
        cdp = CDP(version["webSocketDebuggerUrl"])
        log("chromium up")

        sw = wait_for(lambda: next((t for t in cdp.targets()
                                    if t["type"] == "service_worker"
                                    and t["url"].endswith("/sw.js")
                                    and t["url"].startswith("chrome-extension://")), None),
                      30, "extension service worker target")
        ext_id = sw["url"].split("/")[2]
        log(f"extension loaded: id={ext_id} url={sw['url']}")

        # ---- parent page target -------------------------------------------
        parent_target = cdp.call("Target.createTarget", {"url": PARENT_URL})["targetId"]
        parent = cdp.attach(parent_target)
        cdp.call("Page.enable", {}, parent)
        wait_for(lambda: cdp.evaluate(parent, "document.readyState") == "complete",
                 20, "parent page load")
        log("parent page loaded")

        # ---- panel page (the extension's own sidepanel, opened as a page) --
        panel_target = cdp.call("Target.createTarget",
                                 {"url": f"chrome-extension://{ext_id}/sidepanel.html"})["targetId"]
        panel = Panel(cdp, cdp.attach(panel_target))
        wait_for(lambda: panel.tabs(), 20, "panel page chrome.tabs access")

        # The rig stands in for the native host for exactly this: the install
        # secret a real install provisions into the extension.
        r = panel.set_enroll_secret(SECRET)
        log(f"enroll secret provisioned into extension storage: {r}")

        tabs = wait_for(lambda: [t for t in panel.tabs() if ":8971" in (t.get("url") or "")],
                        20, "parent tab in chrome.tabs")
        tab = tabs[0]
        tab_id, window_id = tab["id"], tab["windowId"]
        log(f"parent chrome tab id={tab_id} window id={window_id}")

        st = wait_for(lambda: (lambda s: s if s.get("relay", {}).get("connected") else None)(
            panel.send("state", {"windowId": window_id})), 40, "extension <-> relay connection")
        log(f"extension connected to relay: {st['relay']}")

        # ---- share the parent tab and get a pairing code -------------------
        # The prompt pump starts BEFORE the share: since v2.9.0 the one
        # full-control confirmation card is asked when the code is
        # GENERATED (before any code exists), so the rig-as-user must be
        # answering the panel before the share begins. Redemption of the
        # generated code then asks nothing.
        pump = PromptPump(panel, window_id)
        pump.start()
        log("panel prompt pump running (auto-approves panel cards, logging each)")

        cdp.call("Target.activateTarget", {"targetId": parent_target})
        r = panel.send("share", {"tabId": tab_id})
        log(f"share requested: {r}")
        if not r.get("ok"):
            raise RuntimeError(f"share failed: {r}")

        def read_code():
            s = panel.send("state", {"windowId": window_id})
            sh = s.get("share") or {}
            return sh.get("code") or None
        code = wait_for(read_code, 30, "pairing code from the panel state")
        log(f"pairing code obtained: {code}")

        rc, out = client(chatdir, "pair", code, "--chat", CHAT_NAME)
        if not out.get("ok"):
            raise RuntimeError(f"client pair failed: {out}")
        log(f"chat paired as {out.get('chatName')!r} session {out.get('sessionId')}")

        # v2.9 one-card evidence: the whole run so far must have raised
        # exactly ONE card — the generation confirmation, approved
        # before the code existed, worded for the chat the code is
        # handed to. Redemption must have added no card.
        time.sleep(1.0)  # let the pump observe any redemption card, if one were raised
        gen = pump.approved
        one_card_ok = (len(gen) == 1 and not gen[0].get("_codeAtApproval")
                       and "hand this code to" in (gen[0].get("title") or ""))
        results["generation-confirmation"] = one_card_ok
        log(f"  one-card evidence: cards approved so far = {len(gen)}; "
            f"first card title = {gen[0].get('title')!r} with code at approval = {gen[0].get('_codeAtApproval')!r}" if gen else
            "  one-card evidence: NO card was approved — the generation confirmation never fired")
        log(f"  => {'PASS' if one_card_ok else 'FAIL'} generation-confirmation (exactly one card, at generation, before the code existed)")

        rc, out = client(chatdir, "tabs_context", "{}")
        if not out.get("ok") or not out.get("data", {}).get("tabs"):
            raise RuntimeError(f"tabs_context shows no tab: {out}")

        if args.dump_tree:
            def dump(tool, args_obj):
                env = {**os.environ, "MBB_RELAY": f"http://127.0.0.1:{HTTP_PORT}"}
                env.pop("MBB_TOKEN_FILE", None)
                p = subprocess.run([VENV_PY, CLIENT, tool, json.dumps(args_obj)],
                                   cwd=chatdir, env=env, capture_output=True,
                                   text=True, timeout=115)
                log(f"\n--- dump {tool} {json.dumps(args_obj)} (exit {p.returncode}) ---")
                log(p.stdout.strip()[:6000])
            # Drill into each Iframe node: read_page's ref_id may open the
            # frame's own subtree even when the top-level tree shows none.
            env = {**os.environ, "MBB_RELAY": f"http://127.0.0.1:{HTTP_PORT}"}
            env.pop("MBB_TOKEN_FILE", None)
            p = subprocess.run([VENV_PY, CLIENT, "read_page", json.dumps({"tabId": tab_id})],
                               cwd=chatdir, env=env, capture_output=True, text=True, timeout=115)
            tree = json.loads(p.stdout.strip().split("\n")[-1]).get("data", {}).get("tree", "")
            log("\n--- dump read_page (full tree) ---")
            log(tree)
            import re as _re
            for label, ref in _re.findall(r'Iframe "([^"]+)" \[(ref_\d+)\]', tree):
                dump("read_page", {"tabId": tab_id, "ref_id": ref})
            dump("find", {"tabId": tab_id, "query": "Send button"})
            dump("find", {"tabId": tab_id, "query": "message composer"})
            dump("find", {"tabId": tab_id, "query": "note textarea"})
            return 0

        # ---- harness ground-truth handles ----------------------------------
        # The framed page's DOM is read two ways, whichever this Chromium
        # offers: its own OOPIF target when site isolation gives it one, or
        # an isolated world created in the child frame on the page session.
        # Either way this is harness instrumentation only — the bridge is
        # driven solely through client.py.
        def build_frame_view():
            for t in cdp.targets():
                if t["type"] == "iframe" and ":8972" in t.get("url", ""):
                    sess = cdp.attach(t["targetId"])
                    return ("oopif target", lambda expr: cdp.evaluate(sess, expr))
            tree = cdp.call("Page.getFrameTree", {}, parent)["frameTree"]
            child, stack = None, [tree]
            while stack:
                node = stack.pop()
                if ":8972" in node["frame"].get("url", ""):
                    child = node["frame"]
                    break
                stack.extend(node.get("childFrames", []))
            if not child:
                return None
            ctx = cdp.call("Page.createIsolatedWorld",
                           {"frameId": child["id"], "worldName": "rig_truth"},
                           parent)["executionContextId"]

            def ev(expr):
                r = cdp.call("Runtime.evaluate",
                             {"expression": expr, "contextId": ctx,
                              "returnByValue": True, "awaitPromise": True}, parent)
                if r.get("exceptionDetails"):
                    raise RuntimeError(f"frame evaluate failed: {json.dumps(r['exceptionDetails'])[:300]}")
                return r.get("result", {}).get("value")
            return ("isolated world in the child frame", ev)

        frame_kind, frame_eval = wait_for(build_frame_view, 20, "a way to read the framed page")
        wait_for(lambda: frame_eval("document.readyState") == "complete",
                 20, "framed chat page load")
        log(f"harness reads the framed page via: {frame_kind}")

        def rect_in(evalfn, el_id):
            return json.loads(evalfn(
                f"(() => {{ const r = document.getElementById({json.dumps(el_id)})"
                f".getBoundingClientRect();"
                f" return JSON.stringify({{x: r.x, y: r.y, w: r.width, h: r.height}}); }})()"))

        def center(r):
            return [round(r["x"] + r["w"] / 2), round(r["y"] + r["h"] / 2)]

        parent_eval = lambda expr: cdp.evaluate(parent, expr)  # noqa: E731
        iframe_rect = rect_in(parent_eval, "chat-frame")
        log(f"iframe rect in parent viewport: {iframe_rect}")

        def framed_point(el_id):
            r = rect_in(frame_eval, el_id)
            return [round(iframe_rect["x"] + r["x"] + r["w"] / 2),
                    round(iframe_rect["y"] + r["y"] + r["h"] / 2)]

        def frame_truth():
            return json.loads(frame_eval(
                "JSON.stringify({"
                " messages: [...document.querySelectorAll('#messages li')].map(li => li.textContent),"
                " note: document.getElementById('note-input').value,"
                " composer: document.getElementById('composer').textContent })"))

        def parent_truth():
            return json.loads(cdp.evaluate(parent, (
                "JSON.stringify({"
                " controlList: [...document.querySelectorAll('#control-list li')].map(li => li.textContent),"
                " controlValue: document.getElementById('control-input').value,"
                " mirror: document.getElementById('mirror').textContent })")))

        def click(tab_id_, point):
            return client(chatdir, "computer", json.dumps(
                {"action": "left_click", "tabId": tab_id_, "coordinate": point}))

        def type_text(tab_id_, text):
            return client(chatdir, "computer", json.dumps(
                {"action": "type", "tabId": tab_id_, "text": text}))

        def bridge_readback():
            rc_, out_ = client(chatdir, "get_page_text", json.dumps({"tabId": tab_id}))
            return (out_.get("data") or {}).get("text", "") if out_.get("ok") else ""

        # ==== CASE 1: framed contenteditable composer -> Send -> list ======
        log("\nCASE framed-contenteditable: click composer, type, click Send, read list back")
        pt = framed_point("composer")
        log(f"  composer viewport point: {pt}")
        click(tab_id, pt)
        type_text(tab_id, TEXT_COMPOSER)
        time.sleep(0.6)
        mid = frame_truth()
        log(f"  frame truth after typing: {mid}")
        pt = framed_point("send-btn")
        log(f"  send button viewport point: {pt}")
        click(tab_id, pt)
        time.sleep(0.8)
        truth = frame_truth()
        back = bridge_readback()
        in_truth = TEXT_COMPOSER in truth["messages"]
        in_bridge = TEXT_COMPOSER in back
        results["framed-contenteditable"] = in_truth and in_bridge
        log(f"  frame messages: {truth['messages']}")
        log(f"  in framed message list (ground truth): {in_truth}; "
            f"in bridge read-back of parent tab: {in_bridge}")
        log(f"  => {'PASS' if results['framed-contenteditable'] else 'FAIL'} framed-contenteditable")

        # ==== CASE 2: framed plain textarea =================================
        log("\nCASE framed-textarea: click textarea, type, read value back")
        pt = framed_point("note-input")
        log(f"  textarea viewport point: {pt}")
        click(tab_id, pt)
        type_text(tab_id, TEXT_NOTE)
        time.sleep(0.6)
        truth = frame_truth()
        back = bridge_readback()
        in_truth = truth["note"] == TEXT_NOTE
        in_bridge = ("NOTE: " + TEXT_NOTE) in back
        results["framed-textarea"] = in_truth and in_bridge
        log(f"  frame textarea value (ground truth): {truth['note']!r}")
        log(f"  value exact match: {in_truth}; in bridge read-back: {in_bridge}")
        log(f"  => {'PASS' if results['framed-textarea'] else 'FAIL'} framed-textarea")

        # ==== CASE 3: parent-page control textarea (control) ================
        log("\nCASE parent-control: click control textarea, type, click Post, read list back")
        pt = center(rect_in(parent_eval, "control-input"))
        log(f"  control textarea viewport point: {pt}")
        click(tab_id, pt)
        type_text(tab_id, TEXT_CONTROL)
        time.sleep(0.6)
        pt = center(rect_in(parent_eval, "control-post"))
        click(tab_id, pt)
        time.sleep(0.8)
        truth = parent_truth()
        back = bridge_readback()
        in_truth = TEXT_CONTROL in truth["controlList"]
        in_bridge = TEXT_CONTROL in back
        results["parent-control"] = in_truth and in_bridge
        log(f"  parent control list (ground truth): {truth['controlList']}")
        log(f"  in control list: {in_truth}; in bridge read-back: {in_bridge}")
        log(f"  => {'PASS' if results['parent-control'] else 'FAIL'} parent-control")

        # ==== CASES 5-7: ref-driven framed interaction (v2.6.0) ============
        # The all-frames read must hand out refs for framed elements, each
        # ref knowing its frame (find reports the frame URL per match), and
        # acting on a framed ref must go through the point-dispatch path.
        log("\nCASE ref-cross-composer: find the cross-origin framed composer by label, click its ref, type, click the Send ref")
        def find_ref_in(query, name, frame_part):
            rc_, out_ = client(chatdir, "find", json.dumps({"tabId": tab_id, "query": query}))
            hits = [m for m in (out_.get("data") or {}).get("matches", [])
                    if (m.get("name") or "").strip() == name and frame_part in (m.get("frame") or "")]
            # Prefer the editable itself over any same-named static match.
            for m in hits:
                if m.get("role") == "textbox":
                    return m.get("ref")
            return hits[0].get("ref") if hits else None

        def same_truth():
            return json.loads(parent_eval(
                "(() => { const d = document.getElementById('chat-frame-same').contentDocument;"
                " return JSON.stringify({"
                " messages: [...d.querySelectorAll('#messages li')].map(li => li.textContent),"
                " note: d.getElementById('note-input').value,"
                " composer: d.getElementById('composer').textContent }); })()"))

        x_composer = find_ref_in("message composer", "Message composer", ":8972")
        x_note = find_ref_in("note textarea", "Note", ":8972")
        x_send = find_ref_in("Send button", "Send", ":8972")
        log(f"  cross-origin refs: composer={x_composer} note={x_note} send={x_send}")
        if x_composer and x_send:
            client(chatdir, "computer", json.dumps(
                {"action": "left_click", "tabId": tab_id, "ref": x_composer}))
            type_text(tab_id, TEXT_REFCROSS)
            time.sleep(0.6)
            log(f"  frame truth after ref-click + type: {frame_truth()}")
            client(chatdir, "computer", json.dumps(
                {"action": "left_click", "tabId": tab_id, "ref": x_send}))
            time.sleep(0.8)
        truth = frame_truth()
        back = bridge_readback()
        in_truth = TEXT_REFCROSS in truth["messages"]
        in_bridge = TEXT_REFCROSS in back
        results["ref-cross-composer"] = bool(x_composer and x_send) and in_truth and in_bridge
        log(f"  frame messages: {truth['messages']}")
        log(f"  in framed message list (ground truth): {in_truth}; "
            f"in bridge read-back of parent tab: {in_bridge}")
        log(f"  => {'PASS' if results['ref-cross-composer'] else 'FAIL'} ref-cross-composer")

        log("\nCASE ref-framed-textarea: form_input sets the cross-origin framed textarea by ref")
        if x_note:
            client(chatdir, "form_input", json.dumps(
                {"tabId": tab_id, "ref": x_note, "value": TEXT_FORM}))
            time.sleep(0.6)
        truth = frame_truth()
        in_truth = truth["note"] == TEXT_FORM
        results["ref-framed-textarea"] = bool(x_note) and in_truth
        log(f"  frame textarea value (ground truth): {truth['note']!r} (wanted {TEXT_FORM!r})")
        log(f"  => {'PASS' if results['ref-framed-textarea'] else 'FAIL'} ref-framed-textarea")

        log("\nCASE ref-sameorigin-composer: the same ref flow inside the same-origin frame")
        s_composer = find_ref_in("message composer", "Message composer", ":8971")
        s_send = find_ref_in("Send button", "Send", ":8971")
        log(f"  same-origin refs: composer={s_composer} send={s_send}")
        if s_composer and s_send:
            client(chatdir, "computer", json.dumps(
                {"action": "left_click", "tabId": tab_id, "ref": s_composer}))
            type_text(tab_id, TEXT_SAME_COMPOSER)
            time.sleep(0.6)
            log(f"  same-origin frame truth after ref-click + type: {same_truth()}")
            client(chatdir, "computer", json.dumps(
                {"action": "left_click", "tabId": tab_id, "ref": s_send}))
            time.sleep(0.8)
        truth = same_truth()
        in_truth = TEXT_SAME_COMPOSER in truth["messages"]
        results["ref-sameorigin-composer"] = bool(s_composer and s_send) and in_truth
        log(f"  same-origin frame messages: {truth['messages']}")
        log(f"  => {'PASS' if results['ref-sameorigin-composer'] else 'FAIL'} ref-sameorigin-composer")

        # ==== CASE 4: same framed flow, shared tab in the BACKGROUND ========
        # v2.5.0 holds focus emulation for the whole debugger session;
        # v2.4.1 emulated focus only around individual calls. A shared tab
        # that is not in front is where that difference can bite: the click
        # must still focus the framed composer and the typing must land.
        log("\nCASE background-framed-composer: decoy tab in front, drive the shared (background) tab")
        decoy_target = cdp.call("Target.createTarget", {"url": PARENT_URL})["targetId"]
        cdp.call("Target.activateTarget", {"targetId": decoy_target})
        time.sleep(0.5)
        log("  decoy tab activated; the shared tab is now in the background")
        # The ref cases scrolled the page; re-measure the frame geometry
        # so this case aims at the same points the earlier cases hit.
        cdp.evaluate(parent, "window.scrollTo(0, 0)")
        time.sleep(0.4)
        iframe_rect = rect_in(parent_eval, "chat-frame")
        log(f"  iframe rect re-measured for the background case: {iframe_rect}")
        if args.bg_experiment:
            # ONE bounded experiment (v2.6.0): Claude's model never attaches
            # to child targets, and the tab-session focus emulation does not
            # make background typing land in the OOPIF. Test whether focus
            # emulation on the child frame's OWN debugger target flips it.
            log("  [bg-experiment] enabling focus emulation on the child frame's own CDP target (flatten attach, harness-side)")
            child = next((t for t in cdp.targets()
                          if t["type"] == "iframe" and ":8972" in t.get("url", "")), None)
            if child:
                sess = cdp.attach(child["targetId"])
                cdp.call("Emulation.setFocusEmulationEnabled", {"enabled": True}, sess)
                log(f"  [bg-experiment] focus emulation ON for child target url={child.get('url')}")
            else:
                log("  [bg-experiment] no iframe target for :8972 in Target.getTargets")
            ext_targets = cdp.evaluate(panel.session,
                "chrome.debugger.getTargets()"
                ".then(ts => JSON.stringify(ts.map(t => ({type: t.type, url: t.url, tabId: t.tabId, attached: t.attached}))))"
                ".catch(e => 'ERR ' + e.message)")
            log(f"  [bg-experiment] chrome.debugger.getTargets() from the panel page: {ext_targets}")
        pt = framed_point("composer")
        click(tab_id, pt)
        type_text(tab_id, TEXT_BG)
        time.sleep(0.6)
        mid = frame_truth()
        log(f"  frame truth after typing: {mid}")
        pt = framed_point("send-btn")
        click(tab_id, pt)
        time.sleep(0.8)
        truth = frame_truth()
        back = bridge_readback()
        in_truth = TEXT_BG in truth["messages"]
        in_bridge = TEXT_BG in back
        results["background-framed-composer"] = in_truth and in_bridge
        log(f"  frame messages: {truth['messages']}")
        log(f"  in framed message list (ground truth): {in_truth}; "
            f"in bridge read-back of parent tab: {in_bridge}")
        log(f"  => {'PASS' if results['background-framed-composer'] else 'FAIL'} background-framed-composer")
        cdp.call("Target.activateTarget", {"targetId": parent_target})
        cdp.call("Target.closeTarget", {"targetId": decoy_target})
        time.sleep(0.5)

    except Exception as e:  # noqa: BLE001 - rig setup failure
        import traceback
        log(f"RIG ERROR: {e}")
        log(traceback.format_exc())
        results.setdefault("rig", False)
    finally:
        if pump:
            pump.stop_flag = True
            log(f"panel prompts approved during the run: {len(pump.approved)}")
            for p in pump.approved:
                log(f"  approved: {p.get('title')!r} -- {p.get('detail')!r}")
        with open(os.path.join(HERE, "last-run.log"), "w", encoding="utf-8") as f:
            f.write("\n".join(TRANSCRIPT) + "\n")
        if not args.keep:
            for proc in (chrome, relay):
                if proc:
                    proc.terminate()
            if results.get("rig") is False:
                log(f"rig failed during setup: tmp dir kept for inspection: {tmp}")
            else:
                shutil.rmtree(tmp, ignore_errors=True)
        else:
            log(f"--keep: chromium + relay left running; state in {tmp}")

    # Whole-run one-card rule (v2.9): no later action may have raised a
    # card either — the pump's total for the entire run must stay 1.
    if pump and len(pump.approved) != 1:
        results["generation-confirmation"] = False
        log(f"one-card evidence FAILED for the whole run: {len(pump.approved)} cards approved in total")

    log("\n==== SUMMARY ====")
    for name in ("generation-confirmation", "framed-contenteditable", "framed-textarea", "parent-control",
                 "ref-cross-composer", "ref-framed-textarea", "ref-sameorigin-composer",
                 "background-framed-composer"):
        if name in results:
            log(f"{'PASS' if results[name] else 'FAIL'} {name}")
    for name, outcome in probes.items():
        log(f"PROBE {name}: {outcome}")
    # The finally block wrote the transcript before this summary existed;
    # write it again so the saved log is the whole run.
    with open(os.path.join(HERE, "last-run.log"), "w", encoding="utf-8") as f:
        f.write("\n".join(TRANSCRIPT) + "\n")
    failed = [n for n, ok in results.items() if not ok]
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
