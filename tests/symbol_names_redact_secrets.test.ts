/** Module-level check that every read command printing a stored symbol name redacts a secret-shaped name, text and --json alike, and prints a name with no secret unchanged. Fixture provenance: HAND-DERIVED, the key is the documented Anthropic key shape (sk-ant-api03- plus 40 characters) and the token is the GitHub token shape (ghp_ plus 36 alphanumerics) from the redaction pattern table in src/secret_redact.ts, placed in a TOML table header, a JSON key and TypeScript identifiers by hand. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildProjectMap, formatProjectMap } from '../src/baseline.js'
import { runCoverageGaps, runBlame, runContextFor, runSimilar, runTestFor } from '../src/graph_analysis.js'
import { runAsk, runCallChain, runCallers, runImpact } from '../src/graph_commands.js'
import { runDead, runScope, runTypes } from '../src/graph_inspection.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runGrep } from '../src/read_commands.js'
import { runLocate } from '../src/read_inspect.js'
import { runSymbol } from '../src/read_symbol.js'

const ANT = 'sk-ant-api03-' + 'a'.repeat(40)
const ANT_PLACEHOLDER = '[REDACTED:anthropic_api_key]'
const GHP_USED = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const GHP_DEAD = 'ghp_' + 'z9Y8x7W6v5U4t3S2r1Q0p9O8n7M6l5K4j3I2'
const GHP_TYPE = 'ghp_' + 'b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9'
const GHP_PLACEHOLDER = '[REDACTED:github_token]'

const SECRET_TS = [
  `export function ${GHP_USED}(): number {`,
  '  return 1 // zebramarker',
  '}',
  'export function callsSecret(): number {',
  `  return ${GHP_USED}() + 1 // zebracaller`,
  '}',
  `export function ${GHP_DEAD}(): number {`,
  '  return 2 // zebradead',
  '}',
  '',
].join('\n')
const SECRET_TYPES_TS = [`export interface ${GHP_TYPE} {`, '  zebrafield: number', '}', ''].join('\n')
const SECRET_TEST_TS = [
  `import { ${GHP_USED} } from './secret'`,
  `export function test_${GHP_USED}(): number {`,
  `  return ${GHP_USED}() // zebratest`,
  '}',
  '',
].join('\n')
const PLAIN_TS = 'export function plainFn(): number {\n  return 1 // zebraplain\n}\nexport function callsPlain(): number {\n  return plainFn() + 1\n}\n'
const VAULT_TOML = `[${ANT}]\nnote = "x"\n`
const VAULT_JSON = `{"${ANT}": {"note": 1}}\n`

let root: string
let origCwd: string

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

function write(name: string, text: string): void {
  const file = join(root, name)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text, 'utf-8')
}

const FILES = ['secret.ts', 'secret_types.ts', 'secret.test.ts', 'plain.ts', 'vault.toml', 'vault.json']

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-symbol-names-redact-')))
  origCwd = process.cwd()
  process.chdir(root)
  git('init')
  git('config', 'user.email', 'test@test.com')
  git('config', 'user.name', 'Test')
  git('config', 'core.autocrlf', 'false')
  write('secret.ts', SECRET_TS)
  write('secret_types.ts', SECRET_TYPES_TS)
  write('secret.test.ts', SECRET_TEST_TS)
  write('plain.ts', PLAIN_TS)
  write('vault.toml', VAULT_TOML)
  write('vault.json', VAULT_JSON)
  git('add', '.')
  git('commit', '-m', 'first')
  for (const name of FILES) indexFileSync(normalizePath(join(root, name)))
})

afterAll(() => {
  process.chdir(origCwd)
  rmSync(root, { recursive: true, force: true })
})

/** Runs `fn` and returns what it wrote to stdout and stderr, joined, after checking it exited 0. */
function printed(fn: () => number): { out: string } {
  let out = ''
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  const grab = (chunk: string | Uint8Array): boolean => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }
  process.stdout.write = grab as typeof process.stdout.write
  process.stderr.write = grab as typeof process.stderr.write
  let code: number | undefined
  try {
    code = fn()
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
  expect(code).toBe(0)
  return { out }
}

function expectNoSecret(out: string): void {
  for (const s of [ANT, GHP_USED, GHP_DEAD, GHP_TYPE]) expect(out).not.toContain(s)
  expect(out).not.toContain('sk-ant-api03')
  expect(out).not.toContain('ghp_')
}

interface Case {
  name: string
  run: (json: boolean) => number
  placeholder: string
}

const CASES: Case[] = [
  { name: 'scope vault.toml:1', run: (json) => runScope({ spec: 'vault.toml:1', json }), placeholder: ANT_PLACEHOLDER },
  { name: 'scope vault.json:1', run: (json) => runScope({ spec: 'vault.json:1', json }), placeholder: ANT_PLACEHOLDER },
  { name: 'scope secret.ts:2', run: (json) => runScope({ spec: 'secret.ts:2', json }), placeholder: GHP_PLACEHOLDER },
  { name: 'context-for', run: (json) => runContextFor({ task: 'zebramarker', json }), placeholder: GHP_PLACEHOLDER },
  { name: 'similar', run: (json) => runSimilar({ spec: `secret.ts::${GHP_USED}`, json }), placeholder: GHP_PLACEHOLDER },
  { name: 'dead', run: (json) => runDead({ includePrivate: true, json }), placeholder: GHP_PLACEHOLDER },
  { name: 'types', run: (json) => runTypes({ json }), placeholder: GHP_PLACEHOLDER },
  { name: 'coverage-gaps', run: (json) => runCoverageGaps({ includePrivate: true, json }), placeholder: GHP_PLACEHOLDER },
  { name: 'test-for', run: (json) => runTestFor({ file: 'secret.ts', json }), placeholder: GHP_PLACEHOLDER },
  { name: 'blame', run: (json) => runBlame({ spec: `secret.ts::${GHP_USED}`, json, cwd: root }), placeholder: GHP_PLACEHOLDER },
  { name: 'locate', run: (json) => runLocate({ spec: 'ghp_', json, projectRoot: root }), placeholder: GHP_PLACEHOLDER },
  { name: 'callers', run: (json) => runCallers({ symbol: GHP_USED, json }), placeholder: GHP_PLACEHOLDER },
  { name: 'call-chain', run: (json) => runCallChain({ symbol: GHP_USED, json }), placeholder: GHP_PLACEHOLDER },
  { name: 'impact', run: (json) => runImpact({ symbol: GHP_USED, json }), placeholder: GHP_PLACEHOLDER },
  { name: 'ask (degraded)', run: (json) => runAsk({ question: 'zebramarker', json }), placeholder: GHP_PLACEHOLDER },
  { name: 'grep --symbol', run: (json) => runGrep({ pattern: 'zebramarker', symbol: true, json, projectRoot: root }), placeholder: GHP_PLACEHOLDER },
]

describe('read commands print no secret from a stored symbol name', () => {
  for (const c of CASES) {
    it(`${c.name} redacts the name, text and --json`, () => {
      const text = printed(() => c.run(false))
      expectNoSecret(text.out)
      expect(text.out).toContain(c.placeholder)
      const json = printed(() => c.run(true))
      expectNoSecret(json.out)
      expect(json.out).toContain(c.placeholder)
    })
  }

  it('map lists a secret-named symbol redacted', () => {
    const text = formatProjectMap(buildProjectMap(root, { compact: true }), true)
    expectNoSecret(text)
    expect(text).toContain('[REDACTED:')
  })

  it('symbol offers a secret-named near match redacted in its did-you-mean list', () => {
    const { text } = runSymbol({ name: 'sk-ant-api03' })
    expect(text).not.toContain(ANT)
    expect(text).toContain(`  - ${ANT_PLACEHOLDER}`)
  })
})

describe('read commands print a symbol name with no secret as written', () => {
  it('scope, context-for, similar, callers, call-chain and impact keep plainFn and callsPlain', () => {
    const scope = printed(() => runScope({ spec: 'plain.ts:2' }))
    expect(scope.out).toContain('plainFn\tfunction\tplain.ts:1-3')
    expect(scope.out).not.toContain('[REDACTED')
    const ctx = printed(() => runContextFor({ task: 'zebraplain' }))
    expect(ctx.out).toContain('plain.ts::plainFn@1')
    expect(ctx.out).not.toContain('[REDACTED')
    const callers = printed(() => runCallers({ symbol: 'plainFn' }))
    expect(callers.out).toContain('callsPlain\tplain.ts:5')
    expect(callers.out).not.toContain('[REDACTED')
    const chain = printed(() => runCallChain({ symbol: 'plainFn' }))
    expect(chain.out).toContain('plainFn -> callsPlain')
    const impact = printed(() => runImpact({ symbol: 'plainFn' }))
    expect(impact.out).toContain('callsPlain')
    expect(impact.out).not.toContain('[REDACTED')
    const json = printed(() => runScope({ spec: 'plain.ts:2', json: true }))
    expect(JSON.parse(json.out)[0].name).toBe('plainFn')
  })
})
