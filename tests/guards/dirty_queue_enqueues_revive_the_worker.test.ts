/**
 * Structural guard for the "enqueue without revive" defect class.
 *
 * `ensureWorkerAlive` (auto-heal: spawn a fresh detached worker if none is running) had exactly one
 * caller in `src/` -- `hooks_edit.ts::postEditHandler`, the Claude Code / Codex post-edit hook.
 * Every other path that appends to the dirty queue (a Bash-hook file rewrite, `token-goat replace`,
 * `write-file`, `read_commands.ts`'s self-heal enqueue, `fold_delivery.ts`, `reconcile.ts`) called
 * `appendDirtyPath` directly and never called `ensureWorkerAlive`: if the worker had died before one
 * of those paths ran, the file it just enqueued sat in `queue/dirty.txt` forever with nothing ever
 * draining it, and the CLI call itself reported success. The fix moved the `ensureWorkerAlive` call
 * into `hooks_index.ts::enqueueDirtyPathSafe`, the one function every one of those paths already
 * calls to append the entry -- so calling `enqueueDirtyPathSafe` (rather than `appendDirtyPath`
 * directly) is now what "safely queues work" means in this codebase.
 *
 * A per-path regression test (tests/enqueue_revives_dead_worker.test.ts) drives one such path
 * (`token-goat replace`) against a real dead worker end to end. It says nothing about the next call
 * site someone adds that calls `appendDirtyPath` directly -- bypassing the safe wrapper -- and
 * forgets the revive `hooks_edit.ts` still does by hand for its own historical reason. So this guard
 * enumerates every direct call to `appendDirtyPath` in `src/` (excluding its own declaration and
 * `enqueueDirtyPathSafe`'s internal call, which is the wrapper itself) and requires each one's
 * enclosing function to also call `ensureWorkerAlive` -- or to be named in EXEMPTIONS with a reason.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { parseTopLevelFunctions, stripComments } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

interface DirectCallSite {
  readonly file: string
  readonly enclosingFunction: string | null
  readonly enclosingBody: string
}

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

/**
 * Every direct `appendDirtyPath(` call site in src, excluding `hooks_index.ts` entirely (that file
 * both declares `appendDirtyPath` and contains `enqueueDirtyPathSafe`'s own internal call to it --
 * the wrapper calling its own primitive is the mechanism, not an instance of the defect class).
 */
function directCallSites(): readonly DirectCallSite[] {
  const out: DirectCallSite[] = []
  for (const f of srcFiles()) {
    if (path.basename(f) === 'hooks_index.ts') continue
    const src = fs.readFileSync(f, 'utf8')
    if (!/\bappendDirtyPath\s*\(/.test(stripComments(src))) continue
    const fns = parseTopLevelFunctions(src)
    const rel = path.relative(SRC_DIR, f).split(path.sep).join('/')
    const hit = fns.find((fn) => /\bappendDirtyPath\s*\(/.test(stripComments(fn.body)))
    out.push({ file: rel, enclosingFunction: hit?.name ?? null, enclosingBody: hit?.body ?? src })
  }
  return out
}

/** Direct appendDirtyPath call sites that are fine without their own ensureWorkerAlive call, and
 * why. An entry here that stops matching a real call site is caught below. */
const EXEMPTIONS: ReadonlyMap<string, string> = new Map([
  [
    'hooks_edit.ts',
    'postEditHandlerInner calls ensureWorkerAlive() in its own try/catch immediately after ' +
      'appendDirtyPath -- this is the original, still-correct site the C4 fix generalized FROM, ' +
      'not an instance of the gap. See the comment directly above its ensureWorkerAlive() call.',
  ],
])

describe('every direct appendDirtyPath call site also revives a dead worker (enqueue-without-revive defect class)', () => {
  it('finds a real, non-empty population of direct appendDirtyPath call sites', () => {
    const sites = directCallSites()
    pinnedPopulation({
      what: 'src/**/*.ts files (outside hooks_index.ts) that call appendDirtyPath( directly',
      items: sites.map((s) => s.file),
      floor: 1,
      mustInclude: ['hooks_edit.ts'],
    })
  })

  it('every direct call site either calls ensureWorkerAlive itself or is exempted', () => {
    const unrevived = directCallSites().filter(
      (s) => !stripComments(s.enclosingBody).includes('ensureWorkerAlive(') && !EXEMPTIONS.has(s.file),
    )
    expect(
      unrevived.map((s) => `${s.file}::${s.enclosingFunction ?? '(top level)'}`),
      'These files call appendDirtyPath directly (bypassing enqueueDirtyPathSafe, the wrapper that ' +
        'revives a dead worker) without calling ensureWorkerAlive themselves either -- the exact ' +
        'enqueue-without-revive gap this guard exists to catch. Either switch to ' +
        'enqueueDirtyPathSafe, add an ensureWorkerAlive() call next to the appendDirtyPath call, or ' +
        'add a named EXEMPTIONS entry explaining why this site is not on a path a dead worker could ' +
        'ever leave permanently stuck.',
    ).toEqual([])
  })

  it('every exemption still names a real direct-call-site file', () => {
    const found = new Set(directCallSites().map((s) => s.file))
    const stale = [...EXEMPTIONS.keys()].filter((f) => !found.has(f))
    expect(stale, 'these files are exempted but the scan no longer finds a direct appendDirtyPath call in them').toEqual([])
  })

  it('enqueueDirtyPathSafe itself (the safe wrapper every other enqueue path is expected to use) still calls ensureWorkerAlive', () => {
    const src = fs.readFileSync(path.join(SRC_DIR, 'hooks_index.ts'), 'utf8')
    const fn = parseTopLevelFunctions(src).find((f) => f.name === 'enqueueDirtyPathSafe')
    expect(fn, 'enqueueDirtyPathSafe was not found in hooks_index.ts -- renamed or removed').toBeDefined()
    expect(
      stripComments(fn!.body).includes('ensureWorkerAlive('),
      'enqueueDirtyPathSafe no longer calls ensureWorkerAlive -- every caller of the "safe" wrapper ' +
        '(read_commands.ts, cli.ts, reconcile.ts, fold_delivery.ts, hooks_bash.ts, and this test\'s ' +
        'own EXEMPTIONS reasoning) relies on this call being here.',
    ).toBe(true)
  })
})
