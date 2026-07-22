// Multi-account verification: several CLAUDE_CONFIG_DIR profiles side by side.
// Fakes $HOME so the ~/.claude* auto-scan runs against two controlled profiles, then checks
// detection, the per-cell account badge, and a real "switch account" (copy + resume + SoT).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchApp, sleep, shot, tmpUserDataDir } from './_helper.mjs';

const udd = tmpUserDataDir();
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-home-'));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-proj-'));

const dirA = path.join(fakeHome, '.claude');       // default profile
const dirB = path.join(fakeHome, '.claude-work');  // second account

// The default profile keeps its config at ~/.claude.json; a custom dir keeps it inside itself.
function seedProfile(dir, email, isDefault) {
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  const cfg = isDefault ? path.join(fakeHome, '.claude.json') : path.join(dir, '.claude.json');
  fs.writeFileSync(cfg, JSON.stringify({
    oauthAccount: { emailAddress: email, organizationName: `${email} Org`, accountUuid: `uuid-${email}` },
  }));
}
const encode = (cwd) => cwd.replace(/[:\\/]/g, '-');
function writeTranscript(dir, sessionId, cwd, firstText) {
  const d = path.join(dir, 'projects', encode(cwd));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${sessionId}.jsonl`),
    JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: firstText }, sessionId }) + '\n');
}
const transcriptIn = (dir, sessionId) => path.join(dir, 'projects', encode(projDir), `${sessionId}.jsonl`);

seedProfile(dirA, 'personal@example.com', true);
seedProfile(dirB, 'work@example.com', false);
writeTranscript(dirA, 'ACC-AAA', projDir, 'a session owned by the personal account');
// A started-but-never-used session: Claude writes the file but there is no user turn, so it is NOT
// resumable and must not be treated as portable. This is the exact shape that produced a bogus
// "no transcript found for this session" error when switching an empty cell.
{
  const d = path.join(dirA, 'projects', encode(projDir));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'ACC-EMPTY.jsonl'), JSON.stringify({ type: 'summary', summary: 'x' }) + '\n');
}
// A session that already exists in BOTH profiles (as if switched earlier) and is NOT opened into a
// cell — so it actually reaches the dedupe path instead of being filtered out as "already open".
writeTranscript(dirA, 'ACC-DUP', projDir, 'a session living in both profiles');
writeTranscript(dirB, 'ACC-DUP', projDir, 'a session living in both profiles');
// Stamp B clearly ahead: file mtimes have sub-ms precision, so a bare Date.now() stamp can land
// behind a file written microseconds earlier.
{ const t = Date.now() / 1000 + 5; fs.utimesSync(transcriptIn(dirB, 'ACC-DUP'), t, t); }

let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };

const { app, win } = await launchApp({
  launchCmd: 'echo resumed', userDataDir: udd,
  // HOME drives the profile auto-scan. CLAUDE_CONFIG_DIR must stay EMPTY (falsy) or discovery
  // short-circuits to that single dir and never scans home.
  extraEnv: { HOME: fakeHome, CLAUDE_CONFIG_DIR: '', CW_ROOT_FOLDER: projDir },
});
try {
  await win.waitForFunction(() => window.__ready === true, { timeout: 20000 });

  // ---- discovery + account identity ----------------------------------------
  const profs = await win.evaluate(() => window.grid.listProfiles());
  assert(profs.length === 2, `discovered 2 profiles (got ${profs.length})`);
  const byLabel = Object.fromEntries(profs.map((p) => [p.label, p]));
  assert(byLabel['.claude'] && byLabel['.claude'].account.email === 'personal@example.com',
    'default profile resolves its account from ~/.claude.json');
  assert(byLabel['.claude-work'] && byLabel['.claude-work'].account.email === 'work@example.com',
    'custom profile resolves its account from <dir>/.claude.json');
  assert(byLabel['.claude'].isDefault === true, 'default profile flagged as default');

  const multi = await win.evaluate(() => document.body.classList.contains('multi-acct'));
  assert(multi, 'multi-account UI enabled when >1 profile exists');

  // ---- a session resumes under the profile that owns it ---------------------
  await win.evaluate((p) => window.grid.importSession('0', 'ACC-AAA', p, 80, 24), projDir);
  await sleep(1800);

  let launch = await win.evaluate(() => window.__launch['0']);
  assert(launch && launch.resumeId === 'ACC-AAA', 'session resumed into the cell');
  assert(launch && String(launch.configDir || '').endsWith('.claude'),
    `cell launched under the owning profile (got ${launch && launch.configDir})`);
  assert(launch && launch.profile && launch.profile.account.email === 'personal@example.com',
    'launch reports the bound account');

  const badgeBefore = await win.evaluate(() => document.querySelector('.cell .cell-acct').textContent);
  assert(badgeBefore === '.claude', `badge shows the owning profile (got "${badgeBefore}")`);
  await win.screenshot({ path: shot('shot-accounts-before.png') });

  // ---- an empty cell has nothing to port ------------------------------------
  // A cell that merely started Claude gets a sessionId from the SessionStart hook but has no
  // transcript, so it must NOT be treated as portable (that produced a bogus "no transcript" error).
  const emptyPortable = await win.evaluate(() => window.grid.cellPortable('1'));
  assert(emptyPortable.portable === false, 'a cell with no conversation is not portable');

  // The reported bug: a cell whose session STARTED (so it has a sessionId) but never produced a
  // user turn. It has a transcript file, yet nothing resumable — switching must not error.
  await win.evaluate((p) => window.grid.importSession('2', 'ACC-EMPTY', p, 80, 24), projDir);
  await sleep(1200);
  const startedOnly = await win.evaluate(() => window.grid.cellPortable('2'));
  assert(startedOnly.sessionId === 'ACC-EMPTY', 'the started-only cell does have a session id');
  assert(startedOnly.portable === false, 'a started-but-unused session is not portable');
  const startedSwitch = await win.evaluate((d) => window.grid.switchProfile('2', d, 80, 24, { port: true }), dirB);
  assert(startedSwitch && startedSwitch.ok === true,
    `switching a started-but-unused cell succeeds instead of erroring (got ${JSON.stringify(startedSwitch)})`);
  assert(startedSwitch.ported === false, 'started-but-unused cell ports nothing');
  assert(!fs.existsSync(transcriptIn(dirB, 'ACC-EMPTY')), 'no empty transcript is copied across');
  const emptySwitch = await win.evaluate((d) => window.grid.switchProfile('1', d, 80, 24, { port: true }), dirB);
  assert(emptySwitch && emptySwitch.ok === true, `switching an empty cell succeeds (got ${JSON.stringify(emptySwitch)})`);
  assert(emptySwitch.ported === false, 'switching an empty cell ports nothing');
  await sleep(1200);
  const emptyLaunch = await win.evaluate(() => window.__launch['1']);
  assert(!emptyLaunch.resumeId, 'empty cell starts a NEW session rather than resuming');
  assert(String(emptyLaunch.configDir || '').endsWith('.claude-work'), 'empty cell still rebinds to the target account');

  // ---- the port confirmation is asked, not implicit --------------------------
  const portableNow = await win.evaluate(() => window.grid.cellPortable('0'));
  assert(portableNow.portable === true, 'a cell with a real conversation IS portable');
  await win.evaluate((d) => { window.__switchPromise = window.__switchPane(d); }, dirB);
  await win.waitForSelector('#port-overlay.open', { timeout: 6000 });
  assert(true, 'porting a real conversation asks first');
  // Cancel must leave everything untouched.
  await win.locator('#port-cancel').click();
  await sleep(500);
  assert(!fs.existsSync(transcriptIn(dirB, 'ACC-AAA')), 'cancelling the prompt ports nothing');
  const stillA = await win.evaluate(() => window.grid.cellProfile('0'));
  assert(String(stillA.configDir || '').endsWith('.claude'), 'cancelling leaves the cell on its original account');

  // ---- switch the session to the other account ------------------------------
  assert(!fs.existsSync(transcriptIn(dirB, 'ACC-AAA')), 'target profile has no copy before the switch');
  const res = await win.evaluate((d) => window.grid.switchProfile('0', d, 80, 24, { port: true }), dirB);
  assert(res && res.ok === true, `switch reported success (got ${JSON.stringify(res)})`);
  assert(res.ported === true, 'switch reports that it ported the conversation');
  await sleep(1800);

  assert(fs.existsSync(transcriptIn(dirB, 'ACC-AAA')), 'transcript copied into the target profile');
  assert(fs.existsSync(transcriptIn(dirA, 'ACC-AAA')), 'original transcript kept as a rollback');

  launch = await win.evaluate(() => window.__launch['0']);
  assert(String(launch.configDir || '').endsWith('.claude-work'),
    `cell relaunched under the target profile (got ${launch.configDir})`);
  assert(launch.resumeId === 'ACC-AAA', 'session resumed (not restarted) after the switch');
  assert(/--resume ACC-AAA/.test(launch.line), 'relaunch command still carries --resume');

  const badgeAfter = await win.evaluate(() => document.querySelector('.cell .cell-acct').textContent);
  assert(badgeAfter === '.claude-work', `badge follows the switch (got "${badgeAfter}")`);

  // ---- source of truth + dedupe --------------------------------------------
  const mA = fs.statSync(transcriptIn(dirA, 'ACC-AAA')).mtimeMs;
  const mB = fs.statSync(transcriptIn(dirB, 'ACC-AAA')).mtimeMs;
  assert(mB > mA, `the copy is newest, so it becomes the source of truth (B=${mB} > A=${mA})`);

  const prof = await win.evaluate(() => window.grid.cellProfile('0'));
  assert(String(prof.sotDir || '').endsWith('.claude-work'), 'SoT resolves to the target profile');
  assert(String(prof.configDir || '').endsWith('.claude-work'), 'cell binding matches the SoT (no drift)');

  // A session present in both profiles must be listed ONCE, attributed to its SoT profile —
  // otherwise every switched session shows up twice in the import list.
  const scan = await win.evaluate(() => window.grid.scanWorkspace());
  const dup = scan.sessions.filter((s) => s.sessionId === 'ACC-DUP');
  assert(dup.length === 1, `session present in both profiles is listed once (got ${dup.length})`);
  assert(dup.length === 1 && String(dup[0].configDir || '').endsWith('.claude-work'),
    `deduped row is attributed to the SoT profile (got ${dup[0] && dup[0].configDir})`);
  assert(dup.length === 1 && dup[0].account && dup[0].account.email === 'work@example.com',
    'deduped row carries the SoT profile account');

  // ---- the binding survives a restart --------------------------------------
  const persisted = await win.evaluate(() => window.grid.getState());
  assert(persisted.cells && persisted.cells['0'] && String(persisted.cells['0'].configDir || '').endsWith('.claude-work'),
    'the cell persists its profile binding for the next launch');

  await win.screenshot({ path: shot('shot-accounts-after.png') });
  console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
} finally {
  await app.close();
}
for (const d of [udd, fakeHome, projDir]) fs.rmSync(d, { recursive: true, force: true });
if (fail) process.exit(1);
