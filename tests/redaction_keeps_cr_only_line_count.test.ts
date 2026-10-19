/** Module-level check that redaction keeps the line count of a private-key block whose lines are separated by a lone CR, the way it does for LF and CRLF, so the lines after the block keep their positions in what a read command prints. Fixture provenance: HAND-DERIVED. The key block is made-up filler: a BEGIN and END marker pair around lines of 'CRBODY' plus an index, the layout the private_key_block pattern in src/secret_redact.ts matches; the expected text is computed from the input line by line, one placeholder per line the block covered, never read off the redactor. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { redactReadLines, redactReadText } from '../src/fence_cap.js'
import { runLineRange } from '../src/read_spec.js'
import { redactSecrets } from '../src/secret_redact.js'

const BEGIN = '-----BEGIN RSA PRIVATE KEY-----'
const END = '-----END RSA PRIVATE KEY-----'
const TAG = '[REDACTED:private_key_block]'
const BODY = Array.from({ length: 3 }, (_, i) => `CRBODY${String(i + 1).padStart(2, '0')}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)
const LINES = ['lead_line', BEGIN, ...BODY, END, 'tail_line', 'last_line']
const EXPECTED = ['lead_line', TAG, TAG, TAG, TAG, TAG, 'tail_line', 'last_line']

let dir: string

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cr-redact-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe.each([
  ['LF', '\n'],
  ['CRLF', '\r\n'],
  ['CR', '\r'],
])('a private-key block in %s text', (_name, nl) => {
  it('redactSecrets with keepLineCount leaves one placeholder per line and every line break', () => {
    const { text, count } = redactSecrets(LINES.join(nl), undefined, { keepLineCount: true })
    expect(text).toBe(EXPECTED.join(nl))
    expect(count).toBe(1)
    expect(text).not.toContain('CRBODY')
  })

  it('redactReadText keeps the position of every line after the block', () => {
    const text = redactReadText(LINES.join(nl) + nl)
    expect(text).toBe(EXPECTED.join(nl) + nl)
    expect(text.split(nl).indexOf('tail_line')).toBe(LINES.indexOf('tail_line'))
  })
})

describe('the CR handling leaves the default collapse and the rest of the text alone', () => {
  it('redactSecrets without keepLineCount still collapses the block to one placeholder', () => {
    expect(redactSecrets(LINES.join('\r')).text).toBe(['lead_line', TAG, 'tail_line', 'last_line'].join('\r'))
  })

  it('a CR-only text with no secret is returned as written', () => {
    const plain = ['one', 'two', 'three'].join('\r')
    expect(redactReadText(plain)).toBe(plain)
  })

  it('redactReadLines keeps a block spanning several list elements one placeholder per element', () => {
    expect(redactReadLines(LINES)).toEqual(EXPECTED)
  })
})

describe('read --lines on a file with CR-only line endings', () => {
  it('prints the key block as one placeholder per line, so the lines after it keep their place', () => {
    const file = path.join(dir, 'crkey.txt')
    writeFileSync(file, LINES.join('\r') + '\r', 'utf-8')
    const { text, code } = runLineRange({ file, start: 1, end: 1 }, { spec: `${file}@1-1`, projectRoot: dir })
    expect(code).toBe(0)
    expect(text).not.toContain('CRBODY')
    const printed = text.slice(text.indexOf('\n') + 1).split('\r')
    expect(printed.slice(0, EXPECTED.length)).toEqual(EXPECTED)
    expect(printed.indexOf('tail_line')).toBe(LINES.indexOf('tail_line'))
  })
})
