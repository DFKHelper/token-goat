import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { MAX_CAPTURE_BYTES } from './constants.js'
import { isInsideRoot } from './path_containment.js'
import { shellMountToWindowsPath } from './paths.js'

/**
 * Notice header emitted by Copilot SDK/CLI when tool output exceeds its inline threshold.
 * e.g.:
 * Output too large to read at once (121.1 KB). Saved to: C:\Users\...\AppData\Local\Temp\1794481520586-copilot-tool-output-3744-3fefc038-c1a5-4c88-a06c-1e7fdcfdcea9.txt
 */
export const COPILOT_SPOOLED_NOTICE_RE = /^Output too large to read at once[^\r\n]*\. Saved to:[ \t]*([^\r\n]+)/im

/**
 * Strict basename regex for Copilot spooled tool output files.
 * Enforces copilot-tool-output in the filename and a .txt extension.
 */
export const COPILOT_SPOOLED_FILENAME_RE = /^(?:\d+-)?copilot-tool-output(?:-[\w-]+)?\.txt$/i

/**
 * Returns true if text starts with or contains the Copilot SDK spooled output notice.
 */
export function isCopilotSpooledNotice(text: unknown): boolean {
  return typeof text === 'string' && COPILOT_SPOOLED_NOTICE_RE.test(text)
}

/**
 * Returns true if the hook event was dispatched from a Copilot CLI or VS Code Copilot harness.
 */
export function isCopilotHarness(raw: Record<string, unknown> | undefined): boolean {
  if (!raw) return false
  const harness = raw['_tg_harness']
  return harness === 'copilot_cli' || harness === 'vscode'
}

/**
 * Extracts candidate file path from Copilot spooled output notice text.
 */
export function extractCopilotSpooledPath(text: string): string | null {
  if (typeof text !== 'string' || text.length === 0) return null
  const m = text.match(COPILOT_SPOOLED_NOTICE_RE)
  if (!m || !m[1]) return null
  const candidate = m[1].trim().replace(/^["']|["']$/g, '')
  return candidate.length > 0 ? candidate : null
}

/**
 * Safely reads a spooled file from disk via descriptor-bounded I/O.
 * Normalizes candidate path to native OS format, validates link-aware containment in `rootDirectory`,
 * matches basename against `filenamePattern`, opens non-blocking, checks `fstatSync` for a regular file
 * bounded to `maxBytes`, re-verifies post-open containment, and reads the full buffer.
 */
export function readConfinedSpoolFile(
  candidatePath: string,
  rootDirectory: string,
  options?: {
    maxBytes?: number
    filenamePattern?: RegExp
  },
): string | null {
  const maxBytes = options?.maxBytes ?? MAX_CAPTURE_BYTES
  const filenamePattern = options?.filenamePattern ?? COPILOT_SPOOLED_FILENAME_RE

  // Convert shell mount paths (e.g. /c/TEMP) to Windows native drive paths (C:/TEMP) on Windows
  const nativeCandidate = process.platform === 'win32'
    ? path.win32.normalize(shellMountToWindowsPath(candidatePath))
    : path.resolve(candidatePath)

  if (!isInsideRoot(nativeCandidate, rootDirectory)) return null

  const base = path.basename(nativeCandidate)
  if (!filenamePattern.test(base)) return null

  let fd: number | undefined
  try {
    // 1. Pre-open lstat: ensure the candidate path is a regular file, rejecting any symbolic link
    const preLstat = fs.lstatSync(nativeCandidate, { bigint: true })
    if (!preLstat.isFile() || preLstat.isSymbolicLink()) {
      return null
    }

    const flags = process.platform === 'win32' ? fs.constants.O_RDONLY : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK
    fd = fs.openSync(nativeCandidate, flags)
    const stat = fs.fstatSync(fd, { bigint: true })
    if (!stat.isFile() || stat.size === 0n || stat.size > BigInt(maxBytes)) {
      return null
    }

    // 2. Post-open identity verification: ensure opened fd matches pre-open lstat identity across platforms
    const preIdentity = `${preLstat.dev}:${preLstat.ino}`
    const postIdentity = `${stat.dev}:${stat.ino}`
    if (preIdentity !== postIdentity) {
      return null
    }

    // 3. Post-open containment check: ensure canonical path is still inside rootDirectory
    const openedPath = fs.realpathSync.native(nativeCandidate)
    if (!isInsideRoot(openedPath, rootDirectory)) {
      return null
    }

    const size = Number(stat.size)
    const buf = Buffer.alloc(size)
    let bytesRead = 0
    while (bytesRead < size) {
      const n = fs.readSync(fd, buf, bytesRead, size - bytesRead, bytesRead)
      if (n === 0) break
      bytesRead += n
    }
    return buf.toString('utf-8', 0, bytesRead)
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // ignore close errors
      }
    }
  }
}

/**
 * Detects Copilot SDK/CLI large output spooled file notice and reads the full text from disk
 * when it was safely saved inside the temporary directory.
 */
export function readCopilotSpooledBashOutput(text: unknown, tempRoot: string = os.tmpdir()): string | null {
  if (typeof text !== 'string') return null
  const candidatePath = extractCopilotSpooledPath(text)
  if (candidatePath === null) return null
  return readConfinedSpoolFile(candidatePath, tempRoot)
}
