# Results — v2.6.0 (staging tree): the all-frames read, proven end to end

Run: 2026-10-28, `run_e2e.py` (default extension path =
`attach-on-redeem/extension`, manifest 2.6.0). **Exit code 0 — all seven
cases pass.** Full transcript: [v260-ref-run.log](v260-ref-run.log).
A second run with `--bg-experiment` also passed all seven
([v260-bg-experiment-run.log](v260-bg-experiment-run.log)).
Earlier state for comparison: [BASELINE.md](BASELINE.md) (v2.4.1) and the
v2.5.0 section at the bottom of this file.

## Per-case results

| Case | Result | Read-back / evidence |
|---|---|---|
| framed-contenteditable (cross-origin OOPIF, coordinate click → type → Send) | **PASS** | framed message list (ground truth): `['alpha-composer-123']`; bridge read-back contains it |
| framed-textarea (cross-origin OOPIF, coordinate click → type) | **PASS** | framed textarea value: `'bravo-textarea-456'` (exact); bridge read-back contains `NOTE: bravo-textarea-456` |
| parent-control (parent page textarea → Post) | **PASS** | control list: `['charlie-control-789']`; present in bridge read-back |
| ref-cross-composer (find the cross-origin framed composer by label → click its ref → type → click the Send ref) | **PASS** | refs carried their frame (`frame: http://frame-b.test:8972/chat.html`); framed list gained `golf-refcross-333`; present in bridge read-back |
| ref-framed-textarea (form_input by ref on the cross-origin framed textarea) | **PASS** | framed textarea value set to exactly `'echo-forminput-111'` |
| ref-sameorigin-composer (same ref flow inside the same-origin frame) | **PASS** | framed list gained `delta-sameorigin-000` |
| background-framed-composer (shared tab not in front; coordinate framed flow) | **PASS** | composer held `foxtrot-background-222` after typing; framed list gained it; present in bridge read-back |

The v2.5.0 probe verdict — *no refs for framed elements* — is reversed:
`read_page`/`find` now expose the framed elements with refs that know
their frame, and acting on those refs (click, type-after-click,
form_input) works in real Chromium, cross-origin and same-origin.

## Defects the rig found in the read copy, and their fixes

The first v2.6.0 rig run failed all three ref cases while the harness
suites were green. Three real defects, all in the read path:

1. **`<label>` elements were emitted as tree entries of their own**
   (they match the probe's actionable selector). A label duplicates its
   control's name, and `find` returned the label's ref first — a press on
   it focuses nothing, so typing went nowhere and Send posted an empty
   message. Fix: `buildFrameTree` in `extension/policy.js` gives LABEL
   no entry; its text still names the control through `describe()`,
   exactly as the AX tree treats labels.
2. **Multiplied field names.** `labelText()` collects the same label
   from up to three scans (native `el.labels`, a document scan, a tree
   walk) and joined every copy: the composer was named
   `"Message composer Message composer"`, the textarea `"Note Note
   Note"`. Harmless for the classifier's substring tests; wrong as a
   name. Fix: identical parts are kept once before the join.
3. **Contenteditable elements had no role** in the framed tree (the AX
   path calls them `textbox`). Fix: a contenteditable with no other role
   is a `textbox` in `buildFrameTree`.

## The background case, and the one bounded experiment

On v2.5.0 this case failed with every tool call returning ok and nothing
landing. On v2.6.0 it passes, in two consecutive full runs plus the
experiment run. One rig defect contributed to the earlier picture: the
case aimed with the iframe geometry measured once at setup, and after
the ref cases scrolled the page its clicks landed in the wrong frame
entirely (observed directly in the first v2.6.0 run). The rig now
re-measures the frame rect immediately before the background case. With
correct aim, the tab-session focus emulation the bridge already holds
(v2.5.0) is sufficient in this Chromium — typing lands in the background
tab's cross-origin composer.

The bounded experiment was still run (`--bg-experiment`): the harness
enabled `Emulation.setFocusEmulationEnabled` on the child frame's own
CDP target (flatten attach). The case passed, as it did without it, so
the experiment is not what flips the case — and the adoption route is
closed on separate evidence: from an extension page,
`chrome.debugger.getTargets()` lists the OOPIF as type `"other"` with
**no `tabId`** (two entries share the frame's URL, one being the
harness's own attach), so the extension cannot reliably correlate a
child target to its tab. No deviation from Claude's no-attach model was
adopted. If the background case ever fails again on desktop Chrome, this
question reopens with that constraint already established.

## What this does and does not prove

Proven in this environment (headless Chromium, site-isolated OOPIF):
discovery of framed elements through the bridge's own read, ref-driven
clicking/typing/form_input inside cross-origin and same-origin frames,
and the background-tab framed flow — no human click anywhere.

Still unproven: the same flows on Daniel's desktop Chrome (the original
failure surface, factory.8090.ai), and frames nested deeper than one
level (the builder aggregates every frame webNavigation reports and the
offset walk handles chains, but the rig's pages nest one level only).

---

# Results — fixed build (v2.5.0, staging tree) against the frame rig

Run: 2026-10-28, `run_e2e.py` (default extension path =
`attach-on-redeem/extension`, manifest 2.5.0). Exit code 1.
Full transcript: [fixed-run.log](fixed-run.log).
Baseline for comparison: [BASELINE.md](BASELINE.md) (same rig, v2.4.1).

## Per-case results

| Case | Result | Read-back / evidence |
|---|---|---|
| framed-contenteditable (cross-origin OOPIF, coordinate click → type → Send) | **PASS** | framed message list (ground truth): `['alpha-composer-123']`; bridge read-back of the parent tab contains `MSG: alpha-composer-123` |
| framed-textarea (cross-origin OOPIF, coordinate click → type) | **PASS** | framed textarea value (ground truth): `'bravo-textarea-456'` (exact match); bridge read-back contains `NOTE: bravo-textarea-456` |
| parent-control (parent page textarea → Post) | **PASS** | control list (ground truth): `['charlie-control-789']`; present in bridge read-back |
| background-framed-composer (shared tab **not** in front; same framed flow) | **FAIL** | every tool call returned `ok: true`; frame truth after typing: `composer: ''`; final framed list stayed `['alpha-composer-123']`; `foxtrot-background-222` reached neither the framed list nor the bridge read-back |

Probe (not gated): **no refs for framed elements**, same as the baseline —
`read_page` exposes both iframes as bare `Iframe` nodes (subtree empty even
when drilled into via `ref_id`), and `find` matches no framed element.

## What this does and does not prove

Proven in this environment: with the tab in front, v2.5.0 clicks into a
cross-origin out-of-process iframe, types into its contenteditable composer
and its textarea, clicks its Send button, and the framed message list can be
read back through the bridge — no human click anywhere. That is the
foreground half of the acceptance shape, and it passes.

Not flipped: the background-tab case fails on v2.5.0 exactly as on v2.4.1.
The session-wide focus emulation is present in the code (enabled at attach,
`sw.js:1256`; ended at detach, `sw.js:1192`) — but in this headless
Chromium it does not make typing land in a background tab's cross-origin
frame. The cause is **not established** by this rig: the two live
candidates are (a) focus emulation set on the tab session does not reach
the child frame's own CDP session/target, and (b) headless hidden-page
behavior differs from desktop Chrome. Either way, on the evidence here the
fix does **not** yet cover the case where the shared tab sits behind
another tab — which is a real working shape for this product (bridge work
is supposed to run while Daniel works in other windows).

Also bounded: ref-driven interaction inside frames cannot be exercised in
this environment at all, because the tab target's accessibility tree
contains no framed descendants on either build. The fake-chrome harness
suites synthesize that path; real-Chromium proof of it is still owed, most
directly on Daniel's desktop Chrome (foreground tab, factory.8090.ai),
which is also where the original failure was observed.
