/** What the session's last Read of each file actually delivered, when that was less than the whole file, kept beside the session so a later Edit of the file can be booked against it. A structural rewrite (outline, skeleton, body/comment/prose fold) or a partial window hands the model part of a file, and an Edit composed from that part may land on lines it was never shown. Nothing recorded the pairing, so there was no way to say how often it happens. postReadHandler writes the shape here and clears it on the next Read that delivers the whole file; postEditHandler reads it. Read and Edit run as separate hook processes, so the record lives on disk, one small JSON map per state key. Best-effort throughout: a failed read or write loses a measurement, never a hook. */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sessionSidecarPath } from './session_store.js'
import { ensureDirSync } from './util.js'

/** How a Read fell short of the whole file: `outline` and `skeleton` replaced it with its structure, `fold` withheld bodies, comments or paragraphs inside it, `truncated` is the harness cutting it at its own cap, and `partial` is a window that did not cover the file. */
export type ReadShape = 'outline' | 'skeleton' | 'fold' | 'truncated' | 'partial'

const SHAPES: ReadonlySet<string> = new Set<ReadShape>(['outline', 'skeleton', 'fold', 'truncated', 'partial'])

// Not `.json`: sessionSidecarPath refuses any other file ending in `.json`, because every reader that lists the sessions directory takes one to be a session.
const SHAPE_SUFFIX = '.read-shape'

// A session touches far fewer files than this; the cap only bounds a runaway one, dropping the oldest entries first.
const MAX_ENTRIES = 512

function load(target: string): Record<string, ReadShape> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, ReadShape>) : {}
  } catch {
    return {}
  }
}

/** Record that the last Read of `file` under `stateKey` delivered `shape`, or, with `null`, that it delivered the whole file. A whole-file Read of a file with no record writes nothing, so the common case costs one failed open. */
export function recordReadShape(stateKey: string, file: string, shape: ReadShape | null): void {
  const target = sessionSidecarPath(stateKey, SHAPE_SUFFIX)
  if (target === null) return
  try {
    const shapes = load(target)
    if (shape === null) {
      if (!Object.hasOwn(shapes, file)) return
      delete shapes[file]
    } else {
      // Re-inserted so the key order stays oldest-first for the cap below.
      delete shapes[file]
      shapes[file] = shape
    }
    const keys = Object.keys(shapes)
    if (keys.length === 0) {
      rmSync(target, { force: true })
      return
    }
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete shapes[k]
    ensureDirSync(dirname(target))
    writeFileSync(target, JSON.stringify(shapes), 'utf8')
  } catch {
    // See the module doc comment.
  }
}

/** The shape of the last Read of `file` under `stateKey` when it fell short of the whole file, or `null` when it did not, or when there is no record. */
export function readShapeOf(stateKey: string, file: string): ReadShape | null {
  const target = sessionSidecarPath(stateKey, SHAPE_SUFFIX)
  if (target === null) return null
  const shapes = load(target)
  const shape = Object.hasOwn(shapes, file) ? shapes[file] : undefined
  return shape !== undefined && SHAPES.has(shape) ? shape : null
}
