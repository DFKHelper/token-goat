/**
 * Uninstall removes the `.bak.<stamp>` files token-goat wrote, and never one the user wrote.
 *
 * Install backs a config up every time it rewrites one, and nothing ever removed those backups. A
 * machine that had installed and uninstalled a few times kept a copy of every config token-goat
 * had ever touched, each holding whatever was in that file at the time, in a directory the user
 * had been told the product was gone from.
 *
 * The identification rule is the one `ada73c5e` established for created config files, reused
 * rather than reinvented: a backup is removed only if token-goat recorded creating it, in the
 * ledger at `<dataDir>/created-configs.json`. It is deliberately not a name pattern.
 * `<config>.bak.<anything>` is a name a user can choose just as easily, so a glob over it would
 * eventually delete someone's own copy of their own config, and that file is not recoverable.
 * Recording happens at the instant of creation, in `backupFile`, which is the only place
 * token-goat writes one. Every failure is read as "not ours": an unreadable, missing or purged
 * ledger removes nothing and leaves litter, which is the recoverable direction.
 *
 * Fixture provenance:
 * - The removed backups are CAPTURE -- written by calling the real `backupFile`, so their names
 *   are whatever the shipping code produces rather than a shape restated from reading it.
 * - The surviving decoys are HAND-DERIVED -- names a user could plausibly pick for a copy of
 *   their own config, written straight to disk so that nothing records them.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { recordCreatedBackup, removeCreatedBackups } from '../src/bridges/created_configs.js'
import { dataDir } from '../src/constants.js'
import { backupFile } from '../src/util.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-created-backups-'))
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

function configAt(name: string): string {
  const p = path.join(TMP, name)
  fs.writeFileSync(p, '{"a":1}\n')
  return p
}

function backupsOf(p: string): string[] {
  const prefix = `${path.basename(p)}.bak.`
  return fs
    .readdirSync(path.dirname(p))
    .filter((f) => f.startsWith(prefix))
    .sort()
}

describe('removeCreatedBackups', () => {
  it('removes a backup token-goat wrote, and says how many went', () => {
    const p = configAt('settings.json')
    backupFile(p)
    expect(backupsOf(p)).toHaveLength(1)

    expect(removeCreatedBackups(p)).toBe(1)
    expect(backupsOf(p)).toEqual([])
  })

  it("leaves a backup the user wrote, even when its stamp is shaped exactly like token-goat's", () => {
    const p = configAt('settings.json')
    const decoy = `${p}.bak.2020-01-01T00-00-00-000Z`
    fs.writeFileSync(decoy, 'user copy')
    backupFile(p)
    expect(backupsOf(p)).toHaveLength(2)

    expect(removeCreatedBackups(p)).toBe(1)
    expect(backupsOf(p)).toEqual(['settings.json.bak.2020-01-01T00-00-00-000Z'])
    expect(fs.readFileSync(decoy, 'utf8')).toBe('user copy')
  })

  it('removes nothing at all for a config token-goat never backed up', () => {
    const p = configAt('settings.json')
    const decoy = `${p}.bak.mine`
    fs.writeFileSync(decoy, 'user copy')

    expect(removeCreatedBackups(p)).toBe(0)
    expect(fs.readFileSync(decoy, 'utf8')).toBe('user copy')
  })

  it('does not reach the backups of a different config', () => {
    const mine = configAt('settings.json')
    const other = configAt('other.json')
    backupFile(mine)
    backupFile(other)

    expect(removeCreatedBackups(mine)).toBe(1)
    expect(backupsOf(other)).toHaveLength(1)
  })

  it('forgets what it removed, so a second uninstall finds nothing of its own', () => {
    const p = configAt('settings.json')
    backupFile(p)

    expect(removeCreatedBackups(p)).toBe(1)
    expect(removeCreatedBackups(p)).toBe(0)
  })

  it('drops a pruned backup from the ledger instead of leaving an entry pointing at nothing', () => {
    const p = configAt('settings.json')
    // backupFile keeps the 5 newest and prunes the rest, lowest stamp first. Six real calls would
    // race the millisecond clock and could land on one name twice, so the first five are written
    // and recorded by hand and only the sixth is a real one.
    const stamps = [
      '2020-01-01T00-00-01-000Z',
      '2020-01-01T00-00-02-000Z',
      '2020-01-01T00-00-03-000Z',
      '2020-01-01T00-00-04-000Z',
      '2020-01-01T00-00-05-000Z',
    ]
    for (const stamp of stamps) {
      const backup = `${p}.bak.${stamp}`
      fs.writeFileSync(backup, 'old')
      recordCreatedBackup(backup)
    }

    backupFile(p)

    expect(fs.existsSync(`${p}.bak.${stamps[0] as string}`)).toBe(false)
    // Ledger keys are case-folded, so the stamps are matched in lower case.
    const ledger = fs.readFileSync(path.join(dataDir(), 'created-configs.json'), 'utf8')
    expect(ledger).not.toContain((stamps[0] as string).toLowerCase())
    expect(ledger).toContain((stamps[1] as string).toLowerCase())
  })
})
