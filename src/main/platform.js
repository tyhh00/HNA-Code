// Everything OS-specific lives here so the rest of the app stays platform-agnostic.
// Windows uses PowerShell + a .ps1 hook + WMI perf counters; macOS/Linux use the login shell +
// a .sh hook + `ps`.
const path = require('path');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function loginShell() {
  if (isWin) return 'powershell.exe';
  return process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash');
}

// How to spawn a cell: run `line` (e.g. "claude --resume <id>") then keep the pane interactive.
// An empty line means "just an interactive shell" (used by tests via CW_LAUNCH_CMD=SHELL).
function cellCommand(line) {
  const has = !!(line && line.trim());
  if (isWin) {
    return { file: 'powershell.exe', args: has ? ['-NoLogo', '-NoExit', '-Command', line] : [] };
  }
  const sh = loginShell();
  // -l: login (sources profile so `claude` is on PATH), -i: interactive. After `line` finishes we
  // exec an interactive shell so the terminal stays usable, matching PowerShell's -NoExit.
  if (has) return { file: sh, args: ['-lic', `${line}; exec ${sh} -i`] };
  return { file: sh, args: ['-li'] };
}

// The hook script the app ships, and the command Claude Code runs to invoke it.
function hookScriptPath(hooksDir) {
  return path.join(hooksDir, isWin ? 'signal.ps1' : 'signal.sh');
}
function hookCommand(scriptPath, kind) {
  if (isWin) return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -Kind ${kind}`;
  return `bash "${scriptPath}" ${kind}`;
}

// One-shot process sampler for the (debug) perf meter. Returns {file,args} to spawn and a parser
// that yields [{ p:pid, pp:parentPid, c:cpuPercent, m:bytes }].
const PERF_PS =
  '$parent=@{}; Get-CimInstance Win32_Process | ForEach-Object { $parent[[int]$_.ProcessId]=[int]$_.ParentProcessId };' +
  'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.IDProcess -ne 0 } | ForEach-Object {' +
  ' [pscustomobject]@{ p=[int]$_.IDProcess; pp=$parent[[int]$_.IDProcess]; c=[int]$_.PercentProcessorTime; m=[long]$_.WorkingSet } } | ConvertTo-Json -Compress';

function perfCommand() {
  if (isWin) return { file: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', PERF_PS] };
  return { file: 'ps', args: ['-axo', 'pid=,ppid=,pcpu=,rss='] };
}
function perfParse(out) {
  if (isWin) {
    try { const j = JSON.parse(out); return Array.isArray(j) ? j : [j]; } catch (_) { return null; }
  }
  const list = [];
  for (const raw of String(out).split('\n')) {
    const m = raw.trim().split(/\s+/);
    if (m.length < 4) continue;
    const p = parseInt(m[0], 10), pp = parseInt(m[1], 10), c = parseFloat(m[2]), rssKb = parseInt(m[3], 10);
    if (!p) continue;
    list.push({ p, pp, c: Number.isFinite(c) ? c : 0, m: (Number.isFinite(rssKb) ? rssKb : 0) * 1024 });
  }
  return list;
}

module.exports = { isWin, isMac, loginShell, cellCommand, hookScriptPath, hookCommand, perfCommand, perfParse };
