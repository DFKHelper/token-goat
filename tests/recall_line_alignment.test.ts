// Cached-output recall (`bash-output`/`mcp-output --file`, `bash-output <id>`, `web-output`) must keep its line numbers and slices aligned with the text it reads: a genuine blank line ending a --lines/--grep slice was dropped as if it were the phantom "" a final newline splits into, and a multi-line PEM private-key block was redacted into one line, shifting every -n number and --lines range after it.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { storeBashOutputSync } from '../src/bash_output_cache.js'
import { _applyFiltersAndPrint, cmdBashOutput } from '../src/cli_cached_output.js'
import { dataDirForHome, _resetDataDirCacheForTesting } from '../src/constants.js'
import { UNTRUSTED_TOOL_TAG } from '../src/injection_scan.js'
import { clearModuleCaches } from '../src/reset.js'
import { redactSecrets } from '../src/secret_redact.js'
import { BUNDLE } from './helpers/bundle.js'
import { unfence } from './helpers/unfence.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let stdout: string[]
let stderr: string[]
let outSpy: WriteSpy
let errSpy: WriteSpy
let home: string
let envRoot: string
const saved: Record<string, string | undefined> = {}
const VARS = ['TOKEN_GOAT_HOME', 'LOCALAPPDATA', 'XDG_DATA_HOME']

beforeEach(() => {
  for (const v of VARS) saved[v] = process.env[v]
  home = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-recall-align-'))
  const dataRoot = dataDirForHome(home)
  envRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
  process.env['TOKEN_GOAT_HOME'] = home
  process.env['LOCALAPPDATA'] = envRoot
  process.env['XDG_DATA_HOME'] = envRoot
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  stdout = []
  stderr = []
  outSpy = spyOnWrite(process.stdout, stdout)
  errSpy = spyOnWrite(process.stderr, stderr)
})

afterEach(() => {
  outSpy.mockRestore()
  errSpy.mockRestore()
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v] as string
  }
  _resetDataDirCacheForTesting()
  clearModuleCaches()
  fs.rmSync(home, { recursive: true, force: true })
})

/** The recall body the shared printer returns, fence stripped. */
function recall(text: string, opts: Parameters<typeof _applyFiltersAndPrint>[1]): string {
  return unfence(_applyFiltersAndPrint(text, opts, true, UNTRUSTED_TOOL_TAG))
}

/** Recall through the built bundle's `bash-output --file`, fence stripped. */
function recallBundle(text: string, args: string[]): { status: number | null; body: string; stderr: string } {
  const file = path.join(home, 'captured.txt')
  fs.writeFileSync(file, text)
  const env = { ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: envRoot, XDG_DATA_HOME: envRoot }
  const res = spawnSync(process.execPath, [BUNDLE, 'bash-output', '--file', file, ...args], { env, encoding: 'utf8', cwd: home })
  return { status: res.status, body: unfence((res.stdout ?? '').replace(/\r\n/g, '\n')).replace(/\n$/, ''), stderr: res.stderr ?? '' }
}

// Provenance: HAND-DERIVED: four lines, the second a genuine blank one, ending in the newline every captured file and blob ends with.
const BLANK_SECOND = 'alpha\n\nbeta\ngamma\n'

describe('a real blank line at the end of a slice survives', () => {
  it('--lines 1-2 -n prints the blank line 2', () => {
    expect(recall(BLANK_SECOND, { lines: '1-2', lineNumbers: true })).toBe('1:alpha\n2:')
  })

  it('--lines 1-2 --full -n prints the blank line 2 and no newline past it', () => {
    expect(recall(BLANK_SECOND, { lines: '1-2', lineNumbers: true, full: true })).toBe('1:alpha\n2:')
  })

  it('--grep keeps a matched blank line that ends the result', () => {
    // Provenance: HAND-DERIVED: no final newline, so the blank line 2 is the last row the grep keeps and nothing is a phantom.
    expect(recall('x\n\ny', { grep: '^$|x', lineNumbers: true })).toBe('1:x\n2:')
  })

  it('--grep never matches the phantom row a final newline leaves, so the match count is the real one', () => {
    // Provenance: HAND-DERIVED: lines 2 and 4 are the only blank lines; the final newline adds none.
    expect(recall('a\n\nb\n\n', { grep: '^$', lineNumbers: true, maxMatches: '1' })).toBe('2:')
    expect(stderr.join('')).toContain('showing first 1 of 2 matching lines')
  })

  it('--tail and --head still count real lines only', () => {
    expect(recall(BLANK_SECOND, { tail: '1', lineNumbers: true })).toBe('4:gamma')
    expect(recall(BLANK_SECOND, { head: '2', lineNumbers: true })).toBe('1:alpha\n2:')
  })

  it('--full with no narrowing still returns the text verbatim, final newline included', () => {
    expect(recall(BLANK_SECOND, { full: true })).toBe(BLANK_SECOND)
    expect(recall(BLANK_SECOND, { full: true, lineNumbers: true })).toBe('1:alpha\n2:\n3:beta\n4:gamma\n')
  })

  it('applies to a cached `bash-output <id>` recall too', () => {
    const id = storeBashOutputSync('echo recall-align', BLANK_SECOND, 0)
    cmdBashOutput(id, { lines: '1-2', lineNumbers: true })
    expect(unfence(stdout.join('').replace(/\n$/, ''))).toBe('1:alpha\n2:')
  })

  it('applies to the built bundle`s `bash-output --file`', () => {
    const r = recallBundle(BLANK_SECOND, ['--lines', '1-2', '-n'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.body).toBe('1:alpha\n2:')
  })
})

// Provenance: FORMAT-DERIVED: the PEM armor (RFC 7468 section 2: a `-----BEGIN RSA PRIVATE KEY-----` line, base64 body lines, the matching END line) that src/secret_redact.ts's private_key_block pattern matches; the body is fake. The markers are split so the source holds no literal key header for a secret scanner to flag.
const BEGIN = '-----' + 'BEGIN RSA PRIVATE KEY-----'
const END = '-----' + 'END RSA PRIVATE KEY-----'
const PEM_FILE = ['line 1 header', 'line 2 config', BEGIN, 'MIIEowIBAAKCAQEAfakefakefake1', 'fakefakefakefakefake2', 'fakefakefakefakefake3', END, 'line 8 after key', 'line 9 after key', 'line 10 last', ''].join('\n')
const KEY_BYTES = ['MIIEowIBAAKCAQEA', 'fakefake', 'PRIVATE KEY']

function expectNoKeyMaterial(text: string): void {
  for (const fragment of KEY_BYTES) expect(text).not.toContain(fragment)
}

describe('a redacted private-key block keeps the lines it covered', () => {
  it('-n numbers the lines after the block as the file does', () => {
    const body = recall(PEM_FILE, { lineNumbers: true })
    expectNoKeyMaterial(body)
    expect(body.split('\n')).toEqual([
      '1:line 1 header',
      '2:line 2 config',
      '3:[REDACTED:private_key_block]',
      '4:[REDACTED:private_key_block]',
      '5:[REDACTED:private_key_block]',
      '6:[REDACTED:private_key_block]',
      '7:[REDACTED:private_key_block]',
      '8:line 8 after key',
      '9:line 9 after key',
      '10:line 10 last',
    ])
  })

  it('--lines addresses the file`s own lines after the block', () => {
    expect(recall(PEM_FILE, { lines: '8-9', lineNumbers: true })).toBe('8:line 8 after key\n9:line 9 after key')
  })

  it('a --lines range inside the block shows placeholders, never key bytes', () => {
    const body = recall(PEM_FILE, { lines: '4-5', lineNumbers: true })
    expect(body).toBe('4:[REDACTED:private_key_block]\n5:[REDACTED:private_key_block]')
  })

  it('keeps CRLF line breaks and the same numbering', () => {
    const crlf = PEM_FILE.split('\n').join('\r\n')
    const body = recall(crlf, { lines: '7-8', lineNumbers: true })
    expect(body).toBe('7:[REDACTED:private_key_block]\n8:line 8 after key')
    expectNoKeyMaterial(recall(crlf, { full: true }))
  })

  it('--grep finds a line after the block at its real number', () => {
    expect(recall(PEM_FILE, { grep: 'line 9', lineNumbers: true })).toBe('9:line 9 after key')
  })

  it('applies to the built bundle`s `bash-output --file`', () => {
    const r = recallBundle(PEM_FILE, ['--lines', '8-9', '-n'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.body).toBe('8:line 8 after key\n9:line 9 after key')
    const all = recallBundle(PEM_FILE, ['-n'])
    expectNoKeyMaterial(all.body)
    expect(all.body.split('\n')).toHaveLength(10)
  })

  it('counts one redaction per block, and the default still collapses the block to one placeholder', () => {
    const kept = redactSecrets(PEM_FILE, undefined, { keepLineCount: true })
    expect(kept.count).toBe(1)
    expect(kept.text.split('\n')).toHaveLength(PEM_FILE.split('\n').length)
    const collapsed = redactSecrets(PEM_FILE)
    expect(collapsed.count).toBe(1)
    expect(collapsed.text).toBe('line 1 header\nline 2 config\n[REDACTED:private_key_block]\nline 8 after key\nline 9 after key\nline 10 last\n')
  })
})
