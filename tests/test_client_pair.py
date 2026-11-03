#!/usr/bin/env python3
"""Client-level tests for attach-on-redeem in agent/client.py.

A stub HTTP server stands in for the relay so the client's choices can be
observed exactly: whether it sends its live token with the code, what it
does with an "attached" answer, and what it does when the relay answers a
token-carrying redemption with a FRESH session (the kept token_file_in_use
refusal, including the cleanup revoke).

  python test_client_pair.py      exit 0 = all passed, 1 = any failure
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CLIENT = os.path.join(HERE, "..", "agent", "client.py")
results = []
SEEN = {"pair_bodies": [], "revokes": []}
MODE = {"pair": "attached"}  # or "fresh"


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -- {detail}"), flush=True)


class Stub(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/status" and self.headers.get("X-Chat-Token") == LIVE_TOKEN:
            return self._json({"ok": True, "sessionId": "sid-live", "chatName": "Chat A", "deviceOnline": True})
        return self._json({"ok": False, "error": "bad_token"}, 401)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/pair":
            SEEN["pair_bodies"].append(body)
            if MODE["pair"] == "attached":
                return self._json({"ok": True, "attached": True, "sessionId": "sid-live", "chatName": "Chat A"})
            if MODE["pair"] == "renamed":
                return self._json({"ok": True, "sessionId": "sid-fresh2", "token": "fresh-token-value", "chatName": "Chat A (2)"})
            return self._json({"ok": True, "sessionId": "sid-fresh", "token": "fresh-token-value", "chatName": "Chat A"})
        if self.path == "/revoke":
            SEEN["revokes"].append(body)
            return self._json({"ok": True})
        return self._json({"ok": False, "error": "not_found"}, 404)


LIVE_TOKEN = "live-token-value-that-is-long-enough"


def run_client(cwd, *args):
    env = {**os.environ, "MBB_RELAY": f"http://127.0.0.1:{PORT}"}
    env.pop("MBB_TOKEN_FILE", None)
    p = subprocess.run([sys.executable, CLIENT, *args], cwd=cwd, env=env,
                       capture_output=True, text=True, timeout=30)
    try:
        return p.returncode, json.loads(p.stdout.strip().split("\n")[-1])
    except Exception:
        return p.returncode, {"raw": p.stdout + p.stderr}


def main():
    global PORT
    server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
    PORT = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tmp = tempfile.mkdtemp()
    chatdir = os.path.join(tmp, "chat")
    os.makedirs(chatdir)
    tokfile = os.path.join(chatdir, ".muse-bridge-token")
    try:
        # (a) no token file: plain pair, no token field sent, token saved
        MODE["pair"] = "fresh"
        code, out = run_client(chatdir, "pair", "CODE0001", "--chat", "Chat A")
        check("no token held: pair sends no token field",
              SEEN["pair_bodies"][-1].get("token") is None, SEEN["pair_bodies"][-1])
        check("...and the fresh token is saved", code == 0 and open(tokfile).read() == "fresh-token-value", out)
        check("...with no rename warning when the name comes back as asked",
              "warning" not in out, out)

        # the chat now holds the stub's live token
        with open(tokfile, "w") as f:
            f.write(LIVE_TOKEN)

        # (b) live token + attached answer: token sent, file untouched
        MODE["pair"] = "attached"
        code, out = run_client(chatdir, "pair", "CODE0002", "--chat", "Chat A")
        check("live token held: pair sends the token with the code",
              SEEN["pair_bodies"][-1].get("token") == LIVE_TOKEN, SEEN["pair_bodies"][-1])
        check("attached answer: ok, attached, same session",
              code == 0 and out.get("attached") is True and out.get("sessionId") == "sid-live", out)
        check("...and the token file is byte-for-byte unchanged",
              open(tokfile).read() == LIVE_TOKEN)

        # (c) live token + FRESH answer: refuse, keep file, revoke the orphan
        MODE["pair"] = "fresh"
        SEEN["revokes"].clear()
        code, out = run_client(chatdir, "pair", "CODE0003", "--chat", "Chat A")
        check("fresh answer to a live-token redemption: token_file_in_use",
              code == 1 and out.get("error") == "token_file_in_use", out)
        check("...the live token file is still unchanged", open(tokfile).read() == LIVE_TOKEN)
        check("...and the unasked-for session was revoked with its own token",
              SEEN["revokes"] == [{"token": "fresh-token-value"}], SEEN["revokes"])

        # (d) --force overrides the refusal and overwrites
        code, out = run_client(chatdir, "pair", "CODE0004", "--chat", "Chat A", "--force")
        check("--force pairs fresh and overwrites, as before",
              code == 0 and out.get("ok") is True and open(tokfile).read() == "fresh-token-value", out)

        # (f) dead token held (v2.10 refresh, case b): the relay rejects
        # it at /status, so pair must NOT present it (a dead token can
        # never attach to — or take over — any session), and the fresh
        # token replaces it in the file cleanly.
        with open(tokfile, "w") as f:
            f.write("dead-token-value-that-is-long-enough")
        MODE["pair"] = "fresh"
        code, out = run_client(chatdir, "pair", "CODE0006", "--chat", "Chat A")
        check("dead token held: pair sends no token field",
              SEEN["pair_bodies"][-1].get("token") is None, SEEN["pair_bodies"][-1])
        check("...pair succeeds fresh and the dead token file is replaced",
              code == 0 and out.get("ok") is True and open(tokfile).read() == "fresh-token-value", out)

        # (e) no token presented and the relay renames the pair (a live
        # session already holds the name): pair succeeds but warns loudly
        otherdir = os.path.join(tmp, "other")
        os.makedirs(otherdir)
        MODE["pair"] = "renamed"
        code, out = run_client(otherdir, "pair", "CODE0005", "--chat", "Chat A")
        check("renamed fresh pair: ok, and a warning names the existing session",
              code == 0 and out.get("chat") == "Chat A (2)" and "already exists" in str(out.get("warning")), out)
    finally:
        server.shutdown()
    fails = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(fails)}/{len(results)} passed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
