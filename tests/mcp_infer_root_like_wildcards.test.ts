import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { inferProjectRootFromTarget } from '../src/mcp_server.js'
import { normalizePath } from '../src/util.js'

// Provenance: HAND-DERIVED. In SQL LIKE, `_` matches any one character, so `%/a_b.ts` also matches `/x/axb.ts`; the decoy and target rows below are chosen so only a literal match picks the target. The ordering case inserts the longer path first, so an unordered LIMIT returns it first.
describe('inferProjectRootFromTarget file-suffix lookup', () => {
  let scratch: string
  const insert = (p: string): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'x')
    getDb(globalDbPath()).prepare('INSERT INTO files (path, sha, mtime, language, indexed_at) VALUES (?, ?, ?, ?, ?)').run(normalizePath(p), 's', 0, 'typescript', 0)
  }

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-infer-like-'))
  })
  afterEach(() => {
    getDb(globalDbPath()).prepare('DELETE FROM files WHERE path LIKE ?').run(`${normalizePath(scratch)}%`)
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  it('treats an underscore in the file name literally, not as a wildcard', () => {
    insert(path.join(scratch, 'decoy-dir', 'axb.ts'))
    insert(path.join(scratch, 'target-dir', 'deep', 'a_b.ts'))
    const root = inferProjectRootFromTarget('a_b.ts')
    expect(root).not.toBeNull()
    expect(normalizePath(root as string)).toContain('target-dir')
    expect(normalizePath(root as string)).not.toContain('decoy-dir')
  })

  it('prefers the shortest matching path regardless of insertion order', () => {
    insert(path.join(scratch, 'long-dir', 'nested', 'deeper', 'same_name.ts'))
    insert(path.join(scratch, 'short-dir', 'same_name.ts'))
    const root = inferProjectRootFromTarget('same_name.ts')
    expect(normalizePath(root as string)).toContain('short-dir')
  })
})
