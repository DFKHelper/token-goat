/**
 * `package-lock.json` reports the same version as `package.json`.
 *
 * Releasing here bumps `package.json` by hand. The lock file carries the same version in two
 * places, and nothing in the release path updates them: `npm test`, `npm run lint`, and `npm run
 * typecheck` never read the field, and `npm ci` compares the dependency tree rather than the root
 * version, so every gate stays green while the two drift apart. The drift found on 2026-09-23 was
 * two releases wide, with the lock still at 2.9.21 against a manifest at 2.9.23, and it had
 * survived every CI run of both.
 *
 * The cost is small but it is real: the checked-in lock is the only record of what a given commit
 * was meant to install, and one that names a version the commit never was makes that record wrong
 * for anyone bisecting or reproducing a build. `npm install --package-lock-only` resyncs it, and
 * on a release commit that touches no dependency the whole diff is the two lines this guard reads.
 *
 * PROVENANCE: FORMAT-DERIVED. Both key paths are read off the lockfileVersion 3 layout of this
 * repository's own `package-lock.json` -- the root `version` and `packages[""].version` that
 * `npm install --package-lock-only` writes. The guard parses the real files rather than a fixture,
 * so it cannot agree with a stale copy of that shape.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, name), 'utf8')) as Record<string, unknown>
}

describe('the lock file and the manifest agree on the version', () => {
  it('reports the manifest version in both places the lock file records it', () => {
    const manifestVersion = readJson('package.json').version
    expect(typeof manifestVersion, 'package.json must carry a version string').toBe('string')

    const lock = readJson('package-lock.json')
    const selfEntry = (lock.packages as Record<string, { version?: string }> | undefined)?.['']

    expect(lock.version, 'package-lock.json root version is behind package.json; run `npm install --package-lock-only`').toBe(
      manifestVersion,
    )
    expect(
      selfEntry?.version,
      'package-lock.json packages[""].version is behind package.json; run `npm install --package-lock-only`',
    ).toBe(manifestVersion)
  })
})
