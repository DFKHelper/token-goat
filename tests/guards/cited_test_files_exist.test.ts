/**
 * Every test file a guard's doc comment cites must exist.
 *
 * A guard's docstring is where it says which half of its subject it does NOT check and who checks
 * the rest: `storage_dirs_are_hardened` said "the POSIX mode itself is asserted at runtime by
 * `tests/data_dir_private.test.ts`", and that file has never existed. Nothing was red, because a
 * citation is prose -- and prose that names a delivered check is worse than an admitted gap, since
 * it reads as a decision someone already made. Two audit rounds read past it. The real file was
 * `tests/data_dir_permissions.test.ts`, four characters away.
 *
 * Scope is deliberately narrow, to keep the false-positive rate at zero rather than merely low:
 * only doc-comment lines (`*`-prefixed) in `tests/guards/**`, where a cited test file is load-
 * bearing evidence for a claim the guard makes about its own coverage. A whole-repo scan was
 * measured first and rejected: 22 of 515 citations do not resolve, nearly all of them synthetic
 * fixture names inside test data (`tests/foo.test.ts`), which is a 4% noise rate on a check whose
 * whole value is that a hit means something. Off-ramp: if this ever starts flagging citations that
 * are correct as written, narrow the pattern or delete the file -- a citation check that has to be
 * argued with is not worth its own maintenance.
 *
 * PROVENANCE: CAPTURE. Both sides are read from disk at run time -- the citations out of the guard
 * sources, the existence out of the filesystem -- so neither is a transcription that can agree with
 * a stale belief.
 *
 * I/O: reads `tests/guards/**\/*.ts` and stats the paths they name. No network, spawn, or write.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..')

const CITATION_RE = /tests\/[A-Za-z0-9_./-]+\.test\.ts/g

/** Every `tests/....test.ts` named on a doc-comment line of a guard source, as `guard -> cited`. */
function citations(): string[] {
  const out = new Set<string>()
  const self = path.basename(fileURLToPath(import.meta.url))
  for (const name of fs.readdirSync(HERE).sort()) {
    // Self-exclusion, not tidiness: this file's own docstring quotes the broken citation it was
    // written for, so scanning itself would make the guard permanently red about its own prose.
    if (!name.endsWith('.ts') || name === self) continue
    const src = fs.readFileSync(path.join(HERE, name), 'utf8')
    for (const line of src.split('\n')) {
      if (!/^\s*\*/.test(line)) continue
      for (const m of line.matchAll(CITATION_RE)) out.add(`${name} -> ${m[0]}`)
    }
  }
  return [...out].sort()
}

describe('a guard docstring cites no test file that does not exist', () => {
  it('finds the citations, so the check below is not vacuous', () => {
    pinnedPopulation({
      what: 'test files cited in guard doc comments',
      items: citations(),
      floor: 20, // measured 33 live (raise this to 9999 and read the count out of the failure)
      ceiling: 80,
      mustInclude: ['storage_dirs_are_hardened.test.ts -> tests/data_dir_permissions.test.ts'],
    })
  })

  it('resolves every one of them on disk', () => {
    const missing = citations().filter((c) => !fs.existsSync(path.join(REPO, c.split(' -> ')[1] as string)))

    expect(
      missing,
      'A guard docstring names a test file that is not there. Either the file moved (fix the ' +
        'citation) or the check it promises was never written (write it, or say plainly in the ' +
        'docstring that the half is unchecked).',
    ).toEqual([])
  })
})
