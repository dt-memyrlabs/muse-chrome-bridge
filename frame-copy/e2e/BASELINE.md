# Baseline — unfixed build (v2.4.1) against the frame rig

Run: 2026-10-28, `run_e2e.py --extension <v2.4.1 tree>`. Exit code 1.
Full transcript: [baseline-run.log](baseline-run.log).

## Which build this is

The staging tree no longer holds the old code — it is v2.5.0 now, and no git
copy of the pre-fix tree was saved. The baseline was therefore run against
the authentic shipped artifact that survives on disk:
`~/workspace/muse-browser-bridge/muse-chrome-bridge-extension-v2.4.1.zip`
(SHA-256 begins `4d53a2d260bffcc1`; manifest version 2.4.1; the zip Daniel
was sent on 2026-10-27), extracted to a temp dir for the run. Nothing in it
was modified or reconstructed. The harness frames suite
(`tests/test_extension_frames.js` header + GAP.md) also documents the old
behavior numerically.

## Environment (why these numbers mean what they mean)

- Real relay (enroll-secret gated, production ports), real extension in
  headless Chromium on the VM, real `agent/client.py` for every command.
- The framed chat page is a genuine **out-of-process iframe**: the two
  origins are different *sites* (`frame-a.test` / `frame-b.test`, mapped to
  127.0.0.1 by `--host-resolver-rules`). Two ports on 127.0.0.1 are one
  site, and an early run in that shape passed everything — that run is
  discarded; it does not reproduce the failure's process model.
- The rig plays the user only at the panel: it provisions the install
  secret (what the native host does on a real install) and approves
  permission prompts. 8 prompts were approved in this run, all of the form
  "inside a frame from frame-b.test … Muse cannot see what it is".

## Results

| Case | Result | Evidence |
|---|---|---|
| framed-contenteditable (cross-origin iframe, click composer by coordinate → type → click Send) | **PASS** | framed message list (ground truth): `['alpha-composer-123']`; bridge read-back of the parent tab contains `MSG: alpha-composer-123` |
| framed-textarea (cross-origin iframe, click → type) | **PASS** | framed textarea value (ground truth): `'bravo-textarea-456'` (exact); read-back contains `NOTE: bravo-textarea-456` |
| parent-control (parent page's own textarea → Post) | **PASS** | control list (ground truth): `['charlie-control-789']`; present in bridge read-back |
| background-framed-composer (same framed flow, but the shared tab is **not** the front tab) | **FAIL** | every tool call returned `ok: true`, yet frame truth after typing was `composer: ''` — the text went nowhere; final framed list stayed `['alpha-composer-123']` and the background text `foxtrot-background-222` appears in neither the frame nor the read-back |

Probe (not gated): **no refs exist for framed elements** — `read_page` shows
both iframes as bare `Iframe` nodes with no subtree (drilling in with
`ref_id` returns the same bare node), and `find` returns no framed element.
Same-origin and cross-origin frames alike, in this Chromium.

## Reading of the baseline

With the tab in front, the old build's coordinate path into a cross-origin
frame already works in this Chromium — the browser routes the tab-level
press into the frame. What fails is the background tab: clicks and typing
report success while nothing lands, because focus emulation in v2.4.1 wraps
only individual calls (`withFocus`) and a background tab's framed field
never truly takes focus. That silent shape — every call ok, nothing typed —
is the same shape as the factory.8090.ai failure reports. Ref-driven work
inside any frame is impossible in this environment on this build: the
elements are not in the tree at all.
