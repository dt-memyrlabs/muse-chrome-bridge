# Tab groups — design

Status: staging only (this tree). Nothing here is deployed. This note sits
on top of `DESIGN.md` (attach-on-redeem); the pairing and attach flows it
describes do not change. What changes is what happens to a tab **after** a
chat gets it, and what a tab group **means**.

Daniel's spec (2026-10-17): replicate how Claude in Chrome feels on a tab —
complete control, no failure. Server auth is not possible, so the code flow
stays: Daniel opens the panel on a tab, clicks "Generate a code", gives the
code to the chat, the chat redeems it (`/pair` + attach-on-redeem). From
that moment the tab lives in a Chrome tab group for that chat, and the
group is the control set.

## The model

- Every chat session has a tab group named **`Muse · <chat name>`**
  (the session's stored `chatName`, verbatim). Groups are per window —
  Chrome groups never span windows — so a session has **at most one group
  per window**, and the worker reuses the session's existing group in a
  window whenever one exists (found by its stored mapping, verified live,
  or by title in that window).
- **Group membership is the control set.** A tab is controlled by a
  session if and only if it is in that session's tabs list, and the worker
  keeps the two views in agreement at all times:
  - a tab that enters a session (pair, attach, panel Add tab, a chat's
    own `tabs_create` / tabless `navigate`, the same-host popup rule) is
    moved into the session's group in its window;
  - a tab that leaves a session (panel Remove, pill ✕, transfer to
    another chat, disconnect, tab closed) is taken out of the group —
    except a transfer, where joining the new session's group is itself
    the removal from the old one (a tab has exactly one group);
  - a tab Daniel moves **into** a session's group is adopted by that
    session (below);
  - a tab Daniel moves **out of** the group — ungrouped, or moved into
    another group — is released by the session in the same moment.
- The pill does not change: a controlled tab shows exactly one pill,
  `● Muse · <chat name> ✕`, drawn and removed by the existing paths.

## Adoption by drag-in

Dragging a tab into a named group is a manual act by Daniel, in the same
class as the panel's Add tab — it is one of only two ways a tab ever
enters a session (the other is a consumed pairing code). Adoption runs
the same checks as the panel's `add_tab`:

- the page must be a web page (`shareableTab`); a non-web page dropped
  into a group is **refused and removed from the group again**, with an
  audit line, so the group never silently contains a tab the chat cannot
  use;
- `attachTab` does the move, so the one-tab-one-session transfer rules
  apply unchanged: a tab dragged out of chat A's group into chat B's
  group leaves A in the same tick (its work on the tab is cancelled, its
  tabless prompts settled if that was its last tab);
- the tab's site is granted to the adopting session (`sites[host] = true`),
  exactly as Add tab and a fresh pairing grant the first tab's site. A new
  site still never arrives by a chat's own action — only by Daniel's
  code, Daniel's Add tab, or Daniel's drag.

Renaming a group **to** a session's exact title is treated the same as
dragging its tabs in: the group becomes that session's group in that
window and its web tabs are adopted. Renaming a session's group **away**
from its title ends the match: its tabs are released, as if dragged out.
Group identity is the title, not the numeric id — ids change across
browser restarts, titles are what Daniel sees.

## Release by drag-out

Membership is watched through `chrome.tabs.onUpdated` (`groupId`
changes), `chrome.tabs.onAttached` (a tab landing in another window —
Chrome ungroups a tab moved between windows unless it lands in a group
there), `chrome.tabGroups.onUpdated` (renames) and
`chrome.tabGroups.onRemoved`. Every event re-evaluates the one tab (or
the one group) it names against live state; events that agree with the
current state are no-ops, which is what makes the worker's own group and
ungroup calls safe to listen to. Release goes through the existing
`releaseTab`: ownership mirror first (same tick), work cancelled,
tabless prompts settled, pill removed, debugger detached.

## Browser startup — the B040 change

The old rule (B040) cleared **all** tab ownership at browser startup,
because Chrome reassigns tab ids across a restart and stored ids cannot
be trusted. Sessions and their site grants persist; tabs had to be
re-added from the panel by hand.

**Decision (2026-10-17, Daniel's group spec): B040 is extended for group
tabs only.** At startup the worker still drops every stored tab id, then
re-adopts the tabs that are **still sitting in a session's named group**:

- groups are found by title (`Muse · <chat name>`); Chrome restores
  groups and their titles across a restart even though tab ids change,
  so the group is the durable handle the tab id never was;
- site checks re-run: a tab is re-adopted only if it is a web page **and**
  its current host is still in the session's permitted sites. A tab
  whose site was revoked while the browser was closed, or which now sits
  on a site the chat was never given, is **not** re-adopted — it is
  removed from the group and an audit line says why, so the group never
  claims a tab the chat does not hold;
- re-adoption goes through `attachTab` (ownership mirror, recorded host,
  pill) and does not grant any site.

A controlled tab that is **not** in the group at startup — the grouping
fallback below — is still dropped, exactly as B040 always did.

## Tabs a chat creates

`tabs_create` (and a tabless `navigate`) already route through
`newTabInGroup`; grouping inside `attachTab` now makes that name true:
the created tab is grouped into the creating session's group in the
window `chatWindow` picked (the window of the chat's last tab, else the
last focused normal window). One group per session per window is
preserved because grouping always targets that window's group.

## When grouping fails

Chrome refuses tab groups in some windows (app windows, for example) —
the reason the previous design avoided groups. The group model keeps the
tab usable there: grouping is attempted **after** ownership is settled,
inside a guard, and a failure only leaves the tab ungrouped (with an
audit line). The tab stays the chat's, with its pill; it behaves exactly
like a pre-group tab, with two honest limits: drag-in/drag-out do not
apply to it, and startup re-adoption will not restore it (above). Group
trouble must never fail a pairing — control first, cosmetics of the tab
strip second.

## What does not change

- Manual sharing only: no tab is adopted without Daniel's code, Daniel's
  Add tab, or Daniel moving it into the group (drag or rename). A chat
  command cannot create group membership for a tab it does not own; the
  only tabs a chat groups are tabs it already holds.
- Site Allow/Deny, risky-action approval, password and payment
  protections, per-chat isolation, rejection of unshared and cross-chat
  tabs: untouched. Group adoption grants a site only in the same three
  manual cases where a grant already happened (code, Add tab, drag-in).
- Stored shape: a session gains `groups: { "<windowId>": <groupId> }` —
  a cache, always re-verified against the live group's window and title
  before use. The title is the identity; the cache only saves a query.
- Group colour is chosen from the existing `COLORS` list by a stable
  hash of the chat name, set only when the worker creates the group;
  a group the worker reuses keeps the colour it has.

## Tests

New `tests/test_extension_groups.js` and
`tests/test_extension_groups_startup.js` (the harness supports one
install per process, so the startup cases live in their own file) on the
fake-chrome harness (extended with group window ids, title/window group
queries, `tabGroups.onUpdated`, `tabs.onAttached`, and Chrome's rule
that an emptied group disappears):

- pair moves the tab into a group titled `Muse · <chat name>`;
- attach-on-redeem moves the second tab into the **same** group;
- a second window gets its own group for the same session;
- drag-in adopts (tab becomes the session's, site granted, pill shown);
- drag-in from another chat's group transfers (one tab, one session);
- drag-out releases (ungroup, and move to another group);
- a non-web tab dragged in is refused and taken back out of the group;
- startup re-adopts group tabs and drops a group tab whose site is not
  permitted, and a controlled tab that is not in any group;
- `tabs_create` lands the new tab in the creating session's group;
- cross-chat isolation: chat B cannot act on a tab in chat A's group,
  and chat A's tabs are untouched by chat B's group events.

## Amendment — 2026-10-18 (Daniel, after the first live use)

1. **No tabs, no session.** A session whose last tab goes — closed,
   removed, dragged out of the group, or taken by another chat — is
   ended at once (relay told, token dead). The panel therefore never
   shows a "0 tabs" chat. At browser startup the order is: clear stored
   tab links, re-adopt tabs still in named groups, then end every
   session the restart left with no tabs. This supersedes the earlier
   "sessions persist across restarts and re-add tabs later" behaviour
   for tab-less sessions; a chat that needs a tab pairs again with a
   fresh code.
2. **The panel shows groups, not counts.** Each chat is listed under
   its group title ("Muse · <chat name>") with the tabs it owns listed
   under the group; a tab in another window is marked as such.
3. **Adoption is verified and never silent.** After a drag-in takeover
   the worker checks that it owns the tab; any failure is written to
   the audit log with its reason. Group changes also schedule delayed
   re-checks (a drag can report a passing group id before the tab
   settles), and the re-check is idempotent.

## v2.7.1 — grouping failures are never silent; refusing windows are escaped

Live failure (Daniel, 2026-10-28): on his desktop Chrome the share and
control worked but NO group ever appeared in the strip, and nothing
anywhere said grouping had failed. The code's only trace was one audit
line (error clipped, write swallowed on failure), the panel state
carried no group information at all, and the only retry driver was the
membership sync — which fires on group-shaped events a never-grouped
tab never produces. "The bridge keeps retrying" was not true.

What changed, copied from Claude in Chrome's group manager (REA
extraction: groupMetadata/memberStates tracking, groupTabInOwnWindow,
adoptOrphanedGroup, followRotatedGroupId, handleTabGroupChange):

- **Own tracking, reconciled.** The worker already tracked each chat's
  group per window (`session.groups`, re-verified by title before use);
  it now also reconciles on tab lifecycle events — activation, load
  complete, window focus (`retryGrouping`) — not only on group events.
  Group-id rotation is followed: whichever write lands first (the
  sync's `rememberGroup` overwrite or the group-removed handler's
  delete) leaves exactly one "group id changed" line in the record.
  A titled group the cache lost (orphan) is adopted back by the same
  reconciliation; no duplicate is created.
- **A refusing window is escaped, not retried.** Failures are
  classified. A transient refusal (tab mid-drag, Chrome mid-edit) is
  recorded and retried later; nothing moves. A refusing window — type
  not "normal", or Chrome's "Grouping is not supported by tabs in this
  window" — sends the tab to `groupTabViaOwnWindow`: it joins the
  chat's existing group in another window if one exists (no scatter),
  else it gets a window of its own (`chrome.windows.create({tabId})`,
  unfocused) and starts the group there. One move per tab per chat,
  guarded against the move's own events, and every move is written to
  the event record with the refusal that caused it.
- **Failure is durable and visible.** The session record keeps the
  last grouping failure (`groupError`: Chrome's real error text +
  window type); panel `state` computes per chat `grouped` /
  `groupMissing` live and carries `groupError`, `groupWindowType`,
  `groupStopped` (retry bound hit). The panel renders it in plain
  words under the chat — including the can't-form-here wording for
  non-normal windows. The error clears only when no tab of the chat
  still carries a retry mark. Retries stay bounded by the same mark
  (GROUP_RETRY_MAX = 8) shared by the sync and the lifecycle retries,
  and a groupless tab is still never released for being groupless.
