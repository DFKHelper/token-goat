/** Module-level check that a text read still prints the doc comment of a symbol whose over-cap doc was stored under other redaction settings than the ones now configured, prints it redacted under the settings now configured, and still prints nothing for a row gone stale because the file changed. Fixture provenance: HAND-DERIVED. EMP-12345678 is a made-up badge id matched by the made-up custom pattern EMP-[0-9]{4,8}, the strict-mode token is made-up mixed-case filler of the shape strict mode treats as a credential, and the filler lines are plain text. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import { querySymbols } from '../src/index_reader.js'
import { indexFileSync, MAX_SYMBOL_DOCSTRING_CHARS, storedDocstringBoundsDoc } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { docCommentLines } from '../src/read_commands.js'

const MARKER = '\n[... docstring truncated by token-goat ...]'
const CUT = 2000
const BADGE = 'EMP-12345678'
const STRICT_TOKEN = 'Zk3pQ9xLm2Vb7Nc4Rt8Wy1Hd5Fg6Js0A'
const FILLER_LINES = Math.ceil((MAX_SYMBOL_DOCSTRING_CHARS * 2) / 40)
const FILLER = Array.from({ length: FILLER_LINES }, (_, i) => `filler ${String(i).padStart(4, '0')} ${'x'.repeat(28)}`)
const DOC = ['lead line', `badge ${BADGE} issued`, `token ${STRICT_TOKEN} issued`, ...FILLER]
const SOURCE = (doc: readonly string[], fn: string): string => `/**\n${doc.map((l) => ` * ${l}`).join('\n')}\n */\nexport function ${fn}(): number {\n  return 1\n}\n`

let root: string
let count = 0

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-doc-config-change-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  delete process.env['TOKEN_GOAT_REDACTION_CUSTOM_PATTERNS']
  delete process.env['TOKEN_GOAT_REDACTION_STRICT']
  invalidateConfigCache()
})

/** Config in force for the next index or read: the custom pattern list and the strict flag. */
function configure(opts: { patterns?: string; strict?: boolean }): void {
  if (opts.patterns === undefined) delete process.env['TOKEN_GOAT_REDACTION_CUSTOM_PATTERNS']
  else process.env['TOKEN_GOAT_REDACTION_CUSTOM_PATTERNS'] = opts.patterns
  process.env['TOKEN_GOAT_REDACTION_STRICT'] = opts.strict === true ? '1' : '0'
  invalidateConfigCache()
}

/** Writes `doc` above a fresh function and indexes it under the config now in force. */
function indexed(doc: readonly string[]): { file: string; fn: string } {
  const fn = `docFn${count++}`
  const file = join(root, `${fn}.ts`)
  writeFileSync(file, SOURCE(doc, fn), 'utf-8')
  indexFileSync(normalizePath(file))
  return { file, fn }
}

function printed(file: string, fn: string): string {
  const [entry] = querySymbols({ filePath: normalizePath(file), name: fn })
  expect(entry).toBeDefined()
  return docCommentLines(entry as NonNullable<typeof entry>).join('\n')
}

describe('docCommentLines after the redaction settings change', () => {
  it('the fixture is over the stored cap, so the row is a cut one', () => {
    configure({})
    const { file, fn } = indexed(DOC)
    const [entry] = querySymbols({ filePath: normalizePath(file), name: fn })
    expect(entry?.docstring.endsWith(MARKER)).toBe(true)
  })

  it('a custom pattern added after indexing: the lines print, with the value redacted under it', () => {
    configure({})
    const { file, fn } = indexed(DOC)
    configure({ patterns: 'EMP-[0-9]{4,8}' })
    const out = printed(file, fn)
    expect(out).toContain('lead line')
    expect(out).toContain('badge [REDACTED:custom] issued')
    expect(out).not.toContain(BADGE)
  })

  it('a custom pattern removed after indexing: the lines print as written', () => {
    configure({ patterns: 'EMP-[0-9]{4,8}' })
    const { file, fn } = indexed(DOC)
    configure({})
    const out = printed(file, fn)
    expect(out).toContain('lead line')
    expect(out).toContain(`badge ${BADGE} issued`)
    expect(out).not.toContain('[REDACTED:custom]')
  })

  it('a custom pattern swapped after indexing: the lines print, redacted by the new pattern only', () => {
    configure({ patterns: 'EMP-[0-9]{4,8}' })
    const { file, fn } = indexed(DOC)
    configure({ patterns: 'lead [a-z]+' })
    const out = printed(file, fn)
    expect(out).toContain('[REDACTED:custom]')
    expect(out).not.toContain('lead line')
    expect(out).toContain(`badge ${BADGE} issued`)
  })

  it('strict mode turned on after indexing: the lines print, with the token redacted', () => {
    configure({})
    const { file, fn } = indexed(DOC)
    configure({ strict: true })
    const out = printed(file, fn)
    expect(out).toContain('lead line')
    expect(out).toContain('token [REDACTED:high_entropy] issued')
    expect(out).not.toContain(STRICT_TOKEN)
  })

  it('strict mode turned off after indexing: the lines print as written', () => {
    configure({ strict: true })
    const { file, fn } = indexed(DOC)
    configure({})
    const out = printed(file, fn)
    expect(out).toContain(`token ${STRICT_TOKEN} issued`)
  })

  it('a doc comment edited after indexing prints nothing, whatever the settings', () => {
    configure({ patterns: 'EMP-[0-9]{4,8}' })
    const { file, fn } = indexed(DOC)
    writeFileSync(file, SOURCE(['edited lead line', ...DOC.slice(1)], fn), 'utf-8')
    expect(printed(file, fn)).toBe('')
    configure({})
    expect(printed(file, fn)).toBe('')
  })

  it('an under-cap doc comment still prints under changed settings', () => {
    configure({})
    const { file, fn } = indexed(DOC.slice(0, 5))
    configure({ patterns: 'EMP-[0-9]{4,8}' })
    const out = printed(file, fn)
    expect(out).toContain('badge [REDACTED:custom] issued')
  })
})

describe('storedDocstringBoundsDoc', () => {
  const live = DOC.join('\n')

  it('accepts a cut row redacted by an earlier build', () => {
    const redacted = live.replace(BADGE, '[REDACTED:custom]')
    expect(storedDocstringBoundsDoc(redacted.slice(0, CUT) + MARKER, live)).toBe(true)
  })

  it('accepts a row cut inside a placeholder', () => {
    const head = `lead line\nbadge ${BADGE} issued`.replace(BADGE, '[REDACTED:custom]')
    const cutAt = head.indexOf('[REDACTED:')
    for (const len of [1, 5, 10, 14]) expect(storedDocstringBoundsDoc(head.slice(0, cutAt + len) + MARKER, live)).toBe(true)
  })

  it('accepts a placeholder that replaced a whole run of lines', () => {
    const stored = ['lead line', '[REDACTED:private_key_block]', '[REDACTED:private_key_block]', ...DOC.slice(3)].join('\n')
    expect(storedDocstringBoundsDoc(stored, live)).toBe(true)
  })

  it('rejects a row whose plain lines differ from the file or whose line count does not line up', () => {
    const redacted = live.replace(BADGE, '[REDACTED:custom]')
    expect(storedDocstringBoundsDoc(`edited line\n${redacted.split('\n').slice(1).join('\n')}`, live)).toBe(false)
    expect(storedDocstringBoundsDoc(`${redacted}\nextra`, live)).toBe(false)
    expect(storedDocstringBoundsDoc(redacted.slice(0, CUT), live)).toBe(false)
    expect(storedDocstringBoundsDoc(`${redacted}\nextra${MARKER}`, live)).toBe(false)
  })

  it('rejects any mismatch for an under-cap doc', () => {
    expect(storedDocstringBoundsDoc('badge [REDACTED:custom] issued', `badge ${BADGE} issued`)).toBe(false)
    expect(storedDocstringBoundsDoc('same', 'same')).toBe(true)
  })
})
