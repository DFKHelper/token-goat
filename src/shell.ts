// Resolve the shell used to run wrapped bash commands (`token-goat compress`).
//
// The pre-bash hook rewrites a Bash tool call into `token-goat compress -c '<cmd>'`, which re-runs <cmd> via spawnSync. On POSIX, spawnSync's `shell: true` uses /bin/sh — correct. On Windows, `shell: true` uses cmd.exe (ComSpec), which cannot run the bash the harness wrote: $VAR expansion, $(...), 2>/dev/null redirects, and quoting all differ, so the command either fails ("The system cannot execute the specified program") or returns silently wrong output. This module locates the harness's bash so the wrapper runs <cmd> under the same interpreter that produced it.
//
// Target is Git-Bash / MSYS bash.exe, never the WSL launcher (System32\bash.exe or the WindowsApps alias): WSL bash runs in the Linux filesystem and would resolve the Windows cwd against the WSL root, behaving nothing like the harness. These functions run once per process (one compress invocation, or one PreToolUse hook), so the PATH scan is not memoized.

import * as fs from 'node:fs'
import * as path from 'node:path'

// Final path segments that mark a directory as a WSL bash.exe launcher rather than a real Git-Bash install. Matched as exact path segments (not substrings) so a directory merely containing "system32" in a longer name — e.g. system32-compat — is not wrongly excluded.
const WSL_LAUNCHER_SEGMENTS = new Set(['system32', 'syswow64', 'windowsapps'])

function isExecutable(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

// True when any path segment of *dir* is a known WSL-launcher directory. Splits on both separators via regex (not path.basename, which only splits the host platform's separator) so the check behaves identically when unit-tested on a POSIX runner with Windows-style paths.
function isWslLauncherDir(dir: string): boolean {
  return dir
    .toLowerCase()
    .split(/[\\/]+/)
    .some((seg) => WSL_LAUNCHER_SEGMENTS.has(seg))
}

// Locate a Git-Bash / MSYS bash.exe from a Windows PATH value, skipping the WSL launchers. Exported for testing with a synthetic PATH; production calls it with process.env.PATH.
export function locateBashOnPath(
  pathValue: string | undefined,
  isExe: (p: string) => boolean = isExecutable,
): string | null {
  for (const dir of (pathValue ?? '').split(path.delimiter)) {
    if (!dir || isWslLauncherDir(dir)) continue
    const cand = path.join(dir, 'bash.exe')
    if (isExe(cand)) return cand
  }
  return null
}

// Known Git-for-Windows install roots, checked when PATH has no usable bash.
function knownGitBashPaths(): string[] {
  const localPrograms = process.env['LOCALAPPDATA']
    ? path.join(process.env['LOCALAPPDATA'], 'Programs')
    : undefined
  const bases = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['ProgramW6432'],
    localPrograms,
  ]
  const out: string[] = []
  for (const base of bases) {
    if (!base) continue
    out.push(path.join(base, 'Git', 'bin', 'bash.exe'))
    out.push(path.join(base, 'Git', 'usr', 'bin', 'bash.exe'))
  }
  return out
}

// The Windows bash.exe to run wrapped commands under, or null if none is found (Windows only; returns null off-Windows because `shell: true` already selects a POSIX shell there). TOKEN_GOAT_BASH overrides the search for unusual installs.
export function resolveWindowsBash(): string | null {
  if (process.platform !== 'win32') return null
  const override = process.env['TOKEN_GOAT_BASH']
  if (override && isExecutable(override)) return override
  const onPath = locateBashOnPath(process.env['PATH'])
  if (onPath) return onPath
  for (const cand of knownGitBashPaths()) {
    if (isExecutable(cand)) return cand
  }
  return null
}

// The value for spawnSync's `shell` option when running a wrapped command. POSIX: `true` (/bin/sh). Windows: the resolved bash.exe, or `true` (cmd.exe) as a last resort when no bash is found — the rewrite hook declines in that case (see canRunWrappedShell), so the last-resort branch only applies to a direct `token-goat compress` invocation.
export function wrappedShell(): string | boolean {
  if (process.platform !== 'win32') return true
  return resolveWindowsBash() ?? true
}

// Whether the compress-rewrite can run the inner command under a bash-compatible shell. POSIX always can (/bin/sh); Windows only when a bash.exe is resolvable. The rewrite hook gates on this so it never rewrites a command into a form that would run under cmd.exe.
export function canRunWrappedShell(): boolean {
  return process.platform !== 'win32' || resolveWindowsBash() !== null
}
