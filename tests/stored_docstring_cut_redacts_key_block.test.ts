/** Module-level check that a private key block straddling the 16 KB docstring cut leaves no key line in the stored docstring or in what outline prints. Fixture provenance: HAND-DERIVED. The key block is made-up filler between real BEGIN and END markers (the private_key_block pattern in src/secret_redact.ts needs both); every body line is 'VAULTBODY' plus a two-digit index, never key material; the filler before it is sized by arithmetic so the cut at MAX_SYMBOL_DOCSTRING_CHARS lands inside the block, the shape the reporter described, never read off the redactor. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { querySymbols } from '../src/index_reader.js'
import { boundSymbolDocstring, indexFileSync, MAX_SYMBOL_DOCSTRING_CHARS } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runOutline } from '../src/read_outline.js'

const BEGIN = '-----BEGIN RSA PRIVATE KEY-----'
const END = '-----END RSA PRIVATE KEY-----'
const MARKER = '[... docstring truncated by token-goat ...]'
const FILLER_LINES = Math.ceil((MAX_SYMBOL_DOCSTRING_CHARS - 600) / 40)
const FILLER = Array.from({ length: FILLER_LINES }, (_, i) => `filler ${String(i).padStart(4, '0')} ${'x'.repeat(28)}`)
const BODY = Array.from({ length: 30 }, (_, i) => `VAULTBODY${String(i + 1).padStart(2, '0')}${'A'.repeat(40)}`)
const TAIL = 'tail_after_the_block'
const DOC = [...FILLER, BEGIN, ...BODY, END, TAIL].join('\n')

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-doc-cut-redact-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('boundSymbolDocstring on a key block that straddles the cut', () => {
  it('the fixture puts the cut inside the block, with BEGIN before it and END after it', () => {
    const cut = MAX_SYMBOL_DOCSTRING_CHARS - `\n${MARKER}`.length
    expect(DOC.indexOf(BEGIN)).toBeLessThan(cut)
    expect(DOC.indexOf(BODY[BODY.length - 1] as string)).toBeGreaterThan(cut)
    expect(DOC.indexOf(END)).toBeGreaterThan(cut)
  })

  it('stores no key line, keeps the bound, and keeps the text before the block', () => {
    const bounded = boundSymbolDocstring(DOC)
    expect(bounded).not.toContain('VAULTBODY')
    expect(bounded).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(bounded).toContain('[REDACTED:private_key_block]')
    expect(bounded.length).toBeLessThanOrEqual(MAX_SYMBOL_DOCSTRING_CHARS)
    expect(bounded.startsWith(FILLER.slice(0, 3).join('\n'))).toBe(true)
  })

  it('cuts an over-cap docstring with no secret exactly as before', () => {
    const plain = FILLER.concat(FILLER, FILLER).join('\n')
    const bounded = boundSymbolDocstring(plain)
    expect(bounded).toBe(plain.slice(0, MAX_SYMBOL_DOCSTRING_CHARS - `\n${MARKER}`.length) + `\n${MARKER}`)
  })

  it('leaves an under-cap docstring holding a whole key block as written', () => {
    const small = ['short', BEGIN, 'VAULTBODY01AAAA', END].join('\n')
    expect(boundSymbolDocstring(small)).toBe(small)
  })
})

describe('outline of a symbol whose doc comment straddles the cut', () => {
  it('stores no key line and prints none, text and --json', () => {
    const file = join(root, 'doc.ts')
    writeFileSync(file, `/**\n${DOC.split('\n').map((l) => ` * ${l}`).join('\n')}\n */\nexport function docFn(): number {\n  return 1\n}\n`, 'utf-8')
    indexFileSync(normalizePath(file))
    const stored = querySymbols({ filePath: normalizePath(file), name: 'docFn' })
    expect(stored.length).toBe(1)
    expect(stored[0]?.docstring.length).toBeGreaterThan(MAX_SYMBOL_DOCSTRING_CHARS - 200)
    expect(stored[0]?.docstring).not.toContain('VAULTBODY')
    for (const json of [false, true]) {
      const { text, code } = runOutline({ file, json })
      expect(code).toBe(0)
      expect(text).toContain('docFn')
      expect(text).not.toContain('VAULTBODY')
      expect(text).not.toContain('BEGIN RSA PRIVATE KEY')
    }
  })
})
