#!/usr/bin/env python3
"""Build the one-file Windows installer for Muse Chrome Bridge.

Output: "Install Muse Chrome Bridge.cmd" — a double-clickable file
that carries the whole payload as base64 after a :::PAYLOAD::: marker:
the bridge tree (from ../attach-on-redeem), a private embeddable
Python 3.12 with the two dependencies installed as site-packages, and
setup.ps1. On the Windows machine the file decodes itself with
PowerShell (built into Windows), extracts to %TEMP%, and runs
setup.ps1. The user never installs Python, never types an extension
ID, and never runs a script by hand; the only step left to them is
Chrome's own: Load unpacked on chrome://extensions.

Inputs cached under build/ (downloaded once):
  python-3.12.7-embed-amd64.zip   from python.org
  winwheels/*.whl                 pip download --platform win_amd64

  python3 build_installer.py
"""
import base64
import io
import os
import pathlib
import shutil
import sys
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
SRC = ROOT / "attach-on-redeem"
BUILD = HERE / "build"
PAYLOAD = BUILD / "payload"
OUT = ROOT / "Install Muse Chrome Bridge.cmd"
PYZIP = BUILD / "python-3.12.7-embed-amd64.zip"
WHEELS = BUILD / "winwheels"

APP_SKIP_DIRS = {"tests", "__pycache__", "logs"}
APP_SKIP_SUFFIXES = (".pyc",)


def build_payload():
    if PAYLOAD.exists():
        shutil.rmtree(PAYLOAD)
    app = PAYLOAD / "app"
    # --- the bridge tree -------------------------------------------------
    shutil.copytree(
        SRC, app,
        ignore=shutil.ignore_patterns(*APP_SKIP_DIRS, "*.pyc"))
    # --- private Python runtime ------------------------------------------
    runtime = PAYLOAD / "runtime"
    runtime.mkdir(parents=True)
    with zipfile.ZipFile(PYZIP) as z:
        z.extractall(runtime)
    sitepkgs = runtime / "Lib" / "site-packages"
    sitepkgs.mkdir(parents=True)
    for whl in sorted(WHEELS.glob("*.whl")):
        with zipfile.ZipFile(whl) as z:
            z.extractall(sitepkgs)
    # The embeddable build ignores site-packages unless the ._pth names
    # it and site processing is on.
    pth = runtime / "python312._pth"
    lines = pth.read_text(encoding="utf-8").splitlines()
    out = []
    for line in lines:
        if line.strip() == "#import site":
            out.append("import site")
        else:
            out.append(line)
    if "Lib\\site-packages" not in out:
        out.append("Lib\\site-packages")
    pth.write_text("\n".join(out) + "\n", encoding="utf-8")
    # --- setup ------------------------------------------------------------
    shutil.copy2(HERE / "setup.ps1", PAYLOAD / "setup.ps1")
    return PAYLOAD


def main():
    if not PYZIP.exists():
        sys.exit(f"missing {PYZIP} — download the embeddable Python zip")
    if not list(WHEELS.glob("*.whl")):
        sys.exit(f"no wheels in {WHEELS} — pip download the win_amd64 wheels")
    payload = build_payload()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path in sorted(payload.rglob("*")):
            if path.is_file():
                z.write(path, path.relative_to(payload).as_posix())
    zip_bytes = buf.getvalue()
    b64 = base64.b64encode(zip_bytes).decode()
    wrapped = "\r\n".join(b64[i:i + 76] for i in range(0, len(b64), 76))

    header = """@echo off
setlocal
title Muse Chrome Bridge Setup
echo Installing Muse Chrome Bridge. This window shows the result.
set "SELF_PATH=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$raw = [IO.File]::ReadAllText($env:SELF_PATH);" ^
  "$m = [regex]::Match($raw, ':::PAYLOAD:::\\r?\\n');" ^
  "$b64 = $raw.Substring($m.Index + $m.Length) -replace '\\s', '';" ^
  "$zip = Join-Path $env:TEMP 'muse-bridge-payload.zip';" ^
  "[IO.File]::WriteAllBytes($zip, [Convert]::FromBase64String($b64));" ^
  "$dir = Join-Path $env:TEMP 'muse-bridge-setup';" ^
  "if (Test-Path $dir) { Remove-Item $dir -Recurse -Force };" ^
  "Expand-Archive -Path $zip -DestinationPath $dir -Force;" ^
  "& (Join-Path $dir 'setup.ps1')"
echo.
if %ERRORLEVEL% EQU 0 (echo Setup finished. You can close this window.) else (echo Setup hit a problem - see %%USERPROFILE%%\\.muse-bridge\\install.log)
pause
:::PAYLOAD:::
"""
    header = header.replace("\n", "\r\n")  # batch files want CRLF
    OUT.write_bytes(header.encode("utf-8") + wrapped.encode("ascii")
                    + b"\r\n")
    print(f"{OUT.name}: {OUT.stat().st_size/1e6:.1f} MB "
          f"(payload zip {len(zip_bytes)/1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
