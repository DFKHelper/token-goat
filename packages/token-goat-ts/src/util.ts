/**
 * Cross-cutting helpers shared across token-goat modules.
 *
 * Kept intentionally small: only utilities with no natural owner that would
 * otherwise be duplicated. Imports only Node built-ins and other Layer 1 files.
 *
 * IMPORTANT: `runGit` is the ONLY place in the entire codebase that spawns git.
 * A structural test (git_chokepoint.test.ts) greps every src/*.ts for bare git
 * spawn patterns outside this file and fails if any are found.
 */

import { spawnSync } from 'node:child_process'
import { closeSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import * as path from 'node:path'

import { normalizePath } from './paths.js'
import type { GitResult, RunGitOptions } from './types.js'

export { normalizePath }

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

/** Windows creation flags for suppressing console windows (CREATE_NO_WINDOW). */
export function noWindowCreationFlags(): number {
  return process.platform === 'win32' ? 0x08000000 : 0
}

/**
 * Run git and return its captured output.
 *
 * THE ONLY git spawn site in the codebase. Always:
 *   - prepends `-c core.fsmonitor=` to disable fsmonitor (prevents it from
 *     interfering with or being slowed by the agent's own git operations);
 *   - passes `windowsHide: true` so no console window flashes on Windows;
 *   - passes the args array directly (no shell, so nothing is shell-escaped).
 *
 * Output is decoded as UTF-8. A spawn failure (git not on PATH) surfaces as a
 * non-zero `exitCode` with the error message on `stderr` rather than throwing.
 */
export function runGit(args: string[], opts: RunGitOptions = {}): GitResult {
  const fullArgs = ['-c', 'core.fsmonitor=', ...args]
  const result = spawnSync('git', fullArgs, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    encoding: 'utf-8',
    windowsHide: true,
  })

  if (result.error) {
    return { stdout: '', stderr: String(result.error.message ?? result.error), exitCode: -1 }
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    // status is null when the process was terminated by a signal; treat as -1.
    exitCode: result.status ?? -1,
  }
}

/** Errno codes worth retrying on Windows when a file is briefly locked. */
const RETRYABLE_ERRNO: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'ETXTBSY'])

function isRetryable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && RETRYABLE_ERRNO.has(code)
}

/**
 * Shared atomic-write core for text and bytes.
 *
 * Writes `content` to a sibling temp file (created with 0o600 so it is never
 * world-readable even transiently on POSIX), then renames over `dest`. On
 * Windows a brief exclusive-lock window can make the rename fail with
 * EPERM/EBUSY/ETXTBSY; we retry up to 5 times with a `50 * attempt` ms backoff.
 */
function atomicWriteCore(dest: string, content: string | Uint8Array): void {
  // Two-component temp name: pid + high-resolution time avoids collisions
  // across concurrent and rapid sequential writes to the same path.
  const tmp = `${dest}.${process.pid}.${process.hrtime.bigint().toString()}.tmp`

  // mode 0o600: owner read/write only (no effect on Windows ACLs, but harmless).
  const fd = openSync(tmp, 'w', 0o600)
  // eslint-disable-next-line no-useless-assignment -- initial false is the sentinel read in the outer finally when writeSync throws before wrote = true
  let wrote = false
  try {
    if (typeof content === 'string') {
      // Encode ourselves so we control the encoding; a Buffer write avoids the
      // CRLF translation a text-mode stream could apply on Windows.
      writeSync(fd, Buffer.from(content, 'utf-8'))
    } else {
      writeSync(fd, Buffer.from(content))
    }
    wrote = true
  } finally {
    closeSync(fd)
  }

  let renamed = false
  try {
    let lastErr: unknown
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        renameSync(tmp, dest)
        renamed = true
        return
      } catch (err) {
        lastErr = err
        if (!isRetryable(err) || attempt === 5) throw err
        sleepSync(50 * attempt)
      }
    }
    // Unreachable: the loop either returns or throws, but satisfies tsc.
    throw lastErr
  } finally {
    if (wrote && !renamed) {
      // Clean up the orphaned temp file on a failed rename. Best-effort.
      try {
        unlinkSync(tmp)
      } catch {
        // ignore: temp cleanup is best-effort
      }
    }
  }
}

/**
 * Atomically write UTF-8 text to `filePath` via a temp file + rename.
 *
 * Avoids partial writes if the process is killed mid-flight. The temp file is
 * created with 0o600 permissions. Retries the rename on transient Windows
 * file-lock errors (EPERM/EBUSY/ETXTBSY) up to 5 times.
 */
export function atomicWriteText(filePath: string, content: string): void {
  atomicWriteCore(filePath, content)
}

/**
 * Atomically write raw bytes to `filePath` via a temp file + rename.
 *
 * Same guarantees as {@link atomicWriteText} but for binary content; writing
 * bytes directly avoids the CRLF doubling a text path could introduce on
 * Windows.
 */
export function atomicWriteBytes(filePath: string, content: Buffer | Uint8Array): void {
  atomicWriteCore(filePath, content)
}

/** Truncate `s` to `maxChars`, appending a single ellipsis when it overflows. */
export function ellipsize(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  return s.slice(0, maxChars - 1) + '…'
}

/** Strip leading/trailing whitespace and lowercase (matches util.py strip_lower). */
export function stripLower(s: string): string {
  return s.trim().toLowerCase()
}

/** Basename of a path, mirroring Python's os.path.basename for convenience. */
export function basename(p: string): string {
  return path.basename(p)
}
