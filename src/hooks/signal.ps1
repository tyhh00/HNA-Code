# Claude Code hook -> Claude Windows signal bridge.
# Registered for SessionStart / Notification(idle_prompt,permission_prompt) / Stop.
# Claude runs this with the hook's JSON on stdin; -Kind tells us which event fired.
# The cell id + signal port + token arrive via env vars the app injected when it spawned claude.
param([string]$Kind = '')

$ErrorActionPreference = 'SilentlyContinue'

$port  = $env:CC_SIGNAL_PORT
$token = $env:CC_SIGNAL_TOKEN
if (-not $port -or -not $token) { exit 0 }   # not launched by Claude Windows; do nothing

$in = $null
try { $in = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { }

$body = @{
  kind       = $Kind
  event      = if ($in) { $in.hook_event_name } else { $null }
  session_id = if ($in) { $in.session_id } else { $null }
  source     = if ($in) { $in.source } else { $null }
  cwd        = if ($in) { $in.cwd } else { $null }
  cell       = $env:CC_CELL_ID
  token      = $token
} | ConvertTo-Json -Compress

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:$port/signal" -Method Post `
    -Body $body -ContentType 'application/json' -TimeoutSec 2 | Out-Null
} catch { }

exit 0   # never block or delay Claude's turn
