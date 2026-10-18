/** A worker daemon or hook server a test starts has to leave on its own when the run is killed before any afterEach runs. The guard finds a test-side start by the argv it hands the spawn (`--worker-daemon`, `--claim-worker`, `hook-server run`, `worker start`), whatever the helper or the variable is called, and fails one that defeats the run's backstop: a spawn environment built without the caller's, an idle exit switched off for a spawn, or a stand-in daemon with no owner-tied death. Test hygiene, not product behaviour. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { trackedFiles } from '../helpers/tracked-files.js'
import { TEST_WORKER_IDLE_EXIT_MS } from '../setup/resident-backstop.js'
import { pinnedPopulation } from './population.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_IDLE_EXIT_MS = 6 * 60 * 60 * 1000

// The argv elements that make a process a resident: an element that IS the flag (a command line that merely mentions it, in a longer string, is not an argv element), `hook-server` followed by `run`, and `worker` followed by `start`, which makes the shim start a daemon.
const WORKER_FLAG = /(['"`])--(?:worker-daemon|claim-worker)\1/
const START_SHAPES = [WORKER_FLAG, /(['"`])hook-server\1\s*,\s*(['"`])run\2/, /(['"`])worker\1\s*,\s*(['"`])start\2/]

// Any call that starts a process or hands argv to one, by its last name. A wrapper named otherwise is reached by the file-level rules below, not here.
const START_CALL = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork|spawnOwned|runBundle|runBundleAsync)\s*\(/g

// What gives a stand-in daemon (a process that only looks like one: it idles and carries the flag) a death tied to its owner. An import of a name is not a use of it, so import lines are left out of the check.
const OWNER_TIED = /\b(?:spawnOwnedDecoy|OWNER_TIED_DECOY_SOURCE|OWNER_LIVENESS_SOURCE)\b/

interface Finding {
  readonly file: string
  readonly rule: 'env-without-inheritance' | 'idle-exit-removed' | 'decoy-without-owner'
  readonly detail: string
}

/** The code half of a line: a whole-line comment and a trailing `//` comment are cut off, so prose that mentions a flag never matches. */
function codeOf(line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
  const at = line.search(/\s\/\/\s/)
  return at === -1 ? line : line.slice(0, at)
}

/** The text of the call whose opening parenthesis is at column `from` of `lines[i]`, up to its closing parenthesis (a parenthesis inside a string literal does not count). */
function callExpression(lines: readonly string[], i: number, from: number): string {
  let depth = 0
  let quote = ''
  let text = ''
  for (let n = i; n < lines.length; n++) {
    const code = n === i ? codeOf(lines[n]!).slice(from) : codeOf(lines[n]!)
    for (let c = 0; c < code.length; c++) {
      const ch = code[c]!
      text += ch
      if (quote !== '') {
        if (ch === String.fromCharCode(92)) text += code[++c] ?? ''
        else if (ch === quote) quote = ''
      } else if (ch === "'" || ch === '"' || ch === '`') quote = ch
      else if (ch === '(') depth++
      else if (ch === ')' && --depth === 0) return text
    }
    text += '\n'
    // Only a template literal runs on to the next line.
    if (quote !== '`') quote = ''
  }
  return text
}

/** The `env:` option of a spawn when it is an object literal that does not begin with a spread: a fresh environment, which drops the idle exit the run set. An identifier or call is not resolved here; the rows over the real builders cover those. */
function freshEnvLiteral(callText: string): string | null {
  const at = callText.search(/\benv\s*:\s*\{/)
  if (at === -1) return null
  const body = callText.slice(callText.indexOf('{', at) + 1).trimStart()
  return body.startsWith('...') ? null : body.slice(0, 60).replace(/\s+/g, ' ')
}

/** Every finding in one file's text. `file` only labels it. */
function findingsIn(file: string, source: string): Finding[] {
  const lines = source.split('\n')
  const code = lines.map(codeOf).join('\n')
  const found: Finding[] = []
  // An environment, in any test-side file, that drops, empties or lengthens the run's idle exit: the value 0 or an empty string is ignored by resolveIdleExitMs, and anything from six hours up is the product default again. Deleting it from process.env itself is the in-process default test, not a spawn environment.
  for (const m of code.matchAll(/delete\s+(?!process\.env\b)[\w.]+\[\s*(['"`])TG_WORKER_IDLE_EXIT_MS\1\s*\]/g)) found.push({ file, rule: 'idle-exit-removed', detail: m[0] })
  for (const m of code.matchAll(/TG_WORKER_IDLE_EXIT_MS['"`]?\s*:\s*(['"`])([^'"`]*)\1/g)) {
    const value = Number(m[2]!.replace(/_/g, ''))
    if (!(value > 0 && value < DEFAULT_IDLE_EXIT_MS)) found.push({ file, rule: 'idle-exit-removed', detail: m[0] })
  }
  if (!START_SHAPES.some((shape) => shape.test(code))) return found

  for (let i = 0; i < lines.length; i++) {
    const line = codeOf(lines[i]!)
    for (const match of line.matchAll(START_CALL)) {
      const text = callExpression(lines, i, match.index! + match[0].length - 1)
      if (!START_SHAPES.some((shape) => shape.test(text))) continue
      const fresh = freshEnvLiteral(text)
      if (fresh !== null) found.push({ file, rule: 'env-without-inheritance', detail: `line ${String(i + 1)}: env: { ${fresh}` })
    }
  }

  // A stand-in that carries the flag and idles has no death condition unless it is tied to its owner.
  if (WORKER_FLAG.test(code) && /\bsetInterval\s*\(/.test(source) && !OWNER_TIED.test(code.replace(/^\s*import\b.*$/gm, ''))) {
    found.push({ file, rule: 'decoy-without-owner', detail: 'a script that idles and an argv that carries the daemon flag, with no owner-tied death' })
  }
  return found
}

/** The longest per-test timeout the suite declares, in ms: a line that closes a test with `}, N)`, a `timeout: N` option, and the vitest config's two defaults. The idle exit has to exceed it, because the runner ends the test first. */
function longestDeclaredTimeoutMs(sources: readonly string[]): number {
  let longest = 0
  const take = (raw: string | undefined): void => {
    const value = Number((raw ?? '').replace(/_/g, ''))
    if (Number.isFinite(value) && value > longest) longest = value
  }
  for (const source of sources) {
    for (const m of source.matchAll(/^\s*\}\s*,\s*([0-9][0-9_]*)\s*\)/gm)) take(m[1])
    for (const m of source.matchAll(/\b(?:timeout|testTimeout|hookTimeout)\s*:\s*([0-9][0-9_]*)/g)) take(m[1])
  }
  return longest
}

function testSideFiles(): string[] {
  return trackedFiles({ pathspec: ['tests'] }).filter((f) => /\.(?:ts|mts|js|mjs)$/.test(f) && !f.startsWith('tests/guards/'))
}

const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8')

// FORMAT-DERIVED: the argv shapes are read off the launch sites in src/worker_lifecycle.ts::startDetachedWorker (`node <entry> --worker-daemon`), src/cli.ts (`--claim-worker`) and the hook client's autostart (`hook-server run --slot N`), and off src/worker.ts::resolveIdleExitMs for what the variable accepts. Every probe below is HAND-DERIVED from those, not captured from a run.
describe('probes: each detection fires on the shape it is named for', () => {
  const START = "const child = spawn(process.execPath, [BUNDLE, 'hook-server', 'run', '--slot', '0'], "
  it('flags a spawn whose environment is a fresh literal', () => {
    expect(findingsIn('t.ts', `${START}{ env: { PATH: process.env.PATH } })`).map((f) => f.rule)).toEqual(['env-without-inheritance'])
  })
  it('flags a fresh literal on the next line of the call, and one under a worker start', () => {
    const source = "const r = runBundle(['worker', 'start'], {\n  cwd: dir,\n  env: {\n    HOME: dir,\n  },\n})\n"
    expect(findingsIn('t.ts', source).map((f) => f.rule)).toEqual(['env-without-inheritance'])
  })
  it('passes an environment that starts from the caller\'s, and one built elsewhere', () => {
    expect(findingsIn('t.ts', `${START}{ env: { ...process.env, X: '1' } })`)).toEqual([])
    expect(findingsIn('t.ts', `${START}{ env: sandboxEnv })`)).toEqual([])
    expect(findingsIn('t.ts', `${START}{ cwd: dir })`)).toEqual([])
  })
  it('ignores a fresh environment on a spawn that starts no resident', () => {
    expect(findingsIn('t.ts', "spawn(process.execPath, [BUNDLE, 'status'], { env: { A: '1' } })\nconst other = ['--worker-daemon']")).toEqual([])
  })
  it('ignores a command line that only mentions the flag, and a comment that does', () => {
    expect(findingsIn('t.ts', "// spawn(x, ['--worker-daemon'], { env: { A: '1' } })\nconst line = 'node entry.mjs --worker-daemon'\nspawn(a, [line], { env: { A: '1' } })")).toEqual([])
  })
  it('flags a spawn environment that deletes, empties, zeroes or lengthens the idle exit', () => {
    const base = "spawn(node, [entry, '--worker-daemon'], { env })\n"
    for (const edit of ["delete laterEnv['TG_WORKER_IDLE_EXIT_MS']", "const e = { TG_WORKER_IDLE_EXIT_MS: '' }", "const e = { TG_WORKER_IDLE_EXIT_MS: '0' }", "const e = { TG_WORKER_IDLE_EXIT_MS: '21600000' }", "const e = { 'TG_WORKER_IDLE_EXIT_MS': '21_600_000' }"]) {
      expect(findingsIn('t.ts', base + edit).map((f) => f.rule), edit).toEqual(['idle-exit-removed'])
    }
  })
  it('passes a shorter idle exit and the in-process default test', () => {
    const base = "spawn(node, [entry, '--worker-daemon'], { env })\n"
    expect(findingsIn('t.ts', `${base}const e = { TG_WORKER_IDLE_EXIT_MS: '1500' }`)).toEqual([])
    expect(findingsIn('t.ts', `${base}delete process.env['TG_WORKER_IDLE_EXIT_MS']`)).toEqual([])
  })
  it('flags an idling stand-in that carries the daemon flag with no owner-tied death, and passes one with it', () => {
    const bare = "const d = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--worker-daemon'])"
    expect(findingsIn('t.ts', bare).map((f) => f.rule)).toEqual(['decoy-without-owner'])
    expect(findingsIn('t.ts', "const d = spawnOwnedDecoy(['--worker-daemon'])\nconst s = 'setInterval(() => {}, 1000)'")).toEqual([])
  })
  it('reads the longest declared timeout from a closing line and from an option', () => {
    expect(longestDeclaredTimeoutMs(['it(a, async () => {\n  x()\n}, 1_800_000)\n', 'it(b, { timeout: 90000 }, fn)'])).toBe(1_800_000)
    expect(longestDeclaredTimeoutMs(['const n = foo(a, 5_000_000)'])).toBe(0)
  })
})

describe('the test-side residents of this repository', () => {
  it('start with a backstop: no tracked test file is flagged', () => {
    const files = pinnedPopulation({
      what: 'tracked test-side files outside tests/guards',
      items: testSideFiles(),
      floor: 400,
      mustInclude: ['tests/worker_daemon_e2e.test.ts', 'tests/hook_server.test.ts', 'tests/helpers/copilot_session_start_tree.ts', 'tests/worker_claim_spawns_nothing.test.ts', 'tests/setup/isolate-home.ts'],
    })
    const resident = pinnedPopulation({
      what: 'test-side files that hand a spawn a resident argv',
      items: files.filter((f) => START_SHAPES.some((shape) => shape.test(read(f)))),
      floor: 15,
      mustInclude: ['tests/worker_daemon_e2e.test.ts', 'tests/hook_server.test.ts', 'tests/helpers/copilot_session_start_tree.ts', 'tests/worker_claim_spawns_nothing.test.ts', 'tests/worker_displaced_note.test.ts', 'tests/worker_stray_retire_e2e.test.ts'],
    })
    expect(resident.length).toBeGreaterThan(0)
    const findings = files.flatMap((f) => findingsIn(f, read(f)))
    expect(findings, `a test-started resident without a backstop:\n${findings.map((f) => `  ${f.file} [${f.rule}] ${f.detail}`).join('\n')}`).toEqual([])
  })

  it('get an idle exit longer than every per-test timeout the suite declares and shorter than the product default', () => {
    const sources = [...testSideFiles(), 'vitest.config.ts'].map(read)
    const longest = longestDeclaredTimeoutMs(sources)
    expect(longest, 'no timeout read: the scan found nothing to compare against').toBeGreaterThan(0)
    expect(TEST_WORKER_IDLE_EXIT_MS).toBeGreaterThan(longest)
    expect(TEST_WORKER_IDLE_EXIT_MS).toBeLessThan(DEFAULT_IDLE_EXIT_MS)
  })

  it('get that idle exit from the setup file every test file runs', () => {
    const setup = read('tests/setup/isolate-home.ts')
    expect(setup).toContain("process.env['TG_WORKER_IDLE_EXIT_MS'] = String(TEST_WORKER_IDLE_EXIT_MS)")
    expect(readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf8')).toContain("'./tests/setup/isolate-home.ts'")
  })
})

// Each mutant is [file, exact anchor, replacement]: applied to the real file's text, it must produce a finding the unmutated file does not.
const MUTANTS: ReadonlyArray<readonly [file: string, anchor: string, replacement: string, rule: Finding['rule']]> = [
  ['tests/worker_claim_spawns_nothing.test.ts', "decoy = spawnOwnedDecoy(['--worker-daemon'])", "decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--worker-daemon'])", 'decoy-without-owner'],
  ['tests/worker_displaced_note.test.ts', "const child = spawnOwnedDecoy(['--worker-daemon'])", "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--worker-daemon'])", 'decoy-without-owner'],
  ['tests/worker_daemon_e2e.test.ts', 'env: { ...tgEnv(dataBase, DAEMON_POLL_MS), TG_WORKER_DATA_DIR: dataDir },', 'env: { TG_WORKER_DATA_DIR: dataDir },', 'env-without-inheritance'],
  ['tests/helpers/copilot_session_start_tree.ts', "spawn(process.execPath, [BUNDLE, 'hook-server', 'run', '--slot', '0'], {", "spawn(process.execPath, [BUNDLE, 'hook-server', 'run', '--slot', '0'], { env: { PATH: process.env['PATH'] },", 'env-without-inheritance'],
  ['tests/worker_retire_e2e.test.ts', "const laterEnv = { ...env, TG_WORKER_IDLE_EXIT_MS: String(TEST_WORKER_IDLE_EXIT_MS) }", "const laterEnv = { ...env }\n      delete laterEnv['TG_WORKER_IDLE_EXIT_MS']", 'idle-exit-removed'],
  ['tests/helpers/worker_stray_env.ts', 'TG_WORKER_IDLE_EXIT_MS: String(TEST_WORKER_IDLE_EXIT_MS)', "TG_WORKER_IDLE_EXIT_MS: '0'", 'idle-exit-removed'],
]

describe('mutants: each detection goes red when its protected line is broken', () => {
  for (const [file, anchor, replacement, rule] of MUTANTS) {
    it(`${file}: ${rule}`, () => {
      const source = read(file)
      expect(source.split(anchor).length - 1, `the anchor is not in ${file} exactly once`).toBe(1)
      expect(findingsIn(file, source), 'the unmutated file is already flagged').toEqual([])
      expect(findingsIn(file, source.replace(anchor, () => replacement)).map((f) => f.rule)).toContain(rule)
    })
  }
})
