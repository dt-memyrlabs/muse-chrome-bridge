# Changelog — Muse Chrome Bridge

Release notes for every shipped version, newest first. The same text
ships on each GitHub release page.

## v2.10.0 — the panel, stripped back; connections that revive (2026-11-02)

The side panel returns to the code-first minimum, and a shared tab gains
one small Connection area.

**Removed** (the v2.8.0 panel extras): the HELPERS section (Record
workflow, Pick an element, the "Allow javascript_tool" checkbox, Export
debug info) and the SAVED PROMPTS section (saved-prompt list, New prompt
form, schedule controls), together with the machinery behind them — the
workflow recorder and element picker files, the saved-prompt store, the
chrome.alarms schedule running, and the `shortcuts_list` /
`shortcuts_execute` tools. `javascript_tool` can no longer be enabled
anywhere: the toggle is gone and the tool is permanently disabled,
refusing every call with `javascript_disabled`. What stays is the whole
code-first panel: the current tab, Generate a code, the one confirmation
at generation (v2.9.0, unchanged), chats and their tabs, unshare /
disconnect, and the event record.

**Added**, on a shared tab, in one Connection area:

- **Refresh connection** — mints a fresh code for an already-shared tab
  through the same generation confirmation. Redemption revives the
  connection both ways it can break: a chat whose token is still live
  re-binds the tab to its session with no new token; a chat whose token
  is dead (`bad_token`) pairs into a fresh session for the tab, and the
  client replaces the dead token in its token file. A dead token is
  never presented for attach, and a live token file is never overwritten
  by a fresh pair (`token_file_in_use` still guards it).
- **Check connection** — a real end-to-end probe for the tab, step by
  step in plain words: relay reachable → session still valid at the
  relay (asked of the relay, which owns the token registry) → tab in
  the chat's tab group → a control round-trip through the session's own
  command path. Each step shows pass or fail with the actual error text.
- **Copy debug report** — plain text to paste into any chat: time,
  browser, extension version, relay address and reachability, the
  controlling chat's name, the tab's host and group state, the Check
  connection results, and the last 20 event-record entries. It never
  contains a token, the enroll secret, a pairing code, or page content;
  a suite test asserts each absence.

**Enter/submit diagnosis.** A new rig case — a cross-origin framed
contenteditable composer that submits ONLY on a real Enter keydown and
records every keydown it receives — was run against the current input
path. Typing delivered per-character keydowns (15 keydowns for 15
characters) and did not submit; the bridge's `computer` key Enter
delivered a real Enter keydown (the frame recorded lastKey
"Enter / Enter") and the message submitted; a Send-button click also
submitted. The failure seen live on factory.8090.ai on 2026-11-02 did
not reproduce on the rig, so no input-path change was made. Desktop-live
proof against factory.8090.ai is still outstanding.

**Verification.** JS: 19 suites, 507 checks, 506 passing — the one
failure ("the waiting command has the working layer up",
indicators suite) fails identically on the pristine v2.9.0 tree in this
environment and is not a regression from this release. The prompts (22)
and panel2 (12) suites were removed with the machinery they tested; a
new connection suite adds 25 checks. Python: attach 22/22, client_pair
13/13 (including new dead-token replacement checks), native_install
10/10, relay 53/59 (the 6 known VM-route failures — baseline). Real-
Chrome rig: 14/14 cases, including exactly one confirmation card per
code generation (three generations in the run: the initial share and
two refreshes), every card approved before its code existed, and none
at any redemption.

## v2.9.0 — confirmation at code generation (2026-10-30)

The full-control confirmation moved to the moment a code is generated:
click Generate a code → the panel asks once that the chat you hand the
code to gets full control of the tab → Allow issues the code, and
pairing then completes with no further tap. Deny or timeout issues no
code at all, and the refusal is written to the event record. Shares by
any other path keep the redemption-time card. Nothing else changed;
pairing stays local (code + token). Verified: 20 JS suites, 515 checks
all passing; Python at baseline; rig 7/7 plus exactly one card in the
whole run, approved before the code existed.

## v2.8.0 — full parity with Claude in Chrome (2026-10-28)

Everything remaining from the full-coverage gap read (FULL-GAP) was
built: background-tab screenshots; input primitives (hold_key,
mouse_move, split down/up, per-character typing); read_console_messages
and read_network_requests; resize_window, upload_image, update_plan and
the shortcuts tools; indicators (glow border, in-page Stop button,
static group pill, ⌛/🔔/✅ title prefixes); saved prompts with
chrome.alarms schedules; GIF recording; panel helpers (workflow
recording, element pick, voice input, debug export); orphan adoption.
Adaptations: a changed scheduled prompt re-asks the one confirmation;
the site-category blocklist mechanism ships with an EMPTY data list
(nothing invented); javascript_tool present but disabled by default;
pairing unchanged; no telemetry of any kind. Verified: 20 JS suites,
508 checks all passing; rig 7/7 with exactly one card. (The panel
extras and saved prompts added here were removed again in v2.10.0.)

## v2.7.2 — dialogs, clean screenshots, resilient sessions (2026-10-28)

JavaScript dialogs can no longer hang a navigation: "Leave site?"
dismisses and reports `navigation_blocked` unless `force: true`;
`alert` is accepted, `confirm`/`prompt` declined, each answer written
to the event record. Screenshots hide the bridge's own cursor and pill
during capture. A dropped CDP session reattaches and retries once, and
a successful command whose result could not be delivered is buffered
(cap 8, 120 s) and redelivered on reconnect. New dialogs suite 52/52;
rig 7/7.

## v2.7.1 — tab groups that actually form (2026-10-28)

Tab grouping now follows Claude in Chrome's model: the extension tracks
each chat's group itself and reconciles against live Chrome state; a
window that refuses grouping gets the tab moved to a window where the
group can form; group-id rotation is followed and foreign groups
adopted; retries happen on tab changes, not only at share time; and a
grouping failure shows in the panel and the event record with Chrome's
own error text instead of silence. Groups suite grew 25 → 41 checks;
rig 7/7.

## v2.7.0 — one confirmation, full control (2026-10-28)

The per-action approval prompts were replaced by the one-confirmation
model: sharing a tab shows ONE confirmation — this chat gets full
control of this tab — covering every action in that tab for the life of
the share. Sharing stays manual, chats stay isolated, the event record
stays (actions logged, never gated), and the credential walls stay
walls with no prompt. The relay's pair-acknowledgement timeout rose to
100 s. Rig 7/7 with exactly one card in the whole run.

## v2.6.0 — the frame copy (2026-10-28)

The bridge now drives pages the way Claude in Chrome does (v2.5.0 +
v2.6.0): one debugger session per tab, mouse and keyboard dispatched as
browser-process input at viewport coordinates so the browser hit-tests
into whichever frame is under the point — cross-origin included — and
focuses that frame's field; focus emulation on for input so background
tabs behave as focused; and an all-frames read tree whose refs carry
their frame identity. Proven on the real-Chrome rig at 7/7 in three
consecutive runs, foreground and background. Carries forward the
v2.4.1 install fixes.

## v2.4.1 (2026-10-28)

One-file Windows installer at the repo root (Install Muse Chrome
Bridge.cmd): brings its own Python, computes the extension ID from the
folder path (no extension ID to type), registers a native-host launcher
Chrome can actually run, and starts the relay. Fixes: the extension
package was missing its icons, so a fresh load failed; and the
native-host registration pointed Chrome at a Python file it cannot run,
so Start relay opened an editor instead of starting the relay.
