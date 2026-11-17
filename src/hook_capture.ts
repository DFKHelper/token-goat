/** Opt-in capture of the hook payloads token-goat receives, so a real payload (Claude Code Code Mode calls, for one) can be read or turned into a test fixture. */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** The environment variable that turns capture on: an absolute directory path. Unset, empty or relative means off. */
export const HOOK_CAPTURE_ENV = 'TOKEN_GOAT_HOOK_CAPTURE'

/** The one file capture appends to, inside the directory the variable names. A fixed name, so the variable can never point a write outside that directory. */
export const HOOK_CAPTURE_FILE = 'hook-payloads.jsonl'

/** Largest serialized payload capture writes; a bigger one is skipped whole, never cut mid-line. */
export const HOOK_CAPTURE_MAX_PAYLOAD_BYTES = 1048576

/** Capture appends nothing once the capture file is at or past this many bytes. */
export const HOOK_CAPTURE_MAX_FILE_BYTES = 16777216

/** Append `rawPayload` as one JSON line to {@link HOOK_CAPTURE_FILE} in the directory {@link HOOK_CAPTURE_ENV} names. The variable is read before the first await, under the caller's environment, because a resident server swaps it in only for the length of one request. Never rejects and never throws: the write is not awaited by the hook, and any failure (an unwritable directory, a payload that cannot be serialized) is dropped, since a capture aid must not change what a hook answers. The payload is stored as received, secrets included, and the file only grows; the directory is the user's to protect and to clear. */
export function captureHookPayload(rawPayload: unknown, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    const dir = env[HOOK_CAPTURE_ENV]
    if (dir === undefined || dir === '' || !isFullyQualified(dir)) return Promise.resolve()
    const line = JSON.stringify(rawPayload)
    if (line === undefined) return Promise.resolve()
    if (Buffer.byteLength(line, 'utf8') > HOOK_CAPTURE_MAX_PAYLOAD_BYTES) return Promise.resolve()
    const file = path.join(dir, HOOK_CAPTURE_FILE)
    return fs.promises
      .mkdir(dir, { recursive: true })
      .then(() => fs.promises.stat(file).then((s) => s.size, () => 0))
      .then((size) => {
        if (size >= HOOK_CAPTURE_MAX_FILE_BYTES) return undefined
        return fs.promises.appendFile(file, line + '\n', { encoding: 'utf8', mode: 0o600 })
      })
      .catch(() => undefined)
  } catch {
    return Promise.resolve()
  }
}

/** Absolute, and on Windows rooted at a drive letter or a UNC share: a bare `\dir` names no drive, so it is refused. */
function isFullyQualified(dir: string): boolean {
  if (!path.isAbsolute(dir)) return false
  if (process.platform !== 'win32') return true
  const root = path.win32.parse(dir).root
  return /^[A-Za-z]:[\\/]$/.test(root) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(root)
}
