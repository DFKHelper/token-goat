/** The dirty queue: the append-only file under `{dataDir}/queue/` that hooks and the CLI write changed paths into and the worker drains. Holds the path, the line format, the reader and the producers' append. Kept apart from worker.ts so a hook that only enqueues never loads the drain. */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { normalizePath } from './paths.js'
import { ensureDirSync, foldPath } from './util.js'

/** Absolute path to the dirty queue file for `dir`. */
export function dirtyQueuePathFor(dir: string): string {
  return path.join(dir, 'queue', 'dirty.txt')
}

/** Marks a queue line whose path could not survive the plain one-path-per-line format. A raw line is an absolute normalized path, which always begins with a slash or a drive letter, so a leading `!` cannot collide with one. The decoder also requires what follows to parse as a JSON string, so a hand-written or legacy line that happens to start with `!` is left alone rather than discarded. */
const ENCODED_LINE_MARKER = '!'

/** Render one path as a queue line. Almost every path is written as itself: that keeps the file byte-identical to what earlier builds produced, which matters because a queue left behind by an older build is read by this one. Only a path the format genuinely cannot hold is encoded -- one containing a line break, which would become two entries, or one whose first or last character is whitespace, which the reader's trim would quietly turn into a different path. */
export function encodeDirtyQueueLine(absPath: string): string {
  const needsEncoding = /[\r\n]/.test(absPath) || absPath !== absPath.trim()
  return needsEncoding ? ENCODED_LINE_MARKER + JSON.stringify(absPath) : absPath
}

/** Undo {@link encodeDirtyQueueLine}, leaving anything that is not a well-formed encoded line as it is. */
function decodeDirtyQueueLine(line: string): string {
  if (!line.startsWith(ENCODED_LINE_MARKER)) return line
  try {
    const decoded: unknown = JSON.parse(line.slice(ENCODED_LINE_MARKER.length))
    return typeof decoded === 'string' ? decoded : line
  } catch {
    return line
  }
}

/** Parse and deduplicate dirty queue lines. Used by both getDirtyPathsFor and the rename-to-claim drain logic, so every reader of the queue (the informational pre-compact snapshot through hooks_index.getDirtyPaths, doctor's pending count) dedupes on the same case-folded key as the real reindex drain rather than an exact-string match that missed case-variant duplicates on Windows/macOS. */
export function parseDirtyQueueLines(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = decodeDirtyQueueLine(line.trim())
    if (trimmed === '') continue
    // On case-insensitive filesystems (Windows/macOS), deduplicate by case-folded form so "C:\Projects\file.ts" and "c:\projects\file.ts" are recognized as the same entry. normalizePath only lowercases the drive letter, so we fold the entire normalized path for dedup.
    const normalized = normalizePath(trimmed)
    const dedupeKey = foldPath(normalized)
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push(trimmed)
  }
  return out
}

/** Read every queued dirty path for `dir`, deduplicated, in insertion order. Parameterised on the data dir so the detached worker (which may run with a different cwd) reads the same file; `hooks_index.getDirtyPaths` is this for the default data dir. Returns `[]` when the queue file is absent. */
export function getDirtyPathsFor(dir: string): string[] {
  let raw: string
  try {
    raw = fs.readFileSync(dirtyQueuePathFor(dir), 'utf8')
  } catch {
    return []
  }
  return parseDirtyQueueLines(raw)
}

/** Guard against a torn last line left by a previous crashed write: if the queue file already exists and does not end in a newline, the next append has to start with one so the partial line never merges with the appended path into a single garbage entry. Answers that question from the file's size and its final byte alone. Reading the whole file to look at one byte made every append cost the length of the queue, so enqueueing N paths read 1 + 2 + ... + N lines -- quadratic on a queue that routinely reaches four figures at session start. */
function dirtyQueueLeadingNewline(queuePath: string): string {
  let fd: number | undefined
  try {
    const size = fs.statSync(queuePath).size
    if (size === 0) return ''
    fd = fs.openSync(queuePath, 'r')
    const tail = Buffer.allocUnsafe(1)
    fs.readSync(fd, tail, 0, 1, size - 1)
    return tail[0] === 0x0a ? '' : '\n'
  } catch {
    // File doesn't exist yet (first append) -- nothing to guard against.
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // Nothing to do about a failed close of a read-only handle.
      }
    }
  }
}

/** Append `data` to `queuePath` and report whether the file written is still the one at that path afterwards. Compared by inode alone: some Windows Node versions report a device number of 0 from a path stat and the volume serial from a descriptor stat of the same file. */
function appendToLiveQueue(queuePath: string, data: string): boolean {
  const fd = fs.openSync(queuePath, 'a')
  try {
    fs.writeFileSync(fd, data)
    return fs.statSync(queuePath, { bigint: true, throwIfNoEntry: false })?.ino === fs.fstatSync(fd, { bigint: true }).ino
  } finally {
    fs.closeSync(fd)
  }
}

/** Append every path in `absPaths` to the dirty queue under `dir`, one path per line, in one filesystem append, and report whether they reached the live queue. Throws when the `queue/` directory or the file cannot be written. Creates both on first use. Uses append mode so concurrent producers accumulate; a trailing newline terminates each entry so {@link parseDirtyQueueLines} can split cleanly. The torn-line guard is consulted once for the whole batch, which is correct because the batch is written as a single append: only the first line of it can ever meet a partial line. The worker claims the queue by renaming it, and a handle opened before that rename still writes into the renamed file, which the worker deletes once it has read it a last time. A write landing after that read went out with the delete. So each append checks, after writing, that the file it wrote is still the one named `dirty.txt`, and writes again if a claim took it: from that point on the path is in a file the worker has yet to claim. A duplicate costs the drain one unchanged-sha skip. Every producer appends through here, the hooks and CLI through hooks_index.ts::appendDirtyPaths and the worker's own requeues through worker.ts::appendToDirtyQueue. */
export function appendDirtyQueuePaths(dir: string, absPaths: readonly string[]): boolean {
  if (absPaths.length === 0) return true
  const queuePath = dirtyQueuePathFor(dir)
  const queueDir = path.dirname(queuePath)
  try {
    ensureDirSync(queueDir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || !fs.existsSync(queueDir)) throw e
  }
  const body = absPaths.map((p) => `${encodeDirtyQueueLine(p)}\n`).join('')
  for (let attempt = 0; attempt < 3; attempt++) {
    if (appendToLiveQueue(queuePath, `${dirtyQueueLeadingNewline(queuePath)}${body}`)) return true
  }
  return false
}
