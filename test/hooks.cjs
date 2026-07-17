// P2 unit test: hook install/uninstall merges into settings.json WITHOUT clobbering the user's.
// Uses a throwaway CLAUDE_CONFIG_DIR so the real ~/.claude/settings.json is never touched.
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-hooks-'));
process.env.CLAUDE_CONFIG_DIR = tmp;
const settingsFile = path.join(tmp, 'settings.json');

// Seed a realistic pre-existing config: unrelated key + the user's own hooks.
fs.writeFileSync(settingsFile, JSON.stringify({
  model: 'claude-opus',
  hooks: {
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo user-own-stop-hook' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
  },
}, null, 2));

const hooks = require('../src/main/hooks.js');
const SCRIPT = path.join(__dirname, '..', 'src', 'hooks', 'signal.ps1');
const ours = (g) => g.hooks[0].command.includes('signal.ps1');

let fail = false;
const assert = (c, m) => { if (!c) { fail = true; console.log('FAIL:', m); } else console.log('ok:', m); };

// install
hooks.installHooks(SCRIPT);
let s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
assert(s.hooks.SessionStart?.some(ours), 'SessionStart hook installed');
assert(s.hooks.Notification?.filter(ours).length === 2, 'both Notification matchers (idle+permission) installed');
assert(s.hooks.Stop?.some(ours), 'Stop hook installed');
assert(s.model === 'claude-opus', 'unrelated setting preserved');
assert(s.hooks.Stop?.some((g) => g.hooks[0].command === 'echo user-own-stop-hook'), "user's Stop hook preserved");
assert(s.hooks.PreToolUse?.some((g) => g.hooks[0].command === 'echo mine'), "user's PreToolUse hook preserved");

// idempotent re-install: no duplicates of ours, user's stays exactly once
hooks.installHooks(SCRIPT);
s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
assert(s.hooks.Notification.filter(ours).length === 2, 're-install is idempotent (Notification)');
assert(s.hooks.Stop.filter(ours).length === 1, 're-install is idempotent (our Stop)');
assert(s.hooks.Stop.filter((g) => g.hooks[0].command === 'echo user-own-stop-hook').length === 1, "user's Stop still single");

// uninstall: ours gone, user's intact
hooks.uninstallHooks(SCRIPT);
s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
assert(!s.hooks.SessionStart, 'SessionStart removed (was only ours)');
assert(!s.hooks.Notification, 'Notification removed (was only ours)');
assert(s.hooks.Stop?.some((g) => g.hooks[0].command === 'echo user-own-stop-hook'), "user's Stop survives uninstall");
assert(!s.hooks.Stop.some(ours), 'our Stop removed on uninstall');
assert(s.hooks.PreToolUse?.length === 1, "user's PreToolUse survives uninstall");
assert(s.model === 'claude-opus', 'unrelated setting survives uninstall');

console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
