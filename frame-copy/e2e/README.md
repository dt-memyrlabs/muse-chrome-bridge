# Frame-copy acceptance rig

A local, repeatable end-to-end proof for the Muse Chrome Bridge's framed
page behavior — the factory.8090.ai shape: a chat UI inside an iframe, and a
bridge chat that must click the framed composer, type, click Send, and read
the framed message list back, with no human click.

## Run it

```
/tmp/relayvenv/bin/python run_e2e.py [--extension PATH] [--keep] [--dump-tree]
```

- Python: the relay venv (`websockets` + `cryptography`). If `/tmp/relayvenv`
  is gone: `python3 -m venv /tmp/relayvenv && /tmp/relayvenv/bin/pip install websockets cryptography`.
- Default extension: the staging tree (`../../attach-on-redeem/extension`).
  Pass `--extension` to test another build (the v2.4.1 baseline used the
  shipped zip's tree).
- Exit code: 0 = all gated cases pass, 1 = a case failed, 2 = rig setup failed.
- Every run writes `last-run.log` (full transcript) and `last-relay.log`.
- The production ports (19822/20822) are required — the extension hardcodes
  them. The runner waits up to 120 s for other test suites on this VM to
  release them.

## What runs

- `serve.py` — two static origins. Origin A (`frame-a.test:8971`) serves a
  parent page with a control textarea, a **cross-origin** iframe (origin B,
  `frame-b.test:8972`) holding the chat page, and a **same-origin** iframe
  holding the same chat page. `pages/chat.html` has a contenteditable
  composer, a plain textarea, and a Send button that appends to a message
  list; the frame reports its state to the parent via postMessage, and the
  parent mirrors it — that mirror is how the bridge reads the framed list
  back through the parent tab.
- The real relay, gated with an enroll-secret file, as the native host runs it.
- The real extension, unpacked, in the VM's headless Chromium
  (`--host-resolver-rules` maps the .test names; `--no-proxy-server` is
  required — this VM's proxy env would otherwise swallow the .test names).
  Different *sites* matter: two ports on 127.0.0.1 are one site and the
  frame stays in-process, which does not reproduce the failure.
- Pairing is fully scripted through the product's own surfaces: the rig
  opens the extension's sidepanel page and sends the same
  `chrome.runtime` messages the real panel sends (`share`, `state`,
  `approve`), then pairs with the real `agent/client.py`. Every bridge
  action in the cases goes through `client.py`. PASS/FAIL is decided by
  ground truth read from the framed DOM over the harness's own CDP
  connection, plus the bridge's own read-back — never by a tool's `ok`.

## What the rig stands in for (the only two human roles)

1. **Install provisioning**: it writes the enroll secret into the
   extension's storage — exactly what the native host hands over on a real
   install. (Without it the extension refuses to say hello; there is no
   native host in this VM.)
2. **Panel approvals**: permission prompts (e.g. acting inside another
   site's frame) are approved through the panel protocol and logged. The
   rig never clicks inside the page on the user's behalf.

## Cases

Gated: `framed-contenteditable`, `framed-textarea`, `parent-control`
(control), `background-framed-composer` (shared tab behind a decoy tab).
Non-gated probe: `ref-visibility` — whether framed elements get refs in
this Chromium at all, and whether refs can drive them if they do.

Results on record: [BASELINE.md](BASELINE.md) (v2.4.1) and
[RESULTS.md](RESULTS.md) (v2.5.0).
