/** Module-level check that logfold, todo and trace redact secret-shaped values in the file text they print, text and --json alike, and leave a plain file's output as it was. Fixture provenance: HAND-DERIVED. The Anthropic key is synthetic, 'sk-ant-api03-' plus forty 'a', the shape tests/secret_redact.test.ts pins for the anthropic_api_key pattern in src/secret_redact.ts. The key block is made-up filler: a BEGIN and END marker pair around lines of 'KEYBODYLINE' plus an index, the layout the private_key_block pattern in src/secret_redact.ts matches. The reporter's shape is a secret on a line the command prints (a logged key, a TODO that quotes one, a traceback that echoes one) and a key block a --tail window cuts in half. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { cmdLogfold } from '../src/text_logfold.js'
import { cmdTodo } from '../src/text_todo.js'
import { cmdTrace } from '../src/text_trace.js'

import { captureStdout } from './helpers/capture-stdout.js'

const ANT = 'sk-ant-api03-' + 'a'.repeat(40)
const ANT_PLACEHOLDER = '[REDACTED:anthropic_api_key]'
const PEM_BEGIN = '-----BEGIN RSA PRIVATE KEY-----'
const PEM_END = '-----END RSA PRIVATE KEY-----'
const PEM_PLACEHOLDER = '[REDACTED:private_key_block]'
const BODY = Array.from({ length: 5 }, (_, i) => `KEYBODYLINE${String(i + 1).padStart(2, '0')}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)

let dir: string

function write(name: string, text: string): string {
  const file = path.join(dir, name)
  writeFileSync(file, text, 'utf-8')
  return file
}

function expectNoSecret(out: string): void {
  expect(out).not.toContain(ANT)
  expect(out).not.toContain('sk-ant-api03')
  expect(out).not.toContain('KEYBODYLINE')
  expect(out).not.toContain('PRIVATE KEY')
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'tg-text-redact-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('logfold prints no secret value', () => {
  const log = ['lead_line', `auth failed key=${ANT}`, PEM_BEGIN, ...BODY, PEM_END, 'tail_line', ''].join('\n')

  it('redacts a key and a key block in the printed lines (the reporter shape)', () => {
    const out = captureStdout(() => cmdLogfold(write('a.log', log), {}))
    expectNoSecret(out)
    expect(out).toContain(ANT_PLACEHOLDER)
    expect(out).toContain(PEM_PLACEHOLDER)
    expect(out).toContain('lead_line\n')
    expect(out).toContain('tail_line\n')
  })

  it('redacts a key block the --tail window cuts in half', () => {
    // 9 lines in the log; the last 4 are body line 4, body line 5, the END marker and tail_line, so the BEGIN marker lies outside the window.
    const out = captureStdout(() => cmdLogfold(write('b.log', log), { tail: '4' }))
    expectNoSecret(out)
    expect(out).toContain(PEM_PLACEHOLDER)
    expect(out).toContain('tail_line\n')
    expect(out).not.toContain('lead_line')
  })

  it('--json carries no secret and stays valid JSON', () => {
    const out = captureStdout(() => cmdLogfold(write('c.log', log), { json: true }))
    expectNoSecret(out)
    const parsed = JSON.parse(out) as { lines: Array<{ text: string }> }
    expect(parsed.lines.map((l) => l.text)).toContain(`auth failed key=${ANT_PLACEHOLDER}`)
  })

  it('prints a log with no secret as it always did', () => {
    const out = captureStdout(() => cmdLogfold(write('d.log', 'plain one\nplain two\nplain two\n'), {}))
    expect(out).toBe('plain one\nplain two  (x2)\n')
  })
})

describe('todo prints no secret value', () => {
  const source = [
    `// TODO: rotate ${ANT}`,
    'const x = 1',
    `// FIXME: ${PEM_BEGIN}`,
    ...BODY,
    PEM_END,
    '// HACK: later',
    `// XXX: ${PEM_BEGIN}${BODY[0]}${PEM_END}`,
    '',
  ].join('\n')

  it('redacts a key and a key block opened on a marker line (the reporter shape), line numbers kept', () => {
    const out = captureStdout(() => cmdTodo([write('a.ts', source)], {}))
    expectNoSecret(out)
    expect(out).toContain(`TODO  rotate ${ANT_PLACEHOLDER}`)
    expect(out).toContain(PEM_PLACEHOLDER)
    expect(out).toMatch(/:10 {2}HACK {2}later\n/)
    expect(out).toMatch(/:11 {2}XXX {2}\[REDACTED:private_key_block\]\n/)
  })

  it('groups by kind without a secret', () => {
    const out = captureStdout(() => cmdTodo([write('b.ts', source)], { group: 'kind' }))
    expectNoSecret(out)
    expect(out).toContain('[TODO]')
  })

  it('--json carries no secret and stays valid JSON', () => {
    const out = captureStdout(() => cmdTodo([write('c.ts', source)], { json: true }))
    expectNoSecret(out)
    const parsed = JSON.parse(out) as { items: Array<{ kind: string; line: number; text: string }> }
    expect(parsed.items.map((i) => [i.kind, i.line])).toEqual([['TODO', 1], ['FIXME', 3], ['HACK', 10], ['XXX', 11]])
  })

  it('prints a file with no secret as it always did', () => {
    const file = write('d.ts', '// TODO: plain note\n')
    const out = captureStdout(() => cmdTodo([file], {}))
    expect(out).toBe(`${path.resolve(file)}:1  TODO  plain note\n`)
  })
})

describe('trace prints no secret value', () => {
  const traceback = [
    'Traceback (most recent call last):',
    '  File "app.py", line 5, in <module>',
    `    client = Client(api_key="${ANT}")`,
    `RuntimeError: auth failed for ${ANT}`,
    '',
  ].join('\n')

  it('redacts the frame context and the exception message (the reporter shape)', () => {
    const out = captureStdout(() => cmdTrace(write('a.txt', traceback), {}))
    expectNoSecret(out)
    expect(out).toContain(`    client = Client(api_key="${ANT_PLACEHOLDER}")`)
    expect(out).toContain(`RuntimeError: auth failed for ${ANT_PLACEHOLDER}`)
    expect(out).toContain('File "app.py", line 5, in <module>')
  })

  it('--json carries no secret and stays valid JSON', () => {
    const out = captureStdout(() => cmdTrace(write('b.txt', traceback), { json: true }))
    expectNoSecret(out)
    const parsed = JSON.parse(out) as { tracebacks: Array<{ exception: string; frames: Array<{ context: string }> }> }
    expect(parsed.tracebacks[0]?.exception).toBe(`RuntimeError: auth failed for ${ANT_PLACEHOLDER}`)
    expect(parsed.tracebacks[0]?.frames[0]?.context).toBe(`client = Client(api_key="${ANT_PLACEHOLDER}")`)
  })

  it('prints a traceback with no secret as it always did', () => {
    const plain = ['Traceback (most recent call last):', '  File "app.py", line 5, in <module>', '    main()', 'ValueError: bad', ''].join('\n')
    const out = captureStdout(() => cmdTrace(write('c.txt', plain), {}))
    expect(out).toBe('Traceback (most recent call last):\n  File "app.py", line 5, in <module>\n    main()\nValueError: bad\n\n')
  })
})
