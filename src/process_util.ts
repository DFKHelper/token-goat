/** Process and OS execution utilities. Extracted from src/util.ts as part of modular decomposition. */

import { spawnSync } from 'node:child_process'
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import * as path from 'node:path'

import { foldPath } from './path_containment.js'

/** Block the calling thread for `ms` milliseconds without spawning a process. Uses `Atomics.wait` on a throwaway SharedArrayBuffer: the wait never resolves (no other thread writes to it), so it always times out after `ms`. This is a true synchronous sleep, unlike a busy-loop, and burns no CPU. */
export function sleepSync(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Check if running on Windows. */
export function isWindows(): boolean {
  return process.platform === 'win32'
}

/** Windows creation flags for suppressing console windows (CREATE_NO_WINDOW). */
export function noWindowCreationFlags(): number {
  return isWindows() ? 0x08000000 : 0
}

/** Encode an argument safely for Windows cmd.exe invocations. */
export function windowsCmdQuoteArg(arg: string): string {
  if (arg === '') return '""'
  if (arg[0] === '"' && arg[arg.length - 1] === '"') {
    throw new Error(`windowsCmdQuoteArg: cannot faithfully encode an argument that both starts and ends with a literal double quote for cmd.exe: ${JSON.stringify(arg)}`)
  }
  let out = ''
  let inQuote = false
  let backslashes = 0

  const flushBackslashesPlain = (): void => {
    if (backslashes > 0) {
      out += '\\'.repeat(backslashes)
      backslashes = 0
    }
  }
  const flushBackslashesDoubled = (): void => {
    out += '\\'.repeat(backslashes * 2)
    backslashes = 0
  }
  const ensureQuoteOpen = (): void => {
    if (!inQuote) {
      flushBackslashesDoubled()
      out += '"'
      inQuote = true
    } else {
      flushBackslashesPlain()
    }
  }
  const ensureQuoteClosed = (): void => {
    if (inQuote) {
      flushBackslashesDoubled()
      out += '"'
      inQuote = false
    } else {
      flushBackslashesPlain()
    }
  }

  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    if (ch === '"') {
      flushBackslashesDoubled()
      if (inQuote) {
        out += '"'
        inQuote = false
      }
      out += '\\^"'
      continue
    }
    if (ch === '%' || ch === '!') {
      ensureQuoteClosed()
      out += `^${ch}`
      continue
    }
    ensureQuoteOpen()
    out += ch
  }
  ensureQuoteClosed()
  return out
}

/** Wraps a path in double quotes for embedding in a generated hook command line. */
export function quoteShellPath(value: string): string {
  if (process.platform === 'win32') return `"${value}"`
  return `"${value.replace(/[\\$`"]/g, '\\$&')}"`
}

/** Wraps a word in single quotes for a POSIX shell, on every platform (Claude Code runs Windows hooks through Git Bash): nothing inside them is special, and a single quote is written as `'\''`. */
export function quotePosixShellWord(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/** Wraps a path in single quotes for embedding in a generated PowerShell command. */
export function quotePowershellPath(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** What follows the program call in every PowerShell hook command line token-goat writes (see {@link powershellHookLine}). `powershell -Command` exits 1 for any nonzero native exit, which turns a hook's exit 2 (block) into exit 1 (a non-blocking error), so the line exits with the native code itself. Written without a `$` because Grok refuses to run a hook whose command names a variable it cannot resolve at load time; and guarded, because LASTEXITCODE is never set when the binary could not be started, where a bare `exit (Get-Variable LASTEXITCODE -ValueOnly)` exits 0 and a missing binary would pass as a hook that allowed the call. */
export const POWERSHELL_EXIT_SUFFIX = '; if (Get-Variable LASTEXITCODE -ErrorAction Ignore) { exit (Get-Variable LASTEXITCODE -ValueOnly) }; exit 1'

/** A complete PowerShell hook command line for `call`, a program and its arguments each already quoted for PowerShell: the call operator, since PowerShell reads two adjacent quoted strings as a parse error rather than a program and its argument, then POWERSHELL_EXIT_SUFFIX. The one shape of every PowerShell line token-goat writes, the native client's and the Node command's alike. */
export function powershellHookLine(call: string): string {
  return `& ${call}${POWERSHELL_EXIT_SUFFIX}`
}

/** Resolve `label` to an executable **on PATH**, never one sitting in the current directory. */
export function resolveOnPath(label: string): string | null {
  if (path.isAbsolute(label)) return existsSync(label) ? label : null
  if (label.includes('/') || label.includes('\\')) return null

  const onWindows = process.platform === 'win32'
  const exts = onWindows ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.trim() !== '') : ['']
  let cwd: string
  try { cwd = realpathSync(process.cwd()) } catch { cwd = path.resolve(process.cwd()) }

  for (const rawDir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    const dir = rawDir.trim().replace(/^"|"$/g, '')
    if (dir === '' || dir === '.') continue
    let resolvedDir: string
    try { resolvedDir = realpathSync(path.resolve(dir)) } catch { continue }
    if (foldPath(resolvedDir) === foldPath(cwd)) continue
    for (const ext of exts) {
      const candidate = path.join(resolvedDir, label + ext)
      try { if (statSync(candidate).isFile()) return candidate } catch { /* try the next extension */ }
    }
  }
  return null
}

/** Run `resolved`, a program {@link resolveOnPath} found, with `args` and no shell. A Windows `.cmd` or `.bat` shim, which is what a global npm install puts on PATH, cannot be spawned directly (Node refuses batch files with EINVAL since 20.12 and 21.7), so it runs through System32's cmd.exe by absolute path, never a bare `cmd.exe` the current directory could supply. `/s /c` strips the first and last quote on the line and runs the rest, so the line is quoted whole around words each encoded by {@link windowsCmdQuoteArg} and passed verbatim; passed as separate arguments instead, the two quotes stripped were the ones around the shim's path, and a shim in a directory with a space in its path ran as the path up to the space. */
export function spawnResolvedSync(resolved: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> {
  if (!isWindows() || !/\.(?:cmd|bat)$/i.test(resolved)) return spawnSync(resolved, args, options)
  const comspec = path.join(process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows', 'System32', 'cmd.exe')
  const line = [resolved, ...args].map(windowsCmdQuoteArg).join(' ')
  return spawnSync(existsSync(comspec) ? comspec : 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true })
}

/** Swallow EPIPE on stdio streams. */
export function installEpipeGuard(streams?: Array<NodeJS.WriteStream | undefined>): Array<NodeJS.WriteStream> {
  const targets = (streams ?? [process.stdout, process.stderr]).filter((s): s is NodeJS.WriteStream => s !== undefined)
  for (const stream of targets) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        process.exitCode = 0
        return
      }
      throw err
    })
  }
  return targets
}
