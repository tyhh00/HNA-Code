// Launcher/home window: the app opens to the home page (no grid). Opening a folder loads that
// workspace's grid IN PLACE (a new grid window appears, the app never closes) — no relaunch.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, sleep, shot, tmpUserDataDir } from './_helper.mjs';

const udd = tmpUserDataDir();
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-proj-'));
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cfg-'));
// Pre-seed a recent folder so the home page has something to click.
fs.writeFileSync(path.join(udd, 'settings.json'), JSON.stringify({ recentFolders: [projDir], workspaceChosen: true }));

let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };

// No CW_SKIP_HOME / CW_ROOT_FOLDER => the app opens to the launcher (home page), not the grid.
const { app, win } = await launchApp({
  launchCmd: 'Write-Output hi', userDataDir: udd, skipHome: false, expectGrid: false,
  extraEnv: { CLAUDE_CONFIG_DIR: cfgDir, CW_NO_IMPORT: '1' },
});
try {
  await win.waitForFunction(() => window.__ready === true, { timeout: 20000 });
  assert(await win.evaluate(() => document.body.classList.contains('home-mode')), 'app opens in home/launcher mode');
  assert(await win.locator('#home-overlay').evaluate((el) => el.classList.contains('open')), 'home page is shown');
  assert((await win.locator('#home-recents .recent-item').count()) >= 1, 'recent folders listed');
  // The launcher has no grid.
  assert((await win.locator('.xterm').count()) === 0, 'no grid/terminals in the launcher');
  await win.screenshot({ path: shot('shot-24-home.png') });

  // Click a recent folder -> a grid window opens in place; the app does NOT close.
  await win.locator('#home-recents .recent-item').first().click();
  const grid = await app.waitForEvent('window', { timeout: 12000 });
  await grid.waitForSelector('.xterm', { timeout: 20000 });
  await grid.waitForFunction(() => window.__ready === true, { timeout: 20000 });
  assert(true, 'opening a folder loads the grid (app stayed open)');
  assert((await grid.locator('.cell').count()) > 0, 'grid window has cells');

  await sleep(600);
  const saved = JSON.parse(fs.readFileSync(path.join(udd, 'settings.json'), 'utf8'));
  assert(saved.lastWorkspace === projDir, 'chosen folder persisted as lastWorkspace');

  console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
} finally {
  await app.close();
}
for (const d of [udd, projDir, cfgDir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
if (fail) process.exit(1);
