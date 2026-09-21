/**
 * Regression: the index wrote rows under whatever spelling the caller happened to use, while every
 * reader addresses a row through `normalizePath`. Two of that function's steps rewrite the
 * DIRECTORY prefix -- `expandShortPath` expands a Windows 8.3 segment, `normalizeDarwinSystemAlias`
 * turns `/var/...` into `/private/var/...` -- and the writer applied neither. On a machine whose
 * project or temp path is reached through an 8.3 alias or the macOS `/var` symlink the file indexed
 * normally and then could not be looked up at all: `symbol`, `read`, `refs` and `section` each
 * answered as though it had never been indexed.
 *
 * Why no test caught it: every test built its fixtures under `os.tmpdir()`, and on Linux and on a
 * developer machine with a short user name that path is already canonical, so writer and reader
 * agreed by accident of environment. It surfaced only on GitHub's Windows runner
 * (`C:/Users/RUNNER~1`) and on macOS (`/var/folders`).
 *
 * FIXTURE PROVENANCE
 *
 * The two spellings below are HAND-DERIVED: `/mnt/c/...` and a backslash drive path are rewritten
 * by `shellMountToWindowsPath`, which is not platform-gated, so the expected answer is computed
 * from the input by hand rather than read off the implementation and holds on every platform.
 *
 * The end-to-end case is CAPTURE in the sense that matters: it does not invent a non-canonical
 * spelling, it asks the OS for one. `fs.realpathSync.native` disagreeing with the path `mkdtempSync`
 * just returned IS the condition the bug needs, and where the OS has no such disagreement to offer
 * there is nothing on that platform to regress, so the case reports that rather than pretending.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { canonicalizeIndexPath, indexFileSync } from '../src/parser.js'
import { globalDbPath, configPath } from '../src/constants.js'
import { getFileEntry, querySymbols } from '../src/index_reader.js'
import { resolveIndexPath, normalizePath } from '../src/paths.js'

fs.mkdirSync(path.dirname(configPath()), { recursive: true })

describe('the spelling the index is keyed on', () => {
  it('is one a reader can produce, for the shapes every platform rewrites', () => {
    expect(canonicalizeIndexPath('/mnt/c/proj/a.ts')).toBe('c:/proj/a.ts')
    expect(canonicalizeIndexPath('C:\\proj\\a.ts')).toBe('c:/proj/a.ts')
  })

  it('is a fixed point of the function every reader resolves through', () => {
    for (const p of ['/mnt/c/proj/a.ts', 'C:\\proj\\a.ts', '/tmp/plain/a.ts', os.tmpdir()]) {
      const key = canonicalizeIndexPath(p)
      expect(normalizePath(key), `not canonical: ${p}`).toBe(key)
    }
  })

  it('lets a file indexed through the OS-reported alias still be looked up', () => {
    const made = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-alias-'))
    const real = fs.realpathSync.native(made)
    // Compared RAW, not normalized. Normalizing both sides erases the alias that is the whole
    // condition here -- the first draft did that and skipped itself on the one platform shape it
    // was written for, passing against a parser that still had the bug.
    if (real === made) {
      // No alias on this platform's temp root, so there is no divergence here to regress. Windows
      // runners (8.3) and macOS (`/var`) do supply one, and that is where this case has teeth.
      expect(real).toBe(made)
      return
    }
    const through = path.join(made, 'doc.md')
    fs.writeFileSync(through, '# First Heading\n\ntext\n', 'utf-8')
    indexFileSync(through, globalDbPath())
    // Addressed the way every read command addresses it, from the alias the caller was handed.
    const lookup = resolveIndexPath('doc.md', made)
    expect(getFileEntry(lookup), 'indexed under a spelling no reader can produce').not.toBeNull()
    expect(querySymbols({ filePath: lookup, limit: -1 }).map((s) => s.name)).toContain('First Heading')
    fs.rmSync(made, { recursive: true, force: true })
  })
})
