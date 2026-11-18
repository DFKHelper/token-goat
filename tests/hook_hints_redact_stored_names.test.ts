/** The hints a hook prints, the fold notice a Read gets, `trace --bodies`, `answer` and the note anchor error all name something the index stored, and a stored name is file text: a TOML table, a JSON key, a heading or an identifier can itself be a credential. Each row drives the real path over a really indexed scratch file and asserts the credential never reaches the output. Fixture provenance: HAND-DERIVED, the key is the documented Anthropic shape (sk-ant-api03- plus 40 characters) and the token the GitHub shape (ghp_ plus 36 alphanumerics) from the pattern table in src/secret_redact.ts, placed by hand as a TOML table header, a JSON key, a heading and TypeScript identifiers; the filler around them is synthetic. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidateConfigCache } from '../src/config.js'
import { globalDbPath } from '../src/constants.js'
import { dispatchFileTypeHandler } from '../src/hints/file_type_handler.js'
import { escapeHintName, hintTarget, hintTargetFromNames } from '../src/hint_target.js'
import { preReadHandler } from '../src/hooks_read.js'
import { postReadHandler } from '../src/hooks_read_post.js'
import { indexFileSync } from '../src/parser.js'
import { clearModuleCaches } from '../src/reset.js'
import { makeHookEvent } from './helpers/hook-event.js'

const ANT = 'sk-ant-api03-' + 'a'.repeat(40)
const GHP = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'

const tmpDirs: string[] = []

function scratch(name: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hint-names-redact-'))
  tmpDirs.push(dir)
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, body, 'utf8')
  return filePath
}

/** `count` one-line TypeScript functions after `lead`, sized past the 50,000-byte first-read threshold and under the 100,000-byte generic large-file gate. */
function bigModule(lead: string[], count = 1200): string {
  const lines = [...lead]
  for (let i = 0; i < count; i++) lines.push(`export function alphaEntry${i}(value: number): number { return value + ${i} }`)
  return lines.join('\n') + '\n'
}

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  vi.unstubAllEnvs()
  invalidateConfigCache()
  clearModuleCaches()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function setPolicy(policy: 'warn' | 'deny' | 'off'): void {
  vi.stubEnv('TOKEN_GOAT_FIRST_READ_SYMBOL_POLICY', policy)
  invalidateConfigCache()
}

/** The text a hook output hands the model, whichever channel it uses. */
function hookText(out: ReturnType<typeof preReadHandler>): string {
  if (out.hookType === 'deny') return out.message
  if (out.hookType === 'context') return out.context
  return ''
}

function firstRead(filePath: string): ReturnType<typeof preReadHandler> {
  return preReadHandler(makeHookEvent({ toolName: 'Read', toolInput: { file_path: filePath }, sessionId: `hint-names-${process.pid}-${Math.random().toString(36).slice(2)}` }))
}

describe('a hint never carries a credential-shaped stored name', () => {
  it('first_read_symbol_policy deny skips a secret-named first symbol for the next safe one', () => {
    setPolicy('deny')
    const filePath = scratch('big.ts', bigModule([`export function ${GHP}(): number { return 0 }`]))
    indexFileSync(filePath, globalDbPath())
    const text = hookText(firstRead(filePath))
    expect(text).toContain('Whole-file first read denied by first_read_symbol_policy')
    expect(text).not.toContain(GHP)
    expect(text).toContain('"alphaEntry0"')
  })

  it('a large markdown file lists a secret-named heading redacted and leads with the next safe one', () => {
    setPolicy('off')
    const sections: string[] = []
    for (let i = 0; i < 401; i++) sections.push(`## Section ${i}\n\nThis section describes step ${i} of the procedure in enough words to fill a line, then says why the step matters.\n`)
    const filePath = scratch('guide.md', `# ${ANT}\n\n## ${ANT} again\n\n` + sections.join('\n'))
    indexFileSync(filePath, globalDbPath())
    const text = hookText(firstRead(filePath))
    expect(text).toContain('Large markdown file')
    expect(text).not.toContain(ANT)
    expect(text).toContain('[REDACTED:anthropic_api_key]')
    expect(text).toContain('"Section 0"')
  })

  const LARGE_FILES: ReadonlyArray<{ name: string; file: string; body: () => string; plain: string }> = [
    { name: 'TOML tables', file: 'vault.toml', body: () => [`[${ANT}]`, 'note = "x"', ...Array.from({ length: 3400 }, (_, i) => `[plain_table_${i}]\nvalue = ${i}`)].join('\n') + '\n', plain: 'plain_table_0' },
    { name: 'JSON keys', file: 'vault.json', body: () => JSON.stringify({ [ANT]: 1, ...Object.fromEntries(Array.from({ length: 6000 }, (_, i) => [`plain_key_${i}`, i])) }), plain: 'plain_key_0' },
    { name: 'TypeScript functions', file: 'big.ts', body: () => bigModule([`export function ${GHP}(): number { return 0 }`], 1600), plain: 'alphaEntry0' },
  ]
  for (const c of LARGE_FILES) {
    it(`the large-file deny over ${c.name} carries no credential-shaped name`, () => {
      setPolicy('off')
      const filePath = scratch(c.file, c.body())
      expect(fs.statSync(filePath).size).toBeGreaterThan(100_000)
      indexFileSync(filePath, globalDbPath())
      const text = hookText(firstRead(filePath))
      expect(text.length).toBeGreaterThan(0)
      expect(text).not.toContain(ANT)
      expect(text).not.toContain(GHP)
      expect(text).toContain(c.plain)
    })
  }

  it('hintTarget and hintTargetFromNames fall back to the placeholder when every name is a secret', () => {
    const filePath = scratch('vault.toml', `[${ANT}]\nnote = "x"\n`)
    expect(hintTarget(filePath, 'section', { content: fs.readFileSync(filePath, 'utf8') }).real).toBe(false)
    expect(hintTargetFromNames([GHP], 'symbol').real).toBe(false)
    expect(hintTargetFromNames([GHP, 'plainFn'], 'symbol')).toMatchObject({ name: 'plainFn', real: true })
  })

  it('escapeHintName drops a secret name and keeps a plain one', () => {
    expect(escapeHintName(GHP)).toBe('')
    expect(escapeHintName(ANT)).toBe('')
    expect(escapeHintName('plainFn')).toBe('plainFn')
  })
})

/** Each listing the large-file handlers build from the file's own bytes: `lead` is the plain text that must survive, `secret` sits where the listing would show it. */
const LISTINGS: ReadonlyArray<{ name: string; file: string; body: () => string; lead: string }> = [
  { name: 'JSONL record keys', file: 'rows.jsonl', body: () => JSON.stringify({ plainKey: 1, [GHP]: 2 }) + '\n' + 'x'.repeat(21_000), lead: 'plainKey' },
  { name: 'CSV header', file: 'rows.csv', body: () => `plain_col,${GHP}\n` + '1,2\n'.repeat(4000), lead: 'plain_col' },
  { name: 'transcript speakers', file: 'talk.vtt', body: () => `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v ${GHP}>hello\n` + '\n00:00:03.000 --> 00:00:04.000\n<v Plain Speaker>hi\n'.repeat(400), lead: 'Plain Speaker' },
  { name: 'HTML title', file: 'page.html', body: () => `<html>\n<head><title>${GHP}</title></head>\n<body>\n<h1>Plain Heading</h1>\n${'<p>filler text for the page</p>\n'.repeat(2000)}</body></html>`, lead: 'Plain Heading' },
  { name: 'text preview', file: 'notes.txt', body: () => `Plain First Line\n${GHP}\n` + 'filler line of the notes file\n'.repeat(1000), lead: 'Plain First Line' },
  { name: 'SVG title', file: 'art.svg', body: () => `<svg><title>${GHP}</title><g id="plain_layer"></g>${'<path d="M0 0L1 1"/>'.repeat(600)}</svg>`, lead: 'plain_layer' },
]

describe('a large-file listing never carries a credential-shaped name from the file', () => {
  for (const c of LISTINGS) {
    it(`the ${c.name} listing is redacted and the plain text survives`, () => {
      const body = c.body()
      const result = dispatchFileTypeHandler(path.join(os.tmpdir(), c.file), body)
      expect(result?.shouldBlock).toBe(true)
      expect(result?.message).not.toContain(GHP)
      expect(result?.message).toContain('[REDACTED:github_token]')
      expect(result?.message).toContain(c.lead)
    })
  }
})

const BODY_FILLER ='  const padding = "filler that exists only to push this fixture past the fold byte floor, and a skeleton that keeps it is not a skeleton"'

/** `count` functions of a 12-line body each, the first one named by `firstName`, as the Read tool's `cat -n` delivery. */
function foldableSource(firstName: string, count = 12): string {
  const fn = (name: string): string => [`export function ${name}(input: string, count: number): number {`, ...Array.from({ length: 12 }, () => BODY_FILLER), '  return input.length + count', '}'].join('\n')
  return [fn(firstName), ...Array.from({ length: count - 1 }, (_, i) => fn(`plainEntry${i}`))].join('\n') + '\n'
}

/** The rewritten text the real post-Read hook hands back for a source file, or '' when it declines to rewrite. */
function foldedText(body: string): string {
  const filePath = scratch('folded.ts', body)
  indexFileSync(filePath, globalDbPath())
  const numbered = body.split('\n').map((l, i) => `${String(i + 1).padStart(6, ' ')}\t${l}`).join('\n')
  const event = { eventName: 'post_tool_use', toolName: 'Read', toolInput: { file_path: filePath }, sessionId: `fold-names-${process.pid}-${Math.random().toString(36).slice(2)}`, agentId: undefined, raw: { tool_response: numbered } } as const
  const out = postReadHandler(event) as { hookType?: string; updatedOutput?: string } | null
  return out?.hookType === 'rewriteOutput' ? (out.updatedOutput ?? '') : ''
}

describe('a Read body fold never names a credential-shaped stored function', () => {
  beforeEach(() => {
    vi.stubEnv('TOKEN_GOAT_SKELETON_LARGE_SOURCES', '1')
  })

  it('folds a file whose first function has a plain name, so the next row is not declined for another reason', () => {
    const text = foldedText(foldableSource('plainFirst'))
    expect(text).not.toBe('')
    expect(text).toContain('plainFirst')
  })

  it('declines to fold a file holding a secret-named function, so no fold notice can name it', () => {
    const text = foldedText(foldableSource(GHP))
    expect(text).not.toContain(GHP)
    expect(text).toBe('')
  })
})
