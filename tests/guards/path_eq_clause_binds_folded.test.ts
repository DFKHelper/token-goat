/**
 * Guard against the "writer minted a key no reader could produce" class, at its one unguarded seam.
 *
 * `pathEqClause(col)` emits `TG_LOWER(col) = ?` on case-insensitive filesystems, so the bound
 * parameter has to arrive already folded. That obligation sits on the caller and nowhere else: the
 * two sibling builders in `src/sql_path.ts` (`pathSuffixClause`, `projectScopeClause`) each carry
 * their own `params()` method and fold internally, so only `pathEqClause` can be misused this way.
 * Its doc comment states the rule, and a doc comment is not a check -- a new call site that binds a
 * raw path compiles, type-checks, runs, and returns nothing at all. That is the failure shape this
 * repo keeps re-shipping: a total miss exits 0, so nothing anywhere reports an error.
 *
 * The behavioural coverage that exists today (`tests/*_collation.test.ts`) pins specific call sites
 * against specific case-variant inputs. That catches a regression at a site someone thought to
 * write a test for; it cannot catch the sixteenth site added next month. This guard is the
 * structural half, and it deliberately claims only what it checks.
 *
 * What it checks: for every `${pathEqClause(` occurrence in `src/`, the first execution call that
 * follows it (`.run(`/`.get(`/`.all(`) binds either a literal `foldPath(...)` call or an identifier
 * this file declared as `const <id> = foldPath(...)`. Those are the only two shapes the fifteen
 * production sites use today. The scan keys on the `${` interpolation rather than the bare name
 * because a call site is by construction inside a SQL template literal: matching the name alone
 * also caught the builder's own definition in `src/sql_path.ts` and a prose mention of it in a
 * `src/db.ts` comment, neither of which binds anything.
 *
 * What it does not check: which statement an execution call actually belongs to. Two statements
 * hoisted together and executed later (as in `src/embed_backfill.ts`) both resolve to the first of
 * the two executions, so a guard pass proves the folded convention is in use around each
 * occurrence, not that a specific bind reaches a specific `?`. Tightening that needs a real parse,
 * and it would buy little: the defect this exists to catch is a site written without `foldPath` in
 * sight, which this does catch.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const SRC = path.join(process.cwd(), 'src')
/** A call site is an interpolation inside a SQL template literal, never a bare mention. */
const CALL_SITE = '${pathEqClause('
const CALL_SITE_RE = /\$\{pathEqClause\(/g

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(full)
    return e.isFile() && e.name.endsWith('.ts') ? [full] : []
  })
}

/** The argument text of the call whose opening paren sits at `open`, walked with paren balance and capped so a malformed source cannot run away. */
function argsAt(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length && i < open + 800; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return src.slice(open + 1, Math.min(src.length, open + 800))
}

interface Site {
  /** `path/to/file.ts:LINE`, the identity this site is pinned and reported under. */
  readonly id: string
  readonly folded: boolean
  readonly bound: string
}

function sitesIn(file: string): Site[] {
  const src = fs.readFileSync(file, 'utf8')
  if (!src.includes(CALL_SITE)) return []
  const foldedIds = new Set([...src.matchAll(/const\s+(\w+)\s*=\s*foldPath\(/g)].map((m) => m[1]))
  const rel = path.relative(process.cwd(), file).replace(/\\/g, '/')
  return [...src.matchAll(CALL_SITE_RE)].map((m) => {
    const from = m.index ?? 0
    // `.pluck()` and `.raw()` sit between the prepare and the execution, so match the execution by name rather than by taking the next chained call.
    const exec = /\.(?:run|get|all)\(/.exec(src.slice(from))
    const at = exec?.index
    const bound = at === undefined ? '' : argsAt(src, from + at + (exec?.[0].length ?? 0) - 1)
    return {
      id: `${rel}:${src.slice(0, from).split('\n').length}`,
      folded: bound.includes('foldPath(') || [...foldedIds].some((id) => new RegExp(`\\b${id}\\b`).test(bound)),
      bound: bound.trim().slice(0, 80),
    }
  })
}

/** Every `${pathEqClause(` occurrence in `src/`, pinned so a scan that stops matching fails instead of passing empty. */
function callSites(): Site[] {
  const sites = sourceFiles(SRC).flatMap(sitesIn)
  pinnedPopulation({
    what: 'pathEqClause() call sites in src/',
    items: sites.map((s) => s.id),
    floor: 10, // measured 15 live across 4 files (raise this to 9999 and read the count out of the failure)
    ceiling: 40,
    // One anchor per file that holds sites today: a bare count cannot tell a collapse from a
    // substitution, and losing a whole file's worth of sites is the shape that matters here.
    mustInclude: ['src/embeddings.ts:', 'src/embed_backfill.ts:', 'src/parser.ts:', 'src/worker.ts:'],
  })
  return sites
}

describe('pathEqClause callers bind a folded path', () => {
  it('no call site binds a raw path', () => {
    const offenders = callSites().filter((s) => !s.folded)
    expect(
      offenders.map((o) => `${o.id} binds \`${o.bound}\``),
      'A pathEqClause() comparison is bound with a path that was never run through foldPath(). ' +
        'The clause folds the column with TG_LOWER(), so an unfolded parameter can only match rows ' +
        'whose stored path happens to already be lower case -- on every other row the comparison is ' +
        'false and the query returns nothing, with no error to notice. Fold the parameter at the ' +
        'bind site, as every sibling call site does.',
    ).toEqual([])
  })
})
