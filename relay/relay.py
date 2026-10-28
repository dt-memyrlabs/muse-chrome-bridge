#!/usr/bin/env python3
"""Muse Browser Bridge v2 — relay. Independent open-source project; runs locally.

One pairing = one chat = one tab group. Each chat gets its own token; the
relay assigns the session, the agent never names it.

  python relay.py [--ws-port 19822] [--http-port 20822] [--state state.json] [--fixtures]

Device side (extension)   ws://127.0.0.1:<ws-port>/device
Chat side (agent)         http://127.0.0.1:<http-port>
  POST /pair    {code, chatName[, token]}   -> {ok, sessionId, token}
                                               | {ok, attached, sessionId, chatName}
  POST /cmd     {token, action, args}       -> {ok, data | error}
  POST /revoke  {token}                     -> {ok}
  GET  /status  (header X-Chat-Token)       -> {ok, sessionId, chatName, deviceOnline}
  GET  /fixture/<name>                      -> test pages (--fixtures only; 404 otherwise)

Security rules this file enforces:
  - Device enrollment is gated by a per-install secret (when started with
    --enroll-secret-file, as the native host does): on connect the relay
    sends a fresh challenge nonce and the hello must carry
    proof = hex HMAC-SHA256(secret, deviceId + ":" + nonce). A hello with
    no proof, a wrong-secret proof, or a proof replayed against a fresh
    nonce is refused (bad_enroll_proof). The secret itself never crosses
    the socket and is never logged.
  - Device key pinned on first hello, persisted; a different key for a known
    device is refused (key_mismatch). Hello signature checked (bad_sig):
    the relay sends a fresh random challenge nonce on every device
    connection and the hello must sign deviceId + ":" + that nonce, so a
    captured hello cannot be replayed on a new connection.
  - Pairing codes: 8 chars, no look-alike characters, single use, 5 min TTL.
    Never logged.
  - Attach-on-redeem: a /pair that also presents a chat token attaches the
    code's tab to the live session that token names (same device only)
    instead of minting a new session; the answer carries no token. A token
    naming a live session on a different device refuses the pair and does
    not consume the code. Only the token's own session can ever be named:
    there is no way to attach into another chat's session.
  - Chat tokens: 32 random bytes, returned once, stored only as SHA-256.
    Never logged.
  - Sessions expire after 7 days without a command: each session carries
    a lastUsed timestamp (updated on /cmd and /status, persisted in
    state.json); expired sessions are pruned when a device says hello
    and before answering /cmd (an expired token answers bad_token).
  - /pair: failed attempts are limited (global brake, 30 per minute); a
    successful pairing never counts against it.
  - The device socket accepts only connections with no Origin or a
    chrome-extension:// Origin, so a web page cannot register a device.
  - At most 50 known devices, 10 open codes per device, 20 code requests per
    device per minute.
  - Every command carries a deadline (ttlMs); when the relay gives up it
    tells the extension to cancel, so nothing acts after the chat was told
    "timeout".
  - There is NO relay message that approves an action, grants a site or sets
    a policy. Approvals happen only in the extension's own UI.
  - Single instance: if either port is taken the process exits with code 2.
  - The second chat-API listener binds only a loopback address or one in
    the Tailscale range 100.64.0.0/10; any other --bind is refused at
    startup, and --bind auto ignores a detected address outside that range.
"""

import argparse
import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import websockets
except ImportError:
    sys.exit("missing dependency: pip install websockets")
try:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ec import (
        ECDSA, SECP256R1, EllipticCurvePublicNumbers)
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
    from cryptography.hazmat.primitives.hashes import SHA256
except ImportError:
    sys.exit("missing dependency: pip install cryptography")

CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I/L
CODE_LEN = 8
CODE_TTL = 300
SESSION_TTL = 7 * 24 * 3600  # sessions expire after 7 days without a command
CMD_TIMEOUT = 120  # seconds; --cmd-timeout overrides (tests)
PAIR_ACK_TIMEOUT = 100    # seconds /pair waits for the extension's paired_ack;
                          # since v2.7 the ack follows the user's ONE
                          # full-control confirmation in the side panel
                          # (the card itself allows 90 s), so this must
                          # comfortably exceed a human's reading time;
                          # --pair-ack-timeout overrides (tests)
PAIR_FAILS_PER_MIN = 30
MAX_DEVICES = 50
MAX_CODES_PER_DEVICE = 10
PAIR_REQS_PER_DEVICE_PER_MIN = 20
DEVICE_WAIT = 40          # seconds /pair and /cmd wait for an offline device:
                          # Chrome stops the extension's worker at times, and
                          # its 30 s keepalive alarm brings it back
EXTENSION_ORIGIN = re.compile(r"chrome-extension://[a-p]{32}")


def log(msg):
    # Attacker-controlled text (e.g. a deviceId holding a lone surrogate
    # from a JSON unicode escape) must never crash the caller: encoding
    # with backslashreplace turns surrogates into literal text while
    # leaving valid characters untouched, so print() cannot raise
    # UnicodeEncodeError from inside a message handler.
    safe = str(msg).encode("utf-8", "backslashreplace").decode("utf-8", "backslashreplace")
    print(f"[relay {time.strftime('%H:%M:%S')}] {safe}", flush=True)


def b64url_decode(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def key_id(jwk):
    return (jwk.get("kty"), jwk.get("crv"), jwk.get("x"), jwk.get("y"))


def verify_hello(device_id, jwk, sig_b64, nonce):
    """Strict check of the hello signature: P-256, raw R||S, over exactly
    deviceId + ":" + nonce, where nonce is the random challenge sent on
    this connection when it opened. There is no time-window fallback: a
    signature over anything else (including the old minute stamp) fails,
    so a captured hello is worthless on any other connection."""
    if not isinstance(nonce, str) or not nonce:
        return False
    try:
        x = int.from_bytes(b64url_decode(jwk["x"]), "big")
        y = int.from_bytes(b64url_decode(jwk["y"]), "big")
        pub = EllipticCurvePublicNumbers(x, y, SECP256R1()).public_key()
        raw = base64.b64decode(sig_b64)
        if len(raw) != 64:
            return False
        der = encode_dss_signature(int.from_bytes(raw[:32], "big"),
                                   int.from_bytes(raw[32:], "big"))
        pub.verify(der, f"{device_id}:{nonce}".encode(), ECDSA(SHA256()))
        return True
    except Exception:
        pass
    return False


class State:
    """Persistent state: pinned device keys and hashed chat tokens."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.devices = {}   # deviceId -> {"pubJwk": {...}}
        self.sessions = {}  # sessionId -> {"deviceId", "tokenHash", "chatName", "created", "lastUsed"}
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    d = json.load(f)
                if not isinstance(d, dict):
                    raise ValueError("not an object")
                self.devices = dict(d.get("devices") or {})
                self.sessions = dict(d.get("sessions") or {})
            except Exception as e:
                # A damaged file must not stop the relay. Keep it for
                # inspection and start empty: chats pair again.
                bad = f"{path}.corrupt-{int(time.time())}"
                try:
                    os.replace(path, bad)
                except OSError:
                    pass
                log(f"state file unreadable ({e}); moved to {bad}; starting empty")

    def save(self):
        """Write atomically and durably. A failed write is logged, never fatal."""
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"devices": self.devices, "sessions": self.sessions}, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        except OSError as e:
            log(f"could not save state: {e}")

    def session_by_token(self, token):
        if not isinstance(token, str) or len(token) < 20:
            return None, None
        h = token_hash(token)
        with self.lock:
            for sid, s in self.sessions.items():
                if secrets.compare_digest(s["tokenHash"], h):
                    return sid, s
        return None, None

    @staticmethod
    def _last_used(s):
        # Sessions written before lastUsed existed fall back to created,
        # so they expire 7 days after creation rather than never (or at once).
        for k in ("lastUsed", "created"):
            v = s.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                return v
        return 0

    def is_expired(self, s, now=None):
        now = time.time() if now is None else now
        return now - self._last_used(s) >= SESSION_TTL

    def prune_expired(self, now=None):
        """Drop every session idle for SESSION_TTL or longer. Persists when
        anything was dropped. Returns [(sessionId, deviceId), ...]."""
        now = time.time() if now is None else now
        with self.lock:
            expired = [(sid, s.get("deviceId")) for sid, s in list(self.sessions.items())
                       if self.is_expired(s, now)]
            for sid, _ in expired:
                del self.sessions[sid]
            if expired:
                self.save()
            return expired

    def touch_session(self, session_id, now=None):
        """Record use of a session (/cmd, /status) and persist lastUsed."""
        now = int(time.time() if now is None else now)
        with self.lock:
            s = self.sessions.get(session_id)
            if s is None:
                return False
            s["lastUsed"] = now
            self.save()
            return True


class Relay:
    def __init__(self, state, enroll_secret=None):
        self.state = state
        self.enroll_secret = enroll_secret  # None = enrollment gate off (standalone/test launches)
        self.loop = None
        self.sockets = {}       # deviceId -> websocket
        self.codes = {}         # code -> {"deviceId", "reqId", "expires"}
        self.pending = {}       # cmdId -> Future
        self.cmd_timeout = CMD_TIMEOUT
        self.pair_ack_timeout = PAIR_ACK_TIMEOUT
        self.pair_fails = []    # [ts] of failed /pair attempts
        self.code_reqs = {}     # deviceId -> [ts] of pair_requests
        self.pair_acks = {}     # sessionId -> (threading.Event, [ok, error])
        self.device_wait = DEVICE_WAIT
        self.lock = threading.Lock()

    def prune_expired_sessions(self):
        """Prune sessions idle past SESSION_TTL and tell any online device,
        so its existing "revoked" handler drops the session locally. The
        hello path prunes separately (see on_hello): there the welcome's
        session list and any revoked sent on the new socket do the same."""
        expired = self.state.prune_expired()
        for sid, device_id in expired:
            log(f"session {str(sid)[:6]} expired (idle over 7 days)")
            ws = self.sockets.get(device_id) if device_id else None
            if ws is not None and self.loop is not None:
                try:
                    asyncio.run_coroutine_threadsafe(
                        ws.send(json.dumps({"t": "revoked", "sessionId": sid})), self.loop)
                except Exception:
                    pass
        return expired

    # ---------------- device side ----------------
    def _settle_pair_ack(self, session_id, ok, error):
        if not session_id:
            return
        with self.lock:
            rec = self.pair_acks.pop(session_id, None)
        if rec is not None:
            rec[1][0] = ok
            rec[1][1] = error
            rec[0].set()

    async def device_handler(self, ws):
        device_id = None
        nonce = None
        try:
            # Per-connection challenge: a fresh random nonce goes out before
            # anything else, and the hello must sign it (see verify_hello).
            # The nonce is consumed by the first hello attempt, so a captured
            # hello cannot be replayed — not on a new connection (its nonce
            # differs) and not a second time on this one. When an enrollment
            # secret is configured, the hello must also prove knowledge of
            # it against this same nonce (see on_hello).
            nonce = secrets.token_hex(32)
            await ws.send(json.dumps({"t": "challenge", "nonce": nonce}))
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if not isinstance(msg, dict):
                    continue
                t = msg.get("t")
                if t == "hello":
                    hello_nonce, nonce = nonce, None  # one hello per challenge
                    device_id = await self.on_hello(ws, msg, hello_nonce)
                    if device_id is None:
                        return
                elif device_id is None:
                    continue  # nothing before a valid hello
                elif t == "pair_request":
                    await self.on_pair_request(ws, device_id, msg)
                elif t == "pair_cancel":
                    # The user replaced or cancelled these codes. They stop counting
                    # toward the open-code limit; a chat that still uses one reaches
                    # the extension, which refuses it and says why.
                    ids = msg.get("reqIds") if isinstance(msg.get("reqIds"), list) else []
                    with self.lock:
                        for r in self.codes.values():
                            if r["deviceId"] == device_id and r["reqId"] in ids:
                                r["cancelled"] = True
                elif t == "result":
                    fut = self.pending.pop(msg.get("id"), None)
                    if fut and not fut.done():
                        fut.set_result(msg)
                elif t == "revoke":
                    self.revoke_session(msg.get("sessionId"), device_id, notify=False)
                elif t == "paired_ack":
                    self._settle_pair_ack(msg.get("sessionId"), True, None)
                elif t == "paired_nack":
                    self._settle_pair_ack(msg.get("sessionId"), False, msg.get("error"))
                elif t == "heartbeat":
                    pass
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            if device_id and self.sockets.get(device_id) is ws:
                del self.sockets[device_id]
                log(f"device {device_id[:8]} offline")

    async def on_hello(self, ws, msg, nonce=None):
        device_id = msg.get("deviceId")
        jwk = msg.get("pubJwk") or {}
        if not isinstance(device_id, str) or not (8 <= len(device_id) <= 64):
            await ws.send(json.dumps({"t": "welcome", "ok": False, "error": "bad_device_id"}))
            return None
        if self.enroll_secret:
            # Enrollment gate, checked before the signature and the pinned
            # key: only a device that learned the secret from the native
            # host may enroll (or re-present) a device key at all.
            proof = msg.get("proof")
            # A genuine proof is exactly 64 hex chars. Anything else --
            # non-ASCII text, lone surrogates from JSON escapes, a wrong
            # length -- is refused here, never fed to compare_digest or
            # .encode(): those raise on non-ASCII str, which used to crash
            # this handler (unhandled traceback, socket closed with no
            # welcome) instead of returning bad_enroll_proof.
            proof_ok = isinstance(proof, str) and len(proof) == 64 and \
                all(c in "0123456789abcdefABCDEF" for c in proof)
            if proof_ok:
                expected = hmac.new(self.enroll_secret.encode("utf-8", "replace"),
                                    f"{device_id}:{nonce or ''}".encode("utf-8", "replace"),
                                    hashlib.sha256).hexdigest()
                proof_ok = hmac.compare_digest(proof.lower().encode("ascii"),
                                               expected.encode("ascii"))
            if not nonce or not proof_ok:
                await ws.send(json.dumps({"t": "welcome", "ok": False, "error": "bad_enroll_proof"}))
                log(f"hello rejected bad_enroll_proof for {device_id[:8]}")
                return None
        if not verify_hello(device_id, jwk, msg.get("sig") or "", nonce):
            await ws.send(json.dumps({"t": "welcome", "ok": False, "error": "bad_sig"}))
            log(f"hello rejected bad_sig for {device_id[:8]}")
            return None
        with self.state.lock:
            known = self.state.devices.get(device_id)
            if known and key_id(known["pubJwk"]) != key_id(jwk):
                reject = True
            else:
                reject = False
                if not known:
                    self.prune_devices()
                    known = self.state.devices[device_id] = {
                        "pubJwk": {k: jwk.get(k) for k in ("kty", "crv", "x", "y")}}
                known["lastSeen"] = int(time.time())
                self.state.save()
        if reject:
            await ws.send(json.dumps({"t": "welcome", "ok": False, "error": "key_mismatch"}))
            log(f"hello rejected key_mismatch for {device_id[:8]}")
            return None
        # Sessions idle over 7 days expire when a device says hello, even
        # if the device still reports them as live. The welcome below omits
        # them (so reconcile() drops them locally); a "revoked" for each is
        # also sent after the welcome, preserving welcome-first order.
        expired = self.state.prune_expired()
        expired_mine = [sid for sid, did in expired if did == device_id]
        if expired:
            log(f"expired {len(expired)} idle session(s) on hello from {device_id[:8]}")
        # A browser restart clears the extension's session store: any session
        # the device no longer knows about is revoked here, except a session
        # still waiting for the extension's paired_ack (its "paired" message
        # may be in flight); pair() rolls that one back itself if no ack comes.
        live = set(msg.get("liveSessions") or [])
        with self.lock:
            awaiting = set(self.pair_acks)
        with self.state.lock:
            stale = [sid for sid, s in self.state.sessions.items()
                     if s["deviceId"] == device_id and sid not in live and sid not in awaiting]
            for sid in stale:
                del self.state.sessions[sid]
            if stale:
                self.state.save()
        if stale:
            log(f"revoked {len(stale)} stale session(s) for {device_id[:8]}")
        old = self.sockets.pop(device_id, None)
        if old is not None and old is not ws:
            try:
                await old.close()
            except Exception:
                pass
        # Tell the device what the relay still holds, so both sides agree:
        # sessions ended while it was offline, and codes lost in a restart.
        with self.state.lock:
            mine = [sid for sid, s in self.state.sessions.items() if s["deviceId"] == device_id]
        with self.lock:
            req_ids = [r["reqId"] for r in self.codes.values()
                       if r["deviceId"] == device_id and r["expires"] >= time.time()]
        await ws.send(json.dumps({"t": "welcome", "ok": True, "sessions": mine, "reqIds": req_ids}))
        # Only now may /pair and /cmd use this socket: nothing may reach
        # the extension before its welcome.
        self.sockets[device_id] = ws
        log(f"device {device_id[:8]} online")
        for sid in expired_mine:
            try:
                await ws.send(json.dumps({"t": "revoked", "sessionId": sid}))
            except Exception:
                pass
        return device_id

    def prune_devices(self):
        """Keep at most MAX_DEVICES known devices (caller holds state.lock).
        Drops the least recently seen devices that have no live sessions."""
        if len(self.state.devices) < MAX_DEVICES:
            return
        busy = {s["deviceId"] for s in self.state.sessions.values()}
        idle = sorted((d.get("lastSeen", 0), did) for did, d in self.state.devices.items() if did not in busy)
        for _, did in idle[:len(self.state.devices) - MAX_DEVICES + 1]:
            del self.state.devices[did]
            log(f"forgot idle device {did[:8]} (device limit)")

    async def on_pair_request(self, ws, device_id, msg):
        req_id = msg.get("reqId")
        if not isinstance(req_id, str) or len(req_id) > 64:
            return
        now = time.time()
        with self.lock:
            for c in [c for c, r in self.codes.items() if r["expires"] < now]:
                del self.codes[c]
            recent = [t for t in self.code_reqs.get(device_id, []) if now - t < 60]
            open_codes = sum(1 for r in self.codes.values()
                             if r["deviceId"] == device_id and r["reqId"] != req_id and not r.get("cancelled"))
            if len(recent) >= PAIR_REQS_PER_DEVICE_PER_MIN or open_codes >= MAX_CODES_PER_DEVICE:
                self.code_reqs[device_id] = recent
                err = "too_many_codes"
            else:
                err = None
                recent.append(now)
                self.code_reqs[device_id] = recent
                # One open code per share request: a re-sent request replaces its old code.
                for c in [c for c, r in self.codes.items() if r["deviceId"] == device_id and r["reqId"] == req_id]:
                    del self.codes[c]
        if err:
            await ws.send(json.dumps({"t": "pair_error", "reqId": req_id, "error": err}))
            return
        with self.lock:
            while True:
                code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
                if code not in self.codes:
                    break
            self.codes[code] = {"deviceId": device_id, "reqId": req_id, "expires": now + CODE_TTL}
        await ws.send(json.dumps({"t": "pair_code", "reqId": req_id, "code": code, "expiresIn": CODE_TTL}))
        log(f"pairing code issued for device {device_id[:8]}")  # code itself never logged

    # ---------------- chat side ----------------
    def pair_retry_after(self):
        """Seconds until /pair accepts attempts again (0 = now). Only failed
        attempts count, so a flood of bad codes can delay pairing by at most
        a minute and a correct code never uses up the budget."""
        now = time.time()
        with self.lock:
            self.pair_fails = [t for t in self.pair_fails if now - t < 60]
            if len(self.pair_fails) >= PAIR_FAILS_PER_MIN:
                return max(1, int(60 - (now - self.pair_fails[0])) + 1)
            return 0

    def wait_device(self, device_id, secs):
        """The device's socket, waiting up to secs for it to come back."""
        end = time.time() + secs
        ws = self.sockets.get(device_id)
        while ws is None and time.time() < end:
            time.sleep(0.2)
            ws = self.sockets.get(device_id)
        return ws

    def attach_target(self, token, device_id):
        """Attach-on-redeem lookup. Returns (target, mismatch): target is
        {"sessionId", "chatName"} of the live session the presented token
        names on this device, or None when there is nothing to attach to
        (no token, unknown token, expired session — the caller then pairs
        fresh, exactly as before this feature). A token naming a live
        session on a DIFFERENT device returns (None, True): attaching there
        would cross chats, and silently pairing fresh instead would strand
        the chat between two sessions, so the pair is refused."""
        if not token:
            return None, False
        sid, s = self.state.session_by_token(token)
        if not sid or self.state.is_expired(s):
            return None, False
        if s["deviceId"] != device_id:
            return None, True
        return {"sessionId": sid, "chatName": s["chatName"]}, False

    def pair(self, code, chat_name, token=None):
        code = str(code or "").strip().upper().replace("-", "").replace(" ", "")
        now = time.time()
        with self.lock:
            rec = self.codes.get(code)
            if not rec or rec["expires"] < now or rec.get("cancelled"):
                self.codes.pop(code, None)
                self.pair_fails.append(now)
                return None, "bad_or_expired_code"
        # Attach-on-redeem: if the redeeming chat presented the token of a
        # live session on this code's device, the code's tab joins THAT
        # session. A token for another device's session refuses the pair
        # here, before the code is consumed, so the code stays live for
        # the chat it was generated for.
        target, mismatch = self.attach_target(token, rec["deviceId"])
        if mismatch:
            with self.lock:
                self.pair_fails.append(time.time())
            return None, "token_device_mismatch"
        # Chrome may have stopped the extension's worker: wait for it to
        # reconnect. The code stays held meanwhile, so the extension keeps
        # it on reconnect, and a later retry still works if it never comes.
        ws = self.wait_device(rec["deviceId"], self.device_wait)
        with self.lock:
            if self.codes.get(code) is not rec or rec["expires"] < time.time() or rec.get("cancelled"):
                if self.codes.get(code) is rec:
                    self.codes.pop(code, None)
                self.pair_fails.append(now)
                return None, "bad_or_expired_code"  # used by another /pair meanwhile, or expired
            if ws is not None:
                del self.codes[code]
        if target is not None:
            return self.complete_attach(rec, target)
        return self.complete_pair(rec["deviceId"], rec["reqId"], chat_name)

    def complete_attach(self, rec, target):
        """Attach-on-redeem: the code's tab joins the session the chat's
        token already names. No session is created and no token is minted:
        the "paired" message carries the existing session id with
        attach: true, and the extension adds the share's tab to that
        session. Unlike complete_pair there is nothing to roll back on a
        nack — the session pre-exists and is not this call's to delete."""
        session_id = target["sessionId"]
        device_id = rec["deviceId"]
        now = time.time()
        ws = self.sockets.get(device_id)
        if ws is None or not getattr(ws, "open", True):
            self.sockets.pop(device_id, None)
            self.pair_fails.append(now)
            return None, "device_offline"
        with self.state.lock:
            live = self.state.sessions.get(session_id)
            if live is None or live["deviceId"] != device_id:
                # The session ended while the code waited for the device.
                self.pair_fails.append(now)
                return None, "session_gone"
        ack_ev = threading.Event()
        ack_res = [None, None]  # [ok, error]
        with self.lock:
            if session_id in self.pair_acks:
                # The extension acks by session id, so two redemptions for
                # the same session in flight at once could not be told
                # apart. Refuse the second (the code is already consumed;
                # the chat asks for a fresh one).
                self.pair_fails.append(now)
                return None, "attach_in_progress"
            self.pair_acks[session_id] = (ack_ev, ack_res)
        fut = asyncio.run_coroutine_threadsafe(ws.send(json.dumps({
            "t": "paired", "reqId": rec["reqId"], "sessionId": session_id,
            "chatName": target["chatName"], "attach": True})), self.loop)
        try:
            fut.result(timeout=5)
        except Exception as e:
            with self.lock:
                self.pair_acks.pop(session_id, None)
            self.sockets.pop(device_id, None)
            log(f"attach send failed for {device_id[:8]}: {type(e).__name__}")
            return None, "device_offline"
        if not ack_ev.wait(timeout=self.pair_ack_timeout):
            with self.lock:
                self.pair_acks.pop(session_id, None)
            log(f"attach ack timeout for device {device_id[:8]}")
            return None, "device_offline"
        ok, err = ack_res
        if not ok:
            log(f"attach nacked by device {device_id[:8]}: {err}")
            return None, ("pair_rejected", str(err or "the extension refused the attach"))
        # An attach is use of the session: it resets the idle expiry,
        # like a command does.
        self.state.touch_session(session_id)
        log(f"tab attached to session {session_id[:6]} (code redeemed with its token)")
        return {"attached": True, "sessionId": session_id, "chatName": target["chatName"]}, None

    def complete_pair(self, device_id, req_id, chat_name):
        """Create the session, tell the extension ("paired") and wait for its
        paired_ack. Used by a code (/pair)."""
        now = time.time()
        ws = self.sockets.get(device_id)
        # A half-open socket (extension suspended, no close frame) would
        # swallow the "paired" message: the session would exist on the
        # relay but the extension would never learn it, and the next
        # hello would revoke it. Refuse instead of creating a phantom.
        if ws is None or not getattr(ws, "open", True):
            self.sockets.pop(device_id, None)
            self.pair_fails.append(now)
            return None, "device_offline"
        chat_name = "".join(ch for ch in str(chat_name or "chat") if ch.isprintable())[:36].strip() or "chat"
        session_id = secrets.token_hex(12)
        token = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
        with self.state.lock:
            # Names are unique per device, so the user can tell chats apart.
            taken = {s["chatName"] for s in self.state.sessions.values() if s["deviceId"] == device_id}
            base, n = chat_name, 2
            while chat_name in taken:
                chat_name = f"{base} ({n})"
                n += 1
            self.state.sessions[session_id] = {
                "deviceId": device_id, "tokenHash": token_hash(token),
                "chatName": chat_name, "created": int(now), "lastUsed": int(now)}
            self.state.save()
        ack_ev = threading.Event()
        ack_res = [None, None]  # [ok, error]
        with self.lock:
            self.pair_acks[session_id] = (ack_ev, ack_res)
        fut = asyncio.run_coroutine_threadsafe(ws.send(json.dumps({
            "t": "paired", "reqId": req_id, "sessionId": session_id,
            "chatName": chat_name})), self.loop)
        try:
            fut.result(timeout=5)
        except Exception as e:
            # The "paired" message never left: roll the session back so
            # we don't leave a phantom the extension never learns about.
            with self.lock:
                self.pair_acks.pop(session_id, None)
            with self.state.lock:
                self.state.sessions.pop(session_id, None)
                self.state.save()
            self.sockets.pop(device_id, None)
            log(f"paired send failed for {device_id[:8]}: {type(e).__name__}")
            return None, "device_offline"
        # The bytes left; now wait for the extension to confirm it actually
        # recorded the session (tab grouped, storage written). Without this,
        # a half-open socket silently eats the message and every later
        # command fails with session_not_found. Since v2.7 the extension
        # acks only after the user confirms full control for the tab in
        # the side panel, so this wait is the pair-ack window (100 s),
        # not a machine-speed timeout.
        if not ack_ev.wait(timeout=self.pair_ack_timeout):
            with self.lock:
                self.pair_acks.pop(session_id, None)
            with self.state.lock:
                self.state.sessions.pop(session_id, None)
                self.state.save()
            log(f"paired ack timeout for device {device_id[:8]}")
            return None, "device_offline"
        ok, err = ack_res
        if not ok:
            with self.state.lock:
                self.state.sessions.pop(session_id, None)
                self.state.save()
            log(f"paired nacked by device {device_id[:8]}: {err}")
            return None, ("pair_rejected", str(err or "the extension refused the pairing"))
        log(f"session {session_id[:6]} paired to device {device_id[:8]} (acked)")
        return {"sessionId": session_id, "token": token, "chatName": chat_name}, None

    def revoke_session(self, session_id, device_id=None, notify=True):
        with self.state.lock:
            s = self.state.sessions.get(session_id)
            if not s or (device_id and s["deviceId"] != device_id):
                return False
            del self.state.sessions[session_id]
            self.state.save()
        log(f"session {str(session_id)[:6]} revoked")
        if notify:
            ws = self.sockets.get(s["deviceId"])
            if ws is not None:
                asyncio.run_coroutine_threadsafe(
                    ws.send(json.dumps({"t": "revoked", "sessionId": session_id})), self.loop)
        return True

    async def send_cmd(self, session_id, device_id, action, args):
        start, waited = time.time(), 0.0
        ws = self.sockets.get(device_id)
        # Chrome may have stopped the extension's worker: wait for it to
        # reconnect, inside the command's own deadline.
        while ws is None and waited < min(self.device_wait, self.cmd_timeout / 2):
            await asyncio.sleep(0.2)
            waited = time.time() - start
            ws = self.sockets.get(device_id)
        if ws is None:
            return {"ok": False, "error": "device_offline"}
        budget = self.cmd_timeout - waited
        cmd_id = secrets.token_hex(8)
        fut = self.loop.create_future()
        self.pending[cmd_id] = fut
        try:
            await ws.send(json.dumps({"t": "cmd", "id": cmd_id, "sessionId": session_id,
                                      "action": action, "args": args, "ttlMs": int(budget * 1000)}))
            res = await asyncio.wait_for(fut, budget)
            out = {"ok": bool(res.get("ok"))}
            if out["ok"]:
                out["data"] = res.get("data")
            else:
                out["error"] = res.get("error") or "error"
                if res.get("detail"):
                    out["detail"] = str(res.get("detail"))[:300]
            # One line per command: which tool, and ok or the error code. Never
            # arguments or page content.
            log(f"cmd {session_id[:6]} {str(action)[:30]} -> {'ok' if out['ok'] else out['error']}"
                + ("" if out["ok"] or not out.get("detail") else f" ({out['detail'][:160]})"))
            return out
        except asyncio.TimeoutError:
            # Tell the extension to stop: nothing may act after "timeout".
            live = self.sockets.get(device_id)
            if live is not None:
                try:
                    await live.send(json.dumps({"t": "cancel", "id": cmd_id}))
                except Exception:
                    pass
            log(f"cmd {session_id[:6]} {str(action)[:30]} -> timeout")
            return {"ok": False, "error": "timeout"}
        except websockets.exceptions.ConnectionClosed:
            return {"ok": False, "error": "device_offline"}
        finally:
            self.pending.pop(cmd_id, None)


FIXTURES = {
    "form": """<!doctype html><title>form</title>
<form id=f action="/fixture/submitted" method=get>
<label>Name <input name=custname id=custname></label>
<label>Phone <input name=custtel id=custtel></label>
<label>Secret <input type=password name=pw id=pw></label>
<button type=submit>Submit order</button></form>""",
    "submitted": "<!doctype html><title>submitted</title><h1>submitted</h1>",
    "child": """<!doctype html><title>child</title>
<a id=same href="/fixture/form" target="_blank" rel="opener">same-site child</a>
<a id=other href="{OTHER}/fixture/form" target="_blank" rel="opener">other-site child</a>
<a id=redir href="/fixture/redirect">redirect away</a>
<a id=third href="http://third.test:{PORT}/fixture/form" target="_blank" rel="opener">third-site child</a>""",
    "refresh": """<!doctype html><title>refresh</title>
<button id=b>Version one</button>
<script>setTimeout(()=>{document.getElementById('b').textContent='Version two'},3000)</script>""",
    # Buttons whose risk is only visible on the button, not on the icon or
    # span a click lands on; an icon-only button; a div used as a button;
    # a risky button far below the fold (coordinate clicks on a scrolled page).
    "risky": """<!doctype html><title>risky</title>
<style>button,div.btn{display:block;margin:10px;padding:10px 16px;font:16px sans-serif}</style>
<button id=pay><svg width=18 height=18 aria-hidden=true><rect width=18 height=18 fill="#393"/></svg> <span id=paylabel>Pay now</span></button>
<button id=trash aria-label="Delete item"><span style="font-size:22px">&#128465;</span></button>
<div id=divbuy class=btn style="cursor:pointer;background:#fc9;width:160px"><svg id=buyicon width=18 height=18 aria-hidden=true><circle cx=9 cy=9 r=8 fill="#c60"/></svg> <span id=buylabel>Buy it</span></div>
<button id=safe>Show details</button>
<p id=out>none</p>
<button id=deep style="margin-top:1600px">Delete account</button>
<script>
const out = (t) => { document.getElementById('out').textContent = t; };
pay.onclick = () => out('paid'); trash.onclick = () => out('deleted');
divbuy.addEventListener('click', () => out('bought')); safe.onclick = () => out('safe');
deep.onclick = () => out('deep-deleted');
</script>""",
    # Keyboard: a focusable Pay button outside any form; a login made of
    # divs (no <form>) that submits on Enter from script.
    "keys": """<!doctype html><title>keys</title>
<input id=before placeholder="Before">
<button id=kpay>Pay now</button>
<div id=spa><div><input id=user name=user placeholder="User"></div>
<div><input id=secret type=password name=secret placeholder="Secret"></div></div>
<p id=out>none</p>
<script>
const out = (t) => { document.getElementById('out').textContent = t; };
kpay.onclick = () => out('paid');
user.addEventListener('keydown', (e) => { if (e.key === 'Enter') out('spa-submitted'); });
</script>""",
    # Password fields inside an open and a closed shadow root.
    "shadow": """<!doctype html><title>shadow</title>
<x-login id=openhost></x-login>
<x-pay id=closedhost></x-pay>
<p id=out>none</p>
<script>
customElements.define('x-login', class extends HTMLElement { constructor() { super();
  const r = this.attachShadow({ mode: 'open' });
  r.innerHTML = '<input id=pw type=password placeholder="Shadow secret"> <button id=go>Go</button>'; } });
customElements.define('x-pay', class extends HTMLElement { constructor() { super();
  const r = this.attachShadow({ mode: 'closed' });
  r.innerHTML = '<input id=pw2 type=password placeholder="Closed secret"> <button id=cpay>Pay</button>';
  r.getElementById('cpay').onclick = () => { document.getElementById('out').textContent = 'closed-paid'; }; } });
</script>""",
    # A same-site frame and a frame from another site.
    "frames": """<!doctype html><title>frames</title>
<p id=out>none</p>
<iframe id=same src="/fixture/inner" width=420 height=150 style="display:block"></iframe>
<iframe id=cross src="http://evil.test:{PORT}/fixture/inner" width=420 height=150 style="display:block"></iframe>""",
    "inner": """<!doctype html><title>inner</title>
<body style="margin:0">
<input id=ipw type=password placeholder="Inner secret" style="display:block;margin:6px">
<button id=ipay style="display:block;margin:6px">Send money</button>
<button id=iok style="display:block;margin:6px">Fine</button>
<p id=out>none</p>
<script>
const out = (t) => { document.getElementById('out').textContent = t; try { parent.document.getElementById('out').textContent = 'frame:' + t; } catch (e) {} };
ipay.onclick = () => out('sent'); iok.onclick = () => out('ok');
</script></body>""",
    # A card form whose submit button has no risky word.
    "payform": """<!doctype html><title>payform</title>
<form action="/fixture/submitted" method=get>
<input name=cardnumber autocomplete=cc-number placeholder="Card number">
<button id=cont type=submit>Continue</button></form>""",
    # A login form with a show-password toggle.
    "reveal": """<!doctype html><title>reveal</title>
<form action="/fixture/submitted" method=get>
<input id=rpw type=password name=password placeholder="Password">
<button type=button id=show aria-label="Show password">&#128065;</button>
<button type=submit>Sign in</button></form>
<script>show.onclick = () => { rpw.type = rpw.type === 'password' ? 'text' : 'password'; };</script>""",
    "drag": """<!doctype html><title>drag</title>
<div id=src draggable=true style="width:80px;height:40px;background:#9cf">drag me</div>
<div id=dst style="width:200px;height:80px;margin-top:40px;border:2px dashed #999">drop</div>
<p id=out>none</p>
<script>
let down=null;
document.addEventListener('mousedown',e=>{down=[e.clientX,e.clientY,e.isTrusted]});
document.addEventListener('mouseup',e=>{if(down){document.getElementById('out').textContent=
 'dragged '+(e.clientX-down[0])+','+(e.clientY-down[1])+' trusted='+down[2]}});
</script>""",
}


def other_origin(handler):
    """The 'other site' for fixtures: 127.0.0.1 and localhost are different
    hosts to the browser, so each fixture links to the other one."""
    port = handler.server.server_address[1]
    host = (handler.headers.get("Host") or "").split(":")[0]
    other = "localhost" if host == "127.0.0.1" else "127.0.0.1"
    return f"http://{other}:{port}"


def is_ipv4(s):
    parts = str(s or "").strip().split(".")
    return len(parts) == 4 and all(p.isdigit() and 0 <= int(p) <= 255 for p in parts)


TAILNET_RANGE = ipaddress.ip_network("100.64.0.0/10")  # Tailscale (CGNAT) range


def is_allowed_bind(s):
    """A second-listener address must be loopback or inside the Tailscale
    range 100.64.0.0/10. Anything else (0.0.0.0, a LAN or public address)
    would expose the chat API beyond the tailnet."""
    try:
        ip = ipaddress.ip_address(str(s or "").strip())
    except ValueError:
        return False
    return ip.is_loopback or ip in TAILNET_RANGE


def detect_tailscale_ip():
    """This PC's Tailscale IPv4 from the tailscale CLI, or None. Never guessed."""
    exes = ["tailscale", r"C:\Program Files\Tailscale\tailscale.exe"]
    for exe in exes:
        try:
            r = subprocess.run([exe, "ip", "-4"], capture_output=True, text=True, timeout=5,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except (OSError, subprocess.TimeoutExpired):
            continue
        first = (r.stdout or "").strip().splitlines()
        if r.returncode == 0 and first:
            ip = first[0].strip()
            # Only a real Tailscale address may be used; a CLI answer outside
            # 100.64.0.0/10 is not trusted as this PC's tailnet address.
            if is_ipv4(ip) and ipaddress.ip_address(ip) in TAILNET_RANGE:
                return ip
    return None


def make_handler(relay, tailnet=False, fixtures=False):
    # tailnet=True: the listener on the Tailscale address. Same API, except
    # /pair is refused there: pairing is a local act, so it is only
    # accepted on the loopback listener.
    # fixtures=True: serve the /fixture/ test pages; without it they 404 on
    # every listener (test scaffolding must not ship enabled by default).
    class Handler(BaseHTTPRequestHandler):
        server_version = "MuseRelay/2"

        def log_message(self, *a):
            pass  # never log request lines (they could carry tokens in bad clients)

        def _json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return None
            if n < 0 or n > 1_000_000:
                return None
            try:
                d = json.loads(self.rfile.read(n) or b"{}")
            except Exception:
                return None
            return d if isinstance(d, dict) else None

        def _local_only(self):
            # The chat API is for programs on this PC (client.py), never for
            # a web page. A DNS-rebinding page sends a foreign Host; a browser
            # sends Origin on every POST. client.py sends neither.
            addr, port = self.server.server_address[:2]
            host = (self.headers.get("Host") or "").lower()
            allowed = {f"{addr}:{port}"} | ({f"localhost:{port}"} if addr == "127.0.0.1" else set())
            if host not in allowed or self.headers.get("Origin") is not None:
                self._json({"ok": False, "error": "forbidden"}, 403)
                return False
            return True

        def do_GET(self):
            if self.path.startswith("/fixture/"):
                if not fixtures:
                    return self._json({"ok": False, "error": "not_found"}, 404)
                name = self.path[len("/fixture/"):].split("?")[0]
                if name == "redirect":
                    self.send_response(302)
                    self.send_header("Location", other_origin(self) + "/fixture/form")
                    self.end_headers()
                    return
                html = FIXTURES.get(name)
                if html is not None:
                    html = html.replace("{OTHER}", other_origin(self)).replace("{PORT}", str(self.server.server_address[1]))
                if html is None:
                    return self._json({"ok": False, "error": "not_found"}, 404)
                body = html.encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if not self._local_only():
                return
            if self.path == "/status":
                relay.prune_expired_sessions()
                sid, s = relay.state.session_by_token(self.headers.get("X-Chat-Token"))
                if not sid:
                    return self._json({"ok": False, "error": "bad_token"}, 401)
                relay.state.touch_session(sid)
                return self._json({"ok": True, "sessionId": sid, "chatName": s["chatName"],
                                   "deviceOnline": s["deviceId"] in relay.sockets})
            self._json({"ok": False, "error": "not_found"}, 404)

        def do_POST(self):
            if not self._local_only():
                return
            if tailnet and self.path == "/pair":
                return self._json({"ok": False, "error": "pair_local_only",
                                   "detail": "pair from this PC (127.0.0.1); the tailnet address refuses /pair"}, 403)
            b = self._body()
            if b is None:
                return self._json({"ok": False, "error": "malformed_json"}, 400)
            if self.path == "/pair":
                wait = relay.pair_retry_after()
                if wait:
                    return self._json({"ok": False, "error": "rate_limited", "retryAfter": wait}, 429)
                res, err = relay.pair(b.get("code"), b.get("chatName"), token=b.get("token"))
                if err:
                    if isinstance(err, tuple):
                        return self._json({"ok": False, "error": err[0], "detail": err[1]}, 400)
                    detail = {"bad_or_expired_code": "the code is wrong, already used, or older than 5 minutes. Ask the user to open the Muse Bridge side panel on the page: if it shows a code, send it; if not, the user clicks 'Share this page with a Muse chat' and sends you the new code",
                              "device_offline": "The user's browser extension is not connected to the relay",
                              "token_device_mismatch": "the token sent with this code belongs to a session on a different device, so the code was refused and NOT used up. Give the code to a chat connected to this browser.",
                              "session_gone": "the session your token names ended while the code was being redeemed. Pair again without the old token to start a fresh session.",
                              "attach_in_progress": "another code redemption for this same session is still finishing. Wait a few seconds, then ask the user for a fresh code."}.get(err)
                    return self._json({"ok": False, "error": err, **({"detail": detail} if detail else {})}, 400)
                return self._json({"ok": True, **res})
            if self.path == "/cmd":
                # Prune before answering: an expired token answers bad_token.
                relay.prune_expired_sessions()
                sid, s = relay.state.session_by_token(b.get("token"))
                if not sid:
                    return self._json({"ok": False, "error": "bad_token"}, 401)
                action = b.get("action")
                args = b.get("args") or {}
                if not isinstance(action, str) or not isinstance(args, dict):
                    return self._json({"ok": False, "error": "bad_request"}, 400)
                relay.state.touch_session(sid)
                fut = asyncio.run_coroutine_threadsafe(
                    relay.send_cmd(sid, s["deviceId"], action, args), relay.loop)
                try:
                    return self._json(fut.result(relay.cmd_timeout + 5))
                except Exception:
                    return self._json({"ok": False, "error": "timeout"})
            if self.path == "/revoke":
                sid, _ = relay.state.session_by_token(b.get("token"))
                if not sid:
                    return self._json({"ok": False, "error": "bad_token"}, 401)
                relay.revoke_session(sid)
                return self._json({"ok": True})
            self._json({"ok": False, "error": "not_found"}, 404)

    return Handler


class StrictHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False  # a second relay must fail, not share the port
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ws-port", type=int, default=19822)
    ap.add_argument("--http-port", type=int, default=20822)
    ap.add_argument("--state", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "state.json"))
    ap.add_argument("--enroll-secret-file", default=None, help="file holding the per-install device "
                    "enrollment secret; when given, a device hello must prove knowledge of it "
                    "(the native host creates the file and passes this in production)")
    ap.add_argument("--cmd-timeout", type=float, default=CMD_TIMEOUT, help="seconds a command may take (tests)")
    ap.add_argument("--device-wait", type=float, default=DEVICE_WAIT, help="seconds to wait for an offline device (tests)")
    ap.add_argument("--pair-ack-timeout", type=float, default=PAIR_ACK_TIMEOUT, help="seconds /pair waits for the extension's paired_ack (tests)")
    ap.add_argument("--bind", default="auto", help="second chat-API listener: auto = this PC's Tailscale address, "
                    "off = loopback only, or a loopback / Tailscale (100.64.0.0/10) IPv4 address")
    ap.add_argument("--fixtures", action="store_true", help="serve the /fixture/ test pages (tests only; off by default)")
    a = ap.parse_args()
    if a.bind not in ("auto", "off") and not is_ipv4(a.bind):
        ap.error("--bind must be auto, off, or an IPv4 address")
    if a.bind not in ("auto", "off") and not is_allowed_bind(a.bind):
        ap.error("--bind refused: the second listener may only bind a loopback address "
                 "or one in the Tailscale range 100.64.0.0/10")

    enroll_secret = None
    if a.enroll_secret_file:
        try:
            with open(a.enroll_secret_file, encoding="utf-8") as f:
                enroll_secret = f.read().strip()
        except (OSError, UnicodeError) as e:
            sys.exit(f"cannot read enrollment secret file {a.enroll_secret_file}: {e}")
        if not enroll_secret:
            sys.exit(f"enrollment secret file {a.enroll_secret_file} is empty -- refusing to start")
        if len(enroll_secret) < 32:
            # A short secret makes the HMAC key brute-forceable connection
            # by connection; the host only ever generates 64 hex chars.
            sys.exit(f"enrollment secret file {a.enroll_secret_file} is too short -- refusing to start")

    relay = Relay(State(a.state), enroll_secret=enroll_secret)
    if enroll_secret:
        log("device enrollment gate on (hello must prove the per-install secret)")
    relay.cmd_timeout = max(1.0, a.cmd_timeout)
    relay.device_wait = max(0.0, a.device_wait)
    relay.pair_ack_timeout = max(1.0, a.pair_ack_timeout)
    relay.loop = asyncio.new_event_loop()
    ready = threading.Event()
    failed = []

    async def ws_main():
        try:
            server = await websockets.serve(relay.device_handler, "127.0.0.1", a.ws_port,
                                            ping_interval=20, max_size=16_000_000,
                                            origins=[None, EXTENSION_ORIGIN])
        except OSError as e:
            failed.append(e)
            ready.set()
            return
        ready.set()
        await server.wait_closed()

    def run_loop():
        asyncio.set_event_loop(relay.loop)
        relay.loop.run_until_complete(ws_main())

    threading.Thread(target=run_loop, daemon=True).start()
    ready.wait(10)
    if failed or not ready.is_set():
        log(f"cannot bind ws 127.0.0.1:{a.ws_port}: {failed[0] if failed else 'timeout'} -- exiting")
        sys.exit(2)
    try:
        httpd = StrictHTTPServer(("127.0.0.1", a.http_port), make_handler(relay, fixtures=a.fixtures))
    except OSError as e:
        log(f"cannot bind http 127.0.0.1:{a.http_port}: {e} -- exiting")
        sys.exit(2)
    log(f"ws 127.0.0.1:{a.ws_port}  http 127.0.0.1:{a.http_port}  state {a.state}")
    tail = None
    if a.bind == "auto":
        tail = detect_tailscale_ip()
        if not tail:
            log("WARNING: no Tailscale address found (tailscale ip -4): chat API is loopback-only")
    elif a.bind != "off":
        tail = a.bind
    if tail:
        try:
            tail_httpd = StrictHTTPServer((tail, a.http_port), make_handler(relay, tailnet=True, fixtures=a.fixtures))
        except OSError as e:
            log(f"cannot bind http {tail}:{a.http_port}: {e} -- exiting")
            sys.exit(2)
        threading.Thread(target=tail_httpd.serve_forever, daemon=True).start()
        log(f"http {tail}:{a.http_port} (tailnet; /pair refused)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
