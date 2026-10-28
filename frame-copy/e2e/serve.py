#!/usr/bin/env python3
"""Two tiny static servers on two localhost ports = two origins.

Origin A (default port 8971) serves pages/parent.html at / and /parent.html,
with __CHAT_ORIGIN__ replaced by origin B's base URL.
Origin B (default port 8972) serves pages/chat.html at / and /chat.html.

Run standalone to serve forever:
    python3 serve.py
or import start_servers() from the runner.
"""
import http.server
import os
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
PAGES = os.path.join(HERE, "pages")
PORT_A = 8971
PORT_B = 8972
# Distinct hostnames, not just distinct ports: a "site" for IP literals is
# the IP alone (ports do not count), so 127.0.0.1:8971 and 127.0.0.1:8972
# are the SAME site and Chrome keeps the frame in the parent's process.
# The production failure (factory.8090.ai) is a cross-SITE embed, which
# Chrome site-isolates into an out-of-process iframe. frame-a.test and
# frame-b.test are different sites; the runner maps both to 127.0.0.1 with
# Chromium's --host-resolver-rules.
HOST_A = "frame-a.test"
HOST_B = "frame-b.test"
ORIGIN_A = f"http://{HOST_A}:{PORT_A}"
ORIGIN_B = f"http://{HOST_B}:{PORT_B}"


class _Quiet(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _html(self, body_bytes):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)


def _handler_a(chat_origin):
    class H(_Quiet):
        def do_GET(self):
            if self.path in ("/", "/parent.html"):
                with open(os.path.join(PAGES, "parent.html"), encoding="utf-8") as f:
                    body = f.read().replace("__CHAT_ORIGIN__", chat_origin).encode()
                return self._html(body)
            if self.path == "/chat.html":
                # The same chat page, served from origin A: embedded by the
                # parent as a SAME-origin frame (the shape where the bridge
                # can see the framed elements and hand out refs for them).
                with open(os.path.join(PAGES, "chat.html"), encoding="utf-8") as f:
                    return self._html(f.read().encode())
            self.send_error(404)
    return H


def _handler_b():
    class H(_Quiet):
        def do_GET(self):
            if self.path in ("/", "/chat.html"):
                with open(os.path.join(PAGES, "chat.html"), encoding="utf-8") as f:
                    return self._html(f.read().encode())
            self.send_error(404)
    return H


def start_servers(port_a=PORT_A, port_b=PORT_B):
    chat_origin = f"http://{HOST_B}:{port_b}"
    a = http.server.ThreadingHTTPServer(("127.0.0.1", port_a), _handler_a(chat_origin))
    b = http.server.ThreadingHTTPServer(("127.0.0.1", port_b), _handler_b())
    for s in (a, b):
        threading.Thread(target=s.serve_forever, daemon=True).start()
    return a, b


if __name__ == "__main__":
    start_servers()
    print(f"parent (origin A): {ORIGIN_A}/parent.html", flush=True)
    print(f"chat   (origin B): {ORIGIN_B}/chat.html", flush=True)
    print("map both hostnames to 127.0.0.1 (hosts file or "
          "--host-resolver-rules) to reach them", flush=True)
    threading.Event().wait()
