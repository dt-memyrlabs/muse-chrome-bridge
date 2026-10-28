#!/usr/bin/env python3
"""Install the Muse Browser Bridge native messaging host for this user.

The tree ships only a template (com.memyr.muse_bridge.json.template);
the real manifest is personal — it contains this user's absolute path
to the host launcher and their own extension's ID — so it is generated
here, at install time, and never committed.

Usage:
  python3 install_native_host.py                  # ID worked out for you
  python3 install_native_host.py <extension-id>   # or give it explicitly
  python3 install_native_host.py --extension-id <extension-id>

With no ID, the installer computes the one Chrome assigns to the
unpacked extension in this tree's extension/ folder: an unpacked
extension's ID is a hash of its folder path, so it is knowable in
advance and there is nothing to look up or copy. An explicit ID (the
one shown on chrome://extensions, 32 letters; a full
chrome-extension://<id>/ origin is also accepted) always wins — use
it if the extension folder lives somewhere else. Options:
  --home DIR        home directory to install under
                    (default: $HOME, or the OS home directory)
  --output-dir DIR  write the manifest directly into DIR instead of
                    the platform location (for tests / manual setups)
  --platform NAME   windows | macos | linux (default: auto-detect;
                    for preparing a manifest for another OS)

Where the manifest is written (per-user, Chrome):
  Windows  <home>\\AppData\\Local\\Google\\Chrome\\User Data\\
             NativeMessagingHosts\\com.memyr.muse_bridge.json
           Chrome on Windows actually finds the host through the
           registry key HKCU\\Software\\Google\\Chrome\\
           NativeMessagingHosts\\com.memyr.muse_bridge, whose value
           is this file's path; on a real Windows run this script
           sets that key too.
  macOS    <home>/Library/Application Support/Google/Chrome/
             NativeMessagingHosts/com.memyr.muse_bridge.json
  Linux    <home>/.config/google-chrome/NativeMessagingHosts/
             com.memyr.muse_bridge.json
"""
import argparse
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
HOST_NAME = "com.memyr.muse_bridge"
TEMPLATE = os.path.join(HERE, HOST_NAME + ".json.template")
RELAY_HOST = os.path.join(HERE, "relay_host.py")
# On Windows Chrome starts the host by executing the manifest's "path"
# directly — it cannot run a .py file. Pointed at relay_host.py, a fresh
# install made every "Start relay" click open the file in whatever app
# .py is associated with (VS Code on Daniel's second PC, 2026-10-28)
# and the relay never started. The installer therefore generates this
# small launcher next to relay_host.py and registers IT on Windows.
# Daniel's first PC only worked because a hand-made launcher already
# existed there; the shipped installer never created one.
RELAY_HOST_BAT = os.path.join(HERE, "relay_host.bat")
EXTENSION_DIR = os.path.normpath(os.path.join(HERE, "..", "extension"))

# Per-user NativeMessagingHosts directory, relative to the home dir.
TARGETS = {
    "windows": os.path.join(
        "AppData", "Local", "Google", "Chrome", "User Data",
        "NativeMessagingHosts"),
    "macos": os.path.join(
        "Library", "Application Support", "Google", "Chrome",
        "NativeMessagingHosts"),
    "linux": os.path.join(
        ".config", "google-chrome", "NativeMessagingHosts"),
}


def detect_platform():
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    return "linux"


def clean_extension_id(raw):
    ext_id = raw.strip()
    # Accept a pasted origin as well as a bare ID.
    if ext_id.startswith("chrome-extension://"):
        ext_id = ext_id[len("chrome-extension://"):]
    ext_id = ext_id.strip("/")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", ext_id or ""):
        raise SystemExit(
            "error: extension ID must be the ID shown on "
            "chrome://extensions (letters and digits, no spaces)")
    return ext_id


def compute_extension_id(path, platform):
    """The ID Chrome assigns an unpacked extension: SHA-256 of the
    extension folder's absolute path (UTF-16LE on Windows, UTF-8
    elsewhere), first 32 hex digits, each digit mapped 0-9a-f -> a-p.
    Verified against real Chrome IDs for two paths on 2026-10-28."""
    raw = path.encode("utf-16-le") if platform == "windows" \
        else path.encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def write_windows_launcher():
    """Generate relay_host.bat, pinned to the Python running this
    installer (no PATH or py-launcher dependence), and return its path."""
    lines = [
        "@echo off",
        f'"{sys.executable}" "%~dp0relay_host.py" %*',
        "",
    ]
    with open(RELAY_HOST_BAT, "w", encoding="utf-8", newline="\r\n") as f:
        f.write("\n".join(lines))
    return RELAY_HOST_BAT


def build_manifest(ext_id, host_path=RELAY_HOST):
    """Fill the shipped template; fall back to the same fields in code."""
    if os.path.exists(TEMPLATE):
        with open(TEMPLATE, encoding="utf-8") as f:
            text = f.read()
        text = text.replace("__EXTENSION_ID__", ext_id)
        # JSON-escape the path the way json.dumps would inside a string.
        escaped = json.dumps(host_path)[1:-1]
        text = text.replace("__RELAY_HOST_PATH__", escaped)
        return json.loads(text)
    return {
        "name": HOST_NAME,
        "description": "Starts the Muse Browser Bridge relay",
        "path": host_path,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{ext_id}/"],
    }


def register_windows(manifest_path):
    """Point Chrome's per-user registry key at the manifest (Windows)."""
    try:
        import winreg
    except ImportError:
        return
    key_path = r"Software\Google\Chrome\NativeMessagingHosts" + "\\" + HOST_NAME
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, manifest_path)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Generate and install the native messaging host "
                    "manifest for the current user.")
    ap.add_argument("extension_id", nargs="?",
                    help="this user's extension ID (chrome://extensions)")
    ap.add_argument("--extension-id", dest="extension_id_opt",
                    help="same as the positional argument")
    ap.add_argument("--home", default=None,
                    help="home directory to install under "
                         "(default: $HOME or the OS home directory)")
    ap.add_argument("--output-dir", default=None,
                    help="write the manifest into this directory instead "
                         "of the platform location")
    ap.add_argument("--platform", default=None,
                    choices=["windows", "win32", "macos", "darwin",
                             "linux"],
                    help="target OS (default: auto-detect)")
    args = ap.parse_args(argv)

    platform = args.platform or detect_platform()
    platform = {"win32": "windows", "darwin": "macos"}.get(
        platform, platform)

    raw_id = args.extension_id_opt or args.extension_id
    if raw_id:
        ext_id = clean_extension_id(raw_id)
    else:
        ext_id = compute_extension_id(EXTENSION_DIR, platform)
        print(f"extension ID for {EXTENSION_DIR}: {ext_id} "
              f"(computed from the folder path; pass --extension-id "
              f"if the extension lives elsewhere)")

    home = args.home or os.environ.get("HOME") or os.path.expanduser("~")
    if args.output_dir:
        out_dir = args.output_dir
    else:
        out_dir = os.path.join(home, TARGETS[platform])
    os.makedirs(out_dir, exist_ok=True)
    manifest_path = os.path.join(out_dir, HOST_NAME + ".json")

    if platform == "windows":
        # Chrome executes the manifest path itself: register the
        # launcher, never the .py file. Written for real on a Windows
        # run; when preparing a manifest elsewhere (--platform /
        # --output-dir) point at the launcher name the Windows run
        # will generate.
        host_path = write_windows_launcher() if sys.platform == "win32" \
            else RELAY_HOST_BAT
        manifest = build_manifest(ext_id, host_path=host_path)
    else:
        manifest = build_manifest(ext_id)
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    if platform != "windows":
        # Chrome runs the host directly on POSIX: it must be executable.
        try:
            os.chmod(RELAY_HOST, 0o755)
        except OSError:
            pass
    elif sys.platform == "win32" and not args.output_dir:
        register_windows(manifest_path)

    print(manifest_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
