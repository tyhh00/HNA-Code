// Per-cell reload (the ⟳ button) + the "don't obstruct native image flows" plumbing.
// Reload must kill the pty and respawn with --resume for the SAME session (so "restart claude to
// pick up the new MCP server" keeps the conversation), and restart a fresh cell clean.
// Image paste: an image-only clipboard must NOT be swallowed as an empty text paste — the raw ^V
// is forwarded so claude reads the clipboard itself. Drops must never navigate the window.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, sleep, bufOf, tmpUserDataDir } from './_helper.mjs';

const udd = tmpUserDataDir();
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-home-'));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-proj-'));

// One default profile with one resumable transcript.
const dirA = path.join(fakeHome, '.claude');
const encode = (cwd) => cwd.replace(/[:\\/]/g, '-');
{
  fs.mkdirSync(path.join(dirA, 'projects', encode(projDir)), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'me@example.com', organizationName: 'Me Org', accountUuid: 'uuid-me' },
  }));
  fs.writeFileSync(path.join(dirA, 'projects', encode(projDir), 'RLD-AAA.jsonl'),
    JSON.stringify({ type: 'user', cwd: projDir, message: { role: 'user', content: 'a real conversation' }, sessionId: 'RLD-AAA' }) + '\n');
}

let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };

const { app, win } = await launchApp({
  launchCmd: 'echo resumed', userDataDir: udd,
  extraEnv: { HOME: fakeHome, CLAUDE_CONFIG_DIR: '', CW_ROOT_FOLDER: projDir },
});
try {
  await win.waitForFunction(() => window.__ready === true, { timeout: 20000 });

  // ---- the reload button exists on every cell -------------------------------
  const btns = await win.evaluate(() => ({
    reload: document.querySelectorAll('.cell-btn.reload').length,
    close: document.querySelectorAll('.cell-btn.close').length,
  }));
  assert(btns.reload > 0 && btns.reload === btns.close, `every cell header has a ⟳ next to ✕ (got ${btns.reload}/${btns.close})`);

  // ---- reload resumes the SAME session --------------------------------------
  await win.evaluate((p) => window.grid.importSession('0', 'RLD-AAA', p, 80, 24), projDir);
  await sleep(1500);
  let launch = await win.evaluate(() => window.__launch['0']);
  assert(launch && launch.resumeId === 'RLD-AAA', 'session resumed into the cell');

  const ok = await win.evaluate(() => window.grid.reloadCell('0', 80, 24));
  assert(ok === true, 'reload reports success');
  await sleep(1500);
  launch = await win.evaluate(() => window.__launch['0']);
  assert(launch && launch.resumeId === 'RLD-AAA', `reload resumed the SAME session (got ${launch && launch.resumeId})`);
  assert(launch && /--resume RLD-AAA/.test(launch.line), 'relaunch command carries --resume');
  const buf = await bufOf(win, '0');
  assert(!/process exited/i.test(buf), 'no spurious "[process exited]" from the killed pty');
  assert(/resumed/.test(buf), 'the respawned command actually ran');

  // ---- reloading a fresh cell restarts clean --------------------------------
  const ok2 = await win.evaluate(() => window.grid.reloadCell('1', 80, 24));
  assert(ok2 === true, 'reloading a cell with no conversation succeeds');
  await sleep(1200);
  const launch1 = await win.evaluate(() => window.__launch['1']);
  assert(launch1 && !launch1.resumeId, 'fresh cell restarts clean (no bogus --resume)');

  // ---- image paste is not swallowed -----------------------------------------
  await app.evaluate(({ clipboard, nativeImage }) => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    clipboard.writeImage(nativeImage.createFromDataURL(png));
  });
  const hasImg = await win.evaluate(() => window.grid.clipboardHasImage());
  assert(hasImg === true, 'renderer sees the image on the clipboard');
  // Dispatch a paste on the wrap itself: only OUR capture handler listens there, so defaultPrevented
  // isolates the new image branch (xterm's own paste handler lives on the inner textarea).
  const imgSwallowed = await win.evaluate(() => {
    const wrap = document.querySelector('.term-wrap');
    return !wrap.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true }));
  });
  assert(imgSwallowed === true, 'image-only clipboard: paste is intercepted and ^V forwarded to the pty');

  await app.evaluate(({ clipboard }) => clipboard.writeText('plain text'));
  const txtSwallowed = await win.evaluate(() => {
    const wrap = document.querySelector('.term-wrap');
    return !wrap.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true }));
  });
  assert(txtSwallowed === false, 'text clipboard: normal paste path untouched');

  // ---- drops never navigate the window --------------------------------------
  const dropGuarded = await win.evaluate(() => {
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
    return !document.dispatchEvent(ev);
  });
  assert(dropGuarded === true, 'a stray drop is defaultPrevented (no navigation to the file)');
  const stillAlive = await win.evaluate(() => window.__ready === true && !!document.querySelector('.xterm'));
  assert(stillAlive, 'grid intact after the drop');

  console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
} finally {
  await app.close();
}
for (const d of [udd, fakeHome, projDir]) fs.rmSync(d, { recursive: true, force: true });
if (fail) process.exit(1);
