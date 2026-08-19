/**
 * Guard: a UTF-16 file must be read as text, not as UTF-8 bytes.
 *
 * PowerShell 5.1 writes UTF-16LE for `>` redirection and `Out-File`, so on the platform token-goat
 * is written for, a generated script, log or document is routinely UTF-16 with a byte-order mark.
 * Every read path decoded with `toString('utf8')`, which turns that file into its text interleaved
 * with NULs: the parser found no symbols in it, so it was recorded as indexed with nothing in it and
 * `symbol Get-Thing` answered "No matches"; `section --list` reported "No sections found" for a
 * document full of headings; and `read` emitted the doubled, NUL-laced mojibake straight into the
 * model's context, at twice the byte cost of the real content.
 *
 * Why didn't a test catch this: every fixture in the suite is written by `writeFileSync` with a
 * JavaScript string, which Node encodes as UTF-8, so no test ever handed the indexer a file in any
 * other encoding. The gap was in the input domain, not in the logic, and no amount of exercising the
 * existing paths would have reached it. These cases write the bytes directly.
 *
 * The controls matter as much as the positive cases: a plain UTF-8 file must decode exactly as
 * before, and a BOM-less UTF-16 file must stay a miss rather than be guessed at, since a wrong
 * encoding guess on binary is worse than an honest empty result.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { decodeSource, detectSourceEncoding, encodeSource } from '../../src/util.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let projectDir: string
let homeDir: string

function run(args: string[]): { status: number; out: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir },
  })
  return { status: res.status ?? 1, out: (res.stdout ?? '') + (res.stderr ?? '') }
}

const TS_SOURCE = 'export function marker(): number {\n  return 1\n}\n'
const MD_SOURCE = '# Heading One\n\nsome text here\n\n# Heading Two\n\nmore text\n'

/** Little-endian UTF-16 with a BOM, exactly what PowerShell 5.1 produces. */
function utf16le(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
}

/** Big-endian UTF-16 with a BOM: same code units, byte-swapped. */
function utf16be(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(Buffer.from(text, 'utf16le')).swap16()])
}

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'tg-utf16-'))
  homeDir = mkdtempSync(join(tmpdir(), 'tg-utf16-home-'))
  writeFileSync(join(projectDir, 'le.ts'), utf16le(TS_SOURCE.replace('marker', 'leMarker')))
  writeFileSync(join(projectDir, 'be.ts'), utf16be(TS_SOURCE.replace('marker', 'beMarker')))
  writeFileSync(join(projectDir, 'bom8.ts'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TS_SOURCE.replace('marker', 'bom8Marker'), 'utf8')]))
  writeFileSync(join(projectDir, 'plain.ts'), TS_SOURCE.replace('marker', 'plainMarker'))
  // No BOM: deliberately still a miss. Guessing an encoding from byte distribution misfires on
  // binary, and this asserts the fix did not start guessing.
  writeFileSync(join(projectDir, 'nobom.ts'), Buffer.from(TS_SOURCE.replace('marker', 'nobomMarker'), 'utf16le'))
  writeFileSync(join(projectDir, 'doc.md'), utf16le(MD_SOURCE))
  run(['index', '.', '--walk'])
})

describe('decodeSource', () => {
  it('decodes little-endian UTF-16 and drops the mark', () => {
    expect(decodeSource(utf16le('hello'))).toBe('hello')
  })

  it('decodes big-endian UTF-16, which Node cannot do directly', () => {
    expect(decodeSource(utf16be('hello'))).toBe('hello')
  })

  it('strips a UTF-8 mark rather than leaving it in the first column', () => {
    expect(decodeSource(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Heading', 'utf8')]))).toBe('# Heading')
  })

  it('leaves a plain UTF-8 file exactly as toString would', () => {
    const text = 'const x = "café ☕"\n'
    expect(decodeSource(Buffer.from(text, 'utf8'))).toBe(text)
  })

  it('survives a truncated big-endian file with an odd trailing byte', () => {
    const odd = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(Buffer.from('hi', 'utf16le')).swap16(), Buffer.from([0x00])])
    expect(decodeSource(odd)).toBe('hi')
  })

  it('returns an empty string for an empty file rather than throwing', () => {
    expect(decodeSource(Buffer.alloc(0))).toBe('')
  })

  // UTF-32LE begins FF FE 00 00, whose first two bytes are exactly the UTF-16LE mark, so a
  // shorter-mark-first check decodes it as UTF-16 and hands back NUL-interleaved text.
  it('does not mistake UTF-32LE for UTF-16LE', () => {
    const bytes = encodeSource('hi', 'utf32le')
    expect(detectSourceEncoding(bytes)).toBe('utf32le')
    expect(decodeSource(bytes)).toBe('hi')
  })

  it('decodes UTF-32BE', () => {
    expect(decodeSource(encodeSource('hi', 'utf32be'))).toBe('hi')
  })

  it('round-trips every recognized encoding, mark included', () => {
    const text = 'heading\nbody ☕\n'
    for (const enc of ['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'utf32le', 'utf32be'] as const) {
      const bytes = encodeSource(text, enc)
      expect(detectSourceEncoding(bytes), `${enc} was not detected from its own output`).toBe(enc)
      expect(decodeSource(bytes), `${enc} did not survive a round trip`).toBe(text)
    }
  })
})

describe('the indexer on a UTF-16 file', () => {
  it('finds a symbol in a little-endian file', () => {
    const r = run(['symbol', 'leMarker'])
    expect(r.status, 'a UTF-16LE file indexed to nothing and looked like an empty file').toBe(0)
    expect(r.out).toContain('leMarker')
  })

  it('finds a symbol in a big-endian file', () => {
    const r = run(['symbol', 'beMarker'])
    expect(r.status).toBe(0)
    expect(r.out).toContain('beMarker')
  })

  it('still finds a symbol in a plain UTF-8 file', () => {
    expect(run(['symbol', 'plainMarker']).status).toBe(0)
  })

  it('still finds a symbol in a UTF-8 file with a mark', () => {
    expect(run(['symbol', 'bom8Marker']).status).toBe(0)
  })

  it('does not guess at a file with no mark', () => {
    expect(run(['symbol', 'nobomMarker']).status, 'an encoding was guessed rather than declared').not.toBe(0)
  })
})

describe('reading a UTF-16 file', () => {
  it('lists the headings of a UTF-16 markdown document', () => {
    const r = run(['section', 'doc.md', '--list'])
    expect(r.status).toBe(0)
    expect(r.out, 'a document full of headings reported none').toContain('Heading Two')
  })

  it('emits the text, not NUL-interleaved bytes', () => {
    const r = run(['read', 'doc.md'])
    expect(r.status).toBe(0)
    expect(r.out).toContain('some text here')
    expect(r.out.includes(String.fromCharCode(0)), 'NUL bytes reached the output stream').toBe(false)
  })
})

describe('insert-section on a UTF-16 file', () => {
  // Resolving the heading is now BOM-aware, so this command reaches a file it used to fail on. If
  // the write path stayed UTF-8 the insert would rewrite the whole file converted, turning an edit
  // of one section into a silent re-encoding of everything around it.
  it('writes the file back in the encoding it was found in', () => {
    const target = join(projectDir, 'editable.md')
    writeFileSync(target, utf16le(MD_SOURCE))
    const added = join(projectDir, 'added.md')
    writeFileSync(added, 'inserted line\n')

    const r = run(['insert-section', 'editable.md', '--after', 'Heading One', '--content-from', 'added.md'])
    expect(r.status, r.out).toBe(0)

    const after = readFileSync(target)
    expect(detectSourceEncoding(after), 'a UTF-16 file was silently converted to UTF-8').toBe('utf16le')
    const text = decodeSource(after)
    expect(text).toContain('inserted line')
    expect(text, 'the original content was mangled by the round trip').toContain('some text here')
    expect(text).toContain('Heading Two')
  })
})
