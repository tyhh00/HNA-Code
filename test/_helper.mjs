// Shared test helpers: launch the app in an isolated user-data-dir, fire real hooks, read buffers.
import { _electron as electron } from 'playwright';
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const root = path.join(__dirname, '..');
export const HOOK = path.join(root, 'src', 'hooks', 'signal.ps1');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const shot = (n) => path.join(__dirname, n);

export function tmpUserDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-udd-'));
}

// launchCmd 'SHELL' => bare interactive shell (default for tests). userDataDir isolates state.
// skipHome (default true) suppresses the first-run home overlay so tests reach the grid directly;
// the home page itself is covered by home.mjs, which passes skipHome:false.
export async function launchApp({ launchCmd = 'SHELL', userDataDir, extraEnv = {}, skipHome = true, autoImport = false, expectGrid = true } = {}) {
  const udd = userDataDir || tmpUserDataDir();
  const app = await electron.launch({
    args: [root, `--user-data-dir=${udd}`],
    cwd: root,
    env: {
      ...process.env, CW_LAUNCH_CMD: launchCmd,
      ...(skipHome ? { CW_SKIP_HOME: '1' } : {}),
      ...(autoImport ? {} : { CW_NO_IMPORT: '1' }), // suppress the import prompt unless a test wants it
      ...extraEnv,
    },
  });
  const win = await app.firstWindow();
  // Grid windows have a terminal; the launcher (home) window shows only the home overlay.
  if (expectGrid) await win.waitForSelector('.xterm', { timeout: 20000 });
  else await win.waitForSelector('#home-overlay.open', { timeout: 20000 });

  // On this box, a full graceful quit can hang on ConPTY teardown (the process never exits, even on
  // the committed baseline). Window state is written synchronously on the window 'close' event, so a
  // brief grace period lets that flush; then we force-kill the process so tests never wedge.
  const origClose = app.close.bind(app);
  app.close = () => forceClose(app, origClose);
  return { app, win, userDataDir: udd };
}

// A full graceful quit can hang on ConPTY teardown on this box (the process never exits, even on the
// committed baseline). Window state is written synchronously on the window 'close' event, so a brief
// grace period lets that flush; then we force-kill the whole tree so tests never wedge, and wait for
// Windows to release the leveldb/Local Storage file locks before temp-dir cleanup.
async function forceClose(app, gracefulClose) {
  const proc = app.process();
  const pid = proc && proc.pid;
  try { await Promise.race([gracefulClose(), sleep(4000)]); } catch (_) {}
  if (pid) { try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {} }
  await sleep(700);
}
// For raw electron.launch() tests: call this instead of app.close() so they never wedge on teardown.
export function safeClose(app) { return forceClose(app, app.close.bind(app)); }

export function runtime(userDataDir) {
  return JSON.parse(fs.readFileSync(path.join(userDataDir, 'runtime.json'), 'utf8'));
}

// Run the REAL signal.ps1 exactly as Claude Code would.
export function fireHook({ kind, cell, sessionId = `sess-${cell}`, port, token, source = 'startup', cwd = 'C:\\test\\proj' }) {
  return new Promise((resolve) => {
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HOOK, '-Kind', kind], {
      env: { ...process.env, CC_CELL_ID: String(cell), CC_SIGNAL_PORT: String(port), CC_SIGNAL_TOKEN: token },
    });
    const evt = kind === 'start' ? 'SessionStart' : (kind === 'stop' ? 'Stop' : 'Notification');
    ps.stdin.write(JSON.stringify({ hook_event_name: evt, session_id: sessionId, source, cwd }));
    ps.stdin.end();
    ps.on('close', () => resolve());
  });
}

export function bufOf(win, id) {
  return win.evaluate((cid) => {
    const t = window.__cellTerms && window.__cellTerms[cid];
    if (!t) return '';
    const b = t.buffer.active; const lines = [];
    for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) lines.push(l.translateToString(true)); }
    return lines.join('\n');
  }, id);
}
