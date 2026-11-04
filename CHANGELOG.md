# Changelog — Muse Chrome Bridge

Release notes for every shipped version, newest first. The same text
ships on each GitHub release page.

## v2.10.5 — Antigravity's audit fixes (2026-11-04)

Four fixes from an audit Antigravity ran on the PC copy of v2.10.4,
working with Daniel. Each one was checked against the shipped tree
before it was ported in; nothing else changed.

- **`get_form_values` crashed on every call.** The tool passed
  `P.hostOf(tab.url)` inline to the page probe and then used a
  `host` variable that was never defined in the audit line, so every
  call threw `ReferenceError: host is not defined`. (This is the
  undefined-host defect 8090 flagged in its source review.) `host`
  is now bound at the top of the tool.
- **`upload_image` could never drop onto an element ref.** The drop
  path read `x`/`y` straight off the ref record, which never carries
  them, so every ref drop answered `no_target`. A ref now resolves
  the same way the pointer actions do: `framedPoint` for framed
  refs, `nodeForRef` + `smoothShowNode` / `pointForNode` for
  top-frame refs; bare coordinates still go through
  `smoothShowPoint` and are checked finite. The file-path route and
  its credential-store refusal are untouched and still fire first.
- **`client.py connect` failed with a confusing error.** `connect`
  and `/announce` were removed in the code-first pairing model, but
  the command still fell through to tool invocation and answered
  `not_paired` / `unknown_action`. It now answers
  `{"error": "use_pair"}` with the pair instructions and exits 2.
  `SKILL.md`'s Connecting section leads with `pair`, and two stale
  `connect` mentions later in the file (the token paragraph and the
  `waiting` error-table row) now match the pair flow too.
- **The relay flooded its error log when a client hung up early.**
  When a client closed its HTTP socket mid-answer, writing the
  response threw `ConnectionResetError` inside the `/cmd` handler,
  whose error path tried to write a second response on the dead
  socket — chained tracebacks by the thousand. `_json` now ignores
  `BrokenPipeError` / `ConnectionResetError` /
  `ConnectionAbortedError`, and the `/cmd` handler takes the
  command result first and writes the response outside the try.

Proven the same way as v2.10.4: all 19 extension JS suites and the
Python suites pass (relay 53/59 is the standing baseline — the same
6 VM-route failures), and the real-Chromium rig passes 16/16,
including the generation-confirmation, single-pill, framed-composer
and refresh cases. Dropping an image by ref is covered by the
tools2 suite; it is not exercised end-to-end in the rig.

## v2.10.4 — the chat box is findable (2026-11-03)

A chat told Daniel it could not find the chat box to type in. The
diagnosis run on the real-Chrome rig proved two causes; this build
fixes both, and nothing else.

- **A box named only by its prompt text now has a name.** Real chat
  editors (the Slate/Lexical/ProseMirror pattern) name their composer
  only through `data-placeholder` — the grey prompt text rendered
  inside the empty box. The page probe's name chain read a label,
  `aria-label`, a real `placeholder`, `name` and `title`, but never
  `data-placeholder`, so such a composer entered the tree with no
  name at all, and `find` by its visible prompt text returned
  nothing. `data-placeholder` now sits in the chain immediately
  after the real `placeholder`, and the name flows into the framed
  tree and `find` results.
- **Find hands back the field before its caption.** Ranking scored
  by text match alone, so a label's static text, a heading or the
  frame itself could tie with — and bury — the real text box (a
  labelled composer ranked #16 of 20 for "chat box"). Framed tree
  entries now carry their field/editable facts into find's flat
  list, and at an equal text score a textbox/field match sorts
  above non-field matches. Matching itself is unchanged: the same
  substring scoring, the same 20-result cap, the same result shape.

Proven on the real-Chrome rig with a new case: a framed composer
stripped of its label and aria-label, carrying only
`data-placeholder="Write your prompt"`, is the top match for
`find "write your prompt"` — the only match — and typing through
its ref lands in the frame, confirmed by the frame's own report.

## v2.10.3 — one pill only (2026-11-03)

Daniel's order: a shared tab showed TWO pill boxes. Now it shows one.

- **The second pill is gone.** The agent layer (agent-ui.js, the v2.8
  parity layer) drew a static pill at the bottom-left of a chat's
  tabs — "Muse is active in this tab group", with Open chat and
  Dismiss buttons, kept alive by a 5 s heartbeat. The pill, its
  buttons and the heartbeat are removed, and so is the worker-side
  machinery that drove them: the `static` state in every agent-ui
  command, the dismissal store, and the agent_heartbeat /
  agent_open_chat / agent_dismiss_static messages. A stray `static`
  field in a command is ignored on the page side, so the pill cannot
  come back.
- **What stays is the one real pill** — pill.js's
  "● Muse · <chat name> ✕" at the top of the tab, draggable, with
  its position remembered — and, while a command runs, the agent
  layer's pulsing glow border and "Stop Muse" button. The layer
  still hides for every capture. Nothing else changed: pairing, the
  generation confirmation, the Connection area and the panel are
  exactly as v2.10.2 shipped them.

## v2.10.2 — panel results that match the state they're in (2026-11-02)

Five panel fixes from the v2.10.1 review gate. Panel-side only: no
behavior changes outside the side panel, and the generation
confirmation, refresh revival, check steps, debug report contents and
helper lines are exactly as v2.10.1 shipped them.

- **Check results clear when the share state changes.** Results belong
  to the state they were run in: moving between unshared, waiting on a
  code, and shared — or the controlling chat changing — drops the old
  results, so a connected panel can no longer show an unshared run's
  red "this tab is not shared with any chat" under a "Shared with …"
  header.
- **Steps that never ran read as neutral.** A "not checked" step now
  renders muted with a – mark, distinct from a ✓ pass and a ✗ fail,
  instead of wearing the red failure glyph.
- **Exit verbs say their scope.** The chat-level button reads
  "Disconnect chat"; the × on a tab row carries the title "Stop
  sharing this tab". Words only — no behavior changed.
- **The code state counts down live.** "Expires in about 5 min" is now
  a ticking "Expires in 4:32", driven by the code's real expiry, in
  the same style as the confirmation card's countdown.
- **Connection buttons keep their labels on one line.** The button row
  wraps whole buttons instead of squeezing each label onto two lines,
  in both the shared and unshared states.

## v2.10.1 — the Connection area, placed right (2026-11-02)

Four panel fixes from the v2.10.0 review gate. Nothing else changed:
no behavior changes outside the side panel, and the generation
confirmation, refresh revival, check steps and debug report contents
are exactly as v2.10.0 shipped them.

- **Refresh connection moved into the Connection area**, alongside
  Check connection and Copy debug report. The This tab block now holds
  only "Stop sharing this tab".
- **The Connection area now shows in the unshared state too**, with
  Check connection and Copy debug report (no Refresh — nothing to
  refresh before pairing). Check connection runs unpaired: it reports
  whether the relay is reachable, and the session steps read as not
  applicable until the tab is shared. The debug report copies unpaired
  — the machine that cannot pair is the one that needs the report.
- **The "Connection" label** now uses the same small uppercase
  letter-spaced gray section-label style as THIS TAB and YOUR CHATS,
  with the same spacing.
- **A recovery line** under the Connection label states the sequence
  in plain words. Shared: "Connection broken? Run Check connection
  first. If it fails, use Refresh connection and paste the new code
  into the chat." Unshared: "Can't connect? Run Check connection, or
  copy a debug report and send it to the chat."

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
