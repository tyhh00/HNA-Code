// Electron main process.
// Owns the PTYs, the localhost signal server, and persisted state (layout, names, glow, sessions).
// One PTY per cell, keyed by cellId. On launch it resumes saved sessions into their cells.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { startSignalServer } = require('./signal-server');
const hooks = require('./hooks');

const HOOK_SCRIPT = path.join(__dirname, '..', 'hooks', 'signal.ps1');

// @lydell/node-pty ships prebuilt binaries (no compiler needed) and loads in Electron.
let pty;
try { pty = require('@lydell/node-pty'); }
catch (e) { pty = require('node-pty'); }

let win = null;
const sessions = new Map();     // cellId -> pty process
let signal = { port: 0, token: '' };

// ---- Persisted state -------------------------------------------------------
// cells: cellId -> { sessionId, cwd, name, glow }. Name is app-owned; on resume the
// same cell index restores its saved session, so the name follows that conversation.
let state = {
  version: 1,
  layout: { rows: 3, cols: 4 },
  settings: {
    glowEnabled: true,
    glowOn: 'idle',
    launch: { command: 'claude', shell: 'auto' },
    rootFolder: null,                 // base folder new sessions start in (null = home)
    autoHooks: true,                  // install glow hooks on startup so it works out of the box
    doneSound: { enabled: false, path: null },
    permissionSound: { enabled: false, path: null },
  },
  cells: {},
};

function stateFile() { return path.join(app.getPath('userData'), 'state.json'); }

function loadState() {
  try {
    const loaded = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    state = {
      ...state,
      ...loaded,
      settings: { ...state.settings, ...(loaded.settings || {}) },
      cells: loaded.cells || {},
    };
  } catch (_) { /* first run / no state yet */ }
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
function saveNow() {
  try {
    const p = stateFile();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); // atomic: temp + rename
    fs.renameSync(tmp, p);
  } catch (_) {}
}
function cellRec(cellId) {
  if (!state.cells[cellId]) state.cells[cellId] = {};
  return state.cells[cellId];
}

// ---- Signal server ---------------------------------------------------------
async function initSignal() {
  const s = await startSignalServer(onSignal);
  signal.port = s.port;
  signal.token = s.token;
  try {
    fs.writeFileSync(
      path.join(os.tmpdir(), 'claude-windows-runtime.json'),
      JSON.stringify({ port: s.port, token: s.token, pid: process.pid })
    );
  } catch (_) {}
}

// Hook POST (token already verified). Persist session id + cwd for resume.
function onSignal(payload) {
  const cellId = payload.cell;
  if (cellId != null) {
    const rec = cellRec(cellId);
    if (payload.session_id) rec.sessionId = payload.session_id;
    if (payload.cwd) rec.cwd = payload.cwd;
    scheduleSave();
  }
  if (win && !win.isDestroyed()) win.webContents.send('signal', payload);
}

// ---- Window ----------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#1e1e1e',
    title: 'Claude Windows',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function defaultCwd() {
  return process.env.USERPROFILE || process.env.HOME || process.cwd();
}

// Base folder that fresh sessions start in: explicit setting > env override > home.
function effectiveRoot() {
  const r = state.settings.rootFolder || process.env.CW_ROOT_FOLDER;
  try { if (r && fs.existsSync(r)) return r; } catch (_) {}
  return defaultCwd();
}

const AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac' };
function readAudioDataUrl(p) {
  try {
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = AUDIO_MIME[ext] || 'application/octet-stream';
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  } catch (_) { return null; }
}

// The command each cell runs. Configurable so native/npm/WSL all work; defaults to `claude`.
// CW_LAUNCH_CMD overrides (used by tests); the sentinel 'SHELL' means a bare interactive shell.
function launchBase() {
  const v = process.env.CW_LAUNCH_CMD;
  if (v !== undefined) return v === 'SHELL' ? '' : v;
  return (state.settings.launch && state.settings.launch.command) || 'claude';
}

function spawnCell(cellId, opts = {}) {
  // A saved cwd may no longer exist (folder deleted) — fall back so the spawn never crashes.
  let cwd = opts.cwd || defaultCwd();
  try { if (!fs.existsSync(cwd)) cwd = defaultCwd(); } catch (_) { cwd = defaultCwd(); }
  const base = launchBase();
  const line = opts.resumeId && base ? `${base} --resume ${opts.resumeId}` : base;
  // A launch command runs via `powershell -NoExit -Command <line>`; empty => plain shell.
  const args = line && line.trim()
    ? ['-NoLogo', '-NoExit', '-Command', line]
    : [];

  const proc = pty.spawn('powershell.exe', args, {
    name: 'xterm-256color',
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    cwd,
    env: {
      ...process.env,
      CC_CELL_ID: String(cellId),
      CC_SIGNAL_PORT: String(signal.port),
      CC_SIGNAL_TOKEN: signal.token,
      ...(opts.env || {}),
    },
  });
  proc.onData((data) => {
    if (win && !win.isDestroyed()) win.webContents.send('pty:data', cellId, data);
  });
  proc.onExit(() => {
    sessions.delete(cellId);
    if (win && !win.isDestroyed()) win.webContents.send('pty:exit', cellId);
  });
  sessions.set(cellId, proc);

  // Tell the renderer what we launched (used by tests to verify resume wiring).
  if (win && !win.isDestroyed()) {
    win.webContents.send('cell:launched', cellId, { line, cwd, resumeId: opts.resumeId || null });
  }
  return proc;
}

// ---- App lifecycle ---------------------------------------------------------
app.whenReady().then(async () => {
  loadState();
  // Install glow hooks BEFORE any session spawns, so every session reports back.
  // Idempotent + additive (preserves the user's own hooks); toggle via settings.autoHooks.
  if (state.settings.autoHooks !== false) {
    try { hooks.installHooks(HOOK_SCRIPT); } catch (_) {}
  }
  await initSignal();
  createWindow();

  ipcMain.handle('state:get', () => state);

  // Hook install/uninstall — only on explicit request (P5 settings UI).
  ipcMain.handle('hooks:install', () => hooks.installHooks(HOOK_SCRIPT));
  ipcMain.handle('hooks:uninstall', () => hooks.uninstallHooks(HOOK_SCRIPT));

  // Native audio-file picker; returns the path + a data: URL (dodges file:// CSP in the renderer).
  ipcMain.handle('dialog:pickSound', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a sound',
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    return { path: p, dataUrl: readAudioDataUrl(p) };
  });
  ipcMain.handle('sound:load', (_e, p) => (p ? readAudioDataUrl(p) : null));

  // A cell mounted: spawn its PTY, resuming a saved session if we have one.
  // Fresh cells (no saved cwd) start in the effective root folder.
  ipcMain.on('cell:ready', (_e, cellId, cols, rows) => {
    if (sessions.has(cellId)) return;
    const saved = state.cells[cellId] || {};
    spawnCell(cellId, { cols, rows, cwd: saved.cwd || effectiveRoot(), resumeId: saved.sessionId });
  });

  // Pick a base folder for new sessions.
  ipcMain.handle('root:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Open folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    state.settings.rootFolder = r.filePaths[0];
    saveNow();
    return r.filePaths[0];
  });
  ipcMain.handle('root:get', () => effectiveRoot());
  ipcMain.on('app:relaunch', () => { app.relaunch(); app.exit(0); });
  ipcMain.on('open:external', (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });

  // Open a cell's folder in VS Code.
  ipcMain.on('cell:openInVsCode', (_e, cellId) => {
    const dir = (state.cells[cellId] && state.cells[cellId].cwd) || effectiveRoot();
    try {
      require('child_process').spawn('code', [dir], { shell: true, detached: true, stdio: 'ignore' }).unref();
    } catch (_) {}
  });

  ipcMain.on('pty:input', (_e, cellId, data) => {
    const proc = sessions.get(cellId);
    if (proc) proc.write(data);
  });

  ipcMain.on('pty:resize', (_e, cellId, cols, rows) => {
    const proc = sessions.get(cellId);
    if (proc && cols > 0 && rows > 0) {
      try { proc.resize(cols, rows); } catch (_) {}
    }
  });

  ipcMain.on('cell:dispose', (_e, cellId) => {
    const proc = sessions.get(cellId);
    if (proc) { try { proc.kill(); } catch (_) {} sessions.delete(cellId); }
  });

  // Persist UI-owned state changes.
  ipcMain.on('cell:rename', (_e, cellId, name) => { cellRec(cellId).name = name; scheduleSave(); });
  ipcMain.on('glow:changed', (_e, cellId, g) => { cellRec(cellId).glow = g; scheduleSave(); });
  ipcMain.on('layout:changed', (_e, rows, cols) => { state.layout = { rows, cols }; scheduleSave(); });
  ipcMain.on('settings:changed', (_e, settings) => {
    state.settings = { ...state.settings, ...settings };
    scheduleSave();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  saveNow();
  for (const proc of sessions.values()) {
    try { proc.kill(); } catch (_) {}
  }
  sessions.clear();
  app.quit();
});
