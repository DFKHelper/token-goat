/** Read-denial loops: a large .txt refused again after the model's own `allow_large: true`, a refusal naming no runnable window, a repeat the detector missed because a size knob changed, and a PDF refusal that said Read cannot read PDFs. Every row drives `preReadHandler` (the shipping default path) with a Claude Code payload. */
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { detectHarness } from '../src/bridges/registry.js'
import { sharpenRepeatedDeny } from '../src/hint_target.js'
import { preReadHandler } from '../src/hooks_read.js'
import { escalateRepeatedFileTypeDeny, readOverridesLargeFileDeny } from '../src/hooks_read_override.js'
import type { HookEvent } from '../src/hook_registry.js'
import type { HookOutput } from '../src/types.js'
import { makeHookEvent } from './helpers/hook-event.js'

let base = ''

// PROVENANCE: CAPTURE: C:/Users/zelys/.claude/projects/C--Projects-frontend/335e9f0a*.jsonl lines 10162/10169 -- a Read of a 22.8 KB, 483-line untracked .txt, then the same Read with `allow_large: true` four seconds later, both denied with identical text. The file here is synthetic (no transcript content) but has that size and line count. The `allow_large` and `pages` parameter names are read off Claude Code's own Read tool schema, not off this repo's code.
function writeText(name: string, lines = 483, bytesPerLine = 46): string {
  const file = path.join(base, name)
  const row = (n: number): string => `line ${String(n).padStart(3, '0')} `.padEnd(bytesPerLine - 1, 'x')
  fs.writeFileSync(file, Array.from({ length: lines }, (_, i) => row(i + 1)).join('\n') + '\n')
  return file
}

// PROVENANCE: CAPTURE: C:/Users/zelys/.claude/projects/C--Projects-GCC/87c28eb5*.jsonl 19:47:04 -- a Read of a PDF denied with "Read cannot return PDF content; this is not retryable". The bytes here are a synthetic header plus padding.
function writePdf(name: string): string {
  const file = path.join(base, name)
  fs.writeFileSync(file, '%PDF-1.4\n' + 'x'.repeat(120_000))
  return file
}

function claudeRead(file: string, extra: Record<string, unknown> = {}, sessionId = session): HookEvent {
  return makeHookEvent({ toolName: 'Read', toolInput: { file_path: file, ...extra }, sessionId, raw: { _tg_harness: 'claude' } })
}

function denyText(out: HookOutput): string {
  expect(out.hookType).toBe('deny')
  return out.hookType === 'deny' ? out.message : ''
}

let session = ''

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-denyfix-'))
  session = 'denyfix-' + crypto.randomUUID()
  // HAND-DERIVED: detectHarness() reads TOKEN_GOAT_HARNESS_OVERRIDE first (src/bridges/registry.ts), so the host the rows run under does not depend on the shell that started vitest.
  vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('allow_large on a large text file', () => {
  it('still denies a plain Read of the 483-line file (no override)', () => {
    const file = writeText('notes.txt')
    expect(fs.statSync(file).size).toBeGreaterThan(20_000)
    expect(denyText(preReadHandler(claudeRead(file)))).toContain('Large text file')
  })

  it('does not deny the retry that carries allow_large: true', () => {
    const file = writeText('notes.txt')
    denyText(preReadHandler(claudeRead(file)))
    const retry = preReadHandler(claudeRead(file, { allow_large: true }))
    expect(retry.hookType, 'allow_large retry must not be refused again').not.toBe('deny')
  })

  it('does not honor allow_large on a host whose Read schema is not cited', () => {
    const file = writeText('notes.txt')
    const other = makeHookEvent({ toolName: 'Read', toolInput: { file_path: file, allow_large: true }, sessionId: session, raw: { _tg_harness: 'codex' } })
    expect(denyText(preReadHandler(other))).toContain('Large text file')
  })

  it('does not treat allow_large: "true" or false as the override', () => {
    const file = writeText('notes.txt')
    expect(preReadHandler(claudeRead(file, { allow_large: 'true' })).hookType).toBe('deny')
    expect(preReadHandler(claudeRead(file, { allow_large: false }, session + 'b')).hookType).toBe('deny')
  })
})

describe('the large-text deny names a runnable next call', () => {
  it('gives concrete offset/limit values and a token-goat read window', () => {
    const file = writeText('notes.txt')
    const text = denyText(preReadHandler(claudeRead(file)))
    expect(text).toContain('Read with offset 1 and limit 200')
    expect(text.toLowerCase()).toContain(('`token-goat read "' + file.split(path.sep).join('/') + '@1-200"`').toLowerCase())
    expect(text).not.toContain('Use Read with offset and limit params to sample')
  })

  it('the window it names is not itself refused, even for long lines', () => {
    const file = writeText('wide.txt', 400, 400)
    const text = denyText(preReadHandler(claudeRead(file)))
    const limit = Number(/limit (\d+)/.exec(text)?.[1])
    expect(limit).toBeGreaterThan(0)
    expect(limit).toBeLessThan(200)
    const named = preReadHandler(claudeRead(file, { offset: 1, limit }, session + 'w'))
    expect(named.hookType, 'the named window must pass the gate that named it').not.toBe('deny')
  })
})

describe('a repeated refusal is judged on the whole request, size knobs included', () => {
  // The r5a version of this row asserted that a different limit is cut to a pointer; that encoded the dropped-size-knob key (a differing window is a different request, so it keeps the full text) and is replaced by the identical-request form.
  it('sharpens a repeat of the identical request to a pointer', () => {
    const file = writeText('notes.txt')
    const first = preReadHandler(claudeRead(file, { offset: 1, limit: 483 }))
    const long = sharpenRepeatedDeny(claudeRead(file, { offset: 1, limit: 483 }), first)
    expect(denyText(long)).toContain('Large text file')
    const again = sharpenRepeatedDeny(claudeRead(file, { offset: 1, limit: 483 }), first)
    expect(denyText(again), 'an identical repeat must be cut to a pointer').toContain('Repeat refusal of this exact call')
  })

  it('a different file is not a repeat', () => {
    const a = writeText('a.txt')
    const b = writeText('b.txt')
    const out = preReadHandler(claudeRead(a))
    sharpenRepeatedDeny(claudeRead(a), out)
    expect(denyText(sharpenRepeatedDeny(claudeRead(b), preReadHandler(claudeRead(b))))).toContain('Large text file')
  })

  it('the second refusal of the same file hands over a bounded window instead of the same text', () => {
    const file = writeText('notes.txt')
    const first = denyText(preReadHandler(claudeRead(file)))
    const second = denyText(preReadHandler(claudeRead(file, { offset: 1, limit: 483 })))
    expect(second).not.toBe(first)
    expect(second).toContain('in place of the full file')
    expect(second).toContain('line 001')
    expect(second).not.toContain('line 483')
    expect(Buffer.byteLength(second, 'utf8')).toBeLessThan(6000)
    expect(second).toMatch(/Read with offset \d+ and limit \d+/)
    const third = denyText(preReadHandler(claudeRead(file, { limit: 483, offset: 1, allow_large: false })))
    expect(third).toContain('in place of the full file')
  })

  // HAND-DERIVED: the escalated text is a deny the wrapper prefixes with one `[tg]`; a literal `[tg]` in the body is escaped to `&#91;tg]` by neutralizeSpokenMarkers (src/injection_scan.ts), so the body must carry none.
  it('the escalated repeat carries no escaped [tg] prefix and at most one [tg]', () => {
    const file = writeText('notes.txt')
    denyText(preReadHandler(claudeRead(file)))
    const repeat = denyText(preReadHandler(claudeRead(file)))
    expect(repeat).toContain('in place of the full file')
    expect(repeat, 'escaped prefix leaked into the escalated text').not.toContain('&#91;tg]')
    expect(repeat.split('[tg]').length - 1, 'literal [tg] count').toBeLessThanOrEqual(1)
  })
})

describe('the PDF deny', () => {
  it('names pages with a concrete range on Claude Code instead of saying Read cannot read PDFs', () => {
    const file = writePdf('report.pdf')
    const text = denyText(preReadHandler(claudeRead(file)))
    expect(text).toContain('pages "1-5"')
    expect(text).not.toContain('Read cannot return PDF content')
    expect(text).not.toContain('not retryable')
  })

  it('does not refuse the retry that carries a bounded pages range', () => {
    const file = writePdf('report.pdf')
    denyText(preReadHandler(claudeRead(file)))
    expect(preReadHandler(claudeRead(file, { pages: '1-5' })).hookType).not.toBe('deny')
  })

  it('still refuses an unbounded, malformed or over-20-page range', () => {
    const file = writePdf('report.pdf')
    for (const pages of ['1-21', '0-3', '5-2', '1-', 'all', 5, '']) {
      expect(preReadHandler(claudeRead(file, { pages }, session + String(pages))).hookType, `pages=${String(pages)}`).toBe('deny')
    }
  })

  it('keeps the accurate text on a host whose Read is not known to take pages', () => {
    const file = writePdf('report.pdf')
    const other = makeHookEvent({ toolName: 'Read', toolInput: { file_path: file, pages: '1-5' }, sessionId: session, raw: { _tg_harness: 'codex' } })
    const text = denyText(preReadHandler(other))
    expect(text).toContain('Read cannot return PDF content')
  })
})

function codexRead(file: string, extra: Record<string, unknown> = {}): HookEvent {
  return makeHookEvent({ toolName: 'Read', toolInput: { file_path: file, ...extra }, sessionId: session, raw: { _tg_harness: 'codex' } })
}

function inlinedBody(text: string): string {
  const m = /<untrusted-file-content>\n([\s\S]*)\n<\/untrusted-file-content>/.exec(text)
  expect(m, 'the escalated deny must fence the inlined window').not.toBeNull()
  return m?.[1] ?? ''
}

function writeRaw(name: string, body: string | Buffer): string {
  const file = path.join(base, name)
  fs.writeFileSync(file, body)
  return file
}

describe('the escalated window is bounded on every path', () => {
  // HAND-DERIVED: 9,000 CJK characters are 27,000 UTF-8 bytes (3 each) on one line, over the txt threshold; a character-based slice(0, 4000) would inline 12,000 bytes.
  it('caps a single long multibyte first line at 4,000 UTF-8 bytes without splitting a code point', () => {
    const file = writeRaw('cjk.txt', '漢'.repeat(9000) + '\n')
    denyText(preReadHandler(claudeRead(file)))
    const body = inlinedBody(denyText(preReadHandler(claudeRead(file, { limit: 5 }))))
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(4000)
    expect(body.length).toBeGreaterThan(0)
    expect(body).not.toContain('�')
    expect(body).toBe('漢'.repeat(body.length))
  })

  // HAND-DERIVED: a 4-byte emoji line of 7,000 code points, cut at 4,000 bytes, lands mid-sequence unless the cut backs up to a code point boundary.
  it('backs up to a code point boundary on a 4-byte character', () => {
    const file = writeRaw('emoji.txt', '\u{1F600}'.repeat(7000) + '\n')
    denyText(preReadHandler(claudeRead(file)))
    const body = inlinedBody(denyText(preReadHandler(claudeRead(file, { limit: 5 }))))
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(4000)
    expect(body).not.toContain('�')
  })

  // HAND-DERIVED: 483 CRLF-terminated rows of 44 bytes plus the terminator, the same size as the LF fixture.
  it('windows a CRLF file from its first line', () => {
    const lines = Array.from({ length: 483 }, (_, i) => `line ${String(i + 1).padStart(3, '0')} `.padEnd(44, 'x'))
    const file = writeRaw('crlf.txt', lines.join('\r\n') + '\r\n')
    denyText(preReadHandler(claudeRead(file)))
    const text = denyText(preReadHandler(claudeRead(file, { limit: 483 })))
    expect(text).toContain('in place of the full file')
    expect(inlinedBody(text)).toContain('line 001')
    expect(text).toMatch(/Next window: Read with offset \d+/)
  })

  // HAND-DERIVED: 3,000 rows of 10 bytes (30 KB, over the txt threshold); the 4,000-byte budget alone would admit about 360 rows, so only the 200-line cap stops at 200.
  it('stops at 200 lines when the byte budget would allow more', () => {
    const file = writeRaw('short.txt', Array.from({ length: 3000 }, (_, i) => String(i + 1).padStart(9, '0')).join('\n') + '\n')
    denyText(preReadHandler(claudeRead(file)))
    const text = denyText(preReadHandler(claudeRead(file, { limit: 3000 })))
    expect(inlinedBody(text).split('\n')).toHaveLength(200)
    expect(text).toContain('Read with offset 201 and limit 200')
  })
})

describe('the escalation is not an inlining of what cannot be read', () => {
  // HAND-DERIVED: a binary-extension file (pdf, sqlite, docx) is never read as text before dispatch, so its scanned content is empty and a repeat refusal has nothing to inline.
  it('returns the plain deny for a repeated PDF, .sqlite and .docx refusal', () => {
    for (const [name, body] of [['a.pdf', '%PDF-1.4\n' + 'x'.repeat(120_000)], ['c.sqlite', Buffer.alloc(120_000, 7)], ['d.docx', Buffer.alloc(120_000, 7)]] as const) {
      const file = writeRaw(name, body)
      expect(denyText(preReadHandler(claudeRead(file))).length, name).toBeGreaterThan(0)
      const second = denyText(preReadHandler(claudeRead(file, { limit: 50 })))
      expect(second, name).not.toContain('in place of the full file')
      expect(second, name).not.toContain('untrusted-file-content')
    }
  })
})

describe('the next-window text follows the host', () => {
  // FORMAT-DERIVED: the Read offset/limit wording is only cited for Claude Code (src/hooks_read_override.ts::isClaudeRead); any other host gets the token-goat command alone.
  it('names token-goat read and no Read offset on a Codex repeat refusal', () => {
    const file = writeText('notes.txt')
    preReadHandler(codexRead(file))
    const second = denyText(preReadHandler(codexRead(file, { limit: 483 })))
    expect(second).toContain('in place of the full file')
    expect(second).toContain('token-goat read "')
    expect(second).not.toContain('offset')
  })
})

describe('allow_large beyond the named text types', () => {
  // HAND-DERIVED: 2,000 rows of about 57 bytes (114 KB) clear every threshold for svg (8,000), xml (20,000) and csv (10,000).
  it('is honored on a large svg, xml and csv file on Claude Code', () => {
    for (const name of ['big.svg', 'big.xml', 'big.csv']) {
      const file = writeRaw(name, Array.from({ length: 2000 }, (_, i) => `row${i},` + 'v'.repeat(50)).join('\n') + '\n')
      expect(preReadHandler(claudeRead(file, {}, session + name)).hookType, `${name} plain`).toBe('deny')
      expect(preReadHandler(claudeRead(file, { allow_large: true }, session + name)).hookType, `${name} allow_large`).not.toBe('deny')
    }
  })

  // HAND-DERIVED: 13,000 rows of about 49 bytes (about 640 KB) is past the default 512,000-byte very-large-file deny; no file-type handler claims .conf, so the very-large-file gate is the deny.
  function writeVeryLarge(name: string): string {
    return writeRaw(name, Array.from({ length: 13_000 }, (_, i) => `key${i}=` + 'v'.repeat(40)).join('\n') + '\n')
  }

  it('is honored on a very large unknown-extension text file, and not on a large binary asset', () => {
    const text = writeVeryLarge('settings.conf')
    expect(denyText(preReadHandler(claudeRead(text)))).toContain('very large')
    expect(preReadHandler(claudeRead(text, { allow_large: true })).hookType).not.toBe('deny')
    const bin = writeRaw('blob.bin', Buffer.alloc(700_000, 0))
    expect(preReadHandler(claudeRead(bin, { allow_large: true })).hookType, 'binary asset with allow_large stays refused').toBe('deny')
  })

  it('is not honored on a very large unknown-extension file on a host whose Read schema is not cited', () => {
    const text = writeVeryLarge('settings.conf')
    expect(preReadHandler(codexRead(text, { allow_large: true })).hookType).toBe('deny')
  })
})

describe('the Claude-only branches need the detected host too', () => {
  // HAND-DERIVED: relay.ts tags every unmapped harness `_tg_harness: 'claude'`, so a payload tagged claude on a host detected as opencode is not a Claude Code Read and its Read schema is not cited.
  it('keeps the deny, and names no allow_large, pages or offset Read knob, when the host is detected as opencode', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'opencode')
    const file = writeText('notes.txt')
    const text = denyText(preReadHandler(claudeRead(file, { allow_large: true })))
    expect(text).toContain('Large text file')
    expect(text).not.toContain('pages')
    const repeat = denyText(preReadHandler(claudeRead(file, { allow_large: true })))
    expect(repeat).toContain('in place of the full file')
    expect(repeat).not.toContain('Read with offset')
    const pdf = writePdf('doc.pdf')
    expect(denyText(preReadHandler(claudeRead(pdf, { pages: '1-5' }, session + 'p')))).not.toContain('pages "1-5"')
  })

  // HAND-DERIVED: a payload tagged `_tg_harness: 'claude'` (relay.ts tags every unmapped harness so) with allow_large on a large .txt, while detectHarness() answers opencode via the same override as the row above while TERM_PROGRAM=claude-code (registry.ts::hasClaudeCodeEnvSignal) is also set, so only the detectHarness() clause refuses: the retry is not honored, the first call is already the deny.
  it('keeps the deny for a claude-tagged allow_large Read when the detected host is not claudecode', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'opencode')
    vi.stubEnv('TERM_PROGRAM', 'claude-code')
    expect(detectHarness(), 'the override puts the host outside claudecode').toBe('opencode')
    const file = writeText('tagged.txt')
    const out = preReadHandler(claudeRead(file, { allow_large: true }))
    expect(out.hookType, 'allow_large from a claude-tagged payload on another host stays denied').toBe('deny')
  })

  it('keeps the very-large-file deny under allow_large when the host is detected as opencode', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'opencode')
    const text = writeRaw('settings.conf', Array.from({ length: 13_000 }, (_, i) => `key${i}=` + 'v'.repeat(40)).join('\n') + '\n')
    expect(preReadHandler(claudeRead(text, { allow_large: true })).hookType).toBe('deny')
  })
})

describe('allow_large on an unknown-extension file with binary content', () => {
  // HAND-DERIVED: 13,000 rows of about 49 bytes (about 640 KB) is past the 512,000-byte very-large-file deny; .zzz is in no asset list (src/asset_extensions.ts), so only the leading bytes can tell binary from text.
  function writeZzz(name: string, nulAt: number | null): string {
    const body = Buffer.from(Array.from({ length: 13_000 }, (_, i) => `key${i}=` + 'v'.repeat(40)).join('\n') + '\n')
    if (nulAt !== null) body[nulAt] = 0
    return writeRaw(name, body)
  }

  it('keeps the deny when a NUL byte sits in the first 8,192 bytes', () => {
    expect(preReadHandler(claudeRead(writeZzz('a.zzz', 8191), { allow_large: true })).hookType, 'NUL at offset 8191').toBe('deny')
    expect(preReadHandler(claudeRead(writeZzz('b.zzz', 100), { allow_large: true }, session + 'b')).hookType, 'NUL at offset 100').toBe('deny')
  })

  it('honors allow_large when there is no NUL, or the first NUL is past the probe', () => {
    expect(preReadHandler(claudeRead(writeZzz('c.zzz', null), { allow_large: true })).hookType, 'no NUL').not.toBe('deny')
    expect(preReadHandler(claudeRead(writeZzz('d.zzz', 8192), { allow_large: true }, session + 'd')).hookType, 'NUL at offset 8192').not.toBe('deny')
  })
})

describe('the escalated window never claims the end of a file it did not show', () => {
  // HAND-DERIVED: 9,000 CJK characters are 27,000 UTF-8 bytes (3 each) on one line. The 4,000-byte cut backs off to 3,999 (a whole 3-byte character is 1,333 characters), leaving 27,000 - 3,999 = 23,001 bytes, so the dd piece is the next 4,000 and a second piece follows.
  it('marks the cut of a one-line file and names the dd command for the rest, not an end of file', () => {
    const file = writeRaw('onelinecjk.txt', '漢'.repeat(9000) + '\n')
    denyText(preReadHandler(claudeRead(file)))
    const text = denyText(preReadHandler(claudeRead(file, { limit: 5 })))
    expect(text).not.toContain('end of the file')
    expect(text).toContain('was cut at 4,000 bytes')
    const lastLine = text.split('\n').at(-1) ?? ''
    const m = /dd if=.* bs=1 skip=(\d+) count=(\d+) status=none/.exec(lastLine)
    expect(m, `the last line of the deny must carry the dd command: ${lastLine}`).not.toBeNull()
    const skip = Number(m?.[1])
    const count = Number(m?.[2])
    expect(skip).toBe(Buffer.byteLength(inlinedBody(text), 'utf8'))
    expect(count).toBe(4000)
    expect(fs.readFileSync(file).subarray(skip, skip + count).toString('utf8').startsWith('漢')).toBe(true)
    expect(lastLine).toContain(`skip=${skip + count}`)
  })

  // HAND-DERIVED: 600 rows of 39 bytes plus a lone CR (40 bytes each, 24,000 bytes), over the txt threshold of 20,000. Split on LF only this is one line; split on CR it is 600.
  it('counts and windows a CR-only file by its CRs', () => {
    const rows = Array.from({ length: 600 }, (_, i) => `row ${String(i + 1).padStart(3, '0')} `.padEnd(39, 'x'))
    const file = writeRaw('cronly.txt', rows.join('\r') + '\r')
    denyText(preReadHandler(claudeRead(file)))
    const text = denyText(preReadHandler(claudeRead(file, { offset: 2, limit: 600 })))
    expect(text).toContain('of 600 are inlined')
    expect(text).not.toContain('end of the file')
    const body = inlinedBody(text).split('\n')
    expect(body[0]).toContain('row 002')
    expect(body).toHaveLength(100)
    expect(text).toContain('Read with offset 102 and limit 100')
  })

  // HAND-DERIVED: 12 rows of 2,999 bytes plus a lone CR (3,000 each, 36,000 bytes) is fewer than 20 lines, so a wide window request from any row 1-6 is refused by size (at least 20,000 bytes) and escalated. One row fits the 4,000-byte window (two would be 6,000), so each window is one row and the next one starts at the next row.
  it('following the printed next-window command three times shows three advancing windows', () => {
    const rows = Array.from({ length: 12 }, (_, i) => `row ${i + 1} `.padEnd(2999, 'x'))
    const seen: string[] = []
    let offset = 1
    for (let n = 0; n < 3; n++) {
      // A fresh copy of the file per step: a second wide ranged retry of one file meets the range-evasion lock (a different layer, keyed by file), which this row is not about.
      const file = writeRaw(`few${n}.txt`, rows.join('\r') + '\r')
      denyText(preReadHandler(claudeRead(file)))
      const text = denyText(preReadHandler(claudeRead(file, { offset, limit: 12 })))
      expect(text, `request ${n + 1} (offset ${offset})`).toContain('in place of the full file')
      seen.push(inlinedBody(text).slice(0, 5))
      const next = /Next window: Read with offset (\d+) and limit (\d+)/.exec(text)
      expect(next, `window ${n + 1} must name the next Read: ${text.slice(-300)}`).not.toBeNull()
      offset = Number(next?.[1])
      expect(preReadHandler(claudeRead(file, { offset, limit: Number(next?.[2]) }, session + '-literal' + n)).hookType, `printed Read ${n + 1} requested literally`).not.toBe('deny')
    }
    expect(seen).toEqual(['row 1', 'row 2', 'row 3'])
  })
})

describe('a text file past the 2 MiB scan cap', () => {
  // HAND-DERIVED: 7,500 rows of 299 bytes plus LF is 300 bytes each, 2,250,000 bytes, past the 2,097,152-byte cap. The txt window budget is half the 20,000-byte threshold (10,000), so 33 rows (9,900 bytes) fit and 34 (10,200) do not.
  function writeBig(name: string): string {
    return writeRaw(name, Array.from({ length: 7500 }, (_, i) => `row ${String(i + 1).padStart(4, '0')} `.padEnd(299, 'x')).join('\n') + '\n')
  }

  it('advises an offset and limit the next Read is allowed, sized from the head of the file', () => {
    const file = writeBig('big.txt')
    const text = denyText(preReadHandler(claudeRead(file)))
    const m = /Read with offset (\d+) and limit (\d+)/.exec(text)
    expect(m, `the deny must name a Read window: ${text}`).not.toBeNull()
    const offset = Number(m?.[1])
    const limit = Number(m?.[2])
    expect(limit * 300).toBeLessThanOrEqual(10_000)
    expect(limit).toBe(33)
    expect(preReadHandler(claudeRead(file, { offset, limit }, session + '-follow')).hookType).not.toBe('deny')
  })

  it('escalates a repeated refusal into a window instead of repeating the plain deny', () => {
    const file = writeBig('bigrepeat.txt')
    denyText(preReadHandler(claudeRead(file)))
    const text = denyText(preReadHandler(claudeRead(file, { limit: 7500 })))
    expect(text).toContain('in place of the full file')
    expect(inlinedBody(text)).toContain('row 0001')
    expect(text).not.toContain('end of the file')
    expect(text).toMatch(/Next window: Read with offset 14 and limit 13/)
  })
})

describe('differing Read windows are different requests; identical ones still reach the circuit breaker', () => {
  // HAND-DERIVED: a synthetic refusal whose message leads with a fenced `token-goat` command, the shape LED_COMMAND_RE (src/hint_target.ts) reads; the key under test is built from the tool input alone, so the message text only has to be the same on every call.
  const refusal: HookOutput = { hookType: 'deny', message: '[tg] Too big. Run `token-goat read "notes.txt@1-50"` instead.' }

  // HAND-DERIVED, not captured: window arguments by host spelling as hooks_read_slice.ts::readRequestedSliceWindow reads them (our code, so not an external producer); no host schema was read for this row.
  const windows: [string, Record<string, unknown>[]][] = [
    ['offset and limit', [{ offset: 1, limit: 50 }, { offset: 51, limit: 50 }, { offset: 101, limit: 50 }]],
  ]

  it.each(windows)('three Reads of one file with %s windows each draw the full refusal, not a pointer', (_name, ws) => {
    const file = writeText('notes.txt')
    for (const w of ws) {
      const event = claudeRead(file, w)
      expect(denyText(sharpenRepeatedDeny(event, refusal)), JSON.stringify(event.toolInput)).toBe(denyText(refusal))
    }
  })

  // HAND-DERIVED: the repeat key is JSON.stringify(toolInput) (ruling B1), so any key added to an otherwise identical input makes a different request; `unrelated` is a made-up name no host reads.
  it('an unrelated key added to an identical input is a different request, not a repeat', () => {
    const file = writeText('notes.txt')
    expect(sharpenRepeatedDeny(claudeRead(file, { offset: 1, limit: 50 }), refusal)).toEqual(refusal)
    expect(denyText(sharpenRepeatedDeny(claudeRead(file, { offset: 1, limit: 50 }), refusal))).toContain('Repeat refusal of this exact call')
    const other = claudeRead(file, { offset: 1, limit: 50, unrelated: 1 })
    expect(denyText(sharpenRepeatedDeny(other, refusal)), 'the extra key must make a new request').toBe(denyText(refusal))
  })

  // HAND-DERIVED: a .txt file of 27,000 bytes (past the 20,000-byte txt threshold, src/hints/file_type_handler.ts) whose byte 100 is NUL; the NUL makes escalation return null, so every refusal is the handler's own deny and the pointer and breaker apply to its real output. (A 100-512 KB unknown-extension file meets the early large-file hint first, so the generic deny is not reachable through this entry.)
  it('the real handler output goes full, pointer, circuit breaker when escalation returns null', () => {
    const body = Buffer.from('abcdefgh\n'.repeat(3000))
    body[100] = 0
    const file = writeRaw('nul-chain.txt', body)
    const same = (): HookEvent => claudeRead(file)
    const first = sharpenRepeatedDeny(same(), preReadHandler(same()))
    expect(denyText(first)).toContain('Large text file')
    const second = sharpenRepeatedDeny(same(), preReadHandler(same()))
    expect(denyText(second)).toContain('Repeat refusal of this exact call')
    expect(denyText(second)).not.toContain('in place of the full file')
    const third = sharpenRepeatedDeny(same(), preReadHandler(same()))
    expect(third.hookType).not.toBe('deny')
    expect(JSON.stringify(third)).toContain('Circuit breaker')
  })

  it('three identical Reads still go full, pointer, circuit breaker', () => {
    const file = writeText('notes.txt')
    const same = (): HookEvent => claudeRead(file, { offset: 1, limit: 50 })
    expect(sharpenRepeatedDeny(same(), refusal)).toEqual(refusal)
    expect(denyText(sharpenRepeatedDeny(same(), refusal))).toContain('Repeat refusal of this exact call')
    const third = sharpenRepeatedDeny(same(), refusal)
    expect(third.hookType).not.toBe('deny')
    expect(JSON.stringify(third)).toContain('Circuit breaker')
  })
})

describe('an unmapped host with ANTHROPIC_API_KEY set is not Claude Code', () => {
  // HAND-DERIVED: bridges/registry.ts::detectHarness returns 'claudecode' as its last fallback for a bare ANTHROPIC_API_KEY once no earlier branch matched, and relay.ts tags every unmapped harness `_tg_harness: 'claude'`. Every variable an earlier branch reads is unset so only the key remains.
  function unmappedHostWithKey(): void {
    for (const name of ['TOKEN_GOAT_HARNESS_OVERRIDE', 'HERMES_SESSION_ID', 'HERMES_HOME', 'TERM_PROGRAM', 'CLAUDE_CODE_VERSION', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_SESSION', 'OPENCODE_SESSION_ID', 'OPENCODE_SESSION', 'OPENCODE_PID', 'GROK_SESSION_ID', 'OPENCLAW_SESSION_ID']) {
      vi.stubEnv(name, undefined)
    }
    vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-key-for-test')
  }

  it('resolves to claudecode in detectHarness, yet the Claude-only allow_large override does not apply', () => {
    unmappedHostWithKey()
    expect(detectHarness(), 'precondition: the bare-key fallback is what answers').toBe('claudecode')
    const file = writeText('notes.txt')
    expect(denyText(preReadHandler(claudeRead(file, { allow_large: true })))).toContain('Large text file')
  })

  it('keeps the very-large-file deny under allow_large', () => {
    unmappedHostWithKey()
    const text = writeRaw('settings.conf', Array.from({ length: 13_000 }, (_, i) => `key${i}=` + 'v'.repeat(40)).join('\n') + '\n')
    expect(preReadHandler(claudeRead(text, { allow_large: true })).hookType).toBe('deny')
  })
})

describe('the NUL probe opens the on-disk path', () => {
  // HAND-DERIVED: the index key and the path the host opens are one string except under WSL, so the two are passed apart here: the key names nothing, the on-disk path holds the bytes. A probe of the key fails to open and reads as binary.
  it('judges the file at the on-disk path, not the index key', () => {
    const text = writeRaw('plain.zzz', 'a'.repeat(100))
    const binary = writeRaw('bin.zzz', Buffer.from([0x61, 0x00, 0x62]))
    const key = path.join(base, 'no-such-key.zzz')
    expect(readOverridesLargeFileDeny(claudeRead(text, { allow_large: true }), key, text), 'text on disk').toBe(true)
    expect(readOverridesLargeFileDeny(claudeRead(binary, { allow_large: true }), key, binary), 'NUL on disk').toBe(false)
  })
})

describe('a text preview counts lines by every terminator', () => {
  // HAND-DERIVED: 600 rows of 39 bytes plus a lone CR (40 bytes each, 24,000 bytes), over the txt threshold of 20,000; split on LF only it is one line.
  it('reports 600 lines for a CR-only file and shows its real first and last rows', () => {
    const rows = Array.from({ length: 600 }, (_, i) => `row ${String(i + 1).padStart(3, '0')} `.padEnd(39, 'x'))
    const file = writeRaw('cronly-preview.txt', rows.join('\r') + '\r')
    const text = denyText(preReadHandler(claudeRead(file)))
    expect(text).toContain('600 lines')
    expect(text).toContain('row 001')
    expect(text).toContain('row 600')
    expect(text).not.toContain('1 lines')
  })
})

describe('the escalated window is redacted and fenced', () => {
  // FORMAT-DERIVED: src/secret_redact.ts SECRET_PATTERNS entry `github_token`, /gh[oprsu]_[A-Za-z0-9]{36,}/g, replaces a match with `[REDACTED:github_token]`; the secret here is `ghp_` plus 40 alphanumerics.
  const secret = 'ghp_' + 'A1b2C3d4E5'.repeat(4)
  function rows(line5: string): string {
    return Array.from({ length: 483 }, (_, i) => (i === 4 ? line5 : `line ${String(i + 1).padStart(3, '0')} `.padEnd(45, 'x'))).join('\n') + '\n'
  }

  it('prints a placeholder, not the secret, and computes the next window on the original bytes', () => {
    const pad = ' '.repeat(Math.max(0, 45 - 2 - secret.length))
    const planted = writeRaw('planted.txt', rows('k=' + secret + pad))
    const control = writeRaw('control.txt', rows('n=' + 'q'.repeat(secret.length) + pad))
    const texts: string[] = []
    for (const file of [planted, control]) {
      denyText(preReadHandler(claudeRead(file)))
      texts.push(denyText(preReadHandler(claudeRead(file, { limit: 483 }))))
    }
    const [p, c] = texts as [string, string]
    expect(p).toContain('[REDACTED:')
    expect(p).not.toContain(secret)
    expect(p).not.toContain('A1b2C3d4E5')
    expect(c).toContain('q'.repeat(secret.length))
    const next = (t: string): string | undefined => /Next window: Read with offset \d+ and limit \d+/.exec(t)?.[0]
    expect(next(p)).toBeDefined()
    expect(next(p), 'redaction shortened the line; the window must still be sized on the original bytes').toBe(next(c))
    expect(inlinedBody(p)).toContain('line 001')
  })
})

describe('the escalation never inlines a file that is not text', () => {
  // HAND-DERIVED: the escalation is called directly at its chokepoint (src/hooks_read_override.ts::escalateRepeatedFileTypeDeny, the single caller being hooks_read.ts) with the file's bytes: a 100-512 KB unknown-extension file never reaches it through preReadHandler, the early large-file hint answers first. The first call books the refusal, the second is the repeat.
  function repeatEscalation(name: string, body: Buffer): string | null {
    const file = writeRaw(name, body)
    const event = claudeRead(file)
    const text = { bytes: fs.readFileSync(file), complete: true }
    expect(escalateRepeatedFileTypeDeny(event, file, text), 'the first refusal is only booked').toBeNull()
    return escalateRepeatedFileTypeDeny(event, file, text)
  }

  it('returns null for a repeated .zzz file with a NUL in its first 8 KB', () => {
    expect(repeatEscalation('nul.zzz', Buffer.concat([Buffer.from('a'.repeat(100)), Buffer.from([0]), Buffer.from('b'.repeat(120_000))]))).toBeNull()
    const edge = Buffer.from('abcdefgh\n'.repeat(15_000))
    edge[8191] = 0
    expect(repeatEscalation('edge.zzz', edge), 'NUL at offset 8191').toBeNull()
  })

  // HAND-DERIVED: .bin is a known non-text asset (src/asset_extensions.ts::isNonTextAsset) in no BINARY_FILE_TYPE_EXTS list; these bytes hold no NUL, so only the asset check can refuse.
  it('returns null for a repeated .bin file made of printable bytes', () => {
    expect(repeatEscalation('plain.bin', Buffer.from('abcdefgh\n'.repeat(15_000)))).toBeNull()
  })

  // HAND-DERIVED: a NUL after the 8,192-byte probe is text as far as the probe can tell, so a .zzz file with its first NUL at byte 8192, and one with none, still get their window.
  it('still escalates a .zzz file whose first NUL is past the probe, or that has none', () => {
    const late = Buffer.from('abcdefgh\n'.repeat(15_000))
    late[8192] = 0
    expect(repeatEscalation('late.zzz', late)).toContain('in place of the full file')
    expect(repeatEscalation('none.zzz', Buffer.from('abcdefgh\n'.repeat(15_000)))).toContain('in place of the full file')
  })

  // HAND-DERIVED: allow_large on a typed text extension (.txt) skipped the NUL probe that unknown extensions get; a 27 KB .txt with a NUL at byte 100 keeps its deny.
  it('keeps the deny for allow_large on a .txt file with a NUL in its first 8 KB', () => {
    const body = Buffer.from('abcdefgh\n'.repeat(3000))
    body[100] = 0
    const file = writeRaw('nul.txt', body)
    expect(preReadHandler(claudeRead(file, { allow_large: true })).hookType).toBe('deny')
  })
})

describe('a window cut inside a multi-line or token secret never prints a part of it', () => {
  // HAND-DERIVED: the fake key body lines hold the marker FAKEPEMBODY (not base64 of any real key); the block is shaped as src/secret_redact.ts SECRET_PATTERNS `private_key_block` reads it (BEGIN line, body, END line).
  const keyLine = (n: number): string => `FAKEPEMBODY${String(n).padStart(3, '0')}`.padEnd(64, 'Q')
  const filler = (n: number): string => `filler ${String(n).padStart(3, '0')} `.padEnd(49, 'x')
  function pemFile(name: string, before: number, keyLines: number, makeLine: (n: number) => string): string {
    const rows = [...Array.from({ length: before }, (_, i) => filler(i + 1)), '-----BEGIN RSA PRIVATE KEY-----', ...Array.from({ length: keyLines }, (_, i) => makeLine(i)), '-----END RSA PRIVATE KEY-----', 'after the key']
    return writeRaw(name, rows.join('\n') + '\n')
  }
  function escalate(file: string, offset?: number): string | null {
    const event = claudeRead(file, offset === undefined ? {} : { offset })
    const text = { bytes: fs.readFileSync(file), complete: true }
    escalateRepeatedFileTypeDeny(event, file, text)
    return escalateRepeatedFileTypeDeny(event, file, text)
  }

  it('redacts a PEM block whose END lies past the 4,000-byte cut', () => {
    const first = escalate(pemFile('pem.txt', 10, 80, keyLine)) ?? ''
    expect(first).toContain('in place of the full file')
    expect(first, 'no key body line from the first window').not.toContain('FAKEPEMBODY')
    expect(first).toContain('[REDACTED:private_key_block]')
  })

  it('redacts the next window, which starts inside the block', () => {
    const file = pemFile('pemnext.txt', 10, 80, keyLine)
    const offset = Number(/Next window: Read with offset (\d+)/.exec(escalate(file) ?? '')?.[1])
    expect(offset).toBeGreaterThan(11)
    const second = escalate(file, offset) ?? ''
    expect(second).toContain('in place of the full file')
    expect(second, 'no key body line from the window that starts mid-block').not.toContain('FAKEPEMBODY')
  })

  it('redacts a PEM block the 200-line cut falls inside', () => {
    const rows = [...Array.from({ length: 150 }, (_, i) => `f${String(i + 1).padStart(3, '0')}`), '-----BEGIN RSA PRIVATE KEY-----', ...Array.from({ length: 100 }, (_, i) => `FAKEPEMBODY${String(i).padStart(3, '0')}`), '-----END RSA PRIVATE KEY-----']
    const file = writeRaw('pem200.txt', rows.join('\n') + '\n')
    const out = escalate(file) ?? ''
    expect(out).toContain('lines 1-200')
    expect(out, 'no key body line from the 200-line window').not.toContain('FAKEPEMBODY')
    expect(out).toContain('[REDACTED:private_key_block]')
  })

  // FORMAT-DERIVED: src/secret_redact.ts `github_token`, /gh[oprsu]_[A-Za-z0-9]{36,}/g: the token here is `ghp_` plus 80 alphanumerics, 10 of which fit before the 4,000-byte cut.
  it('shows no prefix of a token the byte cut falls inside on one over-long line', () => {
    const file = writeRaw('long.txt', 'x'.repeat(3986) + 'ghp_' + 'A1b2'.repeat(20) + '\nsecond line\n')
    const out = escalate(file)
    expect(out === null || !out.includes('ghp_'), 'a cut token prefix must not print').toBe(true)
    expect(out === null || !out.includes('A1b2A1b2'), 'a cut token body must not print').toBe(true)
  })

  it('returns null for an unclosed private-key header in the bytes held', () => {
    const file = writeRaw('open.txt', ['intro', '-----BEGIN PRIVATE KEY-----', keyLine(1), keyLine(2)].join('\n') + '\n')
    expect(escalate(file)).toBeNull()
  })

  // HAND-DERIVED: 15,000 rows of `abcdefgh` (9 bytes each); a NUL at byte 9000 is line 1000, past the 8,192-byte probe and inside the window that starts at offset 1000.
  it('returns null when a NUL past the probe sits inside the window', () => {
    const body = Buffer.from('abcdefgh\n'.repeat(15_000))
    body[9000] = 0
    const file = writeRaw('latenul.zzz', body)
    expect(escalate(file, 1000)).toBeNull()
    expect(escalate(file, 1)).toContain('in place of the full file')
  })

  // HAND-DERIVED: the module is reloaded with injection_scan.js replaced; the fence throwing, or answering something that is not a string, must end in the plain deny (null), never a throw or "[object]" text.
  it('returns null when the fence throws or returns a non-string', async () => {
    const file = writeText('fence.txt')
    const bytes = fs.readFileSync(file)
    for (const fake of [(): string => { throw new Error('fence failed') }, (): unknown => undefined]) {
      vi.resetModules()
      vi.doMock('../src/injection_scan.js', () => ({ fenceUntrustedFileContent: fake }))
      try {
        const mod = await import('../src/hooks_read_override.js')
        const event = claudeRead(file)
        expect(mod.escalateRepeatedFileTypeDeny(event, file, { bytes, complete: true })).toBeNull()
        expect(mod.escalateRepeatedFileTypeDeny(event, file, { bytes, complete: true })).toBeNull()
      } finally {
        vi.doUnmock('../src/injection_scan.js')
        vi.resetModules()
      }
    }
  })

  // HAND-DERIVED: redactSecrets replaced by a function that answers an object with no `.text`, and by one that throws.
  it('returns null when redaction returns no text or throws', async () => {
    const file = writeText('redact.txt')
    const bytes = fs.readFileSync(file)
    for (const fake of [(): unknown => ({ count: 0 }), (): unknown => { throw new Error('redact failed') }]) {
      vi.resetModules()
      vi.doMock('../src/secret_redact.js', () => ({ redactSecrets: fake }))
      try {
        const mod = await import('../src/hooks_read_override.js')
        const event = claudeRead(file)
        expect(mod.escalateRepeatedFileTypeDeny(event, file, { bytes, complete: true })).toBeNull()
        expect(mod.escalateRepeatedFileTypeDeny(event, file, { bytes, complete: true })).toBeNull()
      } finally {
        vi.doUnmock('../src/secret_redact.js')
        vi.resetModules()
      }
    }
  })

  // HAND-DERIVED: the bytes held stop inside the key body (the END line lies past the held limit), so the BEGIN header is unmatched in the held text; complete:false is the shape of a file too large to scan.
  it('returns null for a key whose END lies past the bytes held of an unscanned file', () => {
    const rows = [...Array.from({ length: 5 }, (_, i) => filler(i + 1)), '-----BEGIN RSA PRIVATE KEY-----', ...Array.from({ length: 200 }, (_, i) => keyLine(i)), '-----END RSA PRIVATE KEY-----']
    const file = writeRaw('heldlimit.txt', rows.join('\n') + '\n')
    const bytes = fs.readFileSync(file).subarray(0, 3000)
    const event = claudeRead(file)
    escalateRepeatedFileTypeDeny(event, file, { bytes, complete: false })
    expect(escalateRepeatedFileTypeDeny(event, file, { bytes, complete: false })).toBeNull()
  })

  // HAND-DERIVED: the same block as the 200-line row with CRLF terminators; the redaction keeps each \r\n, so the line count holds and the body must still be gone.
  it('redacts a CRLF private-key block', () => {
    const rows = [...Array.from({ length: 10 }, (_, i) => filler(i + 1)), '-----BEGIN RSA PRIVATE KEY-----', ...Array.from({ length: 30 }, (_, i) => keyLine(i)), '-----END RSA PRIVATE KEY-----', 'after the key']
    const out = escalate(writeRaw('crlf.txt', rows.join('\r\n') + '\r\n')) ?? ''
    expect(out).toContain('in place of the full file')
    expect(out, 'no key body line from a CRLF file').not.toContain('FAKEPEMBODY')
    expect(out).toContain('[REDACTED:private_key_block]')
  })

  // HAND-DERIVED: with lone-CR terminators keepLineCount splits only on \n, so the block collapses to one placeholder and the line count changes; the result is the plain deny (null) or a window without the body, never the body.
  it('never prints the body of a lone-CR private-key block', () => {
    const rows = [...Array.from({ length: 10 }, (_, i) => filler(i + 1)), '-----BEGIN RSA PRIVATE KEY-----', ...Array.from({ length: 30 }, (_, i) => keyLine(i)), '-----END RSA PRIVATE KEY-----', 'after the key']
    const out = escalate(writeRaw('cr.txt', rows.join('\r') + '\r'))
    expect(out === null || !out.includes('FAKEPEMBODY'), 'a lone-CR key body must not print').toBe(true)
  })

  // HAND-DERIVED: 199 one-byte lines inside a key block become 28-byte placeholders (src/secret_redact.ts keepLineCount), so a window that fits 4,000 bytes unredacted (about 400) would show over 5,000; it is refused, while a 40-line block (about 1,200 shown) is still shown within the cap.
  it('never shows more than the 4,000-byte cap after placeholders grow the lines', () => {
    const block = (n: number): string[] => ['-----BEGIN RSA PRIVATE KEY-----', ...Array.from({ length: n }, () => 'Q'), '-----END RSA PRIVATE KEY-----']
    const big = writeRaw('expand.txt', [...block(197), 'tail'].join('\n') + '\n')
    expect(Buffer.byteLength(fs.readFileSync(big))).toBeLessThan(4000)
    expect(escalate(big), 'a redacted window over the cap is refused').toBeNull()
    const small = escalate(writeRaw('expandsmall.txt', [...block(40), 'tail'].join('\n') + '\n')) ?? ''
    expect(small).toContain('[REDACTED:private_key_block]')
    const shown = small.slice(small.indexOf('\n') + 1)
    expect(Buffer.byteLength(shown, 'utf8')).toBeLessThanOrEqual(4000 + 400)
  })
})

describe('the large-text preview is redacted', () => {
  // HAND-DERIVED: 600 rows of 45 bytes (27 KB, past the txt deny threshold); a fake key with BEGIN on line 4 and END on line 8, so the first-5 cut falls inside it.
  it('withholds the key body when the first-5 cut falls inside a key block', () => {
    const rows = Array.from({ length: 600 }, (_, i) => `line ${String(i + 1).padStart(3, '0')} `.padEnd(45, 'x'))
    rows.splice(3, 5, '-----BEGIN RSA PRIVATE KEY-----', 'FAKEPEMBODY001', 'FAKEPEMBODY002', 'FAKEPEMBODY003', '-----END RSA PRIVATE KEY-----')
    const file = writeRaw('previewkey.txt', rows.join('\n') + '\n')
    const out = denyText(preReadHandler(claudeRead(file)))
    expect(out).toContain('Large text file')
    expect(out, 'no key body in the first-5 preview').not.toContain('FAKEPEMBODY')
    expect(out).not.toContain('BEGIN RSA PRIVATE KEY')
  })

  // HAND-DERIVED: BEGIN on line 591 and END on line 599 of 600, so the last-5 block (lines 596-600) starts mid-key with no header of its own.
  it('withholds the key body when the last-5 block starts mid-key', () => {
    const rows = Array.from({ length: 600 }, (_, i) => `line ${String(i + 1).padStart(3, '0')} `.padEnd(45, 'x'))
    rows.splice(590, 9, '-----BEGIN RSA PRIVATE KEY-----', ...Array.from({ length: 7 }, (_, i) => `FAKEPEMBODY00${i}`), '-----END RSA PRIVATE KEY-----')
    const file = writeRaw('previewtail.txt', rows.join('\n') + '\n')
    const out = denyText(preReadHandler(claudeRead(file)))
    expect(out).toContain('Large text file')
    expect(out, 'no key body in the last-5 preview').not.toContain('FAKEPEMBODY')
    expect(out).toContain('lines total')
  })

  // HAND-DERIVED: redactSecrets replaced by a function that throws (same doMock and reload shape as the escalation rows above); the preview is already the redacted view or a static withheld string, so the deny must survive with no body line in it.
  it('still denies, with no file body line, when redaction throws', async () => {
    const rows = Array.from({ length: 600 }, (_, i) => `body-row-${String(i + 1).padStart(3, '0')} `.padEnd(45, 'x'))
    const file = writeRaw('redactthrows.txt', rows.join('\n') + '\n')
    vi.resetModules()
    vi.doMock('../src/secret_redact.js', () => ({ redactSecrets: (): never => { throw new Error('redact failed') } }))
    try {
      const mod = await import('../src/hints/file_type_handler.js')
      const result = mod.handleTxt(file, fs.readFileSync(file, 'utf8'))
      expect(result.shouldBlock, 'the deny is not lost when redaction throws').toBe(true)
      expect(result.message).toContain('Large text file')
      expect(result.message, 'no line of the file body').not.toContain('body-row-')
    } finally {
      vi.doUnmock('../src/secret_redact.js')
      vi.resetModules()
    }
  })

  // FORMAT-DERIVED: src/secret_redact.ts `github_token` replaces `ghp_` plus 36 or more alphanumerics; the secret sits on line 2, inside the first-5-lines preview of src/hints/file_type_handler.ts::handleTxt.
  it('prints a placeholder for a secret in the first lines', () => {
    const rows = Array.from({ length: 600 }, (_, i) => (i === 1 ? 'tok=ghp_' + 'A1b2'.repeat(10) : `line ${String(i + 1).padStart(3, '0')} `.padEnd(45, 'x')))
    const file = writeRaw('preview.txt', rows.join('\n') + '\n')
    const out = denyText(preReadHandler(claudeRead(file)))
    expect(out).toContain('--- first 5 lines ---')
    expect(out).toContain('[REDACTED:github_token]')
    expect(out).not.toContain('A1b2A1b2')
  })
})
