// P0 smoke test: launch the app, type into the terminal like a user, and confirm the PTY
// executed the command. We assert on EVALUATED output (6*7 -> 42) so a wrapped command line
// can't produce a false match — the string 'rt42ok' only exists if the shell actually ran it.
import { launchApp, sleep, shot, bufOf } from './_helper.mjs';

const { app, win } = await launchApp({ launchCmd: 'SHELL' });
try {
  await win.screenshot({ path: shot('shot-1-initial.png') });
  await win.locator('.cell[data-cell="0"] .xterm-helper-textarea').click();

  // Wait for the shell prompt before typing (avoids racing PowerShell startup).
  for (let i = 0; i < 30 && !/PS [A-Z]:/.test(await bufOf(win, '0')); i++) await sleep(300);

  await win.keyboard.type('Write-Output "rt$(6*7)ok"');
  await win.keyboard.press('Enter');

  let found = false;
  for (let i = 0; i < 25; i++) {
    if ((await bufOf(win, '0')).includes('rt42ok')) { found = true; break; }
    await sleep(300);
  }
  await win.screenshot({ path: shot('shot-2-typed.png') });
  if (!found) throw new Error('FAIL: shell did not execute the typed command (no evaluated output)');
  console.log('PASS: PTY round-trip verified (shell evaluated 6*7 -> rt42ok).');
} finally {
  await app.close();
}
