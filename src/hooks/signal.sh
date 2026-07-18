#!/usr/bin/env bash
# Claude Code hook -> HNA-Code signal bridge (macOS/Linux twin of signal.ps1).
# Arg $1 = kind (start|prompt|idle|permission|stop). Claude passes the hook JSON on stdin.
# Cell id + signal port + token arrive via env vars the app injected when it spawned claude.
KIND="$1"
[ -z "$CC_SIGNAL_PORT" ] && exit 0
[ -z "$CC_SIGNAL_TOKEN" ] && exit 0   # not launched by HNA-Code; do nothing

IN="$(cat 2>/dev/null)"

# Pull a top-level string field out of the hook JSON. Prefer jq; fall back to sed.
field() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$IN" | jq -r --arg k "$1" '.[$k] // empty' 2>/dev/null
  else
    printf '%s' "$IN" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n1
  fi
}

EVENT="$(field hook_event_name)"
SESSION="$(field session_id)"
SOURCE="$(field source)"
CWD="$(field cwd)"

# Build the JSON body with jq if available (handles escaping); otherwise a plain printf.
if command -v jq >/dev/null 2>&1; then
  BODY="$(jq -nc \
    --arg kind "$KIND" --arg event "$EVENT" --arg session "$SESSION" \
    --arg source "$SOURCE" --arg cwd "$CWD" --arg cell "$CC_CELL_ID" --arg token "$CC_SIGNAL_TOKEN" \
    '{kind:$kind,event:$event,session_id:$session,source:$source,cwd:$cwd,cell:$cell,token:$token}')"
else
  BODY="$(printf '{"kind":"%s","event":"%s","session_id":"%s","source":"%s","cwd":"%s","cell":"%s","token":"%s"}' \
    "$KIND" "$EVENT" "$SESSION" "$SOURCE" "$CWD" "$CC_CELL_ID" "$CC_SIGNAL_TOKEN")"
fi

curl -s -m 2 -X POST "http://127.0.0.1:$CC_SIGNAL_PORT/signal" \
  -H 'Content-Type: application/json' -d "$BODY" >/dev/null 2>&1

exit 0   # never block or delay Claude's turn
