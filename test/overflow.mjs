// Bulk-resume behaviour: sessions land one at a time (staggered, with an arrival animation), and
// when more are selected than the grid can show the user is asked where the rest should go.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, sleep, shot, tmpUserDataDir } from './_helper.mjs';

const udd = tmpUserDataDir();
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-proj-'));
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cfg-'));

const N = 18; // > the 16-pane maximum, so the overflow prompt must fire
for (let i = 0; i < N; i++) {
  const dir = path.join(cfgDir, 'projects', projDir.replace(/[:\\/]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `OVF-${i}.jsonl`),
    JSON.stringify({ type: 'user', cwd: projDir, message: { role: 'user', content: `task number ${i}` } }) + '\n');
}

let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };

const { app, win } = await launchApp({
  launchCmd: 'echo resumed', userDataDir: udd, autoImport: true,
  extraEnv: { CLAUDE_CONFIG_DIR: cfgDir, CW_ROOT_FOLDER: projDir },
});
try {
  await win.waitForFunction(() => window.__ready === true, { timeout: 20000 });
  await win.waitForSelector('#import-overlay.open', { timeout: 8000 });
  assert((await win.locator('#imp-list .imp-row').count()) === N, `overlay lists all ${N} sessions`);

  // ---- the overflow prompt ---------------------------------------------------
  const started = Date.now();
  await win.locator('#imp-go').click();
  await win.waitForSelector('#overflow-overlay.open', { timeout: 8000 });
  assert(true, 'overflow prompt appears when selection exceeds the grid');
  const desc = await win.locator('#ovf-desc').textContent();
  assert(/18 sessions selected/.test(desc) && /remaining 2/.test(desc),
    `prompt states the real numbers (got "${desc}")`);
  await win.screenshot({ path: shot('shot-overflow-prompt.png') });

  // Remember the choice, then take the "stack as tabs here" branch.
  await win.locator('#ovf-remember').check();
  await win.locator('#ovf-tabs').click();

  // ---- staggered arrival -----------------------------------------------------
  // The arrival animation must actually fire on a pane as its session lands.
  await win.waitForSelector('.cell.arriving', { timeout: 6000 });
  assert(true, 'arrival animation plays as sessions land');

  await win.waitForFunction((n) => Object.keys(window.__cellTerms).length >= n, N, { timeout: 60000 });
  const elapsed = Date.now() - started;
  // 16 in-grid resumes + 2 tab resumes => 17 gaps of 500ms. Allow generous slack, but this is far
  // above what an unstaggered import would take.
  assert(elapsed >= 7000, `sessions opened one at a time, not all at once (${elapsed}ms for ${N})`);

  // ---- the "tabs" branch keeps everything in this window ---------------------
  const shape = await win.evaluate(() => ({
    panes: document.querySelectorAll('.cell').length,
    sessions: Object.keys(window.__cellTerms).length,
    tabs: document.querySelectorAll('.cell .tab').length,
  }));
  assert(shape.panes === 16, `grid grew to its 16-pane maximum (got ${shape.panes})`);
  assert(shape.sessions === N, `all ${N} sessions live in this window (got ${shape.sessions})`);
  assert(shape.tabs >= 4, `overflow stacked as tabs rather than new windows (got ${shape.tabs} tabs)`);

  const resumed = await win.evaluate(() =>
    Object.values(window.__launch).filter((l) => l && l.resumeId).length);
  assert(resumed === N, `every session actually resumed (got ${resumed})`);

  // ---- the remembered choice persists ---------------------------------------
  const pref = await win.evaluate(() => window.__settings.overflowChoice);
  assert(pref === 'tabs', `"remember my choice" persisted (got ${pref})`);
  const sel = await win.evaluate(() => {
    document.getElementById('settings-btn').click();
    return document.getElementById('set-overflow').value;
  });
  assert(sel === 'tabs', `Settings reflects the remembered choice (got "${sel}")`);

  await win.screenshot({ path: shot('shot-overflow-tabs.png') });
  console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
} finally {
  await app.close();
}
for (const d of [udd, projDir, cfgDir]) fs.rmSync(d, { recursive: true, force: true });
if (fail) process.exit(1);
