import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import { globalDbPath } from '../src/constants.js'
import { inlineSymbolGrepHandler, preGrepHandler } from '../src/hooks_grep.js'
import { inlineSymbolAnswer } from '../src/inline_symbol_answer.js'
import { indexFileSync } from '../src/parser.js'
import { runRead } from '../src/read_commands.js'
import { clearModuleCaches } from '../src/reset.js'
import { summarize } from '../src/stats.js'
import { makeHookEvent } from './helpers/hook-event.js'

// The inlined-symbol Grep deny end to end on the shipping path: a real file indexed by the real parser into the isolated global.db (tests/setup/isolate-home.ts pins TOKEN_GOAT_HOME and LOCALAPPDATA/XDG_DATA_HOME), then a Grep driven through the registered handler with no injected seam. The expected body is whatever the real `read` command prints for the same spec, so the test compares two readers, not a string restated from the implementation.

const tmpDirs: string[] = []

// HAND-DERIVED: a synthetic Python module with one unique function, one function name defined twice, and a class.
const SOURCE = [
  'def unique_loader(path):',
  '    """Load one thing."""',
  '    return open(path).read()',
  '',
  'def twice(x):',
  '    return x + 1',
  '',
  'def twice(y):',
  '    return y + 2',
  '',
  'class Holder:',
  '    pass',
  '',
].join('\n')

function scratchProject(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-inline-answer-'))
  tmpDirs.push(dir)
  const file = path.join(dir, 'mod.py')
  fs.writeFileSync(file, SOURCE, 'utf8')
  indexFileSync(file, globalDbPath())
  return { dir, file }
}

function setOn(on: boolean): void {
  vi.stubEnv('TOKEN_GOAT_INLINE_SYMBOL_BODY', on ? '1' : '0')
  invalidateConfigCache()
}

let sessionCounter = 0
function grep(dir: string, file: string, pattern: string, sessionId = `inline-${process.pid}-${++sessionCounter}`) {
  return makeHookEvent({ toolName: 'Grep', toolInput: { pattern, path: file }, sessionId, raw: { cwd: dir } })
}

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  vi.unstubAllEnvs()
  invalidateConfigCache()
  clearModuleCaches()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('inline symbol body in the Grep deny, on a really indexed file', () => {
  it('denies a Grep for the one symbol with exactly the bytes read prints, inside the fence', async () => {
    setOn(true)
    const { dir, file } = scratchProject()
    const printed = runRead({ spec: file + '::unique_loader', projectRoot: dir, suppressStat: true })
    expect(printed.code).toBe(0)
    expect(printed.text).toContain('return open(path).read()')

    const before = summarize(3650).by_kind['inline_symbol_body_deny']
    const out = await inlineSymbolGrepHandler(grep(dir, file, 'def unique_loader'))
    expect(out.hookType).toBe('deny')
    if (out.hookType !== 'deny') return
    const open = out.message.indexOf('<untrusted-file-content>\n')
    const close = out.message.lastIndexOf('\n</untrusted-file-content>')
    expect(open).toBeGreaterThan(0)
    expect(out.message.slice(open + '<untrusted-file-content>\n'.length, close)).toBe(printed.text)
    expect(out.message).toContain('token-goat read ')
    expect(out.message).toContain('::unique_loader')
    expect(out.message).toContain(`symbol body (${Buffer.byteLength(printed.text, 'utf8')} bytes) is inlined below`)
    const after = summarize(3650).by_kind['inline_symbol_body_deny']
    expect((after?.events ?? 0) - (before?.events ?? 0)).toBe(1)
    expect((after?.bytes_saved ?? 0) - (before?.bytes_saved ?? 0)).toBe(0)
  })

  it('answers a given file symbol once: the identical Grep after the deny gets the ordinary hint path', async () => {
    setOn(true)
    const { dir, file } = scratchProject()
    const sessionId = `inline-repeat-${process.pid}`
    expect((await inlineSymbolGrepHandler(grep(dir, file, 'def unique_loader', sessionId))).hookType).toBe('deny')
    expect((await inlineSymbolGrepHandler(grep(dir, file, 'def unique_loader', sessionId))).hookType).toBe('pass')
  })

  it('config off: the handler passes and the ordinary hint text is unchanged', async () => {
    setOn(false)
    const { dir, file } = scratchProject()
    const event = grep(dir, file, 'def unique_loader')
    expect((await inlineSymbolGrepHandler(event)).hookType).toBe('pass')
    const hint = preGrepHandler(event)
    expect(hint.hookType).toBe('context')
    if (hint.hookType !== 'context') return
    expect(hint.context).toContain('token-goat read ')
    expect(hint.context).toContain('::unique_loader')
    expect(hint.context).not.toContain('is inlined below')
  })

  it('a name defined twice in the file is not inlined', async () => {
    setOn(true)
    const { dir, file } = scratchProject()
    expect((await inlineSymbolGrepHandler(grep(dir, file, 'def twice'))).hookType).toBe('pass')
  })

  it('a file edited after indexing is not inlined', async () => {
    setOn(true)
    const { dir, file } = scratchProject()
    fs.writeFileSync(file, '# a new first line\n' + SOURCE, 'utf8')
    expect((await inlineSymbolGrepHandler(grep(dir, file, 'def unique_loader'))).hookType).toBe('pass')
  })

  it('the answer itself names stale for a file edited after indexing, whatever the hint layer in front of it decided', async () => {
    const { dir, file } = scratchProject()
    const event = grep(dir, file, 'def unique_loader')
    expect(await inlineSymbolAnswer({ enabled: true, pattern: 'def unique_loader', grepPath: file, cwd: dir, event })).toMatchObject({ inline: expect.stringContaining('return open(path).read()') })
    fs.writeFileSync(file, '# a new first line\n' + SOURCE, 'utf8')
    expect(await inlineSymbolAnswer({ enabled: true, pattern: 'def unique_loader', grepPath: file, cwd: dir, event })).toEqual({ name: 'stale' })
  })

  it('a pattern that is not one declaration is not inlined', async () => {
    setOn(true)
    const { dir, file } = scratchProject()
    expect((await inlineSymbolGrepHandler(grep(dir, file, 'def unique_loader|def twice'))).hookType).toBe('pass')
    expect((await inlineSymbolGrepHandler(grep(dir, file, 'unique_loader'))).hookType).toBe('pass')
  })

  it('a file that was never indexed is not inlined', async () => {
    setOn(true)
    const { dir } = scratchProject()
    const other = path.join(dir, 'other.py')
    fs.writeFileSync(other, 'def lonely():\n    return 1\n', 'utf8')
    expect((await inlineSymbolGrepHandler(grep(dir, other, 'def lonely'))).hookType).toBe('pass')
  })
})
