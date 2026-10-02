// src/search/path_weight.ts copies the path rules of embeddings.ts::_pathPriorityPenalty (embeddings.ts is off limits to edit and its constants are unexported), so this reads embeddings.ts as text and fails when the two drift: a path `semantic` treats as archival must be archival for `search` too.
//
// Provenance: FORMAT-DERIVED. The constant names and shapes are read off src/embeddings.ts itself (the const declarations near the "Path-segment fragments" comment); this proves agreement with that source, not with any shipped build.
import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { ARCHIVE_FILE_RE, ARCHIVE_PATH_SEGMENTS, DOCS_DIR_SEGMENT, DOCS_FILE_RE } from '../../src/search/path_weight.js'

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'embeddings.ts'), 'utf8')

function grab(re: RegExp, what: string): string {
  const m = re.exec(source)
  if (!m) throw new Error(`embeddings.ts no longer declares ${what} in the expected shape; update this guard and path_weight.ts together`)
  return m[1]!
}

describe('search path weight mirrors embeddings.ts', () => {
  it('has the same archive segments', () => {
    const body = grab(/const _ARCHIVE_PATH_SEGMENTS = new Set\(\[([^\]]*)\]/, '_ARCHIVE_PATH_SEGMENTS')
    const theirs = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort()
    expect(theirs.length).toBeGreaterThan(0)
    expect([...ARCHIVE_PATH_SEGMENTS].sort()).toEqual(theirs)
  })

  it('has the same archive and docs file patterns and docs directory', () => {
    const archive = grab(/const _ARCHIVE_FILE_RE = \/(.*)\/([a-z]*)\r?\n/, '_ARCHIVE_FILE_RE')
    const docs = grab(/const _DOCS_FILE_RE = \/(.*)\/([a-z]*)\r?\n/, '_DOCS_FILE_RE')
    expect(ARCHIVE_FILE_RE.source).toBe(archive)
    expect(DOCS_FILE_RE.source).toBe(docs)
    expect(ARCHIVE_FILE_RE.flags).toBe('i')
    expect(DOCS_FILE_RE.flags).toBe('i')
    expect(DOCS_DIR_SEGMENT).toBe(grab(/const _DOCS_DIR_SEGMENT = '([^']+)'/, '_DOCS_DIR_SEGMENT'))
  })
})
