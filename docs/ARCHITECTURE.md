# Claude Windows — Architecture & Build Plan

A Windows desktop app that hosts many Claude Code sessions in a configurable grid,
glows a cell when its session is done and waiting on you, and restores the whole
layout (sessions, names, glow state) after a restart or crash.

> Status: building. Project name: `claude-windows`.

---

## 0. Requirements (from the brief)

| # | Requirement | Covered in |
|---|---|---|
| R1 | Grid of live terminals, layout 2×4 / 3×4 / 4×4 (configurable) | §2, §3 |
| R2 | Each cell runs one Claude Code session | §1, §4 |
| R3 | Glow a cell's border when the session finishes a turn / is waiting | §5, §6 |
| R4 | Autosave; on reopen/crash, resume the right sessions in the right cells | §5 |
| R5 | Restore each cell's custom name | §5, §4 |
| R6 | Restore glow state (done-and-unreplied) across restarts | §5, §6 |
| R7 | Settings: toggle glow, toggle sound, attach an mp3/wav | §7 |

---

## 1. Process model

Standard Electron split — mirrors how VS Code's integrated terminal is built.

```
┌─────────────────────────── Electron MAIN (Node.js) ───────────────────────────┐
│  • owns all node-pty processes (one per grid cell)                             │
│  • runs a localhost signal server (127.0.0.1) that hooks POST to               │
│  • owns state.json (autosave / load / atomic write)                            │
│  • installs & removes hooks in ~/.claude/settings.json                         │
└───────────────▲───────────────────────────────────┬───────────────────────────┘
                │ IPC (pty data, glow events)        │ IPC (keystrokes, layout, settings)
┌───────────────┴───────────────────────────────────▼───────────────────────────┐
│                         Electron RENDERER (Chromium)                           │
│  • CSS-grid of N cells, each an xterm.js terminal                              │
│  • draws the glow border, plays the sound, renders the settings pane          │
└────────────────────────────────────────────────────────────────────────────────┘
                ▲                                            │
                │ POST /signal  (SessionStart / idle / permission)
        ┌───────┴────────┐   spawned by, and a child of, the claude process
        │  hook script    │   inherits CC_CELL_ID / CC_SIGNAL_PORT / CC_SIGNAL_TOKEN
        └─────────────────┘
```

**Why this split:** PTYs and filesystem/state must live in main (Node). The UI lives in
renderer. Hooks are external processes that can't talk to the renderer directly, so they
POST to a tiny server in main, which forwards glow events to the renderer over IPC.

### Stack
- **Electron** — desktop shell (mature; `node-pty` + `xterm.js` are a paved road here).
- **node-pty** — spawns a real terminal via **ConPTY** on Win 11, running `claude`.
- **xterm.js** (+ `xterm-addon-fit`) — renders each PTY into a cell, handles resize/reflow.
- **PowerShell** for the hook script — always present on Windows, **no `jq`/node dependency**.

---

## 2. Grid & layout

- Layout is `{ rows, cols }`, chosen from a dropdown (2×4, 3×4, 4×4, plus arbitrary if wanted).
- Renderer lays cells out with CSS grid: `grid-template-columns: repeat(cols, 1fr)` etc.
- **Cell count can shrink/grow.** Rule: cells are ordered 0..N-1. Shrinking the grid must not
  kill a running session silently — if the new layout has fewer cells than active sessions,
  prompt the user (move to a scrollable overflow row, or refuse). Decision needed (§9, Q4).
- Each cell has a header bar: editable **name**, a status dot, and a close/restart button.

---

## 3. Terminal cells (PTY ↔ xterm wiring)

**Launcher-agnostic (decided):** don't hard-code native `claude.exe`. The launch command is
configurable (`settings.launch`, §5) and defaults to just `claude` — matching "I type `claude`
in a terminal." The app spawns that command in a PTY, so native, npm-global, and WSL all work
with the same wiring (WSL just needs cwd path translation, §9.6). Correlation and glow are
identical across launchers because hooks fire from inside Claude regardless of how it started.

Per cell:
1. Main spawns: `node-pty.spawn(shell, ['-c', launchCmd], { cwd, env })`
   where `launchCmd` is `<settings.launch.command>` (new) or `<command> --resume <id|name>`
   (restore), and `env` includes the correlation vars from §4.
2. `pty.onData(d => ipc.send('pty:data', cellId, d))` → renderer `term.write(d)`.
3. Renderer `term.onData(d => ipc.send('pty:input', cellId, d))` → main `pty.write(d)`.
4. On layout/window resize: `fitAddon.fit()` → renderer sends new `{cols, rows}` → main
   `pty.resize(cols, rows)`. **Debounce** (~100 ms) — ConPTY dislikes resize storms.

---

## 4. Cell ↔ session correlation (the race-free bit)

The app spawns `claude`, but **claude generates the session id**, not us. Correlation:

1. When spawning a cell, inject env:
   - `CC_CELL_ID` — the cell index (stable identity for this pane)
   - `CC_SIGNAL_PORT` — the localhost port of main's signal server
   - `CC_SIGNAL_TOKEN` — a per-launch random token (anti-spoof; see §8)
2. The **SessionStart** hook fires on startup *and* resume. It POSTs
   `{ event:"start", cell, session_id, source }` to the signal server.
   → Main records `cells[cell].sessionId = session_id`. Now the pane knows its id.
3. Env is inherited by hook processes (verified), so the hook reads `$env:CC_CELL_ID`
   etc. **No shared `current-session.txt` file** — that races across 12–16 sessions.

Session **name — app-owned, one-way, bound to the session id** (decided): the name is a
terminal-side label the app manages. It does **not** read from or write to Claude's own
session name — no dependency on Claude exposing/accepting a name, so **no feasibility risk**.
- The label is keyed by **`sessionId`, not cell slot**: `names[sessionId] = "auth refactor"`,
  persisted the moment you rename in the grid UI.
- On resume, a cell's title is looked up by its `sessionId`, so the name follows that specific
  conversation back to whatever grid position it lands in.
- Resume still uses the UUID (`claude --resume <sessionId>`); the name is purely the app's.

---

## 5. State schema, autosave & resume

Stored at `app.getPath('userData')/state.json`, written **atomically** (temp file + rename)
and **debounced** (~500 ms after any change).

```jsonc
{
  "version": 1,
  "layout": { "rows": 3, "cols": 4 },
  "settings": {
    "glowEnabled": true,
    "glowOn": "idle",           // "idle" = only when waiting on you; "stop" = every turn end
    "launch": {                 // launcher-agnostic; supports native / npm / WSL / custom
      "command": "claude",      // what to type to start Claude; e.g. "claude" or "wsl -e bash -lc 'claude'"
      "shell": "auto"           // "auto" | "powershell" | "cmd" | "wsl"
    },
    "doneSound":       { "enabled": false, "path": null },  // plays on idle_prompt (done, reply needed)
    "permissionSound": { "enabled": false, "path": null }   // plays on permission_prompt (approval needed)
  },
  "cells": [
    {
      "index": 0,
      "sessionId": "550e8400-e29b-41d4-a716-446655440000",
      "sessionName": "auth refactor",   // R5 — app-owned label, keyed by sessionId, one-way
      "cwd": "D:\\work\\api",
      "glow": "idle",                    // "none" | "idle" | "permission"  (R6)
      "lastActivityAt": "2026-07-17T10:31:00Z"
    }
    // ... one per occupied cell
  ]
}
```

**Resume on launch (R4/R5/R6):** read state.json, and for each cell spawn
`claude --resume <sessionId>` in `cwd`, restore `sessionName` into the header, and restore
the `glow` value so a crash that happened while a cell was amber comes back amber.

**Caveat (same as any resume tool):** this restores the *conversation*, not the *process*.
A cell that was running a dev server reopens in the right folder but you restart the server.

---

## 6. Glow state machine (R3/R6)

We drive glow from Claude Code hooks. Two glow colors come almost free:

| Signal (hook) | Meaning | Glow | Sound |
|---|---|---|---|
| `Notification` matcher `idle_prompt` | Claude is **done, waiting for your input** | 🟡 **steady** amber glow (`idle`) | `doneSound` |
| `Notification` matcher `permission_prompt` | Claude is **blocked, needs approval** | 🔵 **breathing** blue — a slow pulse, not a steady glow (`permission`) | `permissionSound` |
| `Stop` | end of a turn (fires *every* response, even mid-chain) | optional (`glowOn:"stop"`) | — |
| user types into the cell (renderer keystroke) | you've engaged | ⚪ none (clear) | — |

Visual distinction is deliberate: **done** is a calm steady amber border; **needs-permission**
is a *breathing* blue (CSS keyframe opacity/box-shadow pulse, ~1.5 s cycle) so it reads as
"actively blocked, act now" at a glance across a 16-cell grid. Each state has its **own**
attachable sound (`doneSound` / `permissionSound`), fired once on entering the state.

```
        SessionStart / resume
                │
                ▼
   ┌────────► none ◄───────────────── user keystroke in this cell
   │            │
   │   idle_prompt│ permission_prompt
   │            ▼            ▼
   │          idle 🟡     permission 🔵
   │            │            │
   └── user keystroke clears ─┘   (also plays sound once, on entering idle/permission)
```

- **Recommended default:** glow on `idle_prompt` (precisely "waiting on you"), not `Stop`
  (which is noisier). Expose `glowOn` in settings for people who want every turn end.
- **Clearing:** the renderer already sees `term.onData` for that cell; the first keystroke
  after glow was set transitions the cell back to `none` and persists it.
- **Sound:** on `none → idle` play `doneSound` (if enabled); on `none → permission` play
  `permissionSound` (if enabled). Each is an independently attachable mp3/wav in Settings.

---

## 7. Hook install / uninstall (into `~/.claude/settings.json`)

The app ships one PowerShell hook script and registers it for three events. On first run
(or a "Connect hooks" button) it **merges** entries into `~/.claude/settings.json` without
clobbering existing hooks, tagging ours so uninstall removes only ours.

Hook command (Windows, no `jq`):
```
powershell -NoProfile -ExecutionPolicy Bypass -File "%APPDATA%\claude-grid\hooks\signal.ps1"
```

`signal.ps1` (sketch):
```powershell
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$body = @{
  event      = $in.hook_event_name          # SessionStart | Notification | Stop
  matcher    = $in.matcher                   # idle_prompt / permission_prompt (Notification)
  session_id = $in.session_id
  source     = $in.source                    # startup | resume | ...
  cell       = $env:CC_CELL_ID
  token      = $env:CC_SIGNAL_TOKEN
} | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:$($env:CC_SIGNAL_PORT)/signal" `
  -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 2
exit 0   # never block the turn
```

settings.json fragment the installer merges:
```jsonc
{
  "hooks": {
    "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<signal.ps1 cmd>" }] }],
    "Notification": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<signal.ps1 cmd>" }] }],
    "Stop":         [{ "matcher": "", "hooks": [{ "type": "command", "command": "<signal.ps1 cmd>" }] }]
  }
}
```

Uninstall = load settings.json, remove entries whose command points at our `signal.ps1`, save.

---

## 8. Signal server & security

- Main runs an HTTP server bound to **`127.0.0.1` only** (never `0.0.0.0`).
- Port is chosen free at startup and passed to each session via `CC_SIGNAL_PORT`.
- Every hook POST must carry `CC_SIGNAL_TOKEN` (per-launch random). The server rejects
  mismatches, so a random local process can't spoof glows or read which sessions exist.
- Endpoint: `POST /signal` with the JSON body from §7. Main maps `cell → glow` and IPCs the
  renderer.

---

## 9. Edge cases & the parts that eat time

1. **ConPTY resize/reflow** — debounce; call `pty.resize` after `fitAddon.fit`. Test on
   layout switches (4×4 → 2×4) and window maximize.
2. **Crash recovery** — atomic state writes so a crash mid-write can't corrupt the layout;
   glow restored from persisted `glow`.
3. **Hook merge safety** — never overwrite the user's existing hooks; tag + surgical removal.
4. **Shrinking the grid with live sessions** — must not silently kill a session (Q4).
5. **Session started/killed outside the app** — the app only manages panes it spawned; a
   reply typed in some *other* terminal won't clear the app's glow. Acceptable for v1.
6. **Launcher variance** — works regardless of native `claude.exe` vs npm vs WSL, because the
   app spawns the command and hooks fire from inside claude either way. WSL adds a `cwd`
   path-translation wrinkle (`\\wsl$\… ↔ /home/…`). Names are app-owned (§4), so there's no
   session-name read/write dependency to verify.
7. **Port already in use / second instance** — single-instance lock (Electron) or per-instance
   port + token.
8. **Stop can block** — our hook always `exit 0`; never return exit 2 (that would trap Claude).

---

## 10. Decisions

Resolved:
- **Q1 — Launcher:** ✅ *Support all.* Launch command is configurable, defaults to `claude`
  (native/npm/WSL/VS Code-terminal-style). §3, §5.
- **Q2 — Naming:** ✅ *App-owned, one-way label bound to `sessionId`* (not synced with Claude's
  own session name). §4.
- **Q3 — Sound:** ✅ *Two separate attachments* — `doneSound` and `permissionSound`. §5, §6.
- **Q5 — Glow default:** ✅ `idle_prompt` → steady amber; `permission_prompt` → **breathing blue**. §6.

Still open:
- **Q4 — Grid shrink:** when a smaller layout has fewer cells than live sessions — scrollable
  overflow row, or block the change? (Default assumption for now: block + warn.)
- **Q6 — Per-cell vs global launch command:** one launcher for all cells, or override per cell
  (e.g. some native, some WSL)? (Default: global, with optional per-cell override later.)

---

## 11. Build roadmap (phased)

| Phase | Deliverable | Rough effort |
|---|---|---|
| P0 | Electron shell + one xterm.js cell running live `claude` via node-pty | 0.5 day |
| P1 | N-cell CSS grid + layout dropdown + resize wiring | 0.5 day |
| P2 | Signal server + hook install + SessionStart correlation | 1 day |
| P3 | Glow state machine (idle/permission/clear) + sound | 1 day |
| P4 | state.json autosave + resume-on-launch (R4–R6) | 1 day |
| P5 | Settings pane (glow toggle, sound picker), uninstall hooks, polish | 1–2 days |
| — | Hardening: ConPTY edge cases, crash recovery, 16-cell soak test | +ongoing |

**MVP (P0–P4):** ~3–4 focused days. **Trustworthy with a full 4×4 grid:** ~2–3 weeks with polish.

---

## 12. Risks — honest list

- **Depends on Claude Code internals** (hook schema, `--resume`, session files). Stable across
  recent versions, but Anthropic can change them; the app degrades gracefully (no glow) rather
  than breaking loudly.
- **ConPTY quirks** are the most likely source of "works-but-flaky" time.
- **16 concurrent `claude` processes** is real load (RAM/CPU) — a grid limit or lazy-spawn may help.
- Nothing here is research-hard: every component is a known, library-backed solved problem.
