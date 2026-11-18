/** The shell Claude Code runs a string-form hook command in, so the guard uses that shell's syntax. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { GuardShell } from './hook_guard.js'

/** The `shell` hook field value (code.claude.com/docs/en/hooks, command hook fields) for each guard syntax. */
export const CLAUDE_HOOK_SHELL_FIELD: Readonly<Record<'sh' | 'powershell', 'bash' | 'powershell'>> = {
  sh: 'bash',
  powershell: 'powershell',
}

/** Whether the basename alone is bash or sh, so `my-bash.exe` is no match; case-insensitive on Windows. */
function isBashName(p: string): boolean {
  const base = path.basename(p.replace(/\\/g, '/'))
  return /^(?:bash|sh)(?:\.exe)?$/.test(process.platform === 'win32' ? base.toLowerCase() : base)
}

/** Whether Claude Code finds Git Bash: the bash or sh `CLAUDE_CODE_GIT_BASH_PATH` names, else by git.exe. */
export function claudeFindsGitBash(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
): boolean {
  const named = env['CLAUDE_CODE_GIT_BASH_PATH']
  if (named !== undefined && isBashName(named) && exists(named)) return true
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (dir === '' || !exists(path.join(dir, 'git.exe'))) continue
    const root = path.dirname(dir)
    if (exists(path.join(root, 'bin', 'bash.exe'))) return true
    if (exists(path.join(path.dirname(root), 'bin', 'bash.exe'))) return true
  }
  return false
}

/** The guard syntax and `shell` field to register: sh unless Windows lacks Git Bash; none off Windows. */
export function claudeHookShell(
  platform: NodeJS.Platform = process.platform,
  gitBash: boolean = platform === 'win32' && claudeFindsGitBash(),
): { guard: GuardShell; field?: 'bash' | 'powershell' } {
  if (platform !== 'win32') return { guard: 'sh' }
  const guard = gitBash ? 'sh' : 'powershell'
  return { guard, field: CLAUDE_HOOK_SHELL_FIELD[guard] }
}
