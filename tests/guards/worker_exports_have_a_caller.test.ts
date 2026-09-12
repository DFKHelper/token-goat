/**
 * Structural guard for the "exported seam with zero callers" defect class on the worker critical
 * path.
 *
 * `worker.ts::pendingEmbeddings` (tracks every in-flight embed call) had zero callers anywhere in
 * `src/` before this fix -- the detached daemon's SIGTERM handler called `process.exit(0)`
 * immediately, so a daemon stopped or replaced mid-batch dropped whatever embedding was still
 * running, silently, with nothing ever consulting the tracking map that existed to prevent exactly
 * that. An exported function that nothing in the shipping code calls is not a seam waiting for a
 * caller -- CLAUDE.md's own account of this repo's worst regression (`drainOnce` draining into a
 * stub nobody wired up) is this same shape one level up: unreachable production code that a test
 * suite full of direct-call unit tests never notices, because a direct-call test IS a caller, just
 * not one that ships.
 *
 * A per-symbol regression test (tests/worker_sigterm_drains_embeddings.test.ts) pins
 * `pendingEmbeddings`/`sigtermDrainDeadline`'s own fix. It says nothing about the next helper added
 * to this file and never wired into anything that runs in production -- so this guard enumerates
 * every top-level exported function/const declared directly in `worker.ts` and requires each one to
 * have at least one reference elsewhere in `src/**\/*.ts` (any file, including worker.ts itself,
 * since an internal caller such as sigtermDrainDeadline calling pendingEmbeddings is exactly how
 * this fix shipped) outside its own declaration line -- or to be named in EXEMPTIONS with a reason.
 *
 * Scope is deliberately narrowed to worker.ts, not all of `src/`: this is the file CLAUDE.md singles
 * out as the highest-priority critical path ("the indexer and worker come first"), and a codebase-
 * wide dead-export sweep is a different, much noisier guard with its own false-positive shape
 * (a public API surface, a CLI subcommand registered by string, a type-only export) that this one
 * does not try to solve.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { stripComments } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')
const WORKER_FILE = path.join(SRC_DIR, 'worker.ts')

interface ExportedSymbol {
  readonly name: string
  readonly line: number
}

const EXPORT_RE = /^export\s+(?:async\s+)?function\s+(\w+)|^export\s+const\s+(\w+)/gm

function workerExports(): readonly ExportedSymbol[] {
  const raw = fs.readFileSync(WORKER_FILE, 'utf8')
  const stripped = stripComments(raw)
  const lines = stripped.split('\n')
  const out: ExportedSymbol[] = []
  for (let i = 0; i < lines.length; i++) {
    EXPORT_RE.lastIndex = 0
    const m = EXPORT_RE.exec(lines[i]!)
    if (m) out.push({ name: (m[1] ?? m[2])!, line: i + 1 })
  }
  return out
}

/** Every `.ts` file under src/ except worker.ts's own declaration lines are irrelevant here -- a
 * reference INSIDE worker.ts counts (that is exactly how sigtermDrainDeadline calling
 * pendingEmbeddings ships), so every non-test src file, worker.ts included, is searched. */
function srcFiles(): readonly string[] {
  const out: string[] = []
  ;(function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p)
    }
  })(SRC_DIR)
  return out
}

/** True when `name` is referenced anywhere in src (any file) other than on `declLine` of
 * worker.ts itself -- i.e. it has at least one real USE, not just its own declaration. */
function hasCaller(name: string, declLine: number): boolean {
  const nameRe = new RegExp(`\\b${name}\\b`)
  for (const f of srcFiles()) {
    const stripped = stripComments(fs.readFileSync(f, 'utf8'))
    const lines = stripped.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (path.resolve(f) === path.resolve(WORKER_FILE) && i + 1 === declLine) continue
      if (nameRe.test(lines[i]!)) return true
    }
  }
  return false
}

/**
 * Exports with no reference anywhere in src outside their own declaration, and why that is fine.
 * An entry here that stops being true (a symbol regains a real caller, or genuinely becomes dead)
 * is caught by the "still real" checks below.
 */
const EXEMPTIONS: ReadonlyMap<string, string> = new Map([])

describe('every worker.ts export has a real caller somewhere in src (dead-critical-path-export defect class)', () => {
  it('finds a real, non-empty export population', () => {
    const names = workerExports().map((e) => e.name)
    pinnedPopulation({
      what: 'top-level exported functions/consts in src/worker.ts',
      items: names,
      floor: 15,
      mustInclude: ['pendingEmbeddings', 'sigtermDrainDeadline', 'ensureWorkerAlive', 'drainOnce'],
    })
  })

  it('every export has a caller somewhere in src, or is exempted', () => {
    const dead = workerExports().filter((e) => !hasCaller(e.name, e.line) && !EXEMPTIONS.has(e.name))
    expect(
      dead.map((e) => `${e.name} (worker.ts:${e.line})`),
      'These worker.ts exports have no reference anywhere in src/**/*.ts outside their own ' +
        'declaration line -- the exact shape pendingEmbeddings had before this fix. Wire in a real ' +
        'caller, or add a named EXEMPTIONS entry explaining why the export is intentionally unused ' +
        'in production code.',
    ).toEqual([])
  })

  it('every exemption still names a real worker.ts export', () => {
    const found = new Set(workerExports().map((e) => e.name))
    const stale = [...EXEMPTIONS.keys()].filter((n) => !found.has(n))
    expect(stale, 'these names are exempted but the scan no longer finds them in worker.ts').toEqual([])
  })
})
