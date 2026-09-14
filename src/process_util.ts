/**
 * Process and OS execution utilities.
 *
 * Extracted from src/util.ts as part of modular decomposition.
 */

import { existsSync, realpathSync, statSync } from 'node:fs'
import * as path from 'node:path'

import { foldPath } from './path_containment.js'

/**
 * Block the calling thread for `ms` milliseconds without spawning a process.
 *
 * Uses `Atomics.wait` on a throwaway SharedArrayBuffer: the wait never resolves
 * (no other thread writes to it), so it always times out after `ms`. This is a
 * true synchronous sleep, unlike a busy-loop, and burns no CPU.
 */
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

/**
 * Encode an argument safely for Windows cmd.exe invocations.
 */
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

/** Wraps a path in single quotes for embedding in a generated PowerShell command. */
export function quotePowershellPath(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Resolve `label` to an executable **on PATH**, never one sitting in the current directory.
 */
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
