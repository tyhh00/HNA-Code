// Settings importer (#24 follow-up): from Settings, browse another project folder and resume a
// specific session INTO this window, running in ITS OWN original folder (no transcript copying).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, sleep, shot, tmpUserDataDir } from './_helper.mjs';

const udd = tmpUserDataDir();
const folderA = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-A-')); // workspace we open the app in (empty)
const folderB = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-B-')); // a different project with a session
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cfg-'));

// A session that was started in folderB: its transcript records cwd = folderB.
{
  const dir = path.join(cfgDir, 'projects', folderB.replace(/[:\\/]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'IMP-B.jsonl'),
    JSON.stringify({ type: 'user', cwd: folderB, message: { role: 'user', content: 'work in folder B' }, sessionId: 'IMP-B' }) + '\n');
}

let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };

const { app, win } = await launchApp({
  launchCmd: 'Write-Output imported', userDataDir: udd,
  extraEnv: { CLAUDE_CONFIG_DIR: cfgDir, CW_ROOT_FOLDER: folderA }, // opened in A; no auto-import (default)
});
try {
  await win.waitForFunction(() => window.__ready === true, { timeout: 20000 });
  // No auto-import popup for folderA (it has no sessions).
  assert(!(await win.locator('#import-overlay').evaluate((el) => el.classList.contains('open'))), 'no auto import for empty workspace');

  // Open Settings -> Choose sessions.
  await win.locator('#settings-btn').click();
  await sleep(200);
  await win.locator('#import-open').click();
  await win.waitForSelector('#import-overlay.open', { timeout: 8000 });
  assert(await win.locator('#imp-project-row').isVisible(), 'project selector shown in manual mode');

  // Only folderB has sessions, so it is the sole (default) project; its one session lists.
  await win.waitForSelector('#imp-list .imp-row', { timeout: 6000 });
  assert((await win.locator('#imp-list .imp-row').count()) === 1, 'folder B session listed');
  const optText = await win.locator('#imp-project option').first().textContent();
  assert(optText.includes(path.basename(folderB)), 'project selector shows folder B by its real path');
  await win.screenshot({ path: shot('shot-24-import-manual.png') });

  await win.locator('#imp-go').click();
  await sleep(2000);

  const launches = await win.evaluate(() => window.__launch);
  const b = Object.values(launches).find((l) => l && l.resumeId === 'IMP-B');
  assert(!!b, 'folder B session resumed into a cell');
  assert(b && b.cwd === folderB, `session resumes in its OWN folder (got ${b && b.cwd})`);

  console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
} finally {
  await app.close();
}
for (const d of [udd, folderA, folderB, cfgDir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
if (fail) process.exit(1);
