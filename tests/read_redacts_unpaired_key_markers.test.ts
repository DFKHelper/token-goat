/** Read-path redaction of a private key block whose BEGIN or END marker is missing from the text a read prints. Fixture provenance: HAND-DERIVED, the body lines are `VAULTBODY` plus a run of `A`, never a real key. */
import { describe, expect, it } from 'vitest'

import { guardRedactAndFence, redactReadJson, redactReadLines, redactReadText } from '../src/fence_cap.js'
import { guardText } from '../src/read_commands.js'

const BEGIN = '-----BEGIN RSA PRIVATE KEY-----'
const END = '-----END RSA PRIVATE KEY-----'
const BODY = Array.from({ length: 4 }, (_, i) => `VAULTBODY${String(i + 1).padStart(2, '0')}${'A'.repeat(40)}`)
const PLACEHOLDER = '[REDACTED:private_key_block]'

function expectNoKey(out: string): void {
  expect(out).not.toContain('VAULTBODY')
  expect(out).not.toContain('PRIVATE KEY')
}

describe('read paths redact a key block with one marker missing', () => {
  it('BEGIN without END hides from the marker to the end and keeps the text before it', () => {
    const out = redactReadText(['config_before', BEGIN, ...BODY].join('\n'))
    expectNoKey(out)
    expect(out.startsWith('config_before\n')).toBe(true)
    expect(out.split('\n')).toHaveLength(2 + BODY.length)
  })

  it('END without BEGIN hides from the start to the marker and keeps the text after it', () => {
    const out = redactReadText([...BODY, END, 'config_after'].join('\n'))
    expectNoKey(out)
    expect(out.endsWith('\nconfig_after')).toBe(true)
  })

  it('a window that starts inside the block, with neither marker, is hidden whole', () => {
    const out = redactReadText(BODY.join('\n'))
    expectNoKey(out)
    expect(out).toContain(PLACEHOLDER)
  })

  it('keeps CRLF line breaks while hiding an unterminated block', () => {
    const out = redactReadText(['config_before', BEGIN, ...BODY].join('\r\n'))
    expectNoKey(out)
    expect(out.split('\r\n')).toHaveLength(2 + BODY.length)
  })

  it('hides an unterminated second block after a paired first one', () => {
    const out = redactReadText(['first', BEGIN, BODY[0], END, 'middle', BEGIN, BODY[1], BODY[2]].join('\n'))
    expectNoKey(out)
    expect(out).toContain('middle')
    expect(out).toContain('first')
  })

  it('leaves a paired block behaving as before: one placeholder per line it covered', () => {
    const out = redactReadText(['before', BEGIN, BODY[0], END, 'after'].join('\n'))
    expect(out).toBe(['before', PLACEHOLDER, PLACEHOLDER, PLACEHOLDER, 'after'].join('\n'))
  })

  it('shows a window of one repeated character, which no key body is', () => {
    const filler = 'x'.repeat(2000)
    expect(redactReadText(filler)).toBe(filler)
    expect(redactReadText(`${filler}\n${filler}`)).toBe(`${filler}\n${filler}`)
  })

  it('leaves text with no key marker and no key body lines untouched', () => {
    const plain = 'const a = 1\nconst b = "two words"\n'
    expect(redactReadText(plain)).toBe(plain)
  })

  it('guardText prints no key line of an unterminated block', () => {
    expectNoKey(guardText(['head', BEGIN, ...BODY].join('\n'), 'read'))
  })

  it('guardRedactAndFence prints no key line of an unterminated block', () => {
    expectNoKey(guardRedactAndFence(['head', BEGIN, ...BODY].join('\n'), 'doc', 'untrusted_file'))
  })

  it('redactReadLines and redactReadJson hide a window that ends inside the block', () => {
    const lines = ['head', BEGIN, ...BODY]
    const redacted = redactReadLines(lines)
    expect(redacted).toHaveLength(lines.length)
    expectNoKey(redacted.join('\n'))
    expectNoKey(redactReadJson({ lines }))
    expectNoKey(redactReadJson({ text: ['head', BEGIN, ...BODY].join('\n') }))
  })
})
