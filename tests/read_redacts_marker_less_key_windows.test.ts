/** Key body lines with no marker are hidden. Fixture provenance: SYNTHETIC, hash-chain base64, no real key. */
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { redactReadText } from '../src/fence_cap.js'

const PLACEHOLDER = '[REDACTED:private_key_block]'

function bodyLine(index: number, width: number): string {
  const chain = [0, 1]
    .map((part) => createHash('sha256').update(`window-${index}-${part}`).digest('base64'))
    .join('')
  return chain.replaceAll('=', 'A').slice(0, width)
}

const PEM_LINES = Array.from({ length: 4 }, (_, i) => bodyLine(i, 64))
const PEM_LAST = 'Zm9vYg=='
const PGP_LINES = Array.from({ length: 3 }, (_, i) => bodyLine(i + 10, 76))
const PGP_LAST = 'xYz9'
const PGP_CHECKSUM = '=aB3d'

function expectHidden(out: string, lines: readonly string[]): void {
  for (const line of lines) expect(out).not.toContain(line)
  expect(out).toContain(PLACEHOLDER)
}

describe('a marker-less window of key body is hidden whole', () => {
  it('a window that ends just before the END marker, with a short last body line', () => {
    const lines = [...PEM_LINES, PEM_LAST]
    expectHidden(redactReadText(lines.join('\n')), lines)
  })

  it('a window that starts in the middle of the block', () => {
    const lines = [PEM_LINES[2] as string, PEM_LINES[3] as string, PEM_LAST]
    expectHidden(redactReadText(lines.join('\n')), lines)
  })

  it('a PGP block cut after its checksum line', () => {
    const lines = [...PGP_LINES, PGP_LAST, PGP_CHECKSUM]
    const out = redactReadText(lines.join('\n'))
    expectHidden(out, lines)
    expect(out.split('\n')).toHaveLength(lines.length)
  })

  it('keeps CRLF line breaks while hiding it', () => {
    const lines = [...PEM_LINES, PEM_LAST]
    const out = redactReadText(lines.join('\r\n'))
    expectHidden(out, lines)
    expect(out.split('\r\n')).toHaveLength(lines.length)
  })

  it('a window of long lines alone is hidden as before', () => {
    expectHidden(redactReadText(PEM_LINES.join('\n')), PEM_LINES)
  })

  it('a lone 40-character line is hidden, so a bare git sha on a line of its own is too', () => {
    const sha = createHash('sha1').update('commit').digest('hex')
    expect(redactReadText(sha)).toContain(PLACEHOLDER)
  })
})

describe('text that is not key body stays readable', () => {
  it('a sha in a sentence', () => {
    const sha = createHash('sha1').update('commit').digest('hex')
    const prose = `fixed in commit ${sha} on main`
    expect(redactReadText(prose)).toBe(prose)
  })

  it('ordinary prose and short word lines', () => {
    const prose = 'const a = 1\nreturn value\nmain\nfoo\n'
    expect(redactReadText(prose)).toBe(prose)
  })

  it('short base64-shaped lines with no long line', () => {
    const words = 'alpha\nbravo\ncharlie\n=aB3d'
    expect(redactReadText(words)).toBe(words)
  })

  it('a short line between two long ones is not the tail of a key', () => {
    const text = [PEM_LINES[0], 'main', PEM_LINES[1]].join('\n')
    expect(redactReadText(text)).toBe(text)
  })

  it('a long line followed by a last line with spaces', () => {
    const text = [PEM_LINES[0], 'the end'].join('\n')
    expect(redactReadText(text)).toBe(text)
  })

  it('a long line followed by three short lines', () => {
    const text = [PEM_LINES[0], 'abcd', 'efgh', 'ijkl'].join('\n')
    expect(redactReadText(text)).toBe(text)
  })
})
