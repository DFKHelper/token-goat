/**
 * Built-bundle e2e for three shipping-path behaviours whose whole value is that the emitted
 * output is *usable*, and which unit tests with an injected fixture would happily pass while the
 * real binary emitted something broken:
 *
 *  1. `context-for` / `ask` emit `token-goat read ...` commands as their ENTIRE output. Before
 *     the `@LINE` anchor was appended, any symbol name with two definitions in one file produced
 *     two byte-identical suggestions, and running either failed with "Ambiguous symbol". This
 *     suite asserts that ambiguity precondition FIRST -- so the fixture cannot silently degrade
 *     into a single-definition one and make the whole test vacuous -- then EXECUTES every emitted
 *     suggestion and requires exit 0 with a non-empty body.
 *  2. `outline`/`skeleton`/`exports`/`imports` accept the family's comma-separated multi-file
 *     spec, and no longer drop extra space-separated file arguments in silence.
 *  3. `refs`/`callers` `-C <n>` show real call-site source text, and omitting it leaves output
 *     byte-identical.
 */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runBatched, stopBatchCli } from './helpers/batch-cli.js'

let repo: string
let dataBase: string
const tempDirs: string[] = []

function mkIsolated(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

async function run(args: string[]): Promise<RunResult> {
  return runBatched(args, { cwd: repo, env: { ...process.env, LOCALAPPDATA: dataBase, XDG_DATA_HOME: dataBase } })
}

/** Pulls the quoted spec out of an emitted `token-goat read "<spec>"` suggestion line. */
function specOf(line: string): string {
  const m = /^token-goat read "(.+)"$/.exec(line.trim())
  expect(m, `not a well-formed read suggestion: ${JSON.stringify(line)}`).not.toBeNull()
  return m![1]!
}

beforeAll(async () => {
  dataBase = mkIsolated('tg-runnable-data-')
  repo = mkIsolated('tg-runnable-repo-')

  // Item 1 fixture: `dupBudgetCalc` is defined TWICE in one file (a class method and a top-level
  // function), at different lines. This is the exact shape that made unanchored suggestions
  // unrunnable.
  fs.writeFileSync(
    path.join(repo, 'dupsym.ts'),
    'export class DupBudgetHolder {\n' +
      '  dupBudgetCalc(): number {\n' +
      '    return 11\n' +
      '  }\n' +
      '}\n' +
      'export function dupBudgetCalc(): number {\n' +
      '  return 22\n' +
      '}\n',
  )

  // Item 2 fixture: two files with DISJOINT symbol sets, disjoint exports, and disjoint imports.
  fs.writeFileSync(
    path.join(repo, 'alpha.ts'),
    "import { sharedNothingA } from './vendor_a.js'\n" +
      'export function alphaOnlyFn(): number {\n  return sharedNothingA\n}\n',
  )
  fs.writeFileSync(
    path.join(repo, 'beta.ts'),
    "import { sharedNothingB } from './vendor_b.js'\n" +
      'export function betaOnlyFn(): number {\n  return sharedNothingB\n}\n',
  )

  // Item 3 fixture: `ctxTarget` is called on a line carrying a token that appears NOWHERE else --
  // not in the symbol name, not in the enclosing-symbol name -- so a `-C` assertion on it can only
  // pass if real source text was rendered.
  fs.writeFileSync(
    path.join(repo, 'ctxdef.ts'),
    'export function ctxTarget(n: number): number {\n  return n + 1\n}\n',
  )
  fs.writeFileSync(
    path.join(repo, 'ctxuse.ts'),
    "import { ctxTarget } from './ctxdef.js'\n" +
      'export function ctxCaller(): number {\n' +
      '  return ctxTarget(9) /* ZQUNIQUECALLSITE */\n' +
      '}\n',
  )

  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  }
  git(['init'])
  git(['-c', 'core.hooksPath=/dev/null', 'add', '.'])
  git(['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'init'])

  const idx = await run(['index', '.'])
  expect(idx.status, `index failed: ${idx.stderr}`).toBe(0)
}, 120000)

afterAll(() => {
  stopBatchCli()
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

describe('context-for / ask emit runnable read commands', () => {
  it('PRECONDITION: the unanchored spec really is ambiguous in this fixture', async () => {
    // Guards the whole suite against going vacuous. If the fixture ever degrades to a single
    // definition, `read "dupsym.ts::dupBudgetCalc"` starts succeeding, this fails, and nobody is
    // fooled into thinking the anchored suggestions below proved anything.
    const r = await run(['read', 'dupsym.ts::dupBudgetCalc'])
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}${r.stderr}`).toContain('Ambiguous symbol')
  })

  it('context-for emits anchored suggestions that all execute successfully', async () => {
    const r = await run(['context-for', 'dupBudgetCalc'])
    expect(r.status, r.stderr).toBe(0)
    const lines = r.stdout.trim().split('\n').filter((l) => l.trim().length > 0)
    // The load-bearing assertion comes FIRST and is behavioural, not cosmetic: every emitted
    // suggestion, verbatim, must actually run. A change to how the suggestion is *formatted*
    // cannot make this pass or fail; only an unrunnable suggestion can.
    for (const line of lines) {
      const exec = await run(['read', specOf(line)])
      expect(exec.status, `suggestion failed: ${line}\n${exec.stderr}`).toBe(0)
      expect(exec.stdout.trim().length).toBeGreaterThan(0)
    }
    // Exact count pinned: both `dupBudgetCalc` definitions plus the enclosing class the FTS
    // query also matches. Not "some entries exist".
    expect(lines.length).toBe(3)
    expect(lines.filter((l) => l.includes('::dupBudgetCalc@')).length).toBe(2)
    // Suggestions must be distinguishable from each other.
    expect(new Set(lines).size).toBe(3)
  })

  it('context-for --json entries are pairwise distinct and carry a line', async () => {
    const r = await run(['context-for', 'dupBudgetCalc', '--json'])
    expect(r.status, r.stderr).toBe(0)
    const entries = JSON.parse(r.stdout) as { file: string; symbol: string; kind: string; line: number; readCmd: string }[]
    expect(entries.length).toBe(3)
    expect(new Set(entries.map((e) => JSON.stringify(e))).size).toBe(3)
    expect(new Set(entries.map((e) => e.readCmd)).size).toBe(3)
    for (const e of entries) {
      expect(Number.isInteger(e.line)).toBe(true)
      expect(e.line).toBeGreaterThan(0)
      expect(e.readCmd).toContain(`@${e.line}`)
    }
    // The two same-named definitions are the point: distinct lines, distinct commands.
    const dups = entries.filter((e) => e.symbol === 'dupBudgetCalc')
    expect(dups.length).toBe(2)
    expect(dups[0]!.line).not.toBe(dups[1]!.line)
  })

  it('ask (degraded mode) emits anchored suggestions that all execute successfully', async () => {
    const r = await run(['ask', 'dupBudgetCalc'])
    expect(r.status, r.stderr).toBe(0)
    const lines = r.stdout.trim().split('\n').filter((l) => l.startsWith('token-goat read '))
    for (const line of lines) {
      const exec = await run(['read', specOf(line)])
      expect(exec.status, `suggestion failed: ${line}\n${exec.stderr}`).toBe(0)
      expect(exec.stdout.trim().length).toBeGreaterThan(0)
    }
    expect(lines.length).toBe(3)
    expect(lines.filter((l) => l.includes('::dupBudgetCalc@')).length).toBe(2)
    expect(new Set(lines).size).toBe(3)
  })
})

describe('outline / skeleton / exports / imports accept a comma-separated file list', () => {
  it('outline "a,b" reports both files, each with its own unique symbol', async () => {
    const r = await run(['outline', 'alpha.ts,beta.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('# Outline: alpha.ts')
    expect(r.stdout).toContain('# Outline: beta.ts')
    expect(r.stdout).toContain('alphaOnlyFn')
    expect(r.stdout).toContain('betaOnlyFn')
  })

  it('skeleton "a,b" reports both files, each with its own unique symbol', async () => {
    const r = await run(['skeleton', 'alpha.ts,beta.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('# Skeleton: alpha.ts')
    expect(r.stdout).toContain('# Skeleton: beta.ts')
    expect(r.stdout).toContain('alphaOnlyFn')
    expect(r.stdout).toContain('betaOnlyFn')
  })

  it('exports "a,b" reports both files, each with its own unique export', async () => {
    const r = await run(['exports', 'alpha.ts,beta.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('# Exports: alpha.ts')
    expect(r.stdout).toContain('# Exports: beta.ts')
    expect(r.stdout).toContain('alphaOnlyFn')
    expect(r.stdout).toContain('betaOnlyFn')
  })

  it('imports "a,b" reports both files, each with its own unique import', async () => {
    const r = await run(['imports', 'alpha.ts,beta.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('# Imports: alpha.ts')
    expect(r.stdout).toContain('# Imports: beta.ts')
    expect(r.stdout).toContain('./vendor_a.js')
    expect(r.stdout).toContain('./vendor_b.js')
  })

  it('single-file behaviour is unchanged (no per-file header, no second file)', async () => {
    const r = await run(['outline', 'alpha.ts'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('# Outline: alpha.ts')
    expect(r.stdout).not.toContain('# Outline: beta.ts')
    expect(r.stdout).not.toContain('betaOnlyFn')
  })

  it('extra space-separated file arguments are named, not silently dropped', async () => {
    for (const cmd of ['outline', 'skeleton', 'exports', 'imports']) {
      const r = await run([cmd, 'alpha.ts', 'beta.ts'])
      expect(r.status, `${cmd}: ${r.stderr}`).toBe(0)
      expect(r.stdout, `${cmd} dropped beta.ts in silence`).toContain('beta.ts')
      expect(r.stdout).toContain(`token-goat ${cmd} "alpha.ts,beta.ts"`)
    }
  })
})

describe('refs / callers -C shows real call-site source', () => {
  const MARKER = 'ZQUNIQUECALLSITE'

  it('refs -C 1 renders the call-site source line; plain refs does not', async () => {
    const plain = await run(['refs', 'ctxdef.ts::ctxTarget'])
    expect(plain.status, plain.stderr).toBe(0)
    expect(plain.stdout).not.toContain(MARKER)

    const ctx = await run(['refs', 'ctxdef.ts::ctxTarget', '-C', '1'])
    expect(ctx.status, ctx.stderr).toBe(0)
    expect(ctx.stdout).toContain(MARKER)
  })

  it('omitting -C leaves refs output byte-identical to -C 0', async () => {
    const plain = await run(['refs', 'ctxdef.ts::ctxTarget'])
    const zero = await run(['refs', 'ctxdef.ts::ctxTarget', '-C', '0'])
    expect(plain.status).toBe(0)
    expect(zero.stdout).toBe(plain.stdout)
  })

  it('callers -C 1 renders the call-site source line; plain callers does not', async () => {
    const plain = await run(['callers', 'ctxTarget'])
    expect(plain.status, plain.stderr).toBe(0)
    expect(plain.stdout).not.toContain(MARKER)

    const ctx = await run(['callers', 'ctxTarget', '-C', '1'])
    expect(ctx.status, ctx.stderr).toBe(0)
    expect(ctx.stdout).toContain(MARKER)
  })

  it('brief -C 1 renders the call-site source line in its caller block', async () => {
    const plain = await run(['brief', 'ctxdef.ts::ctxTarget'])
    expect(plain.status, plain.stderr).toBe(0)
    expect(plain.stdout).not.toContain(MARKER)

    const ctx = await run(['brief', 'ctxdef.ts::ctxTarget', '-C', '1'])
    expect(ctx.status, ctx.stderr).toBe(0)
    expect(ctx.stdout).toContain(MARKER)
  })

  it('refs --json gains contextLines only with -C, and keeps the existing context field', async () => {
    const plain = await run(['refs', 'ctxdef.ts::ctxTarget', '--json'])
    expect(plain.status, plain.stderr).toBe(0)
    const plainItems = (JSON.parse(plain.stdout) as { items: Record<string, unknown>[] }).items
    expect(plainItems.length).toBe(1)
    expect(plainItems[0]!['contextLines']).toBeUndefined()
    expect(plainItems[0]!['context']).toBe('ctxCaller')

    const ctx = await run(['refs', 'ctxdef.ts::ctxTarget', '--json', '-C', '1'])
    expect(ctx.status, ctx.stderr).toBe(0)
    const ctxItems = (JSON.parse(ctx.stdout) as { items: Record<string, unknown>[] }).items
    expect(ctxItems.length).toBe(1)
    // The existing enclosing-symbol field is untouched...
    expect(ctxItems[0]!['context']).toBe('ctxCaller')
    // ...and the new source window sits alongside it.
    const windowLines = ctxItems[0]!['contextLines'] as { line: number; text: string }[]
    expect(windowLines.length).toBe(3)
    expect(windowLines.some((l) => l.text.includes(MARKER))).toBe(true)
  })
})
