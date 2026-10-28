#!/usr/bin/env python3
"""Native-host installer tests.

Two failures shipped in the fresh-install path and only a second PC
found them:
- v2.4.0's installer registered relay_host.py itself as the Windows
  native host. Chrome executes the manifest path; it cannot execute a
  .py, so "Start relay" opened the file in the .py app (VS Code) and
  the relay never started (2026-10-28).
- The installer demanded an extension ID the user had to read off
  chrome://extensions and copy back, when an unpacked extension's ID
  is a hash of its folder path and can be computed in advance.

  python test_native_install.py     exit 0 = all passed
"""
import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
NATIVE = os.path.join(HERE, "..", "native")
spec = importlib.util.spec_from_file_location(
    "install_native_host", os.path.join(NATIVE, "install_native_host.py"))
inst = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inst)

failures = 0
passes = 0


def check(name, cond, detail=None):
    global failures, passes
    if cond:
        passes += 1
        print("PASS " + name)
    else:
        failures += 1
        print("FAIL " + name + ("" if detail is None else
                                "  -- " + repr(detail)[:300]))


# --- compute_extension_id against IDs real Chrome assigned -----------
check("linux vector 1 (staging tree)",
      inst.compute_extension_id(
          "/home/hatch/workspace/muse-browser-bridge/"
          "attach-on-redeem/extension", "linux")
      == "kakpicabljpbdbhjokkldmlkdbgcehoj")
check("linux vector 2 (zipcheck tree)",
      inst.compute_extension_id("/tmp/zipcheck/extension", "linux")
      == "gemhdddebedhekfkjhhnolcinnmmdjpg")
check("windows vector (Daniel's PC path, UTF-16LE)",
      inst.compute_extension_id(
          r"C:\Users\danie\.muse-bridge\v2\extension", "windows")
      == "hkohggodeeeckipelifcbkbhccdgbhco")

# --- windows launcher --------------------------------------------------
with tempfile.TemporaryDirectory() as td:
    bat = os.path.join(td, "relay_host.bat")
    old = inst.RELAY_HOST_BAT
    inst.RELAY_HOST_BAT = bat
    try:
        inst.write_windows_launcher()
    finally:
        inst.RELAY_HOST_BAT = old
    body = open(bat, "rb").read().decode("utf-8")
    check("launcher exists and runs relay_host.py with the same python",
          "relay_host.py" in body and sys.executable in body
          and "%*" in body, body)
    check("launcher uses CRLF line endings",
          "\r\n" in open(bat, "rb").read().decode("utf-8"))

# --- full installer runs into a scratch output dir ---------------------
def run_install(extra):
    td = tempfile.mkdtemp()
    rc = inst.main(extra + ["--output-dir", td])
    manifest = json.load(open(os.path.join(
        td, "com.memyr.muse_bridge.json"), encoding="utf-8"))
    return rc, manifest


rc, m = run_install(["--platform", "windows"])
check("windows install: manifest path is the .bat launcher, not the .py",
      m["path"].endswith("relay_host.bat"), m["path"])
check("windows install: origin uses the auto-computed ID",
      m["allowed_origins"] == [
          "chrome-extension://"
          + inst.compute_extension_id(inst.EXTENSION_DIR, "windows")
          + "/"], m["allowed_origins"])

rc, m = run_install(["--platform", "linux"])
check("linux install: manifest path is relay_host.py",
      m["path"].endswith("relay_host.py"), m["path"])
check("linux install: origin uses the auto-computed ID",
      m["allowed_origins"] == [
          "chrome-extension://"
          + inst.compute_extension_id(inst.EXTENSION_DIR, "linux")
          + "/"], m["allowed_origins"])

rc, m = run_install(["--platform", "windows",
                     "--extension-id", "a" * 32])
check("explicit ID wins over the computed one",
      m["allowed_origins"] == ["chrome-extension://" + "a" * 32 + "/"],
      m["allowed_origins"])

print(f"\n{passes} passed, {failures} failed")
sys.exit(1 if failures else 0)
