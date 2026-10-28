#!/usr/bin/env python3
"""End-to-end tests for v2/relay/relay.py using a fake extension device.

Runs the real relay as a subprocess on spare ports with a throwaway state
file, connects a fake device over the real websocket protocol, and drives
the chat side over real HTTP. No browser needed.

  python test_relay.py        exit 0 = all passed, 1 = any failure
"""
import asyncio
import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

import websockets
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.hashes import SHA256

HERE = os.path.dirname(os.path.abspath(__file__))
RELAY = os.path.join(HERE, "..", "relay", "relay.py")
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -- {detail}"), flush=True)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def b64u(n):
    return base64.urlsafe_b64encode(n.to_bytes(32, "big")).rstrip(b"=").decode()


class Device:
    """Speaks the extension side of the protocol."""

    def __init__(self, ws_url, device_id=None, key=None):
        self.ws_url = ws_url
        self.device_id = device_id or ("dev-" + os.urandom(8).hex())
        self.key = key or ec.generate_private_key(ec.SECP256R1())
        self.ws = None
        self.inbox = []
        self.handler = None  # fn(msg) -> reply dict for "cmd"
        self.ack_pairs = "paired_ack"  # or "paired_nack", or None (never answers)

    def jwk(self):
        n = self.key.public_key().public_numbers()
        return {"kty": "EC", "crv": "P-256", "x": b64u(n.x), "y": b64u(n.y)}

    # STAGING-ONLY adaptation (merged protocol): the relay sends a
    # per-connection challenge first and the hello must sign
    # deviceId + ":" + that nonce.
    def sig(self, corrupt=False):
        if corrupt:
            return base64.b64encode(b"\x00" * 64).decode()
        der = self.key.sign(f"{self.device_id}:{self.nonce}".encode(), ec.ECDSA(SHA256()))
        r, s = decode_dss_signature(der)
        return base64.b64encode(r.to_bytes(32, "big") + s.to_bytes(32, "big")).decode()

    async def connect(self, live=(), corrupt=False, jwk=None, origin=None):
        self.ws = await websockets.connect(self.ws_url + "/device", origin=origin)
        challenge = json.loads(await asyncio.wait_for(self.ws.recv(), 5))
        self.nonce = challenge.get("nonce")
        await self.ws.send(json.dumps({"t": "hello", "deviceId": self.device_id,
                                       "pubJwk": jwk or self.jwk(), "sig": self.sig(corrupt),
                                       "liveSessions": list(live)}))
        return json.loads(await asyncio.wait_for(self.ws.recv(), 5))

    async def pump(self):
        try:
            async for raw in self.ws:
                m = json.loads(raw)
                if m.get("t") == "cmd" and self.handler:
                    await self.ws.send(json.dumps({"t": "result", "id": m["id"], **self.handler(m)}))
                else:
                    if m.get("t") == "paired" and self.ack_pairs:
                        # a real extension confirms it recorded the session
                        await self.ws.send(json.dumps({"t": self.ack_pairs, "sessionId": m["sessionId"],
                                                       **({"error": "share_not_found: test"} if self.ack_pairs == "paired_nack" else {})}))
                    self.inbox.append(m)
        except websockets.exceptions.ConnectionClosed:
            pass

    async def wait_for(self, t, timeout=5):
        end = time.time() + timeout
        while time.time() < end:
            for m in self.inbox:
                if m.get("t") == t:
                    self.inbox.remove(m)
                    return m
            await asyncio.sleep(0.05)
        return None


def http(method, url, body=None, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {}
    except (urllib.error.URLError, OSError) as e:
        return 0, {"error": "connection_failed", "detail": str(e)}


RELAY_LOG = []


def start_relay(ws_port, http_port, state, extra=()):
    p = subprocess.Popen([sys.executable, RELAY, "--ws-port", str(ws_port), "--http-port", str(http_port),
                          "--state", state, *extra], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    # Always drain the relay's output so a full pipe can never block it.
    threading.Thread(target=lambda: [RELAY_LOG.append(l) for l in p.stdout], daemon=True).start()
    end = time.time() + 10
    while time.time() < end:
        try:
            socket.create_connection(("127.0.0.1", http_port), 0.3).close()
            return p
        except OSError:
            if p.poll() is not None:
                break
            time.sleep(0.1)
    return p


async def ah(*a, **k):
    return await asyncio.to_thread(http, *a, **k)


async def main():
    tmp = tempfile.mkdtemp()
    state = os.path.join(tmp, "state.json")
    wsp, hp = free_port(), free_port()
    relay = start_relay(wsp, hp, state, ["--device-wait", "1", "--pair-ack-timeout", "3"])
    WS, H = f"ws://127.0.0.1:{wsp}", f"http://127.0.0.1:{hp}"
    logs = RELAY_LOG
    try:
        # --- single instance ---
        dup = subprocess.run([sys.executable, RELAY, "--ws-port", str(wsp), "--http-port", str(free_port()),
                              "--state", os.path.join(tmp, "s2.json")], capture_output=True, text=True, timeout=20)
        check("second relay on a taken port exits with code 2", dup.returncode == 2, dup.returncode)

        # --- device identity ---
        dev = Device(WS)
        w = await dev.connect()
        check("device hello accepted", w.get("ok") is True, w)
        check("welcome lists the device's sessions and open codes (none yet)",
              w.get("sessions") == [] and w.get("reqIds") == [], w)

        # --- only an extension (or no Origin) may open the device socket ---
        try:
            evil = Device(WS)
            w = await evil.connect(origin="https://evil.example")
            refused = False
        except Exception as e:
            refused = "403" in str(e) or "rejected" in str(e).lower()
        check("a web page (Origin https://...) cannot open the device socket", refused, "handshake accepted")
        extdev = Device(WS)
        w = await extdev.connect(origin="chrome-extension://abcdefghijklmnopabcdefghijklmnop")
        check("a chrome-extension:// Origin is accepted", w.get("ok") is True, w)
        await extdev.ws.close()
        pump = asyncio.create_task(dev.pump())

        bad = Device(WS, device_id="dev-" + os.urandom(8).hex())
        w = await bad.connect(corrupt=True)
        check("bad signature rejected (bad_sig)", w.get("error") == "bad_sig", w)

        thief = Device(WS, device_id=dev.device_id)  # same id, different key
        w = await thief.connect()
        check("different key for known device rejected (key_mismatch)", w.get("error") == "key_mismatch", w)

        # --- pairing ---
        await dev.ws.send(json.dumps({"t": "pair_request", "reqId": "r1"}))
        pc = await dev.wait_for("pair_code")
        code = pc and pc["code"]
        check("pair code issued: 8 chars, no look-alikes",
              code and len(code) == 8 and not set(code) & set("01OIL"), pc)
        check("pair code never written to relay log", code and not any(code in l for l in logs), "code found in log")

        st, b = await ah("POST", H + "/pair", {"code": "WRONGXXX", "chatName": "x"})
        check("wrong code rejected", st == 400 and b.get("error") == "bad_or_expired_code", (st, b))

        st, b = await ah("POST", H + "/pair", {"code": code.lower()[:4] + "-" + code.lower()[4:], "chatName": "Chat A"})
        check("code accepted (case and dash tolerant)", st == 200 and b.get("ok"), (st, b))
        tokA, sidA = b.get("token"), b.get("sessionId")
        paired = await dev.wait_for("paired")
        check("device told which request paired, with relay-made sessionId",
              paired and paired["reqId"] == "r1" and paired["sessionId"] == sidA, paired)
        check("token never written to relay log", tokA and not any(tokA in l for l in logs), "token in log")
        saved = open(state).read()
        check("token stored only as a hash", tokA and tokA not in saved, "raw token found in state file")

        st, b = await ah("POST", H + "/pair", {"code": code, "chatName": "again"})
        check("code is single use", st == 400, (st, b))
        check("a bad code tells the chat what to do", "side panel" in (b.get("detail") or ""), b)

        # the extension refuses: the chat gets the reason, no session is left behind
        dev.ack_pairs = "paired_nack"
        await dev.ws.send(json.dumps({"t": "pair_request", "reqId": "rn"}))
        cn = (await dev.wait_for("pair_code"))["code"]
        st, b = await ah("POST", H + "/pair", {"code": cn, "chatName": "Refused"})
        check("a pairing the extension refuses returns pair_rejected with its reason",
              st == 400 and b.get("error") == "pair_rejected" and "share_not_found" in (b.get("detail") or ""), (st, b))
        await dev.wait_for("paired")
        dev.ack_pairs = None
        await dev.ws.send(json.dumps({"t": "pair_request", "reqId": "rs"}))
        cs = (await dev.wait_for("pair_code"))["code"]
        t0 = time.time()
        st, b = await ah("POST", H + "/pair", {"code": cs, "chatName": "Silent"})
        await dev.wait_for("paired")
        check("a pairing the extension never confirms fails after the pair-ack window (3 s here; 100 s in production, for the v2.7 share confirmation), with no session kept",
              st == 400 and 2 < time.time() - t0 < 8 and "Silent" not in open(state).read(), (st, b, round(time.time() - t0, 1)))
        dev.ack_pairs = "paired_ack"

        # second chat
        await dev.ws.send(json.dumps({"t": "pair_request", "reqId": "r2"}))
        code2 = (await dev.wait_for("pair_code"))["code"]
        st, b = await ah("POST", H + "/pair", {"code": code2, "chatName": "Chat B"})
        tokB, sidB = b.get("token"), b.get("sessionId")
        await dev.wait_for("paired")
        check("second chat gets a different session", sidB and sidB != sidA, (sidA, sidB))

        # --- routing and isolation ---
        seen = []
        dev.handler = lambda m: (seen.append((m["sessionId"], m["action"], m["args"])), {"ok": True, "data": m["sessionId"]})[1]
        st, b = await ah("POST", H + "/cmd", {"token": tokA, "action": "tabs_context", "args": {"session": sidB}})
        check("command carries the relay's session, not an agent-supplied one",
              b.get("data") == sidA and seen[-1][0] == sidA, b)
        st, b = await ah("POST", H + "/cmd", {"token": tokB, "action": "tabs_context", "args": {}})
        check("chat B routed as session B", b.get("data") == sidB, b)
        dev.handler = lambda m: {"ok": False, "error": "target_changed", "detail": "read_page again"}
        st, b = await ah("POST", H + "/cmd", {"token": tokB, "action": "computer", "args": {}})
        check("an error's detail reaches the chat", b.get("error") == "target_changed" and b.get("detail") == "read_page again", b)
        dev.handler = lambda m: (seen.append((m["sessionId"], m["action"], m["args"], m.get("ttlMs"))), {"ok": True, "data": m["sessionId"]})[1]
        st, b = await ah("POST", H + "/cmd", {"token": tokB, "action": "tabs_context", "args": {}})
        check("the command tells the device how long the relay will wait", seen[-1][3] == 120000, seen[-1])

        # --- chat names are unique per device ---
        names = []
        for rid in ("n1", "n2"):
            await dev.ws.send(json.dumps({"t": "pair_request", "reqId": rid}))
            c = (await dev.wait_for("pair_code"))["code"]
            st, b = await ah("POST", H + "/pair", {"code": c, "chatName": "Same name"})
            names.append(b.get("chatName"))
            await dev.wait_for("paired")
        check("a second chat with the same name gets a distinct name", names == ["Same name", "Same name (2)"], names)

        # --- open codes per device are capped ---
        got = []
        for i in range(11):
            await dev.ws.send(json.dumps({"t": "pair_request", "reqId": f"cap{i}"}))
            m = None
            end = time.time() + 5
            while time.time() < end and not m:
                for x in list(dev.inbox):
                    if x.get("reqId") == f"cap{i}":
                        m = x
                        dev.inbox.remove(x)
                await asyncio.sleep(0.02)
            got.append(m and m["t"])
        check("at most 10 open codes per device; the 11th request is refused",
              got[:10] == ["pair_code"] * 10 and got[10] == "pair_error", got)
        st, b = await ah("POST", H + "/cmd", {"token": "not-a-real-token-at-all-xx", "action": "x", "args": {}})
        check("bad token -> 401", st == 401, (st, b))
        st, b = await ah("POST", H + "/cmd", raw=b"{nope")
        check("malformed JSON -> 400", st == 400, st)
        st, b = await ah("GET", H + "/status")
        check("status without token -> 401", st == 401, st)
        st, b = await ah("GET", H + "/status", headers={"X-Chat-Token": tokA})
        check("status with token -> own session only", st == 200 and b.get("sessionId") == sidA, b)

        # --- no approval path through the relay ---
        before = len(seen)
        await dev.ws.send(json.dumps({"t": "approval", "id": "x", "allow": True}))
        await asyncio.sleep(0.3)
        check("relay has no approval message (ignored, nothing forwarded)", len(seen) == before, seen[before:])

        # --- revoke ---
        st, b = await ah("POST", H + "/revoke", {"token": tokA})
        rv = await dev.wait_for("revoked")
        check("revoke tells the device", st == 200 and rv and rv["sessionId"] == sidA, (st, rv))
        st, b = await ah("POST", H + "/cmd", {"token": tokA, "action": "tabs_context", "args": {}})
        check("revoked token is dead", st == 401, (st, b))
        st, b = await ah("POST", H + "/cmd", {"token": tokB, "action": "tabs_context", "args": {}})
        check("other chat unaffected by revoke", b.get("data") == sidB, b)

        # (timeout + cancel: tested on a second relay with a 2 s deadline below)

        # --- device offline ---
        pump.cancel()
        await dev.ws.close()
        await asyncio.sleep(0.3)
        st, b = await ah("POST", H + "/cmd", {"token": tokB, "action": "tabs_context", "args": {}})
        check("device offline -> device_offline after the device wait", b.get("error") == "device_offline", b)

        # --- devices are capped at 50; idle ones are forgotten first ---
        for _ in range(55):
            d = Device(WS)
            await d.connect()
            await d.ws.close()
        devices = json.load(open(state))["devices"]
        check("at most 50 devices are kept, and a device with a live chat is never dropped",
              len(devices) <= 50 and dev.device_id in devices, len(devices))

        # --- rate limit: failed attempts only ---
        codes = []
        for _ in range(40):
            st, b = await ah("POST", H + "/pair", {"code": "ZZZZZZZZ"})
            codes.append(st)
            if st == 429:
                break
        check("30 failed pairing attempts in a minute -> 429 with retryAfter",
              codes[-1] == 429 and len(codes) <= 31 and b.get("retryAfter", 0) > 0, (len(codes), b))

        # --- persistence across restart, and stale-session cleanup ---
        relay.terminate()
        relay.wait(10)
        # STAGING-ONLY: the relay binds with SO_REUSEADDR off, so on this VM
        # the just-killed listener lingers in TIME_WAIT and a fresh bind
        # fails (exit 2) for a while; a TCP probe cannot see that state, so
        # retry the start until the new relay stays up.
        relay = None
        for _attempt in range(24):
            relay = start_relay(wsp, hp, state)
            if relay.poll() is None:
                break
            time.sleep(5)
        if relay.poll() is not None:
            raise RuntimeError("restarted relay never came up")
        dev2 = Device(WS, device_id=dev.device_id, key=dev.key)
        w = await dev2.connect(live=[sidB])
        check("pinned key survives relay restart", w.get("ok") is True, w)
        check("after a restart, welcome lists the surviving session and no codes",
              w.get("sessions") == [sidB] and w.get("reqIds") == [], w)
        pump2 = asyncio.create_task(dev2.pump())
        dev2.handler = lambda m: {"ok": True, "data": m["sessionId"]}
        st, b = await ah("POST", H + "/cmd", {"token": tokB, "action": "tabs_context", "args": {}})
        check("chat token survives relay restart", b.get("data") == sidB, b)
        thief2 = Device(WS, device_id=dev.device_id)
        w = await thief2.connect()
        check("key_mismatch still enforced after restart", w.get("error") == "key_mismatch", w)
        pump2.cancel()
        await dev2.ws.close()
        dev3 = Device(WS, device_id=dev.device_id, key=dev.key)
        await dev3.connect(live=[])  # browser restarted: extension knows no sessions
        st, b = await ah("POST", H + "/cmd", {"token": tokB, "action": "tabs_context", "args": {}})
        check("sessions the browser forgot are revoked on hello", st == 401, (st, b))
        await dev3.ws.close()

    finally:
        relay.terminate()

    # --- a relay with a short deadline: timeout tells the device to cancel ---
    tmp2 = tempfile.mkdtemp()
    wsp2, hp2 = free_port(), free_port()
    r2 = start_relay(wsp2, hp2, os.path.join(tmp2, "s.json"), ["--cmd-timeout", "2"])
    try:
        d = Device(f"ws://127.0.0.1:{wsp2}")
        await d.connect()
        pump = asyncio.create_task(d.pump())
        await d.ws.send(json.dumps({"t": "pair_request", "reqId": "t1"}))
        c = (await d.wait_for("pair_code"))["code"]
        st, b = await ah("POST", f"http://127.0.0.1:{hp2}/pair", {"code": c, "chatName": "slow"})
        tok = b.get("token")
        await d.wait_for("paired")
        d.handler = None
        t0 = time.time()
        st, b = await ah("POST", f"http://127.0.0.1:{hp2}/cmd", {"token": tok, "action": "navigate", "args": {}})
        took = time.time() - t0
        cmd = next((m for m in d.inbox if m.get("t") == "cmd"), None)
        cancel = await d.wait_for("cancel", 3)
        check("an unanswered command returns timeout at the relay's deadline", b.get("error") == "timeout" and 1.5 < took < 6, (b, took))
        check("...the device was told the deadline (ttlMs 2000)", cmd is not None and cmd.get("ttlMs") == 2000, cmd)
        check("...and was told to cancel that command", cancel is not None and cmd is not None and cancel.get("id") == cmd.get("id"), (cancel, cmd))
        pump.cancel()
        await d.ws.close()
    finally:
        r2.terminate()

    # --- a damaged state file does not stop the relay ---
    tmp3 = tempfile.mkdtemp()
    bad_state = os.path.join(tmp3, "state.json")
    with open(bad_state, "w") as f:
        f.write("{ this is not json")
    wsp3, hp3 = free_port(), free_port()
    r3 = start_relay(wsp3, hp3, bad_state)
    try:
        st, b = await ah("GET", f"http://127.0.0.1:{hp3}/status")
        moved = [n for n in os.listdir(tmp3) if n.startswith("state.json.corrupt-")]
        check("a damaged state file is set aside and the relay still starts", st == 401 and bool(moved), (st, os.listdir(tmp3)))
    finally:
        r3.terminate()

    # --- web pages cannot reach the chat API (security check 2026-09-27) ---
    tmp4 = tempfile.mkdtemp()
    wsp4, hp4 = free_port(), free_port()
    # STAGING-ONLY: --fixtures so the /fixture/ check at the end of this
    # section can load a page (fixtures are off by default in the relay).
    r4 = start_relay(wsp4, hp4, os.path.join(tmp4, "s.json"), ["--fixtures"])
    try:
        H4 = f"http://127.0.0.1:{hp4}"
        body = {"chatName": "Claude", "wait": 0}
        st, b = await ah("POST", H4 + "/announce", body, {"Origin": "https://evil.example"})
        check("a POST from a web page (Origin header) is refused", st == 403 and b.get("error") == "forbidden", (st, b))
        st, b = await ah("POST", H4 + "/announce", body, {"Origin": "null"})
        check("...also with Origin: null (sandboxed page or form)", st == 403, (st, b))
        st, b = await ah("POST", H4 + "/announce", body, {"Host": f"rebind.attacker.com:{hp4}"})
        check("a DNS-rebinding request (foreign Host) is refused", st == 403 and b.get("error") == "forbidden", (st, b))
        st, b = await ah("GET", H4 + "/status", None, {"Host": f"rebind.attacker.com:{hp4}", "X-Chat-Token": "x"})
        check("...and GET /status with a foreign Host is refused", st == 403, (st, b))
        st, b = await ah("POST", H4 + "/announce", body)
        check("client.py's own request (no Origin, Host 127.0.0.1) still works", st != 403 and b.get("error") == "waiting" and b.get("secret"), (st, b))
        st, b = await ah("POST", f"http://localhost:{hp4}/announce", {"chatName": "Other", "wait": 0})
        check("...and so does Host localhost", st != 403 and b.get("error") == "waiting", (st, b))
        def fixture_status():
            req = urllib.request.Request(H4 + "/fixture/form", headers={"Host": f"evil.test:{hp4}"})
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status
        st = await asyncio.to_thread(fixture_status)
        check("test pages under /fixture/ still load on other hostnames", st == 200, st)
    finally:
        r4.terminate()

    # --- second listener (Daniel applied the tailnet patch himself, 2026-09-28):
    # same API on a second address, /pair refused there. Tested on 127.0.0.2.
    tmp5 = tempfile.mkdtemp()
    wsp5, hp5 = free_port(), free_port()
    r5 = start_relay(wsp5, hp5, os.path.join(tmp5, "s.json"), extra=("--bind", "127.0.0.2"))
    try:
        T5, L5 = f"http://127.0.0.2:{hp5}", f"http://127.0.0.1:{hp5}"
        # start_relay returns when 127.0.0.1 answers; the second listener binds a moment later
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.2", hp5), 0.3).close(); break
            except OSError:
                await asyncio.sleep(0.1)
        await asyncio.sleep(0.3)
        logged = any(f"http 127.0.0.2:{hp5} (tailnet; /pair refused)" in l for l in RELAY_LOG)
        check("the relay logs its second listener", logged, [l for l in RELAY_LOG if "127.0.0.2" in l][-2:])
        st, b = await ah("POST", T5 + "/pair", {"code": "WRONGXXX", "chatName": "x"})
        check("/pair on the second address is refused (pair_local_only)", st == 403 and b.get("error") == "pair_local_only", (st, b))
        st, b = await ah("POST", L5 + "/pair", {"code": "WRONGXXX", "chatName": "x"})
        check("...while /pair on 127.0.0.1 still checks the code (400, not 403)", st == 400 and b.get("error") == "bad_or_expired_code", (st, b))
        st, b = await ah("GET", T5 + "/status", None, {"X-Chat-Token": "nope"})
        check("/status on the second address without a valid token is refused", st == 401, (st, b))
        st, b = await ah("POST", T5 + "/announce", {"chatName": "x", "wait": 0}, {"Origin": "https://evil.example"})
        check("a web page (Origin header) is refused on the second address too", st == 403, (st, b))
        dev5 = Device(f"ws://127.0.0.1:{wsp5}")
        await dev5.connect()
        pump5 = asyncio.create_task(dev5.pump())
        await dev5.ws.send(json.dumps({"t": "pair_request", "reqId": "r5"}))
        code5 = (await dev5.wait_for("pair_code"))["code"]
        st, b = await ah("POST", L5 + "/pair", {"code": code5, "chatName": "Tail chat"})
        tok5 = b.get("token")
        check("pairing on 127.0.0.1 gives a token", st == 200 and tok5, (st, b))
        st, b = await ah("GET", T5 + "/status", None, {"X-Chat-Token": tok5})
        check("that token works on the second address (the VM's route)", st == 200 and b.get("chatName") == "Tail chat", (st, b))
        pump5.cancel()
        await dev5.ws.close()
    finally:
        r5.terminate()

    fails = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(fails)}/{len(results)} passed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
