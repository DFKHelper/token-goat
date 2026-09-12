/**
 * Every directory token-goat creates inside its own storage must go through `ensureDirSync`.
 *
 * `ensureDirSync` calls `ensureDataDirPrivate()` first, which creates the data root 0700 and
 * chmods an already-permissive one down. A bare `fs.mkdirSync(..., { recursive: true })` on a path
 * under that root skips it, so on a shared Linux host the root is left at the umask default (755)
 * and every other local user can list the cached pages, command output, session blobs and index
 * databases inside it -- the file NAMES alone leak which commands ran and which URLs were fetched.
 *
 * This guard exists because the original finding was fixed at two sites and the class was not
 * swept. Three more instances of the identical shape were still in the tree afterwards
 * (`bridges/created_configs.ts`, `pending_context.ts`, `hooks_tool_failure.ts`), one of them on a
 * path these very commits made hotter. Each self-repaired on the next token-goat process, so the
 * window was narrow -- but "narrow" is what the first finding said too. A per-site fix leaves the
 * next instance to the next audit; the default has to be inverted so it is red on arrival.
 *
 * How the population is decided, stated rather than left to be reverse-engineered:
 *
 *  - A STORAGE PRODUCER is `dataDir`/`tokenGoatHome`/`DATA_DIR`, or any function that builds a
 *    path (`join`/`resolve`) out of one, to a fixed point across all of `src`.
 *  - A function is STORAGE-TAINTED when its own body names a producer, or when a same-file
 *    function that names one calls it. Taint flows caller -> callee because the path is routinely
 *    computed in the caller and passed down as a parameter -- which is exactly the shape of
 *    `hooks_tool_failure.ts::writeLedger(target)`, one of the three misses.
 *  - The population is every directory-creating call inside a tainted function, whether it goes
 *    through the helper or not. Pinning only the violations would leave the guard able to pass by
 *    finding nothing at all.
 *
 * Both rules over-approximate, deliberately: a false edge widens the population, which is the
 * direction that fails loudly and gets an exemption with a reason written next to it. Resolution is
 * by NAME, so an aliased import (`import { dataDir as d }`) is invisible; nothing in this repo does
 * that today.
 *
 * The POSIX mode itself is asserted at runtime by `tests/data_dir_private.test.ts`, honestly
 * skipped on Windows where Node ignores POSIX modes. This guard is the static half and runs
 * everywhere.
 *
 * PROVENANCE: CAPTURE. The population is read from `src/**\/*.ts` at run time, not transcribed.
 *
 * I/O: reads `src/**\/*.ts` once and does no network, spawn, or write -- lefthook runs it pre-commit.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { codeOnly, parseTopLevelFunctions } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** The roots. `DATA_DIR` is the module-level constant `dataDir()` returns. */
const ROOTS = ['dataDir', 'tokenGoatHome', 'DATA_DIR']

/** Creates a directory. `ensureDirSync` is the hardened one; the rest are raw. */
const HARDENED = /\bensureDirSync\s*\(/
const RAW_MKDIR = /\b(?:fs\.promises\.mkdir|fs\.mkdir|mkdirSync|mkdir)\s*\(/

interface SrcFile {
  readonly rel: string
  readonly fns: ReadonlyArray<{ name: string; body: string }>
}

function srcFiles(): SrcFile[] {
  const out: SrcFile[] = []
  ;(function walk(dir: string): void {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) {
        const code = fs.readFileSync(p, 'utf8')
        out.push({
          rel: path.relative(SRC_DIR, p).replace(/\\/g, '/'),
          fns: parseTopLevelFunctions(code).map((f) => ({ name: f.name, body: codeOnly(f.body) })),
        })
      }
    }
  })(SRC_DIR)
  return out
}

/** Names that resolve to a path inside token-goat's own storage, to a fixed point. */
function storageProducers(files: readonly SrcFile[]): Set<string> {
  const producers = new Set(ROOTS)
  for (let pass = 0; pass < 8; pass++) {
    let grew = false
    for (const f of files) {
      for (const fn of f.fns) {
        if (producers.has(fn.name)) continue
        if (!/\b(?:join|resolve)\s*\(/.test(fn.body)) continue
        if (![...producers].some((p) => new RegExp(`\\b${p}\\b`).test(fn.body))) continue
        producers.add(fn.name)
        grew = true
      }
    }
    if (!grew) break
  }
  return producers
}

/** Functions in `file` that name a producer, plus everything they call in the same file. */
function taintedFunctions(file: SrcFile, producers: ReadonlySet<string>): Set<string> {
  const names = new Set(file.fns.map((f) => f.name))
  const byName = new Map(file.fns.map((f) => [f.name, f.body]))
  const tainted = new Set<string>()
  const stack: string[] = []
  for (const fn of file.fns) {
    if ([...producers].some((p) => new RegExp(`\\b${p}\\b`).test(fn.body))) stack.push(fn.name)
  }
  while (stack.length > 0) {
    const name = stack.pop() as string
    if (tainted.has(name)) continue
    tainted.add(name)
    const body = byName.get(name)
    if (body === undefined) continue
    const callRe = /\b([A-Za-z_]\w*)\s*\(/g
    let m: RegExpExecArray | null
    while ((m = callRe.exec(body)) !== null) {
      const callee = m[1] as string
      if (names.has(callee) && !tainted.has(callee)) stack.push(callee)
    }
  }
  return tainted
}

interface Site {
  readonly key: string
  readonly hardened: boolean
}

/** Every directory creation inside a storage-tainted function. */
function storageDirSites(): Site[] {
  const files = srcFiles()
  const producers = storageProducers(files)
  const out: Site[] = []
  for (const file of files) {
    const tainted = taintedFunctions(file, producers)
    for (const fn of file.fns) {
      if (!tainted.has(fn.name)) continue
      const hardened = HARDENED.test(fn.body)
      if (!hardened && !RAW_MKDIR.test(fn.body)) continue
      if (hardened && !RAW_MKDIR.test(fn.body)) {
        out.push({ key: `${file.rel}::${fn.name}`, hardened: true })
        continue
      }
      out.push({ key: `${file.rel}::${fn.name}`, hardened })
    }
  }
  return out
}

/**
 * Raw directory creations on storage paths that are allowed, each with the reason.
 *
 * The bar: routing it through `ensureDirSync` would be wrong, not merely inconvenient. "It works
 * today" is not a reason -- that was true of all three sites this guard was written for.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'constants.ts::ensureDataDirPrivate',
    'IS the hardening helper: it creates the root 0700 in two deliberate steps, and ensureDirSync calls it. Routing it through ensureDirSync would be a cycle.',
  ],
  [
    'util.ts::ensureDirSync',
    'IS the hardened wrapper; the raw mkdir inside it is the one every other site is required to reach instead of calling directly.',
  ],
  [
    'skill_cache.ts::acquireSkillHitLock',
    'mkdir-as-mutex: a NON-recursive, non-existing-ok mkdir whose EEXIST is the lock-held signal. ensureDirSync swallows EEXIST and creates recursively, which would hand the lock to every caller at once. The data root is already hardened by the atomicWriteText on the path that reaches this.',
  ],
])

describe('every directory token-goat creates in its own storage is hardened', () => {
  it('finds the storage directory creations, so the check below is not vacuous', () => {
    pinnedPopulation({
      what: 'directory creations on token-goat storage paths',
      items: storageDirSites().map((s) => s.key),
      floor: 25, // measured 35 live (raise this to 9999 and read the count out of the failure)
      ceiling: 50,
      mustInclude: [
        'constants.ts::ensureDataDirPrivate',
        'bridges/created_configs.ts::writeLedger',
        'pending_context.ts::queuePendingContext',
        'hooks_tool_failure.ts::writeLedger',
      ],
    })
  })

  it('routes every one of them through ensureDirSync', () => {
    const raw = storageDirSites()
      .filter((s) => !s.hardened && !EXEMPT.has(s.key))
      .map((s) => s.key)
    expect(
      raw,
      'A bare mkdir on a path under token-goat\'s data root skips ensureDataDirPrivate(), which is ' +
        'what creates that root 0700 and chmods an already-permissive one down. Call ensureDirSync ' +
        '(src/util.ts) instead, or add the site to EXEMPT in this file with the reason a raw mkdir ' +
        'is correct there.',
    ).toEqual([])
  })

  it('names no exemption that has stopped creating a directory', () => {
    // The stale half: an exemption for code that no longer exists reads as a live decision and
    // hides the next real instance behind it.
    const sites = new Set(storageDirSites().map((s) => s.key))
    expect([...EXEMPT.keys()].filter((k) => !sites.has(k))).toEqual([])
  })
})
