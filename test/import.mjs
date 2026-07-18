// #24 verification: one-click import of a folder's existing Claude sessions.
// Seed 3 real transcripts under an isolated ~/.claude, open the app in that folder, and confirm
// the import overlay lists them and "Resume selected" resumes each into a cell (--resume wired).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, sleep, shot, tmpUserDataDir } from './_helper.mjs';

const udd = tmpUserDataDir();
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-proj-'));
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cfg-')); // isolated ~/.claude

function writeTranscript(sessionId, cwd, firstText) {
  const dir = path.join(cfgDir, 'projects', cwd.replace(/[:\\/]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`),
    JSON.stringify({ type: 'user', message: { role: 'user', content: firstText }, sessionId }) + '\n');
}
const SIDS = ['IMP-AAA', 'IMP-BBB', 'IMP-CCC'];
writeTranscript('IMP-AAA', projDir, 'refactor the auth module');
writeTranscript('IMP-BBB', projDir, 'write unit tests for parser');
writeTranscript('IMP-CCC', projDir, 'fix the flaky CI job');
// A never-used session (no user turn) must NOT be offered.
(() => {
  const dir = path.join(cfgDir, 'projects', projDir.replace(/[:\\/]/g, '-'));
  fs.writeFileSync(path.join(dir, 'IMP-EMPTY.jsonl'),
    JSON.stringify({ type: 'summary', summary: 'x' }) + '\n');
})();

let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };

const { app, win } = await launchApp({
  launchCmd: 'Write-Output imported', userDataDir: udd, autoImport: true,
  extraEnv: { CLAUDE_CONFIG_DIR: cfgDir, CW_ROOT_FOLDER: projDir },
});
try {
  await win.waitForFunction(() => window.__ready === true, { timeout: 20000 });

  // scan returns exactly the 3 resumable sessions (not the empty one), with titles.
  const scan = await win.evaluate(() => window.grid.scanWorkspace());
  assert(scan && scan.sessions.length === 3, `scan found 3 sessions (got ${scan && scan.sessions.length})`);
  const titles = scan.sessions.map((s) => s.title);
  assert(titles.includes('refactor the auth module'), 'session title comes from first prompt');
  assert(!scan.sessions.some((s) => s.sessionId === 'IMP-EMPTY'), 'never-used session excluded');

  // Import overlay auto-shows on boot for an empty workspace with existing sessions.
  await win.waitForSelector('#import-overlay.open', { timeout: 8000 });
  assert(await win.locator('#import-overlay').evaluate((el) => el.classList.contains('open')), 'import overlay opened');
  assert((await win.locator('#imp-list .imp-row').count()) === 3, 'overlay lists 3 sessions');
  await win.screenshot({ path: shot('shot-24-import.png') });

  // Resume all selected.
  await win.locator('#imp-go').click();
  await sleep(2000); // let cell:importSession -> spawn -> cell:launched land

  const launches = await win.evaluate(() => window.__launch);
  const resumed = Object.values(launches).filter((l) => l && l.resumeId).map((l) => l.resumeId);
  assert(resumed.length === 3, `3 cells resumed (got ${resumed.length})`);
  assert(SIDS.every((s) => resumed.includes(s)), 'each existing session was resumed into a cell');
  const anyLine = Object.values(launches).find((l) => l && l.resumeId);
  assert(anyLine && /--resume IMP-/.test(anyLine.line), 'resumed cell launch line includes --resume');

  assert(!(await win.locator('#import-overlay').evaluate((el) => el.classList.contains('open'))), 'overlay closes after import');
  await win.screenshot({ path: shot('shot-24-imported.png') });

  console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
} finally {
  await app.close();
}
for (const d of [udd, projDir, cfgDir]) fs.rmSync(d, { recursive: true, force: true });
if (fail) process.exit(1);
