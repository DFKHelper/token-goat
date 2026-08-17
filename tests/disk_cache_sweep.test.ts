/**
 * Regression coverage for the automatic cache sweep.
 *
 * Two gaps existed here, neither of which any test caught. First, pruneBlobs skipped every file
 * whose name did not end in `.json`, so `.txt`/`.gz` payloads from older versions, `.tmp` files
 * from interrupted atomic writes, and `.lock` files whose holder died survived every prune
 * forever. Second, nothing invoked eviction for these directories automatically: storeBlob prunes
 * the subdir it writes, but session state is written outside that funnel, so the sessions
 * directory grew without any bound at all.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { pruneBlobDir, sweepCacheRoots, DEFAULT_MAX_COUNT } from '../src/disk_cache.js'

const STALE_MS = 25 * 3600 * 1000

let home: string
let extraRoot: string
let priorHome: string | undefined

/** Write `name` into `dir`, backdating its mtime past the 24h cutoff when `stale`. */
function writeFile(dir: string, name: string, stale: boolean): string {
  fs.mkdirSync(dir, { recursive: true })
  const full = path.join(dir, name)
  fs.writeFileSync(full, '{}')
  if (stale) {
    const when = new Date(Date.now() - STALE_MS)
    fs.utimesSync(full, when, when)
  }
  return full
}

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sweep-'))
  home = path.join(base, 'home')
  extraRoot = path.join(base, 'legacy')
  priorHome = process.env['TOKEN_GOAT_HOME']
  process.env['TOKEN_GOAT_HOME'] = home
})

afterEach(() => {
  if (priorHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = priorHome
  try {
    fs.rmSync(path.dirname(home), { recursive: true, force: true })
  } catch {
    // best-effort scratch cleanup
  }
})

describe('pruneBlobDir non-JSON companions', () => {
  it('reaps stale .txt/.gz/.tmp/.lock debris alongside stale .json blobs', () => {
    const dir = path.join(home, 'bash_outputs')
    const staleJson = writeFile(dir, 'a.json', true)
    const staleTxt = writeFile(dir, 'a.txt', true)
    const staleGz = writeFile(dir, 'a.gz', true)
    const staleTmp = writeFile(dir, 'a.json.tmp', true)
    const staleLock = writeFile(dir, 'a.json.lock', true)

    const removed = pruneBlobDir(dir)

    expect(removed).toBe(5)
    for (const p of [staleJson, staleTxt, staleGz, staleTmp, staleLock]) {
      expect(fs.existsSync(p)).toBe(false)
    }
  })

  it('leaves fresh non-JSON companions alone', () => {
    const dir = path.join(home, 'bash_outputs')
    const freshTxt = writeFile(dir, 'fresh.txt', false)
    const freshLock = writeFile(dir, 'fresh.json.lock', false)

    expect(pruneBlobDir(dir)).toBe(0)
    expect(fs.existsSync(freshTxt)).toBe(true)
    expect(fs.existsSync(freshLock)).toBe(true)
  })

  it('does not let a fresh non-JSON file consume a count-budget slot', () => {
    // The count budget is expressed in addressable blobs, so a `.txt` companion must not push a
    // `.json` blob out. With maxCount 2 and two fresh .json blobs plus one .txt, nothing is due.
    const dir = path.join(home, 'bash_outputs')
    const a = writeFile(dir, 'a.json', false)
    const b = writeFile(dir, 'b.json', false)
    writeFile(dir, 'c.txt', false)

    expect(pruneBlobDir(dir, 2)).toBe(0)
    expect(fs.existsSync(a)).toBe(true)
    expect(fs.existsSync(b)).toBe(true)
  })

  it('ignores subdirectories rather than trying to unlink them', () => {
    const dir = path.join(home, 'bash_outputs')
    const nested = path.join(dir, 'nested')
    fs.mkdirSync(nested, { recursive: true })
    const when = new Date(Date.now() - STALE_MS)
    fs.utimesSync(nested, when, when)

    expect(pruneBlobDir(dir)).toBe(0)
    expect(fs.existsSync(nested)).toBe(true)
  })
})

describe('sweepCacheRoots', () => {
  it('reaps stale cache files under the home root', () => {
    const stale = writeFile(path.join(home, 'sessions'), 'old.json', true)
    const fresh = writeFile(path.join(home, 'sessions'), 'live.json', false)

    expect(sweepCacheRoots()).toBe(1)
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('reaps stale cache files under an extra root too', () => {
    // The stranded legacy root: the same age policy applies to it, so its contents age out
    // without any bespoke "delete the old directory" migration.
    const legacyJson = writeFile(path.join(extraRoot, 'mcp_outputs'), 'x.json', true)
    const legacyGz = writeFile(path.join(extraRoot, 'mcp_outputs'), 'x.gz', true)
    const legacyFresh = writeFile(path.join(extraRoot, 'mcp_outputs'), 'y.json', false)

    expect(sweepCacheRoots([extraRoot])).toBe(2)
    expect(fs.existsSync(legacyJson)).toBe(false)
    expect(fs.existsSync(legacyGz)).toBe(false)
    expect(fs.existsSync(legacyFresh)).toBe(true)
  })

  it('never count-evicts fresh session blobs, however many there are', () => {
    // Session blobs hold live read-dedup state and cannot be re-fetched, so the sessions policy is
    // age-only. Count-capping them would silently reset a live conversation's state.
    const dir = path.join(home, 'sessions')
    const written: string[] = []
    for (let i = 0; i < DEFAULT_MAX_COUNT + 5; i++) written.push(writeFile(dir, `s${i}.json`, false))

    expect(sweepCacheRoots()).toBe(0)
    for (const p of written) expect(fs.existsSync(p)).toBe(true)
  })

  it('still count-evicts a count-capped subdir past its budget', () => {
    // Anti-vacuity control for the case above: the age-only exemption is specific to sessions, not
    // a sweep that silently applies no count budget anywhere. bash_outputs' real budget is 4096
    // blobs, so the env override sets a small one rather than writing 4k files.
    const dir = path.join(home, 'bash_outputs')
    for (let i = 0; i < 5; i++) writeFile(dir, `b${i}.json`, false)
    process.env['TOKEN_GOAT_BASH_CACHE_MAX_FILES'] = '2'
    try {
      expect(sweepCacheRoots()).toBe(3)
    } finally {
      delete process.env['TOKEN_GOAT_BASH_CACHE_MAX_FILES']
    }
    expect(fs.readdirSync(dir).length).toBe(2)
  })

  it('skips a missing root without throwing', () => {
    expect(sweepCacheRoots([path.join(extraRoot, 'does-not-exist')])).toBe(0)
  })

  it('sweeps a duplicated root only once', () => {
    const stale = writeFile(path.join(home, 'web_outputs'), 'old.json', true)

    expect(sweepCacheRoots([home, home])).toBe(1)
    expect(fs.existsSync(stale)).toBe(false)
  })
})
