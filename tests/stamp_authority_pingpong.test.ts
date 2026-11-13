/** Two builds with different fingerprints sharing one global.db must not take turns marking each other's rows stale. Observed on a real machine: the global install (2.9.34) and the daemon's dist (2.9.35) carried different PARSER_FINGERPRINT and EMBED_FINGERPRINT values, each treated the other's stamps as stale, and the daemon re-indexed and re-embedded tens of thousands of unedited files for hours. Provenance: CAPTURE for the fingerprints (read from both installed bundles on the affected machine: 2.9.34 PARSER 2bfacb32efb0cb37 / EMBED 49bdbe10181bd51d, dist PARSER 750e657a8ae9e5ed / EMBED b1e7668a0d5c791f); HAND-DERIVED for the ordering expectations. The reconcile cases run the real built bundle against a real indexed database whose authority row is rewritten to name a newer or older build. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { getDb } from '../src/db.js'
import { claimStampAuthority, compareVersions } from '../src/stamp_authority.js'
import { findGlobalDb } from './helpers/find_global_db.js'
import { indexableDir } from './helpers/temp-config.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')
let projectDir: string
let homeDir: string

function run(args: string[]): string {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir },
  })
  return res.stdout ?? ''
}

describe('compareVersions', () => {
  it('orders dotted numeric versions', () => {
    expect(compareVersions('2.9.35', '2.9.34')).toBe(1)
    expect(compareVersions('2.9.9', '2.9.10')).toBe(-1)
    expect(compareVersions('2.9.35', '2.9.35')).toBe(0)
    expect(compareVersions('2.9.35+build', '2.9.35')).toBe(0)
  })
})

describe('claimStampAuthority', () => {
  const older = { version: '2.9.34', fingerprint: '2bfacb32efb0cb37/49bdbe10181bd51d' }
  const newer = { version: '2.9.35', fingerprint: '750e657a8ae9e5ed/b1e7668a0d5c791f' }

  it('alternating builds on one database never hand the authority back to the older one', () => {
    const db = getDb(join(mkdtempSync(join(tmpdir(), 'tg-auth-')), 'global.db'))
    const verdicts: boolean[] = []
    for (let round = 0; round < 5; round++) {
      verdicts.push(claimStampAuthority(db, older), claimStampAuthority(db, newer))
    }
    // The older build wins only if it is first; once the newer one has recorded, every later claim by the older one is refused.
    expect(verdicts.slice(2).filter((_, i) => i % 2 === 0)).toEqual([false, false, false, false])
    expect(verdicts.filter((_, i) => i % 2 === 1)).toEqual([true, true, true, true, true])
  })

  it('a second build of the same version with other fingerprints does not take over', () => {
    const db = getDb(join(mkdtempSync(join(tmpdir(), 'tg-auth-')), 'global.db'))
    expect(claimStampAuthority(db, newer)).toBe(true)
    expect(claimStampAuthority(db, { version: '2.9.35', fingerprint: 'other/other' })).toBe(false)
    expect(claimStampAuthority(db, newer)).toBe(true)
  })
})

describe('reconcile with a foreign parser stamp', () => {
  beforeEach(() => {
    projectDir = indexableDir()
    homeDir = mkdtempSync(join(tmpdir(), 'tg-auth-home-'))
    writeFileSync(join(projectDir, 'widget.ts'), 'export function widget(): number {\n  return 1\n}\n')
    spawnSync('git', ['init'], { cwd: projectDir })
    spawnSync('git', ['add', '-A'], { cwd: projectDir })
    run(['index', '.'])
  })

  function reconcile(authorityVersion: string): { parserStale: number } {
    const dbPath = findGlobalDb(homeDir) as string
    const db = getDb(dbPath)
    db.prepare("UPDATE files SET parser_sha = '0000000000000000' WHERE path LIKE '%widget.ts'").run()
    claimStampAuthority(db)
    db.prepare('UPDATE stamp_authority SET version = ? WHERE id = 1').run(authorityVersion)
    return JSON.parse(run(['reconcile', '--dry-run', '--json'])) as { parserStale: number }
  }

  it('leaves rows stamped by a newer build alone, so the two builds cannot loop', () => {
    expect(reconcile('999.0.0').parserStale).toBe(0)
  })

  it('still reparses rows stamped by an older build', () => {
    expect(reconcile('0.0.1').parserStale).toBeGreaterThan(0)
  })
})
