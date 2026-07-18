// Install / uninstall Claude Code hooks into settings.json without clobbering the user's own.
// Honors CLAUDE_CONFIG_DIR (same env var Claude Code itself uses) so tests can point at a temp dir.
const fs = require('fs');
const path = require('path');
const os = require('os');
const platform = require('./platform');

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
function settingsPath() {
  return path.join(claudeDir(), 'settings.json');
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
  catch (_) { return {}; }
}
function writeSettings(obj) {
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p); // atomic replace
}

function command(scriptPath, kind) {
  return platform.hookCommand(scriptPath, kind);
}
function entry(scriptPath, matcher, kind) {
  return { matcher, hooks: [{ type: 'command', command: command(scriptPath, kind) }] };
}
// An entry is "ours" if any of its commands references our exact script path.
function isOurs(group, scriptPath) {
  return !!(group && Array.isArray(group.hooks) &&
    group.hooks.some((h) => typeof h.command === 'string' && h.command.includes(scriptPath)));
}

// The events we register. Notification is split by matcher so we learn idle vs permission
// from the -Kind argument rather than parsing stdin.
function plan(scriptPath) {
  return {
    SessionStart: [entry(scriptPath, '', 'start')],
    UserPromptSubmit: [entry(scriptPath, '', 'prompt')], // the agent just started working -> "running"
    Notification: [
      entry(scriptPath, 'idle_prompt', 'idle'),
      entry(scriptPath, 'permission_prompt', 'permission'),
    ],
    Stop: [entry(scriptPath, '', 'stop')],
  };
}

function installHooks(scriptPath) {
  const s = readSettings();
  s.hooks = s.hooks || {};
  const p = plan(scriptPath);
  for (const [event, entries] of Object.entries(p)) {
    const existing = Array.isArray(s.hooks[event]) ? s.hooks[event] : [];
    // Drop any prior copies of ours (idempotent re-install), keep the user's own.
    const kept = existing.filter((g) => !isOurs(g, scriptPath));
    s.hooks[event] = kept.concat(entries);
  }
  writeSettings(s);
  return settingsPath();
}

function uninstallHooks(scriptPath) {
  const s = readSettings();
  if (!s.hooks) return settingsPath();
  for (const event of Object.keys(s.hooks)) {
    if (!Array.isArray(s.hooks[event])) continue;
    s.hooks[event] = s.hooks[event].filter((g) => !isOurs(g, scriptPath));
    if (s.hooks[event].length === 0) delete s.hooks[event];
  }
  if (s.hooks && Object.keys(s.hooks).length === 0) delete s.hooks;
  writeSettings(s);
  return settingsPath();
}

module.exports = { installHooks, uninstallHooks, settingsPath, command };
