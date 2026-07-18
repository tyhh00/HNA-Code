// Per-folder workspaces: which windows resume is scoped to the launch folder.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { _electron as electron } from 'playwright';
import { root, sleep, tmpUserDataDir, safeClose } from './_helper.mjs';

const udd = tmpUserDataDir();
const folderA = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-wsA-'));
const folderB = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-wsB-'));

let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };
const launch = (folder) => electron.launch({
  args: [root, `--user-data-dir=${udd}`], cwd: root,
  env: { ...process.env, CW_LAUNCH_CMD: 'SHELL', CW_ROOT_FOLDER: folder, CW_SKIP_HOME: '1', CW_NO_IMPORT: '1' },
});
const idOf = async (app) => {
  const w = await app.firstWindow();
  await w.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  return { w, id: await w.evaluate(() => window.__windowId) };
};

let idA = null;
// 1) Open in folder A.
{
  const app = await launch(folderA);
  const { w, id } = await idOf(app);
  idA = id;
  const shownFolder = await w.locator('#folder-name').textContent();
  assert(folderA.endsWith(shownFolder), `folder A shown in toolbar (got "${shownFolder}")`);
  await sleep(500);
  await safeClose(app);
}

// 2) Open in folder B -> a DIFFERENT window, and A's window must not appear.
{
  const app = await launch(folderB);
  const { id } = await idOf(app);
  assert(id !== idA, `folder B opens a different window than A (A=${idA}, B=${id})`);
  assert(app.windows().length === 1, 'folder B shows only its own window (not A\'s)');
  await sleep(500);
  await safeClose(app);
}

// 3) Reopen folder A -> A's window comes back (same id).
{
  const app = await launch(folderA);
  const { id } = await idOf(app);
  assert(id === idA, `reopening folder A restores its window (${idA})`);
  await sleep(500);
  await safeClose(app);
}

console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
for (const d of [udd, folderA, folderB]) fs.rmSync(d, { recursive: true, force: true });
if (fail) process.exit(1);
