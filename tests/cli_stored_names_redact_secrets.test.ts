/** `trace --bodies`, `answer` and the note anchor error print a name the index stored for a symbol or its container, and a stored name is file text that can itself be a credential. Each row drives the real command over a really indexed scratch project and asserts the credential is absent and the redaction marker present, text and --json where the command has both. Fixture provenance: HAND-DERIVED, the token is the GitHub shape (ghp_ plus 36 alphanumerics) from the pattern table in src/secret_redact.ts, placed by hand as a Python function name and a TypeScript class name; the surrounding code is synthetic. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runAnswer } from '../src/answer_router.js'
import { resolveNoteAnchor } from '../src/cli_file_ops.js'
import { CliError } from '../src/command_error.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { cmdTrace } from '../src/text_trace.js'

const GHP = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
const GHP_PLACEHOLDER = '[REDACTED:github_token]'

const SECRET_PY = `def ${GHP}():\n    return 1\n\ndef main():\n    return ${GHP}()\n`
const CLASSES_TS = `export class ${GHP} {\n  run(): number { return 1 }\n}\nexport class Other {\n  run(): number { return 2 }\n}\n`
const TRACE = ['Traceback (most recent call last):', '  File "secret.py", line 2, in main', '    return 1', 'ValueError: boom', ''].join('\n')

let root: string
let origCwd: string
let traceFile: string

function write(name: string, text: string): void {
  const file = join(root, name)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text, 'utf-8')
}

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-cli-names-redact-')))
  origCwd = process.cwd()
  process.chdir(root)
  const git = (...args: string[]): void => void execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  git('init')
  git('config', 'user.email', 'test@test.com')
  git('config', 'user.name', 'Test')
  git('config', 'core.autocrlf', 'false')
  write('secret.py', SECRET_PY)
  write('classes.ts', CLASSES_TS)
  write('trace.txt', TRACE)
  traceFile = join(root, 'trace.txt')
  git('add', '.')
  git('commit', '-m', 'first')
  for (const name of ['secret.py', 'classes.ts']) indexFileSync(normalizePath(join(root, name)))
})

afterAll(() => {
  process.chdir(origCwd)
  rmSync(root, { recursive: true, force: true })
})

/** Runs `fn` and returns what it wrote to stdout and stderr, joined, with its exit code. */
function printed(fn: () => number | void): { out: string; code: number | undefined } {
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
    code = fn() ?? undefined
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
  return { out, code }
}

function expectRedacted(out: string): void {
  expect(out).not.toContain(GHP)
  expect(out).not.toContain('ghp_')
  expect(out).toContain(GHP_PLACEHOLDER)
}

describe('trace --bodies prints the enclosing symbol redacted', () => {
  it('text', () => {
    const { out } = printed(() => cmdTrace(traceFile, { bodies: true }))
    expect(out).toContain('# body: ')
    expectRedacted(out)
  })

  it('--json', () => {
    const { out } = printed(() => cmdTrace(traceFile, { bodies: true, json: true }))
    expect(JSON.parse(out).tracebacks[0].frames[0].bodySymbol).toBeDefined()
    expectRedacted(out)
  })
})

describe('answer names no credential-shaped container in a refusal', () => {
  it('who calls an ambiguous method', () => {
    const { out, code } = printed(() => runAnswer({ question: 'who calls run' }))
    expect(code).toBe(1)
    expect(out).toContain('definitions in this project')
    expectRedacted(out)
  })
})

describe('the note anchor error names no credential-shaped container', () => {
  it('ambiguous symbol', () => {
    let error: unknown
    try {
      resolveNoteAnchor('classes.ts::run', root, root)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(CliError)
    const text = (error as CliError).message
    expect(text).toContain('Ambiguous symbol')
    expectRedacted(text)
  })
})
