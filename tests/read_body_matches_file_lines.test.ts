/** Regression: a symbol read printed different bytes from an `@N-M` read of the same lines. Provenance: HAND-DERIVED. Each test writes its own source file and counts its line numbers by hand (1-based); the expected text is that file's own lines rejoined with `\n`, the shape an `@N-M` read prints. The real pipeline is driven: indexFileSync into the isolated DB, then runRead/runSymbol/runBriefCore. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runBriefCore } from '../src/read_brief.js'
import { runRead } from '../src/read_commands.js'
import { runSymbol } from '../src/read_symbol.js'

function withSource(name: string, text: string, fn: (file: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'tg-bodylines-'))
  try {
    const file = join(root, name)
    writeFileSync(file, text)
    indexFileSync(normalizePath(file))
    fn(file)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('a symbol read prints the lines an @N-M read of its span prints', () => {
  // 1 export function crlfBodyA() { / 2   return 1; / 3 } / 4 (blank) / 5 export function crlfBodyB() { / 6   return 2; / 7 }, every line ending in CRLF.
  const CRLF_SOURCE = ['export function crlfBodyA() {', '  return 1;', '}', '', 'export function crlfBodyB() {', '  return 2;', '}', ''].join('\r\n')
  const CRLF_A = ['export function crlfBodyA() {', '  return 1;', '}'].join('\n')

  it('ends lines with LF on a CRLF file, as the range read does', () => {
    withSource('crlf_body.ts', CRLF_SOURCE, (file) => {
      const ranged = runRead({ spec: `${file}@1-3` })
      expect(ranged.text).toContain(CRLF_A)
      const read = runRead({ spec: `${file}::crlfBodyA` })
      expect(read.code).toBe(0)
      expect(read.text).toContain(CRLF_A)
      expect(read.text).not.toContain('\r')
      const json = JSON.parse(runRead({ spec: `${file}::crlfBodyA`, json: true }).text) as { body: string }
      expect(json.body).toBe(CRLF_A)
      expect(runSymbol({ name: 'crlfBodyA' }).text).not.toContain('\r')
      expect(runBriefCore({ spec: `${file}::crlfBodyA` }).text).not.toContain('\r')
    })
  })
})
