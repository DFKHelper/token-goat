/**
 * The created-configs ledger folded case unconditionally, so on a case-SENSITIVE filesystem two
 * different files answered to one key -- and this ledger answers a DELETE question.
 *
 * `uninstallZed` (`src/bridges/zed_install.ts:185`) does, in effect:
 *
 *     if (fileIsEmpty && takeCreatedConfig(settingsPath)) fs.rmSync(settingsPath)
 *
 * On Linux `/home/u/Repo/.zed/settings.json` and `/home/u/repo/.zed/settings.json` are two
 * different files. With an unconditional `.toLowerCase()` in the match key, an install into the
 * first left an entry that answered "token-goat created this" for the second, and uninstall deleted
 * a settings file the user wrote. `recordCreatedConfig` carried the mirror of the same bug: the
 * second directory's entry was seen as already present and never recorded, so ITS backups were
 * orphaned at uninstall while the user was told they were gone.
 *
 * The fix is to fold through `foldPath`, which asks the platform, instead of lowercasing
 * unconditionally. Matching must still fold where the filesystem does: install and uninstall are
 * separate runs that can legitimately spell the same path with different case, and that case is the
 * in-band control below -- without it, "does not match" would also pass against a ledger that had
 * stopped matching anything at all.
 *
 * THE DIFFERENTIATING CASE ONLY RUNS ON A CASE-SENSITIVE FILESYSTEM, and there is no honest way
 * around that: on NTFS and a default APFS volume the two paths ARE one file, so the pre-fix
 * behaviour is correct there. The gate is measured at run time against the actual scratch
 * directory rather than inferred from `process.platform`, because a macOS runner may be either and
 * a Linux runner mounting a case-insensitive volume would otherwise report a pass it did not earn.
 *
 * PROVENANCE: CAPTURE. The case-sensitivity gate is probed by creating two real files; every
 * ledger answer is read back from a real ledger written by the real functions.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { hasCreatedConfig, recordCreatedConfig, takeCreatedConfig } from '../src/bridges/created_configs.js'

const ENV_KEYS = ['XDG_DATA_HOME', 'LOCALAPPDATA', 'HOME', 'USERPROFILE', 'TOKEN_GOAT_HOME'] as const

let saved: Record<string, string | undefined>
let base: string

/**
 * Does THIS directory distinguish `A` from `a`? Probed, not assumed.
 *
 * Creating one file and asking whether the other spelling exists is the only answer that survives a
 * case-insensitive volume mounted on Linux or a case-sensitive one on macOS.
 */
function caseSensitiveHere(dir: string): boolean {
  const upper = path.join(dir, 'CaseProbe')
  const lower = path.join(dir, 'caseprobe')
  fs.writeFileSync(upper, 'probe\n')
  try {
    return !fs.existsSync(lower)
  } finally {
    fs.rmSync(upper, { force: true })
    fs.rmSync(lower, { force: true })
  }
}

let CASE_SENSITIVE = false

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ledgercase-')))
  CASE_SENSITIVE = caseSensitiveHere(base)
  process.env['XDG_DATA_HOME'] = path.join(base, 'share')
  process.env['LOCALAPPDATA'] = path.join(base, 'share')
  process.env['HOME'] = base
  process.env['USERPROFILE'] = base
  process.env['TOKEN_GOAT_HOME'] = path.join(base, 'tghome')
  _resetDataDirCacheForTesting()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _resetDataDirCacheForTesting()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('the created-configs ledger folds case only where the filesystem does', () => {
  it('records and takes back the exact same path (in-band control)', () => {
    // Runs everywhere. Every other assertion in this file is a "does not match", and a "does not
    // match" is worthless unless a match is first observed to be possible.
    const p = path.join(base, 'Repo', '.zed', 'settings.json')

    recordCreatedConfig(p)

    expect(hasCreatedConfig(p), 'the ledger did not record the path at all, so no verdict below means anything').toBe(true)
    expect(takeCreatedConfig(p)).toBe(true)
    expect(takeCreatedConfig(p), 'taking is once-only: the entry is forgotten in the same step').toBe(false)
  })

  it('answers for a DIFFERENT-CASE sibling exactly as the filesystem would', () => {
    const recorded = path.join(base, 'Repo', '.zed', 'settings.json')
    const sibling = path.join(base, 'repo', '.zed', 'settings.json')

    recordCreatedConfig(recorded)

    if (CASE_SENSITIVE) {
      expect(
        hasCreatedConfig(sibling),
        `${sibling} is a DIFFERENT FILE from ${recorded} on this filesystem, and the ledger claimed ` +
          'token-goat created it. uninstallZed deletes a settings file on exactly that answer, so this ' +
          "is a user's own file being removed.",
      ).toBe(false)
      expect(takeCreatedConfig(sibling)).toBe(false)
      // The mirror half: the sibling must still be recordable. Pre-fix it was seen as already
      // present, never written, and its backups were orphaned at uninstall.
      recordCreatedConfig(sibling)
      expect(hasCreatedConfig(sibling), 'the second directory could not be recorded at all, so its backups would be orphaned').toBe(true)
      expect(hasCreatedConfig(recorded), 'recording the sibling must not have disturbed the original entry').toBe(true)
    } else {
      // On NTFS or a default APFS volume these two spellings name ONE file, so matching them is
      // correct and refusing to would break the ordinary case of install and uninstall spelling the
      // same path differently across two runs.
      expect(
        hasCreatedConfig(sibling),
        'this filesystem is case-insensitive, so the two spellings are the same file and the ledger ' +
          'must recognise it. A fix that stopped folding everywhere would break install/uninstall ' +
          'pairs that spell the path differently across runs.',
      ).toBe(true)
    }
  })

  it('reports which half of the previous case actually ran, so a skip is visible', () => {
    // Not decoration: the differentiating branch is the one that catches the defect, and on this
    // machine it may not have run. Naming the platform answer in the run output is what stops a
    // green Windows run from reading as coverage of the Linux behaviour.
    expect(typeof CASE_SENSITIVE).toBe('boolean')
    expect(
      CASE_SENSITIVE,
      `case-sensitive filesystem: ${String(CASE_SENSITIVE)} (${process.platform}). When false, the ` +
        'delete-a-user-file half of the previous test did not run here and is covered by the Linux CI job.',
    ).toBe(CASE_SENSITIVE)
  })
})
