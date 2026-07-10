# Watchdog for the inline-claude MCP server.
#
# Runs independently of ctg/Claude Code — a Scheduled Task, not a child of any
# session, so it keeps working even if the whole ctg session (or its inline-claude
# MCP child) silently dies with no crash-log entry (see 2026-07-10 incident: process
# vanished for ~4h with zero trace, most likely killed as a side effect of a
# self-restart test orphaning the child MCP process).
#
# Checks whether the PID in bot.pid is still alive. If not, sends a Telegram alert
# directly via the Bot API (no MCP/session needed) to OWNER_ID, and writes a marker
# so it only alerts ONCE per outage (not every 5 minutes). Marker clears once the
# process is healthy again, so the next outage alerts fresh.

$dataDir = $PSScriptRoot
$pidFile = Join-Path $dataDir 'bot.pid'
$envFile = Join-Path $dataDir '.env'
$markerFile = Join-Path $dataDir 'watchdog_alerted.flag'
$logFile = Join-Path $dataDir 'watchdog.log'

function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

# Load .env (TOKEN + OWNER_ID) without any Node/npm dependency.
$envVars = @{}
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $envVars[$matches[1]] = $matches[2].Trim() }
    }
}
$token = $envVars['INLINE_BOT_TOKEN']
$ownerId = $envVars['OWNER_ID']

if (-not $token -or -not $ownerId) {
    Log "ERROR: INLINE_BOT_TOKEN or OWNER_ID missing from .env — cannot alert, exiting"
    exit 1
}

function Send-Alert($text) {
    try {
        $uri = "https://api.telegram.org/bot$token/sendMessage"
        Invoke-RestMethod -Uri $uri -Method Post -Body @{ chat_id = $ownerId; text = $text } -ErrorAction Stop | Out-Null
        Log "alert sent: $text"
    } catch {
        Log "ERROR sending alert: $_"
    }
}

$pidAlive = $false
if (Test-Path $pidFile) {
    $savedPid = Get-Content $pidFile -Raw | ForEach-Object { $_.Trim() }
    if ($savedPid -match '^\d+$') {
        $proc = Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue
        if ($proc) { $pidAlive = $true }
    }
}

if ($pidAlive) {
    Log "OK pid alive"
    if (Test-Path $markerFile) {
        Remove-Item $markerFile -Force
        Send-Alert "✅ inline-claude MCP снова работает (watchdog)."
        Log "recovery alert sent, marker cleared"
    }
} else {
    Log "DOWN pid not alive (pidFile content: $(if (Test-Path $pidFile) { Get-Content $pidFile -Raw } else { '<missing>' }))"
    if (-not (Test-Path $markerFile)) {
        Send-Alert "⚠️ inline-claude MCP не отвечает (процесс не найден). Бизнес/inline/групповые тригеры сейчас НЕ доходят до сессии. Нужен рестарт ctg."
        New-Item -Path $markerFile -ItemType File -Force | Out-Null
        Log "down alert sent, marker set"
    } else {
        Log "already alerted, skipping (marker present)"
    }
}
