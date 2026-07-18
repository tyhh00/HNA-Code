# HNA-Code

**HNA-Code (Humans and Agents Code)** is a Windows desktop app that hosts many **Claude Code**
sessions in a configurable grid, glows a cell the moment its session is done and waiting on you,
and restores the whole board (sessions, names, glow state, folders) after a restart or crash.

Built for running 12 to 16 coding agents at once without losing your place. Themeable, with a
built-in importer that pulls your existing Claude Code sessions in from any folder.

## Features

- **Grid of live terminals.** One real terminal (ConPTY) per cell, each running `claude`.
  Landscape layouts (2x4, 3x4, 4x4, 2x2) and portrait layouts for vertical monitors
  (4x2, 6x2, 8x2, 6x1). The layout dropdown shows a little grid glyph for each option.
- **Glow when a session needs you.** Driven by Claude Code hooks:
  - steady amber: the session finished its turn and is waiting for your reply
  - breathing blue: the session is blocked needing a permission approval
  - typing into a cell clears its glow.
- **Optional sounds.** Attach your own mp3 or wav, separately for "done" and "needs permission".
- **Autosave and resume.** On reopen, every cell resumes its exact conversation
  (`claude --resume <id>`) in its original folder, with the name you set and its glow restored.
- **Editable names.** Double-click or right-click a cell header to rename. The name is bound to
  the session, so it follows that conversation across restarts.
- **Project folder.** Point the app at a folder and new sessions all start there.
- **Home page and one-click import.** On first run, a welcome page lets you open a folder to work
  in. When that folder already has Claude sessions running outside HNA-Code, it offers to
  resume them into the grid in one click (all, a selection, or only ones after a date), spilling
  into extra windows when they do not all fit.
- **Import specific sessions any time.** Settings has a session importer that browses every folder
  Claude knows about, so you can pull specific past sessions into the current window. Each one
  resumes in its own original folder, so nothing is copied out of Claude's normal session store.
- **Recent folders.** The folder button is an "Open recent" menu like VS Code, so you can jump
  between workspaces quickly.
- **Open in VS Code.** Each cell has a button that opens its folder in VS Code.
- **Your config stays yours.** Glow hooks are added to `~/.claude/settings.json` on startup, but
  only HNA-Code entries are touched. Your own hooks are preserved, and you can disconnect.

## Requirements

- Windows 10 or 11 with Windows Terminal / ConPTY (built in on Windows 11)
- Node.js (used to run Electron; no C++ compiler needed, the PTY ships prebuilt)
- Claude Code installed and on PATH (`claude`)

## Compatibility

- **Claude Code hooks tested against: `2.1.x`.**

The glow and resume features rely on Claude Code's hook schema (SessionStart, the Notification
matchers `idle_prompt` and `permission_prompt`, Stop, and `claude --resume`). These were verified
on the `2.1.x` line. If a future Claude Code release changes them, glow degrades gracefully
(no crash) rather than breaking. Contributions that widen the tested range are very welcome:
bump this note and add coverage as you confirm newer versions.

## Install and run

```bash
npm install
npm start
```

Glow and resume work out of the box: the app installs its hooks on startup and learns each
session id as it starts.

## How it works

```
 Electron main                                each cell
 - one node-pty per cell (runs claude)        powershell -> claude --resume <id>
 - 127.0.0.1 signal server (+ per-run token)          |
 - state.json (layout, names, glow, sessions)         | hooks POST {cell, session_id, kind}
 Renderer                                             v
 - xterm.js grid, glow, settings          signal.ps1 (SessionStart / Stop /
                                           idle_prompt / permission_prompt)
```

- Each cell is spawned with `CC_CELL_ID` plus the signal server's port and token in its
  environment.
- A small PowerShell hook (`src/hooks/signal.ps1`) posts `{cell, session_id, kind}` back to the
  app on SessionStart, Stop, idle, and permission. That is how the app learns each cell's session
  id (race free) and when to glow.
- State is written atomically (temp then rename) and debounced, so a crash leaves the last good
  state.

See `docs/ARCHITECTURE.md` for the full design.

## Tests

```bash
npm test
```

Every phase is verified by driving the real app with Playwright (screenshots plus terminal-buffer
assertions):

| Test | Covers |
|------|--------|
| `test/hooks.cjs` | settings.json merge preserves your own hooks; idempotent; clean uninstall |
| `test/smoke.mjs` | one live terminal, real PTY round trip |
| `test/grid.mjs` | 12 independent terminals, layout switching |
| `test/signal.mjs` | real `signal.ps1` round trip, cell correlation, bad-token rejection |
| `test/glow.mjs` | done to amber, permission to breathing blue, keystroke clears |
| `test/persist.mjs` | autosave and resume: names, glow, sessions, cwd survive restart |
| `test/settings.mjs` | settings persist and reflect after restart; sound pipeline; hooks connect |
| `test/sidebar.mjs` | sessions sidebar: real-only list, needs-you first, click to jump, collapse |
| `test/home.mjs` | first-run home page shows, lists recent folders, and the chosen flag persists |
| `test/import.mjs` | one-click import of a folder's existing sessions into the grid |
| `test/import-manual.mjs` | Settings importer browses another folder and resumes in its own cwd |

There is also `test/e2e-real.mjs`, a live test against an authenticated `claude` (not part of
`npm test`, since it needs auth and network).

## Notes and limitations

- Restores conversations, not processes. A session that was running a dev server reopens in the
  right folder, but you restart the server yourself.
- Uses `@lydell/node-pty` (prebuilt ConPTY, no compiler), pinned to `1.1.0` to avoid a debug
  assertion on PTY teardown in the beta builds.
- Electron is pinned to `32` because its installer runs on Node 20; newer Electron needs Node 22.
- Depends on Claude Code's hook schema (SessionStart, Notification matchers, `--resume`), verified
  against Claude Code 2.1.x. If those change, glow degrades gracefully rather than breaking.

## Building and releasing

```bash
npm run pack:portable   # dist/HNA-Code-<version>-portable.exe (single-file, no install)
npm run pack            # portable + NSIS installer (HNA-Code Setup <version>.exe)
```

Notes:
- The build uses `asar: false` on purpose, so `src/hooks/signal.ps1` and the icon stay real
  files on disk. The hook must be a real file because Claude Code's hook runner (an external
  process) executes it; it cannot read inside a packed `.asar`.
- First Windows build may fail extracting electron-builder's `winCodeSign` toolchain with
  "Cannot create symbolic link". That is a Windows privilege quirk (the archive contains macOS
  symlinks). Fix by enabling Windows Developer Mode, or building from an elevated shell. We only
  need the Windows tools from it.

### Code signing (avoid the "unknown publisher" warning)

An unsigned exe triggers SmartScreen ("unknown publisher") on first run. To ship a trusted
release you need a code-signing certificate:

- **OV** certificate: cheaper, but SmartScreen still warns until the app earns download reputation.
- **EV** certificate: pricier and requires a hardware token or cloud HSM, but gives instant
  SmartScreen trust. This is what most public apps use.

Once you have one, signing is config only:

```jsonc
"win": {
  "target": ["nsis", "portable"],
  "icon": "build/icon.ico",
  "signtoolOptions": { "certificateSubjectName": "Your Company", "signingHashAlgorithms": ["sha256"] }
}
```

electron-builder then signs the exe and installer during the build. (For a `.pfx` file cert use
`certificateFile` + the `CSC_KEY_PASSWORD` env var instead.) For a personal or OSS build you can
ship unsigned and tell users to click "More info -> Run anyway".

## Contributing

Issues and pull requests are welcome. Good first areas: widening the tested Claude Code version
range (see Compatibility), more layouts, packaging, and cross-checking the hook schema on newer
Claude Code releases.

## License

MIT
