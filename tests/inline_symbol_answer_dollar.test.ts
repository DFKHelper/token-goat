import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import { globalDbPath } from '../src/constants.js'
import { inlineSymbolGrepHandler } from '../src/hooks_grep.js'
import { bareNameOf, declaredNameOf } from '../src/inline_symbol_answer.js'
import { indexFileSync } from '../src/parser.js'
import { clearModuleCaches } from '../src/reset.js'
import { makeHookEvent } from './helpers/hook-event.js'

// A symbol whose name holds a dollar sign (`function $foo`), asked for by the spellings an agent writes. In ripgrep's regex an unescaped `$` is an end anchor, so `function $foo` matches no line at all and must not be answered; the escaped `\$` is a literal dollar and is the real spelling.

const tmpDirs: string[] = []

// HAND-DERIVED: a synthetic JavaScript module declaring one function whose name starts with a dollar sign, and one plain function.
const SOURCE = ['function $foo(a) {', '  return a + 1', '}', '', 'function plain(b) {', '  return b', '}', ''].join('\n')

function scratch(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-inline-dollar-'))
  tmpDirs.push(dir)
  const file = path.join(dir, 'dollar.js')
  fs.writeFileSync(file, SOURCE, 'utf8')
  indexFileSync(file, globalDbPath())
  return { dir, file }
}

let sessionCounter = 0
function grep(dir: string, file: string, pattern: string) {
  return makeHookEvent({ toolName: 'Grep', toolInput: { pattern, path: file, output_mode: 'content' }, sessionId: `inline-dollar-${process.pid}-${++sessionCounter}`, raw: { cwd: dir } })
}

beforeEach(() => {
  vi.stubEnv('TOKEN_GOAT_INLINE_SYMBOL_BODY', '1')
  invalidateConfigCache()
  clearModuleCaches()
})

afterEach(() => {
  vi.unstubAllEnvs()
  invalidateConfigCache()
  clearModuleCaches()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a dollar sign in the symbol name', () => {
  // The verifier's exact spellings, in the verifier's order.
  it.each([String.raw`function \$foo\b`, String.raw`\$foo`])('answers the escaped spelling %s with the symbol body', async (pattern) => {
    const { dir, file } = scratch()
    const out = await inlineSymbolGrepHandler(grep(dir, file, pattern))
    expect(out.hookType).toBe('deny')
    if (out.hookType !== 'deny') return
    expect(out.message).toContain('function $foo(a) {')
    expect(out.message).toContain('return a + 1')
  })

  // ripgrep reads the unescaped `$` as an end anchor, so these match nothing and the Grep runs as written.
  it.each([String.raw`function $foo\b`, String.raw`$foo`])('passes the unescaped spelling %s, which ripgrep would match nothing with', async (pattern) => {
    const { dir, file } = scratch()
    expect((await inlineSymbolGrepHandler(grep(dir, file, pattern))).hookType).toBe('pass')
  })

  it('reads the name out of the escaped spellings and refuses an unescaped one', () => {
    expect(declaredNameOf(String.raw`function \$foo\b`)).toBe('$foo')
    expect(declaredNameOf(String.raw`function $foo\b`)).toBeNull()
    expect(bareNameOf(String.raw`\$foo`)).toBe('$foo')
    expect(bareNameOf(String.raw`\b\$foo\b`)).toBe('$foo')
    expect(bareNameOf('$foo')).toBeNull()
    expect(bareNameOf('foo$')).toBeNull()
  })
})
