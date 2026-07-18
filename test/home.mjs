// #24 verification: the home page shows on first run, lists recent folders, dismisses, and the
// "chosen" flag persists (so it won't nag on the next launch — verified via settings.json on disk).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, sleep, shot, tmpUserDataDir } from './_helper.mjs';

const udd = tmpUserDataDir();
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cfg-')); // empty ~/.claude -> nothing to import

let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };

// No CW_ROOT_FOLDER and a fresh user-data-dir => genuine first run => home page.
const { app, win } = await launchApp({
  launchCmd: 'Write-Output hi', userDataDir: udd, skipHome: false, extraEnv: { CLAUDE_CONFIG_DIR: cfgDir },
});
try {
  await win.waitForFunction(() => window.__ready === true, { timeout: 20000 });
  await win.waitForSelector('#home-overlay.open', { timeout: 8000 });
  assert(true, 'home overlay shows on first run');
  assert((await win.locator('#home-recents .recent-item').count()) >= 1, 'recent folders listed');
  await win.screenshot({ path: shot('shot-24-home.png') });

  // Dismiss: "Continue in current folder" closes home and marks the workspace chosen.
  await win.locator('#home-skip').click();
  await sleep(700); // let the settings write flush
  assert(!(await win.locator('#home-overlay').evaluate((el) => el.classList.contains('open'))), 'home closes on skip');
} finally {
  await app.close();
}

// The chosen flag persisted, so a future launch (firstRun = !workspaceChosen) won't show home.
const saved = JSON.parse(fs.readFileSync(path.join(udd, 'settings.json'), 'utf8'));
assert(saved.workspaceChosen === true, 'workspaceChosen persisted -> home will not reappear');
assert(Array.isArray(saved.recentFolders) && saved.recentFolders.length >= 1, 'recentFolders persisted');

console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
for (const d of [udd, cfgDir]) fs.rmSync(d, { recursive: true, force: true });
if (fail) process.exit(1);
