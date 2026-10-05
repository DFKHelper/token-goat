/** healStaleIndex reparsed a file only when its bytes no longer matched files.sha, so rows an older extractor wrote for unchanged bytes were served as current. reconcile.ts sweeps parser-stale rows, but only at session start in a project that was run through `token-goat index`; a file `outline`/`symbol`/`read` indexed on demand anywhere else kept the old extractor's spans after every upgrade. Fixture provenance: CAPTURE. The stale rows are the ones the build before d79e113d really wrote for this Scala file: `b` spanning 8-11 (its brace search ran into the `locally` block below it), stamped with that build's Scala digest `f68090b8b747b686`, read off `git show d79e113d^:src/parser_fingerprint.ts`. The fresh 8-8 span is HAND-DERIVED: `def b: Int = 2` is a one-line expression body. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { getDb } from '../src/db.js'
import { globalDbPath } from '../src/constants.js'
import { getFileEntry } from '../src/index_reader.js'
import { indexFileSync } from '../src/parser.js'
import * as parserModule from '../src/parser.js'
import { parserFingerprintForLanguage } from '../src/parser_stamp.js'
import { normalizePath } from '../src/paths.js'
import { runOutline } from '../src/read_outline.js'
import { runSymbol } from '../src/read_symbol.js'

const SOURCE = ['object A:', '  def a: Int = 1', '', '  locally {', '    println(1)', '  }', '', 'def b: Int = 2', '', 'locally {', '  println(2)', '}', ''].join('\n')

const OLD_SCALA_STAMP = 'f68090b8b747b686'

/** Index `file` with the current parser, then put back the rows and stamp the pre-d79e113d build left for the same bytes. */
function seedOldExtractorRows(file: string): string {
  const resolved = normalizePath(file)
  indexFileSync(resolved)
  const db = getDb(globalDbPath())
  const oldBody = SOURCE.split('\n').slice(7, 11).join('\n')
  db.prepare("UPDATE symbols SET line_end = 11, body = ? WHERE file_path = ? AND name = 'b'").run(oldBody, resolved)
  db.prepare('UPDATE files SET parser_sha = ? WHERE path = ?').run(OLD_SCALA_STAMP, resolved)
  // Premise: the bytes still match, so only the parser stamp says these rows are old.
  const entry = getFileEntry(resolved)
  expect(entry?.parserSha).toBe(OLD_SCALA_STAMP)
  expect(parserFingerprintForLanguage('scala')).not.toBe(OLD_SCALA_STAMP)
  return resolved
}

describe('a single-file read reparses rows an older extractor wrote for unchanged bytes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('outline serves the current extractor spans and restamps the file', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-parser-stale-outline-'))
    try {
      const file = join(root, 'Pre.scala')
      writeFileSync(file, SOURCE)
      const resolved = seedOldExtractorRows(file)
      const spy = vi.spyOn(parserModule, 'indexFileSync')

      const { text, code } = runOutline({ file })
      expect(code).toBe(0)
      // Also proves the spy sees the heal's reparse, so the control below is not vacuous.
      expect(spy).toHaveBeenCalledTimes(1)
      expect(text).toMatch(/^\s*8-8\s+function\s+b\b/m)
      expect(text).not.toMatch(/8-11/)
      expect(getFileEntry(resolved)?.parserSha).toBe(parserFingerprintForLanguage('scala'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('symbol --file returns the one-line body, not the block below it', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-parser-stale-symbol-'))
    try {
      const file = join(root, 'Pre.scala')
      writeFileSync(file, SOURCE)
      seedOldExtractorRows(file)

      const { text, code } = runSymbol({ name: 'b', file })
      expect(code).toBe(0)
      expect(text).toContain('def b: Int = 2')
      expect(text).not.toContain('println(2)')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Control: a file whose sha and stamp both match is not reparsed on every read.
  it('leaves a current row alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-parser-stale-current-'))
    try {
      const file = join(root, 'Pre.scala')
      writeFileSync(file, SOURCE)
      indexFileSync(normalizePath(file))
      const spy = vi.spyOn(parserModule, 'indexFileSync')

      const { code } = runOutline({ file })
      expect(code).toBe(0)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
