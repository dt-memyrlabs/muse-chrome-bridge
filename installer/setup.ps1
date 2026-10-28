# Muse Chrome Bridge - one-shot setup. Runs from the extracted payload.
# Everything lands under %USERPROFILE%\.muse-bridge:
#   v2\       the bridge tree (extension, relay, native host, agent)
#   runtime\  a private Python the bridge uses; no system Python needed
# Then it registers the native host for the current user (the extension
# ID is computed from the extension folder path - nothing to type),
# starts the relay, and opens chrome://extensions plus the extension
# folder for the one step Chrome reserves for the user: Load unpacked.
$ErrorActionPreference = "Continue"
$payload = Split-Path -Parent $MyInvocation.MyCommand.Path
$base = Join-Path $env:USERPROFILE ".muse-bridge"
$dest = Join-Path $base "v2"
$runtime = Join-Path $base "runtime"
$log = Join-Path $base "install.log"
New-Item -ItemType Directory -Force $base | Out-Null

function Say($text) {
    Write-Host $text
    Add-Content -Path $log -Value $text
}
Say "=== Muse Chrome Bridge setup $(Get-Date -Format o) ==="

try {
    # Keep any previous install whole, next to the new one.
    if (Test-Path $dest) {
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $old = Join-Path $base "v2-backup-$stamp"
        Rename-Item $dest $old
        Say "Previous install kept as $old"
    }
    if (Test-Path $runtime) { Remove-Item $runtime -Recurse -Force }

    New-Item -ItemType Directory -Force $dest | Out-Null
    Copy-Item (Join-Path $payload "app\*") $dest -Recurse -Force
    Copy-Item (Join-Path $payload "runtime") $runtime -Recurse -Force
    Say "Files installed to $dest"

    $py = Join-Path $runtime "python.exe"

    # Register the native host: writes relay_host.bat (pinned to the
    # bundled Python), the host manifest (extension ID computed from
    # the folder path), and Chrome's per-user registry key.
    $reg = & $py (Join-Path $dest "native\install_native_host.py") 2>&1
    $reg | ForEach-Object { Say $_ }
    if ($LASTEXITCODE -ne 0) { throw "native host registration failed" }

    # Stop a relay left running by a previous install before starting:
    # start_relay() treats already-open ports as success and would leave
    # the old relay code serving under the new install. Matches the
    # relay process by its command line, as the deploy tooling does.
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'relay\.py' } |
        ForEach-Object { Say "Stopping previous relay (pid $($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Seconds 1

    # Start the relay through the same code path the extension uses.
    $code = "import sys, json; sys.path.insert(0, r'$($dest)\native'); import relay_host; print(json.dumps(relay_host.start_relay()))"
    $answer = & $py -c $code 2>&1
    Say "Relay start: $answer"
    if ($answer -notmatch '"ok": true') { throw "the relay did not start; see relay\relay_err.txt under $dest" }

    $extDir = Join-Path $dest "extension"
    Set-Clipboard -Value $extDir
    Start-Process explorer.exe $extDir
    $chrome = @(
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($chrome) { Start-Process $chrome "chrome://extensions" }
    else { Start-Process "chrome://extensions" }

    Say ""
    Say "DONE. The relay is running."
    Say "Last step, and it is Chrome's rule, not ours: in the"
    Say "chrome://extensions tab, turn on Developer mode (top right),"
    Say "click Load unpacked, and pick the folder that just opened in"
    Say "Explorer (its path is on your clipboard). Then open the Muse"
    Say "Chrome Bridge panel and pair with a code from your chat."
    exit 0
} catch {
    Say ""
    Say "SETUP FAILED: $($_.Exception.Message)"
    Say "Send this log to Memyr: $log"
    exit 1
}
