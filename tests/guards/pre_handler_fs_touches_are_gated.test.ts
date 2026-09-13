/**
 * Every filesystem or network touch the VS Code relay makes BEFORE a handler runs must be gated.
 *
 * `tests/vscode_pre_handler_path_gate.test.ts` sweeps the handler REGISTRY, so it can only see code
 * a registered pre_tool_use handler reaches. Three times now a pre-approval touch has been added
 * ABOVE that line -- in `relay.ts` itself or in something it calls before `runHook` dispatches --
 * and been invisible to that sweep every time:
 *
 *   1. `view_image` stat'd a UNC or out-of-workspace path before approval;
 *   2. every VS Code pre hook stat'd its path before approval (fixed 1c6368fd by the shared
 *      `vscode_path_gate` + a registry sweep -- which is exactly the guard that cannot see here);
 *   3. `vscode_duplicate.ts::userScopeCopyIsRedundant` ran a bare `fs.existsSync` on a
 *      VS-Code-supplied `cwd`, which on Windows opens an SMB connection carrying an NTLM
 *      authentication attempt when that cwd is a UNC path, with no timeout on the in-process path.
 *
 * So this guard's population is the OTHER half: the call graph reachable from `relayInProcess` up
 * to the first handler dispatch. Default is inverted -- an fs/net call in a function nobody has
 * classified fails on arrival, and the author has to either route it through the path gate or name
 * it here with a reason. A guard that only knows about touches somebody remembered to declare is
 * the thing that failed three times.
 *
 * Of those three, only #3 is IN this population, and that is by construction rather than by
 * omission: #1 and #2 both sat inside registered pre_tool_use handlers, which is the other guard's
 * half of the relay. The two populations partition it -- everything up to `runHook` here,
 * everything past it there -- so neither one alone would have caught all three, and the pair does.
 *
 * Scope limits, stated rather than papered over. Only DIRECT fs/net calls count. A function that
 * passes a payload-derived path into a wrapper (`ensureDirSync`, `atomicWriteText`) is not flagged,
 * because propagating "touches" transitively up the call graph makes every caller including
 * `relayInProcess` red and the guard useless. All three historical instances were direct calls, so
 * this is the shape that has actually recurred; a wrapper-laundered one would slip past.
 * Resolution is by NAME through import statements:
 * a call through a variable, a method on an object, or a dynamically imported module is not
 * followed, and `calleeNames`-style matching over-approximates edges (a false edge only widens the
 * population, which is the safe direction). The traversal stops at `runHook` because everything
 * past it is the registry sweep's job. Being static, it says nothing about whether a gated call is
 * gated CORRECTLY -- `tests/vscode_pre_handler_path_gate.test.ts` and
 * `tests/vscode_duplicate.test.ts` cover that at runtime.
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

/** Node modules whose exports reach the filesystem or the network from inside this process. */
const TOUCHING_MODULES = /^(?:node:)?(?:fs|fs\/promises|net|tls|http|https|dgram|dns)$/

/** The dispatch boundary: everything past it belongs to tests/vscode_pre_handler_path_gate.ts. */
const DISPATCH = new Set(['runHook', 'handlersFor'])

interface Module {
  readonly fns: Map<string, string>
  /** Local name -> the module-relative file and original export name it came from. */
  readonly imports: Map<string, { file: string; name: string }>
  /** Local names bound to a whole touching module (`import * as fs from 'node:fs'`). */
  readonly namespaces: Set<string>
  /** Local names bound to a single touching-module export (`import { existsSync } from 'node:fs'`). */
  readonly bindings: Set<string>
}

function srcFiles(): string[] {
  const out: string[] = []
  ;(function walk(dir: string): void {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) out.push(p)
    }
  })(SRC_DIR)
  return out
}

function relOf(file: string): string {
  return path.relative(SRC_DIR, file).replace(/\\/g, '/')
}

function parseModule(rel: string, code: string): Module {
  const fns = new Map<string, string>()
  for (const fn of parseTopLevelFunctions(code)) fns.set(fn.name, fn.body)
  const imports = new Map<string, { file: string; name: string }>()
  const namespaces = new Set<string>()
  const bindings = new Set<string>()

  const importRe = /import\s+(type\s+)?([\s\S]*?)\s+from\s+'([^']+)'/g
  let m: RegExpExecArray | null
  while ((m = importRe.exec(code)) !== null) {
    if (m[1] !== undefined) continue // `import type` binds no value
    const clause = (m[2] ?? '').trim()
    const spec = m[3] ?? ''
    const touching = TOUCHING_MODULES.test(spec)
    if (clause.startsWith('* as ')) {
      if (touching) namespaces.add(clause.slice(5).trim())
      continue
    }
    if (!clause.startsWith('{')) continue
    for (const part of clause.replace(/^\{/, '').replace(/\}$/, '').split(',')) {
      const t = part.trim()
      if (t === '' || t.startsWith('type ')) continue
      const [orig, alias] = t.split(/\s+as\s+/).map((s) => s.trim())
      const local = alias ?? orig
      if (local === undefined || orig === undefined) continue
      if (touching) {
        bindings.add(local)
      } else if (spec.startsWith('.')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec.replace(/\.js$/, '.ts')))
        imports.set(local, { file: target, name: orig })
      }
    }
  }
  return { fns, imports, namespaces, bindings }
}

function loadModules(): Map<string, Module> {
  const mods = new Map<string, Module>()
  for (const file of srcFiles()) {
    const rel = relOf(file)
    mods.set(rel, parseModule(rel, fs.readFileSync(file, 'utf8')))
  }
  return mods
}

interface Visited {
  readonly key: string
  readonly file: string
  readonly name: string
  readonly body: string
  readonly touches: readonly string[]
  /** Keys of the pre-dispatch functions that call this one. */
  readonly callers: Set<string>
}

/** Which fs/net calls `body` makes directly, given the touching names `mod` bound. */
function touchesIn(body: string, mod: Module): string[] {
  const hits = new Set<string>()
  for (const ns of mod.namespaces) {
    const re = new RegExp(`\\b${ns}\\.(\\w+)\\s*\\(`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) hits.add(`${ns}.${m[1] ?? ''}`)
  }
  for (const b of mod.bindings) {
    if (new RegExp(`\\b${b}\\s*\\(`).test(body)) hits.add(b)
  }
  return [...hits].sort()
}

/** Every function reachable from `relayInProcess` before the handler registry takes over. */
function preDispatchClosure(mods: Map<string, Module>): Visited[] {
  const out = new Map<string, Visited>()
  const stack: Array<[string, string, string | undefined]> = [['relay.ts', 'relayInProcess', undefined]]
  while (stack.length > 0) {
    const [file, name, from] = stack.pop() as [string, string, string | undefined]
    const key = `${file}::${name}`
    const already = out.get(key)
    if (already !== undefined) {
      if (from !== undefined) already.callers.add(from)
      continue
    }
    const mod = mods.get(file)
    if (mod === undefined) continue
    const raw = mod.fns.get(name)
    if (raw === undefined) continue
    const body = codeOnly(raw)
    const visited: Visited = { key, file, name, body, touches: touchesIn(body, mod), callers: new Set(from === undefined ? [] : [from]) }
    out.set(key, visited)
    const callRe = /\b([A-Za-z_]\w*)\s*\(/g
    let m: RegExpExecArray | null
    while ((m = callRe.exec(body)) !== null) {
      const callee = m[1] as string
      if (DISPATCH.has(callee)) continue
      if (mod.fns.has(callee)) {
        stack.push([file, callee, key])
        continue
      }
      const im = mod.imports.get(callee)
      if (im !== undefined && mods.has(im.file)) stack.push([im.file, im.name, key])
    }
  }
  return [...out.values()]
}

/** Routed through the shared VS Code path gate, or through its UNC/device rejection directly. */
function isGated(body: string): boolean {
  return /vscodePathDeclined|vscodePathAllowed/.test(body)
}

/**
 * A leaf reader is classified when every pre-dispatch caller gated the path first.
 *
 * This is the one inference the guard makes, and it is deliberately not transitive: a single
 * ungated caller re-reds the leaf. That coupling is the point -- deleting the gate line from
 * `userScopeCopyIsRedundant` turns `readCopilotHooksOwners` red without anyone having to remember
 * to also remove an exemption for it.
 */
function isGatedByEveryCaller(v: Visited, byKey: Map<string, Visited>): boolean {
  if (v.callers.size === 0) return false
  return [...v.callers].every((c) => {
    const caller = byKey.get(c)
    return caller !== undefined && isGated(caller.body)
  })
}

function unclassifiedTouchers(): string[] {
  const closure = preDispatchClosure(loadModules())
  const byKey = new Map(closure.map((v) => [v.key, v]))
  return closure
    .filter((v) => v.touches.length > 0 && !isGated(v.body) && !isGatedByEveryCaller(v, byKey) && !EXEMPT.has(v.key))
    .map((v) => `${v.key} -> ${v.touches.join(', ')}`)
}

/**
 * Touching functions that are allowed to reach fs/net before dispatch, each with the reason it is
 * not a pre-approval hazard.
 *
 * The bar for an entry: the path it touches must NOT be derived from the hook payload. A path the
 * harness or the model supplied belongs behind the gate, not on this list. Add an entry only with
 * the reason written out -- an unexplained exemption reads as a decision and is worse than a gap.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  ['constants.ts::ensureDataDirPrivate', 'takes no argument; mkdir/chmod/stat only on dataDir(), which is derived from the environment and never from a payload'],
  ['constants.ts::ensureHomeDirPrivate', 'the same helper for the other root: takes no argument, and mkdir/chmod/stat only on tokenGoatHome(), which is TOKEN_GOAT_HOME or $HOME/.token-goat and never a payload path'],
  ['session_store.ts::saveSessionState', 'writes sessionPath(sessionId) under tokenGoatHome(), an env-derived root -- and the one payload-derived part, the session id, is sanitized to a stem and containment-checked against that directory in sessionSidecarPath before it becomes a path. NOT dataDir(), as this entry said for two rounds: the roots are different directories, and until ensureStorageRootPrivate the wording carried a false confidentiality implication too, since only dataDir() was mode-hardened'],
  ['session_store.ts::readDiskState', 'reads the path saveSessionState computed, same tokenGoatHome() provenance and the same sanitization'],
  ['vscode_duplicate.ts::alreadyClaimed', 'exclusive-creates one marker under markerDir() (dataDir()); its basename is a hash of (session_id, event, timestamp), not a path'],
  ['vscode_duplicate.ts::pruneMarkers', 'readdir/stat/rm inside markerDir() only'],
  ['bridges/created_configs.ts::readLedger', 'reads the created-configs ledger inside dataDir(); its whole purpose is to be a file no clone can reach'],
  ['path_containment.ts::resolveThroughLinks', 'the realpath/readlink containment primitive isInsideRoot -- and therefore the path gate itself -- is built out of; gating it would be circular'],
  ['util.ts::ensureDirSync', 'generic mkdir primitive: it touches only the path its caller supplies, so the caller is where a payload path has to be classified'],
  ['util.ts::atomicWriteCore', 'generic write primitive, same reasoning as ensureDirSync'],
  ['util.ts::withFileLock', 'generic lockfile primitive, same reasoning as ensureDirSync'],
])

describe('the pre-dispatch call graph is real', () => {
  it('reaches the relay entry point and the code the registry sweep cannot see', () => {
    const closure = preDispatchClosure(loadModules())
    pinnedPopulation({
      what: 'functions reachable from relayInProcess before handler dispatch',
      items: closure.map((v) => v.key),
      // Measured, not believed. This was pinned at 40 against a BELIEVED population of 45; the real
      // one is 112, so the floor could have lost 72 members -- 64% of the closure -- before saying
      // anything. The ceiling is what makes the belief falsifiable: a 45-sized belief implies a
      // ceiling around 55, which goes red at 112 instead of passing silently. Measure both (raise
      // the floor to 9999, read the count out of the failure) whenever the traversal or the shared
      // parser in reachability.ts changes -- widening that parser moves this number.
      floor: 100,
      ceiling: 140,
      mustInclude: ['relay.ts::relayInProcess', 'relay.ts::buildEvent', 'vscode_duplicate.ts::shouldSuppressDuplicateVscodeHook', 'vscode_duplicate.ts::userScopeCopyIsRedundant'],
    })
  })

  it('finds fs/net touches in it, so the classification below is not vacuous', () => {
    const touching = preDispatchClosure(loadModules()).filter((v) => v.touches.length > 0)
    pinnedPopulation({
      what: 'pre-dispatch functions that touch fs or net',
      items: touching.map((v) => v.key),
      floor: 8, // measured the same way: 11 live
      ceiling: 20,
      mustInclude: ['vscode_duplicate.ts::alreadyClaimed', 'bridges/copilot_cli_install.ts::readCopilotHooksOwners', 'constants.ts::ensureDataDirPrivate'],
    })
  })
})

describe('every pre-dispatch fs/net touch is gated or named', () => {
  it('has no unclassified toucher', () => {
    expect(
      unclassifiedTouchers(),
      'These run BEFORE VS Code asks the user to approve the tool call, and the registry sweep in ' +
        'tests/vscode_pre_handler_path_gate.test.ts cannot see them. Route the path through ' +
        'vscodePathDeclined (or reject a UNC/device root outright), or add the function to EXEMPT ' +
        'in this file with the reason its path cannot come from the payload.',
    ).toEqual([])
  })

  it('names no exemption that has stopped touching anything', () => {
    // A stale exemption is the other half of the false-exemption failure: it reads as a live
    // decision about code that no longer exists, and it hides the next real one behind it.
    const touchers = new Set(preDispatchClosure(loadModules()).filter((v) => v.touches.length > 0).map((v) => v.key))
    expect([...EXEMPT.keys()].filter((k) => !touchers.has(k))).toEqual([])
  })
})
