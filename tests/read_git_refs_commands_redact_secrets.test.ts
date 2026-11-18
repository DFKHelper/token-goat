/** Module-level check that refs, diff, log, conflicts and changed --symbol redact secret-shaped values in what they print, text and --json alike, and print a file with no secret unchanged. Fixture provenance: HAND-DERIVED. The Anthropic key is synthetic, 'sk-ant-api03-' plus forty 'a', the shape the anthropic_api_key pattern in src/secret_redact.ts names (sk-ant- plus twenty or more of [A-Za-z0-9_-]); the key block is made-up filler between real BEGIN and END markers, the private_key_block pattern in the same file. Every key body line is 'VAULTBODY' plus a two-digit index, never key material. The repo layout copies the reporter's shape: a git repo whose second commit adds a key block and an api_key line to a function, a caller beside them, and a TOML table whose name is the key. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runChanged, runConflicts, runDiff, runLog } from '../src/read_git.js'
import { runRefs } from '../src/read_refs.js'

import { captureStdout } from './helpers/capture-stdout.js'

const ANT = 'sk-ant-api03-' + 'a'.repeat(40)
const ANT_PLACEHOLDER = '[REDACTED:anthropic_api_key]'
const PEM_PLACEHOLDER = '[REDACTED:private_key_block]'
const PEM_BEGIN = '-----BEGIN RSA PRIVATE KEY-----'
const PEM_END = '-----END RSA PRIVATE KEY-----'
const BODY = Array.from({ length: 4 }, (_, i) => `VAULTBODY${String(i + 1).padStart(2, '0')}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)
const SECRET_LINES = [`  const pem = \`${PEM_BEGIN}`, ...BODY, `${PEM_END}\``, `  const api_key = "${ANT}"`]

const VAULT_V1 = 'export function vaultFn(): number {\n  return 1\n}\n'
const VAULT_V2 = ['export function vaultFn(): number {', ...SECRET_LINES, '  return pem.length + api_key.length', '}', ''].join('\n')
const USE_TS = ['import { vaultFn } from "./vault"', 'export function useVault(): number {', ...SECRET_LINES, '  return vaultFn() + pem.length + api_key.length', '}', ''].join('\n')
const PLAIN_V1 = 'export function plainFn(): number {\n  return 1\n}\n'
const PLAIN_V2 = 'export function plainFn(): number {\n  return 2\n}\n'
const PLAIN_USE_TS = 'import { plainFn } from "./plain"\nexport function usePlain(): number {\n  return plainFn() + 1\n}\n'
const SECRET_CONFLICT = ['before', '<<<<<<< ours', `api_key = "${ANT}"`, PEM_BEGIN, ...BODY, PEM_END, '=======', 'theirs_line', '>>>>>>> theirs', 'after', ''].join('\n')
const PLAIN_CONFLICT = ['one', '<<<<<<< ours', 'mine', '=======', 'theirs', '>>>>>>> theirs', 'two', ''].join('\n')

let root: string
let origCwd: string

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

function write(name: string, text: string): string {
  const file = join(root, name)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text, 'utf-8')
  return file
}

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-git-refs-redact-')))
  origCwd = process.cwd()
  process.chdir(root)
  git('init')
  git('config', 'user.email', 'test@test.com')
  git('config', 'user.name', 'Test')
  git('config', 'core.autocrlf', 'false')
  write('vault.ts', VAULT_V1)
  write('plain.ts', PLAIN_V1)
  write('plain_use.ts', PLAIN_USE_TS)
  write('use.ts', USE_TS)
  git('add', '.')
  git('commit', '-m', 'first')
  write('vault.ts', VAULT_V2)
  write('plain.ts', PLAIN_V2)
  write('vault.toml', `[${ANT}]\nnote = "x"\n`)
  git('add', '.')
  git('commit', '-m', 'second')
  for (const name of ['vault.ts', 'plain.ts', 'plain_use.ts', 'use.ts', 'vault.toml']) indexFileSync(normalizePath(join(root, name)))
})

afterAll(() => {
  process.chdir(origCwd)
  rmSync(root, { recursive: true, force: true })
})

function printed(fn: () => number): string {
  let code = -1
  const out = captureStdout(() => {
    code = fn()
  })
  expect(code).toBe(0)
  return out
}

function expectNoSecret(out: string): void {
  expect(out).not.toContain(ANT)
  expect(out).not.toContain('sk-ant-api03')
  expect(out).not.toContain('VAULTBODY')
  expect(out).not.toContain(PEM_BEGIN)
}

function expectSecretPlaceholders(out: string): void {
  expect(out).toContain(ANT_PLACEHOLDER)
  expect(out).toContain(PEM_PLACEHOLDER)
}

describe('refs prints no secret from the lines around a reference', () => {
  it('redacts a key block and an api_key line in the context window, per reference and grouped by caller', () => {
    const flat = printed(() => runRefs({ spec: 'vaultFn', context: 8 }))
    expectNoSecret(flat)
    expectSecretPlaceholders(flat)
    expect(flat).toContain('return vaultFn() + pem.length + api_key.length')
    const grouped = printed(() => runRefs({ spec: 'vaultFn', callers: true, context: 8 }))
    expectNoSecret(grouped)
    expectSecretPlaceholders(grouped)
  })

  it('--json keeps valid JSON with the context redacted', () => {
    const out = printed(() => runRefs({ spec: 'vaultFn', context: 8, json: true }))
    expectNoSecret(out)
    expect(out).toContain(ANT_PLACEHOLDER)
    expect(() => JSON.parse(out)).not.toThrow()
  })

  it('prints a caller with no secret as written', () => {
    const out = printed(() => runRefs({ spec: 'plainFn', context: 2 }))
    expect(out).toContain('plain_use.ts')
    expect(out).toContain('return plainFn() + 1')
    expect(out).not.toContain('[REDACTED')
  })
})

describe('diff prints no secret from the changed lines', () => {
  it('redacts the added key block and api_key line, text and --json', () => {
    const text = printed(() => runDiff({ spec: 'vault.ts::vaultFn', ref: 'HEAD~1..HEAD', projectRoot: root }))
    expectNoSecret(text)
    expectSecretPlaceholders(text)
    expect(text).toContain('+  return pem.length + api_key.length')
    const json = printed(() => runDiff({ spec: 'vault.ts::vaultFn', ref: 'HEAD~1..HEAD', projectRoot: root, json: true }))
    expectNoSecret(json)
    expect(json).toContain(ANT_PLACEHOLDER)
    expect(() => JSON.parse(json)).not.toThrow()
  })

  it('prints a change with no secret as written', () => {
    const out = printed(() => runDiff({ spec: 'plain.ts::plainFn', ref: 'HEAD~1..HEAD', projectRoot: root }))
    expect(out).toContain('-  return 1\n+  return 2')
    expect(out).not.toContain('[REDACTED')
  })
})

describe('log prints no secret from the patches it shows', () => {
  it('redacts the added key block and api_key line, text and --json', () => {
    const text = printed(() => runLog({ spec: 'vault.ts::vaultFn', projectRoot: root }))
    expectNoSecret(text)
    expectSecretPlaceholders(text)
    expect(text).toContain('second')
    const json = printed(() => runLog({ spec: 'vault.ts::vaultFn', projectRoot: root, json: true }))
    expectNoSecret(json)
    expect(json).toContain(ANT_PLACEHOLDER)
    expect(() => JSON.parse(json)).not.toThrow()
  })

  it('prints a history with no secret as written', () => {
    const out = printed(() => runLog({ spec: 'plain.ts::plainFn', projectRoot: root }))
    expect(out).toContain('-  return 1\n+  return 2')
    expect(out).toContain('    second')
    expect(out).not.toContain('[REDACTED')
  })
})

describe('conflicts prints no secret from a conflict region', () => {
  it('redacts the key block and api_key line inside the region, text and --json', () => {
    const file = write('conflict.txt', SECRET_CONFLICT)
    const text = printed(() => runConflicts({ path: file }))
    expectNoSecret(text)
    expectSecretPlaceholders(text)
    expect(text).toContain('theirs_line')
    const json = printed(() => runConflicts({ path: file, json: true }))
    expectNoSecret(json)
    expect(json).toContain(ANT_PLACEHOLDER)
    expect(() => JSON.parse(json)).not.toThrow()
    expectNoSecret(printed(() => runConflicts({ path: file, summary: true })))
  })

  it('prints a conflict with no secret as written', () => {
    const file = write('plain_conflict.txt', PLAIN_CONFLICT)
    const out = printed(() => runConflicts({ path: file }))
    expect(out).toContain('<<<<<<< ours\n      mine\n    =======\n      theirs\n    >>>>>>> theirs')
    expect(out).not.toContain('[REDACTED')
  })
})

describe('changed --symbol prints no secret from a symbol name', () => {
  it('redacts a TOML table named with the key, text and --json', () => {
    const text = printed(() => runChanged({ ref: 'HEAD~1', projectRoot: root, symbolMode: true }))
    expect(text).not.toContain(ANT)
    expect(text).not.toContain('sk-ant-api03')
    expect(text).toContain(`${ANT_PLACEHOLDER} (section) — vault.toml:1`)
    const json = printed(() => runChanged({ ref: 'HEAD~1', projectRoot: root, symbolMode: true, json: true }))
    expect(json).not.toContain(ANT)
    expect(() => JSON.parse(json)).not.toThrow()
  })

  it('prints the symbol names of a change with no secret as written', () => {
    const out = printed(() => runChanged({ ref: 'HEAD~1', projectRoot: root, symbolMode: true, grep: 'plain' }))
    expect(out).toBe('plainFn (function) — plain.ts:1\n')
  })
})
