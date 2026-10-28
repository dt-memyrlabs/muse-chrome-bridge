<p align="center">
  <img src="icon-512.png" width="160" alt="Muse Chrome Bridge icon">
</p>

<h1 align="center">Muse Chrome Bridge</h1>

<p align="center"><strong>Share a browser tab with a Muse chat — by a one-time code, only when you say so.</strong></p>

You generate a one-time code in the extension's side panel and paste it
into a Muse chat. That chat can then work in the tab you shared: read
the page, click, type, and scroll — while you watch it happen. Nothing
is shared until you generate a code or drag a tab into a chat's group,
and closing the tab ends the connection.

## Install (Windows)

Download **[Install Muse Chrome Bridge.cmd](https://raw.githubusercontent.com/dt-memyrlabs/muse-chrome-bridge/main/Install%20Muse%20Chrome%20Bridge.cmd)** (also in this repo's root, and on the [v2.7.1 release](https://github.com/dt-memyrlabs/muse-chrome-bridge/releases/tag/v2.7.2) page) and double-click it. It brings its own Python — nothing to install first, no extension ID to type, no scripts to run. It sets everything up, starts the relay, and opens chrome://extensions plus the extension folder.

Your one step, which Chrome reserves for the user: in that tab, turn on **Developer mode** (top right), click **Load unpacked**, and pick the folder it opened. Then open the Muse Chrome Bridge panel and pair with a code from your chat.

The manual route (Python 3.10+ already installed) is under [Setup](#setup).

## What it does

- **Pair by code.** One code, one tab, one chat. Codes work once and
  expire in about 5 minutes.
- **A tab group per chat.** A shared tab moves into a Chrome tab group
  named `Muse · <chat name>`. Drag a tab into the group to share it
  with that chat — no second code. Drag it out, or close it, and the
  chat loses it.
- **You can see it work.** A controlled tab carries a pill:
  `● Muse · <chat name> ✕`. While a chat acts, its cursor travels to
  each target on the page, the page scrolls smoothly to what it is
  about to touch, and the side panel shows a live view of the work.
- **Your rules stand.** Site allow/deny lists, an approval prompt
  before risky actions, and extra protection around password and
  payment pages — the live view and screenshots stay hidden there.
- **Local only.** No account, no Memyr Labs server, nothing leaves
  your machine. The relay, the extension, and the chat client all run
  on your computer.

## How it works

Three pieces, all on your machine:

1. The **Chrome extension** holds the sharing rules and works the tab.
2. A small **Python relay** passes messages between the extension and
   the chat, and starts on demand through a native-messaging host.
3. The **chat-side client** (`agent/client.py`) is how a Muse chat
   pairs with your code and calls the tab tools.

This is an independent open-source project that works with Muse
chats. It is not a Meta or Anthropic product, and it is not affiliated
with or endorsed by Meta or Anthropic.

## Prerequisites

- Windows or macOS.
- Python 3.10 or newer, with `pip`. On Windows, the `py -3` launcher
  works wherever the commands below say `python`.
- Google Chrome 116 or newer.

## Setup (once)

Do these steps in order. The native-host installer in step 3 needs the
extension ID that Chrome shows in step 2.

1. Install the relay's Python dependencies. From the folder that
   contains this README, run:

   ```
   python -m pip install -r requirements.txt
   ```

   This installs the two packages the relay needs, `websockets` and
   `cryptography`, at the minimum versions listed in
   `requirements.txt`.

2. Load the extension in Chrome:

   - Open `chrome://extensions`.
   - Turn on Developer mode.
   - Click "Load unpacked" and choose this tree's `extension` folder.
   - Chrome now lists "Muse Chrome Bridge".

3. Install the native-messaging host. The extension starts the relay
   through a native host named `com.memyr.muse_bridge`, and Chrome
   only trusts that host once it is registered for your user account.
   From the folder that contains this README, run:

   ```
   python native/install_native_host.py
   ```

   No extension ID is needed: Chrome gives an unpacked extension an
   ID made from its folder path, and the installer works it out from
   this tree's `extension` folder. (If you ever load the extension
   from a different folder, pass `--extension-id <id>` with the ID
   shown on chrome://extensions.) The installer writes the real
   native-host manifest for your user — on Windows its `path` points
   at a small `relay_host.bat` launcher the installer generates next
   to `relay_host.py`, because Chrome starts the host by executing
   that path and cannot execute a `.py` file; elsewhere it points at
   `relay_host.py` itself — and its `allowed_origins` names only your
   extension ID. It writes into the per-user native-messaging
   location for your operating system (Windows and macOS are
   supported). The tree ships only a template,
   `native/com.memyr.muse_bridge.json.template`, whose `path` and
   extension ID are placeholders. Do not edit or use that template by
   hand; the installer generates the manifest your machine needs.

4. Open the side panel. Click the Muse Chrome Bridge extension icon
   in Chrome. The panel asks Chrome to start the relay through the
   native host; if the panel says the relay is offline, click
   "Start relay" in the panel. The dot turns green and the panel says
   "relay online" once the extension is connected.

   You can also start the relay by hand from the folder that contains
   this README:

   ```
   python relay/relay.py
   ```

   The relay listens for the extension on `ws://127.0.0.1:19822` and
   for chats on `http://127.0.0.1:20822`.

   **Network exposure, plainly:** by default the relay also listens
   on this machine's Tailscale address, on the same chat port (20822),
   when the machine has one, so another of your devices on your
   tailnet can reach the chat API at that address. Pairing is refused
   on the Tailscale listener; pairing only works from this machine.
   If the machine has no Tailscale address, the relay listens on
   loopback only. To force loopback only even when a Tailscale
   address exists, start the relay with `--bind off`:

   ```
   python relay/relay.py --bind off
   ```

## Use: pair a chat by code

1. In Chrome, go to the page you want to share.
2. Click the Muse Chrome Bridge extension icon to open the side
   panel, then click "Generate a code". The panel shows an
   8-character code. It works once and expires in about 5 minutes.
3. Paste the code into the Muse chat that should control this tab.
   That chat pairs from the folder that contains this README with:

   ```
   python agent/client.py pair <CODE> --chat "<chat name>"
   ```

   The code may be typed with or without the hyphen shown in the
   panel. On success the client saves this chat's token to
   `.muse-bridge-token` in the folder it was run from; later commands
   for that chat must run from the same folder (see
   `agent/SKILL.md` for the tools a paired chat can call).
4. The shared tab is now connected to that chat. Chrome may show a
   "being debugged" bar while the chat is acting in the tab. That is
   how its clicks and typing become real input.
5. To stop sharing: use "Stop sharing this tab" in the side panel for
   one tab, or "Disconnect" in the panel's "Your chats" list to end a
   chat.

## Folder

- `extension/`: the Chrome extension (Manifest V3). Load this folder
  as an unpacked extension.
- `relay/relay.py`: the relay. Extension side on port 19822, chat
  side on port 20822.
- `native/relay_host.py`: the native-messaging host that starts the
  relay when the extension asks Chrome to. Installed by
  `native/install_native_host.py` (see Setup step 3).
- `native/install_native_host.py`: the installer from Setup step 3.
  It fills `native/com.memyr.muse_bridge.json.template` (placeholders
  only, not a usable manifest) with your path and extension ID.
- `agent/`: `client.py`, the chat-side client, and `SKILL.md`, its
  instructions for a Muse chat.
- `requirements.txt`: the relay's Python dependencies.
