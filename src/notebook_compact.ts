/**
 * Strip cell outputs from Jupyter notebooks to reduce token burn.
 *
 * `stripNotebook()` strips all cell outputs and execution counts from
 * a notebook dict in-place-safe (returns a new dict). `getOrCreateSidecar()`
 * caches the stripped version keyed on the SHA-256 of the original bytes so
 * subsequent reads of an unchanged notebook skip the stripping work.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

import { atomicWriteBytes } from './util.js'

// Minimum bytes saved by output stripping before a redirect is worth emitting.
export const NB_STRIP_MIN_SAVINGS = 4096

export interface NotebookCell {
  cell_type: string
  outputs?: unknown[]
  execution_count?: number | null
  [key: string]: unknown
}

export interface NotebookDict {
  cells?: NotebookCell[]
  [key: string]: unknown
}

/**
 * Return a new notebook dict with all code-cell outputs cleared.
 *
 * Markdown and raw cells are left untouched. `execution_count` on code cells
 * is set to `null` so re-execution counts are not misleading. The `outputs`
 * array is replaced with `[]`; other fields are preserved.
 */
export function stripNotebook(nbDict: NotebookDict): NotebookDict {
  const cells: NotebookCell[] = []
  for (const cell of nbDict.cells ?? []) {
    if (cell.cell_type === 'code') {
      cells.push({
        ...cell,
        outputs: [],
        execution_count: null,
      })
    } else {
      cells.push(cell)
    }
  }
  return { ...nbDict, cells }
}

/**
 * Return `[sidecarPath, created]` for the stripped version of `rawBytes`.
 *
 * If a sidecar already exists for this exact content (same SHA-256), return it
 * directly without re-stripping (`created=false`). Otherwise parse, strip,
 * write, and return (`created=true`). Throws `Error` if `rawBytes` is not valid
 * JSON or not a recognisable notebook dict.
 */
export function getOrCreateSidecar(
  rawBytes: Buffer,
  cacheRoot: string,
): [string, boolean] {
  const sha = crypto.createHash('sha256').update(rawBytes).digest('hex')
  const sidecarDir = path.join(cacheRoot, 'nb_strip', sha)
  const sidecarPath = path.join(sidecarDir, 'stripped.ipynb')

  if (fs.existsSync(sidecarPath)) {
    return [sidecarPath, false]
  }

  let nb: unknown
  try {
    nb = JSON.parse(rawBytes.toString('utf-8'))
  } catch (err) {
    throw new Error(`Failed to parse notebook JSON: ${String(err)}`, { cause: err })
  }

  if (typeof nb !== 'object' || nb === null || !('cells' in nb)) {
    throw new Error('Not a notebook')
  }

  const nbDict = nb as NotebookDict
  const stripped = stripNotebook(nbDict)

  // Create directory with retry for Windows race conditions.
  try {
    fs.mkdirSync(sidecarDir, { recursive: true })
  } catch (err) {
    if (!fs.existsSync(sidecarDir)) {
      throw err
    }
  }

  const strippedJson = JSON.stringify(stripped, null, 2) + '\n'
  atomicWriteBytes(sidecarPath, Buffer.from(strippedJson, 'utf-8'))

  return [sidecarPath, true]
}
