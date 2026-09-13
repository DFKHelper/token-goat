/**
 * A freshly created scratch directory must be resolved with `fs.realpathSync.native`, never the
 * plain `fs.realpathSync`.
 *
 * The plain form is a JS walker: it follows symlinks and otherwise echoes back the spelling it was
 * handed. `.native` asks the OS. The two differ exactly where a machine spells a path one way and
 * the filesystem another, which is the case on every CI runner this suite runs on and on none of
 * the machines it is written on:
 *
 *   - `windows-latest` roots its temp directory at the 8.3 alias `C:\Users\RUNNER~1\...`, which
 *     canonicalizes to `C:\Users\runneradmin\...`. The plain walker keeps the alias.
 *   - `macos-latest` roots it at `/var/folders/...`, a symlink to `/private/var/folders/...`.
 *
 * Both rewrites change the path's LENGTH as well as its spelling, so a fixture that measures bytes
 * against the unresolved form is measuring a path the implementation never sees. That is how
 * `path_containment_walk_cap` failed on one Windows shard and nowhere else: it sized a path to sit
 * one byte under a 4096-byte cap, the runner's alias expanded by three bytes on canonicalization,
 * and the assertion that fired said only `expected false to be true`.
 *
 * `.native` is never worse here. The directory was created by this process microseconds earlier, so
 * its on-disk casing is the casing that was asked for, and the case-folding concern that keeps
 * `expandShortPath` from running `.native` over a whole caller-supplied path does not arise.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SELF = 'tests/guards/scratch_roots_resolve_natively.test.ts'

/**
 * The forbidden call, assembled rather than written out.
 *
 * A guard that scans the repo for a literal it also contains reports itself, and the usual repair
 * is to special-case its own path -- which then makes the guard blind to a real occurrence added
 * to it later. Building the needle from parts keeps this file out of its own population honestly:
 * there is no exemption to go stale, because the string never appears here.
 */
const PLAIN = ['realpathSync', '(', 'fs.mkdtempSync'].join('')
const PLAIN_BARE = ['realpathSync', '(', 'mkdtempSync'].join('')

function trackedSources(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', 'tests', 'src'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 24 })
    .split('\0')
    .filter((p) => p.endsWith('.ts'))
}

describe('a scratch root is resolved the way the OS spells it', () => {
  it('never resolves a mkdtemp result with the non-native realpathSync', () => {
    const offenders: string[] = []
    let scanned = 0
    let withMkdtemp = 0
    for (const rel of trackedSources()) {
      if (rel === SELF) continue
      const text = fs.readFileSync(path.join(REPO, rel), 'utf8')
      scanned += 1
      if (!text.includes('mkdtempSync')) continue
      withMkdtemp += 1
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string
        // `.native(` reads as `...realpathSync.native(fs.mkdtempSync`, which does NOT contain the
        // needle, so a plain `includes` is enough and no negative lookbehind is needed.
        if (line.includes(PLAIN) || /(^|[^.\w])realpathSync\(mkdtempSync/.test(line)) offenders.push(`${rel}:${i + 1}`)
      }
    }
    // Non-vacuity, both halves. A `git ls-files` that returns nothing, a rename that empties the
    // population, or a repo that stopped using mkdtemp at all would each make the assertion below
    // pass while checking nothing.
    expect(scanned, 'no TypeScript sources were scanned, so this guard would certify an empty set').toBeGreaterThan(500)
    expect(withMkdtemp, 'no file uses mkdtempSync, so the rule under test has no population').toBeGreaterThan(10)
    expect(offenders, `resolve these with fs.realpathSync.native: the plain ${PLAIN_BARE.slice(0, 12)} echoes the spelling it is handed, which is the 8.3 alias on windows-latest and the /var symlink on macos-latest`).toEqual([])
  })
})
