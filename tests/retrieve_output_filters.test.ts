/**
 * `retrieve` gains the same output filters as bash-output/web-output/mcp-output (--head, --tail,
 * --grep, --max-matches, --section, --full) via the shared `_applyFiltersAndPrint`, so a large
 * stored blob can be recalled a slice at a time instead of taking all of it.
 *
 * The one place `retrieve` must NOT match its siblings: it is the lossless round-trip contract
 * for `compress-text`, and other commands' output literally quotes `recovery: token-goat
 * retrieve <id>` as the way to get the original bytes back. The siblings default to eliding
 * everything past a 30/80 head/tail window when no --head/--tail is given; `retrieve` must not
 * inherit that default, or the recovery contract silently stops being lossless. Any narrowing
 * flag IS an explicit ask, so sibling semantics (elision included) apply once one is given.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'
import { dataDirForHome, _resetDataDirCacheForTesting } from '../src/constants.js'
import { clearModuleCaches } from '../src/reset.js'

let home: string
let envRoot: string
let previousHome: string | undefined
let previousLocalAppData: string | undefined
let previousXdgDataHome: string | undefined

beforeEach(() => {
  previousHome = process.env['TOKEN_GOAT_HOME']
  previousLocalAppData = process.env['LOCALAPPDATA']
  previousXdgDataHome = process.env['XDG_DATA_HOME']
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-retrieve-filters-'))
  process.env['TOKEN_GOAT_HOME'] = home
  const dataRoot = dataDirForHome(home)
  envRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
  process.env['LOCALAPPDATA'] = envRoot
  process.env['XDG_DATA_HOME'] = envRoot
  fs.writeFileSync(path.join(home, 'package.json'), '{}\n')
  _resetDataDirCacheForTesting()
  clearModuleCaches()
})

afterEach(() => {
  if (previousHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = previousHome
  if (previousLocalAppData === undefined) delete process.env['LOCALAPPDATA']
  else process.env['LOCALAPPDATA'] = previousLocalAppData
  if (previousXdgDataHome === undefined) delete process.env['XDG_DATA_HOME']
  else process.env['XDG_DATA_HOME'] = previousXdgDataHome
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  fs.rmSync(home, { recursive: true, force: true })
})

function runIsolated(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: envRoot, XDG_DATA_HOME: envRoot }
  const res = spawnSync(process.execPath, [BUNDLE, ...args], { env, encoding: 'utf8', cwd: home })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** 200 numbered lines, well past the 30/80 head/tail elision window, so a default-elision regression is caught. */
function bigBlob(): string {
  const lines: string[] = []
  for (let i = 1; i <= 200; i++) lines.push(`line ${i}`)
  return lines.join('\n')
}

function retrieveIdFor(text: string): string {
  const file = path.join(home, 'blob.txt')
  fs.writeFileSync(file, text)
  const r = runIsolated(['compress-text', '--file', file])
  expect(r.status, r.stderr).toBe(0)
  const match = /^id: (\S+)$/m.exec(r.stdout)
  expect(match, `expected an id line in: ${r.stdout}`).not.toBeNull()
  return match![1]
}

describe('retrieve output filters', () => {
  it('bare retrieve <id> returns a large blob byte-identical, with no elision marker', () => {
    const text = bigBlob()
    expect(text.split('\n').length, 'fixture must exceed the default 30+80 head/tail window').toBeGreaterThan(110)
    const id = retrieveIdFor(text)

    const r = runIsolated(['retrieve', id])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe(text)
    expect(r.stdout).not.toContain('...(elided lines ')
  })

  // HAND-DERIVED: the stored text carries an SGR colour code and CRLF line endings, and the lossless contract means both come back exactly as stored, with or without --full.
  it('bare retrieve and retrieve --full keep ANSI codes and CRLF line endings byte-verbatim', () => {
    const text = 'build \u001b[31mfailed\u001b[0m\r\nsecond line\r\nthird line'
    const id = retrieveIdFor(text)
    for (const args of [['retrieve', id], ['retrieve', id, '--full']]) {
      const r = runIsolated(args)
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout, args.join(' ')).toBe(text)
    }
    // A narrowing flag is an explicit slice, and slices are rendered plain like every sibling recall.
    const grep = runIsolated(['retrieve', id, '--grep', 'failed'])
    expect(grep.stdout.trim()).toBe('build failed')
    // -n is a rendering the caller asked for, so it numbers lines rather than echoing the bytes; --context without --grep is still refused.
    expect(runIsolated(['retrieve', id, '-n']).stdout).toBe('1:build failed\n2:second line\n3:third line\n')
    expect(runIsolated(['retrieve', id, '--context', '1']).status).toBe(1)
  })

  // HAND-DERIVED: a stored text that ends without a newline comes back without one, and one that ends with a newline keeps exactly that one; appending a newline made `retrieve <id> > file` differ from the file compress-text read.
  it('bare retrieve adds no trailing newline the stored text did not have', () => {
    for (const text of ['no newline at end', 'ends with one\n', 'ends with two\n\n']) {
      expect(runIsolated(['retrieve', retrieveIdFor(text)]).stdout, JSON.stringify(text)).toBe(text)
    }
  })

  it('--section extracts just the named section', () => {
    const text = ['# intro', 'intro body', '', '## Details', 'detail line 1', 'detail line 2'].join('\n')
    const id = retrieveIdFor(text)

    const r = runIsolated(['retrieve', id, '--section', 'Details'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('detail line 1')
    expect(r.stdout).not.toContain('intro body')
  })

  it('--grep filters to matching lines only', () => {
    const text = bigBlob()
    const id = retrieveIdFor(text)

    const r = runIsolated(['retrieve', id, '--grep', 'line 5$'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('line 5\n')
    expect(r.stdout).not.toContain('line 50\n')
    expect(r.stdout).not.toContain('line 1\n')
  })

  it('--head N truncates to the first N lines', () => {
    const text = bigBlob()
    const id = retrieveIdFor(text)

    const r = runIsolated(['retrieve', id, '--head', '3'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('line 1\nline 2\nline 3')
  })
})

// Provenance: the 600-line body is HAND-DERIVED ("line N" for N in 1..600); the default window is head 30 / tail 80, so lines 31..520 are cut and the marker names them. The Commander stderr text is CAPTURE (a real `bash-output abc --bogus` run on the previous build printed it twice).
describe('cached-output recall: ranges, line numbers, context and the elision marker', () => {
  /** The recalled lines inside the untrusted-tool-output fence (CAPTURE: the fence is two lines before the body and one after, as printed by `bash-output --file`). */
  function body(stdout: string): string[] {
    const lines = stdout.trimEnd().split('\n')
    return lines[1] === '<untrusted-tool-output>' ? lines.slice(2, -1) : lines
  }

  function recallFile(): string {
    const file = path.join(home, 'out600.txt')
    const lines: string[] = []
    for (let i = 1; i <= 600; i++) lines.push(`line ${i}`)
    fs.writeFileSync(file, lines.join('\n') + '\n')
    return file
  }

  it('the default elision marker names the cut lines and the flag that fetches them', () => {
    const r = runIsolated(['bash-output', '--file', recallFile()])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('...(elided lines 31-520 of 600: --lines 31-520)...')
    expect(r.stdout).toContain('line 30\n')
    expect(r.stdout).not.toContain('line 31\n')
    expect(r.stdout).toContain('line 521\n')
  })

  it('--lines A-B prints exactly that inclusive range with no elision', () => {
    const r = runIsolated(['bash-output', '--file', recallFile(), '--lines', '395-405'])
    expect(r.status, r.stderr).toBe(0)
    const expected = Array.from({ length: 11 }, (_, i) => `line ${395 + i}`).join('\n')
    expect(body(r.stdout).join('\n')).toBe(expected)
  })

  it('--lines clamps to the end of the text and prints a range wider than the default window whole', () => {
    const r = runIsolated(['bash-output', '--file', recallFile(), '--lines', '590-9999'])
    expect(r.status, r.stderr).toBe(0)
    expect(body(r.stdout)).toHaveLength(11)
    const wide = runIsolated(['bash-output', '--file', recallFile(), '--lines', '1-300'])
    expect(wide.stdout).not.toContain('elided')
    expect(body(wide.stdout)).toHaveLength(300)
  })

  it('--lines rejects a malformed or out-of-range spec', () => {
    const file = recallFile()
    expect(runIsolated(['bash-output', '--file', file, '--lines', 'abc']).status).toBe(1)
    expect(runIsolated(['bash-output', '--file', file, '--lines', '9-3']).status).toBe(1)
    const past = runIsolated(['bash-output', '--file', file, '--lines', '700-710'])
    expect(past.status).toBe(1)
    expect(past.stderr).toContain('600 lines')
  })

  it('--grep -n prefixes each hit with its original line number', () => {
    const r = runIsolated(['bash-output', '--file', recallFile(), '--grep', 'line 40[0-2]', '-n'])
    expect(r.status, r.stderr).toBe(0)
    expect(body(r.stdout)).toEqual(['400:line 400', '401:line 401', '402:line 402'])
  })

  // HAND-DERIVED: recallFile() holds "line N" for N in 1..600, so NOMATCHXYZ occurs nowhere and --lines 3-4 leaves exactly two lines, neither containing FAIL.
  it('--grep with no matching line says so on stderr and exits 1, instead of printing a bare empty line', () => {
    const r = runIsolated(['bash-output', '--file', recallFile(), '--grep', 'NOMATCHXYZ'])
    expect(r.status).toBe(1)
    expect(r.stdout.trim()).toBe('')
    expect(r.stderr).toContain('--grep matched no lines of 600')
    expect(r.stderr).toContain('NOMATCHXYZ')

    const ranged = runIsolated(['bash-output', '--file', recallFile(), '--lines', '3-4', '--grep', 'FAIL'])
    expect(ranged.status).toBe(1)
    expect(ranged.stderr).toContain('--grep matched no lines of 2')
  })

  it('--grep --context N shows the neighbouring lines, and separates groups with --', () => {
    const one = runIsolated(['bash-output', '--file', recallFile(), '--grep', 'line 300', '--context', '1'])
    expect(one.status, one.stderr).toBe(0)
    expect(body(one.stdout)).toEqual(['line 299', 'line 300', 'line 301'])
    const two = runIsolated(['bash-output', '--file', recallFile(), '--grep', 'line (10|20)$', '--context', '1', '-n'])
    expect(body(two.stdout)).toEqual(['9:line 9', '10:line 10', '11:line 11', '--', '19:line 19', '20:line 20', '21:line 21'])
  })

  it('web-output and mcp-output accept the same options', () => {
    const bad = runIsolated(['mcp-output', 'mcp_deadbeefdeadbeef', '--lines', '1-2', '-n', '--context', '1'])
    expect(bad.stderr).not.toContain('unknown option')
    const web = runIsolated(['web-output', 'nope', '--lines', '1-2', '-n', '--context', '1'])
    expect(web.stderr).not.toContain('unknown option')
  })

  it('a Commander parse error is printed once, not twice', () => {
    const r = runIsolated(['bash-output', 'abc', '--bogus'])
    expect(r.status).toBe(1)
    expect(r.stderr.match(/unknown option '--bogus'/g)).toHaveLength(1)
  })

  it('--help still exits 0 with help text', () => {
    const r = runIsolated(['bash-output', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('--lines')
  })

  it('--full -n numbers only the real lines, with no bare number for the newline at the end', () => {
    const r = runIsolated(['bash-output', '--file', recallFile(), '--full', '-n'])
    expect(r.status, r.stderr).toBe(0)
    const plain = body(runIsolated(['bash-output', '--file', recallFile(), '--full']).stdout)
    const got = body(r.stdout)
    // Same shape as the verbatim --full view, which keeps the text's final newline; only the 600 real lines carry a number.
    expect(got).toEqual(plain.map((l, i) => (i < 600 ? `${i + 1}:${l}` : l)))
    expect(got).toContain('600:line 600')
    expect(r.stdout).not.toMatch(/^601:/m)
  })

  it('retrieve takes --lines, -n and --context like its siblings', () => {
    const id = retrieveIdFor(bigBlob())
    const ranged = runIsolated(['retrieve', id, '--lines', '150-152', '-n'])
    expect(ranged.status, ranged.stderr).toBe(0)
    expect(ranged.stdout.trim()).toBe('150:line 150\n151:line 151\n152:line 152')
    const ctx = runIsolated(['retrieve', id, '--grep', 'line 100$', '--context', '1'])
    expect(ctx.status, ctx.stderr).toBe(0)
    expect(ctx.stdout.trim()).toBe('line 99\nline 100\nline 101')
    // -n alone is not a narrowing flag: every line comes back, numbered, with no elision.
    const numbered = runIsolated(['retrieve', id, '-n'])
    expect(numbered.status, numbered.stderr).toBe(0)
    expect(numbered.stdout).not.toContain('elided')
    expect(numbered.stdout.trimEnd().split('\n')).toHaveLength(200)
  })
})
