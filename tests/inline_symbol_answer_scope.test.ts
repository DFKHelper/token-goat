import { execFileSync } from 'node:child_process'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import { globalDbPath } from '../src/constants.js'
import { inlineSymbolGrepHandler } from '../src/hooks_grep.js'
import { SCOPE_MAX_BYTES, SCOPE_MAX_FILES, readScopeDir } from '../src/inline_grep_scan.js'
import { inlineSymbolAnswer, INLINE_SYMBOL_MAX_BYTES } from '../src/inline_symbol_answer.js'
import { indexFileSync } from '../src/parser.js'
import { clearModuleCaches } from '../src/reset.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { indexableDir } from './helpers/temp-config.js'

// The directory-scoped and bare-name answers of the inlined Grep deny, on files the real parser indexed into the isolated global.db and a real git work tree (git init in a fixture directory; the answer lists its files with git). Fixtures: every source file is HAND-DERIVED (small synthetic Python modules). The ignore behaviour under test is FORMAT-DERIVED from the ripgrep invocation Claude Code 2.1.306 runs, read out of the strings in its claude.exe this run: `--hidden`, a `--glob` that drops only .git/.svn/.hg/.bzr/.jj/.sl, no `--no-ignore`, so ripgrep applies .gitignore, .ignore and the global ignore file, and git's `--exclude-standard` list is a superset of what it searches. Ripgrep's CRLF and binary rules are CAPTURE (see tests/inline_grep_scan.test.ts).

const MODULE = ['def unique_loader(path):', '    """Load one thing."""', '    return open(path).read()', ''].join('\n')
const LOADER = String.raw`def unique_loader\b`
const BARE = String.raw`\bunique_loader\b`

let sessionCounter = 0
function grep(cwd: string, pattern: string, grepPath: string | undefined, extra: Record<string, unknown> = {}) {
  const toolInput: Record<string, unknown> = { pattern, output_mode: 'content', ...extra }
  if (grepPath !== undefined) toolInput['path'] = grepPath
  return makeHookEvent({ toolName: 'Grep', toolInput, sessionId: `scope-${process.pid}-${++sessionCounter}`, raw: { cwd } })
}

function setOn(on: boolean): void {
  vi.stubEnv('TOKEN_GOAT_INLINE_SYMBOL_BODY', on ? '1' : '0')
  invalidateConfigCache()
}

/** A fresh git work tree with the given files written and indexed; maintenance is off so no detached git process outlives the test. */
function project(files: Record<string, string>, indexed: readonly string[] = Object.keys(files)): string {
  const dir = indexableDir()
  execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'init', '-q'], { cwd: dir, stdio: 'ignore' })
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), text, 'utf8')
  }
  for (const name of indexed) indexFileSync(path.join(dir, name), globalDbPath())
  return dir
}

function exclude(dir: string, line: string): void {
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), line + '\n', 'utf8')
}

beforeEach(() => {
  clearModuleCaches()
  setOn(true)
})

afterEach(() => {
  vi.unstubAllEnvs()
  invalidateConfigCache()
  clearModuleCaches()
})

describe('a directory-scoped declaration Grep', () => {
  it('is answered when the name is declared once in the directory and the pattern matches that one line', async () => {
    const dir = project({ 'mod.py': MODULE, 'other.py': 'def helper():\n    return 1\n' })
    const out = await inlineSymbolGrepHandler(grep(dir, LOADER, dir))
    expect(out.hookType).toBe('deny')
    if (out.hookType !== 'deny') return
    expect(out.message).toContain('symbol body (')
    expect(out.message).toContain('return open(path).read()')
    expect(out.message).toContain('mod.py:1:def unique_loader(path):')
  })

  it('is answered when the Grep names no path, which Claude Code reads as its working directory', async () => {
    const dir = project({ 'mod.py': MODULE })
    const out = await inlineSymbolGrepHandler(grep(dir, LOADER, undefined))
    expect(out.hookType).toBe('deny')
  })

  it('passes through when the name is declared again in a second file of the directory', async () => {
    const dir = project({ 'mod.py': MODULE, 'copy.py': MODULE })
    expect((await inlineSymbolGrepHandler(grep(dir, LOADER, dir))).hookType).toBe('pass')
  })

  it('passes through when a second file only mentions the declaration, so the pattern matches two lines', async () => {
    const dir = project({ 'mod.py': MODULE, 'notes.py': '# def unique_loader is documented in mod.py\nx = 1\n' })
    expect((await inlineSymbolGrepHandler(grep(dir, LOADER, dir))).hookType).toBe('pass')
  })

  it('passes through when the directory holds a file the index has never seen, and answers once that file is gone', async () => {
    const dir = project({ 'mod.py': MODULE, 'stray.xyz': 'def unique_loader\n' }, ['mod.py'])
    expect((await inlineSymbolGrepHandler(grep(dir, LOADER, dir))).hookType).toBe('pass')
    fs.rmSync(path.join(dir, 'stray.xyz'))
    expect((await inlineSymbolGrepHandler(grep(dir, LOADER, dir))).hookType).toBe('deny')
  })

  it('does not count a file that git ignores, because ripgrep skips it, and counts it once it is no longer ignored', async () => {
    const dir = project({ 'mod.py': MODULE, 'skipped/copy.py': MODULE }, ['mod.py'])
    exclude(dir, 'skipped/')
    expect((await inlineSymbolGrepHandler(grep(dir, LOADER, dir))).hookType).toBe('deny')
    fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '', 'utf8')
    expect((await inlineSymbolGrepHandler(grep(dir, LOADER, dir))).hookType).toBe('pass')
  })

  it('passes through a directory that is itself ignored, where ripgrep may search files git does not list', async () => {
    const dir = project({ 'built/mod.py': MODULE })
    exclude(dir, 'built/*')
    expect((await inlineSymbolGrepHandler(grep(dir, LOADER, path.join(dir, 'built')))).hookType).toBe('pass')
  })

  it('passes through a directory that is not in a git work tree', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-scope-plain-'))
    try {
      fs.writeFileSync(path.join(plain, 'mod.py'), MODULE, 'utf8')
      expect(readScopeDir(plain, plain)).toEqual({ passReason: 'the scope is ignored or not in a git work tree' })
    } finally {
      fs.rmSync(plain, { recursive: true, force: true })
    }
  })

  it('passes through when ripgrep would read a config file', async () => {
    const dir = project({ 'mod.py': MODULE })
    vi.stubEnv('RIPGREP_CONFIG_PATH', path.join(dir, 'rg.conf'))
    expect((await inlineSymbolGrepHandler(grep(dir, LOADER, dir))).hookType).toBe('pass')
  })

  it('passes through a file that bars the answer, naming no body', async () => {
    const dir = project({ 'mod.py': MODULE })
    const out = await inlineSymbolAnswer({ enabled: true, pattern: LOADER, grepPath: dir, cwd: dir, event: grep(dir, LOADER, dir), isBarred: () => true })
    expect(out).toEqual({ name: 'untouchable_path' })
  })

  it('stays off when the setting is off', async () => {
    const dir = project({ 'mod.py': MODULE })
    setOn(false)
    expect((await inlineSymbolGrepHandler(grep(dir, LOADER, dir))).hookType).toBe('pass')
  })
})

describe('the scope caps', () => {
  it('passes through a scope with more files than the file cap, before it opens any', async () => {
    const files: Record<string, string> = { 'mod.py': MODULE }
    for (let i = 0; i < SCOPE_MAX_FILES; i++) files[`f${i}.txt`] = 'x\n'
    const dir = project(files, ['mod.py'])
    const read = readScopeDir(dir, dir)
    expect(read).toEqual({ passReason: 'the scope holds more than ' + SCOPE_MAX_FILES + ' files' })
    expect((await inlineSymbolGrepHandler(grep(dir, LOADER, dir))).hookType).toBe('pass')
  })

  it('passes through a scope whose files exceed the byte cap', async () => {
    const dir = project({ 'mod.py': MODULE, 'big.py': '# ' + 'x'.repeat(SCOPE_MAX_BYTES) + '\n' })
    const read = readScopeDir(dir, dir)
    expect(read).toEqual({ passReason: 'the files exceed the byte allowance' })
    expect((await inlineSymbolGrepHandler(grep(dir, LOADER, dir))).hookType).toBe('pass')
  })

  it('answers a scope just inside both caps', () => {
    const files: Record<string, string> = { 'mod.py': MODULE }
    for (let i = 0; i < SCOPE_MAX_FILES - 1; i++) files[`f${i}.py`] = 'x = 1\n'
    const dir = project(files)
    const read = readScopeDir(dir, dir)
    expect('files' in read && read.files.length).toBe(SCOPE_MAX_FILES)
  })
})

describe('a bare-name Grep', () => {
  const CALLER = ['from mod import unique_loader', '', 'a = unique_loader("a.txt")', 'b = unique_loader("b.txt")', ''].join('\n')

  it.each([['unique_loader'], [BARE], [String.raw`unique_loader\b`]])('with pattern %s lists every matching line and then the body', async (pattern) => {
    const dir = project({ 'mod.py': MODULE, 'use.py': CALLER })
    const out = await inlineSymbolGrepHandler(grep(dir, pattern, dir))
    expect(out.hookType).toBe('deny')
    if (out.hookType !== 'deny') return
    for (const line of ['mod.py:1:def unique_loader(path):', 'use.py:1:from mod import unique_loader', 'use.py:3:a = unique_loader("a.txt")', 'use.py:4:b = unique_loader("b.txt")']) expect(out.message).toContain(line)
    expect(out.message).toContain('4 matching lines')
    expect(out.message).toContain('return open(path).read()')
  })

  it('also answers inside one file, where the call sites of that file are listed', async () => {
    const dir = project({ 'mod.py': MODULE + 'z = unique_loader("z")\n' })
    const out = await inlineSymbolGrepHandler(grep(dir, BARE, path.join(dir, 'mod.py')))
    expect(out.hookType).toBe('deny')
    if (out.hookType !== 'deny') return
    expect(out.message).toContain('mod.py:4:z = unique_loader("z")')
  })

  it('lists a secret-looking value redacted, not as written', async () => {
    const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    const dir = project({ 'mod.py': MODULE, 'use.py': `token = "${secret}"; unique_loader(token)\n` })
    const out = await inlineSymbolGrepHandler(grep(dir, BARE, dir))
    expect(out.hookType).toBe('deny')
    if (out.hookType !== 'deny') return
    expect(out.message).not.toContain(secret)
    expect(out.message).toContain('[REDACTED]')
  })

  it('passes through when the matching lines and the body together pass the delivery cap', async () => {
    const calls = Array.from({ length: 400 }, (_, i) => `value_${i} = unique_loader("path-number-${i}.txt")`).join('\n') + '\n'
    const dir = project({ 'mod.py': MODULE, 'use.py': calls })
    expect(calls.length).toBeGreaterThan(INLINE_SYMBOL_MAX_BYTES)
    expect((await inlineSymbolGrepHandler(grep(dir, BARE, dir))).hookType).toBe('pass')
  })

  it('passes through a name that two files declare, and a name the index does not hold', async () => {
    const dir = project({ 'mod.py': MODULE, 'copy.py': MODULE })
    expect((await inlineSymbolGrepHandler(grep(dir, BARE, dir))).hookType).toBe('pass')
    expect((await inlineSymbolGrepHandler(grep(dir, String.raw`\bnot_a_symbol\b`, dir))).hookType).toBe('pass')
  })

  it('passes through a pattern that is more than a name', async () => {
    const dir = project({ 'mod.py': MODULE })
    for (const pattern of ['unique_load', 'unique_loader.*', 'unique_loader|other', String.raw`\bunique_loader\(`]) expect((await inlineSymbolGrepHandler(grep(dir, pattern, dir))).hookType).toBe('pass')
  })

  it('passes through a Grep that asks for more than a plain content search', async () => {
    const dir = project({ 'mod.py': MODULE })
    for (const extra of [{ '-i': true }, { '-A': 2 }, { glob: '*.py' }, { head_limit: 1 }, { multiline: true }]) expect((await inlineSymbolGrepHandler(grep(dir, BARE, dir, extra))).hookType).toBe('pass')
  })
})
