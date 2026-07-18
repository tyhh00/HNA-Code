// One short launch: open the app pointed at a folder, print the window ids that opened, close.
// Called repeatedly with the same user-data-dir to verify per-folder workspace isolation.
import { _electron as electron } from 'playwright';
import { root, sleep, safeClose } from './_helper.mjs';

const folder = process.argv[2];
const udd = process.argv[3];

const app = await electron.launch({
  args: [root, `--user-data-dir=${udd}`], cwd: root,
  env: { ...process.env, CW_LAUNCH_CMD: 'SHELL', CW_ROOT_FOLDER: folder, CW_SKIP_HOME: '1', CW_NO_IMPORT: '1' },
});
try {
  const w0 = await app.firstWindow();
  await w0.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  await sleep(900);
  const ids = [];
  for (const p of app.windows()) { try { ids.push(await p.evaluate(() => window.__windowId)); } catch (_) {} }
  console.log('WINDOWS=' + ids.sort().join(','));
} finally {
  await safeClose(app);
}
