// P1 verification: grid of independent live terminals + layout switching.
import { launchApp, sleep, shot, bufOf } from './_helper.mjs';

const { app, win } = await launchApp({ launchCmd: 'SHELL' });
let failed = false;
const assert = (c, m) => { if (!c) { failed = true; console.log('FAIL:', m); } else console.log('ok:', m); };
try {
  await sleep(3000); // let all 12 shells spawn + print prompts

  const cellCount = await win.locator('.cell').count();
  assert(cellCount === 12, `default layout renders 12 cells (got ${cellCount})`);

  let live = 0;
  for (let i = 0; i < cellCount; i++) {
    const b = await bufOf(win, String(i));
    if (/PowerShell|PS [A-Z]:/.test(b)) live++;
  }
  assert(live === 12, `all terminals live (${live}/12)`);

  const MARK = 'only-in-cell-5-xyz';
  await win.locator('.cell[data-cell="5"] .xterm-helper-textarea').click();
  await win.keyboard.type(`echo ${MARK}`);
  await win.keyboard.press('Enter');
  await sleep(1200);
  const inTarget = (await bufOf(win, '5')).includes(MARK);
  const inOther = (await bufOf(win, '0')).includes(MARK);
  assert(inTarget && !inOther, 'terminals are independent (marker only in cell 5)');
  await win.screenshot({ path: shot('shot-3-grid-3x4.png') });

  await win.evaluate((k) => window.__setLayout(k), '2x4');
  await sleep(1500);
  const after = await win.locator('.cell').count();
  assert(after === 8, `shrink to 2x4 leaves 8 cells (got ${after})`);
  await win.screenshot({ path: shot('shot-4-grid-2x4.png') });

  console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
} finally {
  await app.close();
}
if (failed) process.exit(1);
