/** The combined `token-goat section` line of a Markdown Read in aligned layout, the one fold pointer the relay (relay.ts::relayInProcess, stripUnsafeSuggestions) reads: a heading holding U+FE0F (a variation selector the relay reads as unsafe and displaySafeText does not escape) or `$(` is left out of the combined command, so the relay never omits it. Fixture provenance: HAND-DERIVED (the unsafe characters are the ones stripUnsafeSuggestions in src/hint_suggestion_guard.ts names; the headings are written from that rule, not from the code under test). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { stripUnsafeSuggestions } from '../src/hint_suggestion_guard.js'
import { normalizePath } from '../src/paths.js'
import { relayInProcess } from '../src/relay.js'

const FILLER = 'It then continues for a good while longer, restating the point in more detail than a reader scanning the document has any use for, which is exactly the text this fold exists to remove from the delivered output. '
const FIRST_MARKER = 'the first withheld sentence that only the first section holds'
const SECOND_MARKER = 'the second withheld sentence that only the second section holds'
const VARIATION_SELECTOR_16 = String.fromCodePoint(0xfe0f)

const dirs: string[] = []

function paragraph(marker: string): string {
  return `This opening sentence stays visible. ${FILLER.repeat(3)}${marker}.`
}

/** A markdown file holding `sections` as `## heading` / body pairs after a padding block, in a directory of its own, returned as its normalized path. */
function writeDoc(sections: readonly (readonly [string, string])[]): string {
  const pad = '```\n' + 'filler line to push the file size past the markdown size threshold\n'.repeat(160) + '```'
  const body = ['# Fixture Document', '', pad, '', ...sections.flatMap(([heading, text]) => [`## ${heading}`, '', text, '']), ''].join('\n')
  expect(Buffer.byteLength(body, 'utf-8')).toBeGreaterThan(8000)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fold-relay-safe-'))
  dirs.push(dir)
  const file = path.join(dir, 'doc.md')
  fs.writeFileSync(file, body)
  return normalizePath(file)
}

/** Every string value in the relay's JSON reply, joined: the text the model reads, with JSON escaping removed so a `"` in a printed command is a `"`. */
function replyText(wire: string): string {
  const out: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(JSON.parse(wire))
  return out.join('\n')
}

/** The text the relay hands back for a whole-file Read of `file` in aligned layout (the harness numbers it from `file.content`). */
async function relayReadAligned(file: string): Promise<string> {
  const body = fs.readFileSync(file, 'utf-8')
  const n = body.split('\n').length
  const response = { type: 'text', file: { filePath: file, content: body, numLines: n, startLine: 1, totalLines: n } }
  const sessionId = `fold-relay-safe-${Math.random().toString(36).slice(2)}`
  return replyText(await relayInProcess('post_tool_use', { session_id: sessionId, cwd: path.dirname(file), tool_name: 'Read', hook_event_name: 'PostToolUse', tool_input: { file_path: file }, tool_response: response }))
}

describe('a combined section command the relay would strip', () => {
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  // Provenance: HAND-DERIVED (positive control: plain headings, so the combined command is printed and the relay passes it unchanged).
  it('prints the combined section command for plain headings, unchanged by the relay (positive control)', async () => {
    const file = writeDoc([['First Section', paragraph(FIRST_MARKER)], ['Second Section', paragraph(SECOND_MARKER)]])
    const wire = await relayReadAligned(file)
    expect(wire, 'the combined command names both headings').toContain(`token-goat section "${file}::First Section,Second Section"`)
    expect(stripUnsafeSuggestions(wire), 'the relay leaves every printed command unchanged').toBe(wire)
  })

  // Provenance: HAND-DERIVED (a heading holding U+FE0F, built with String.fromCodePoint(0xfe0f); the relay's CONTROL_OR_BIDI names it).
  it('names only the headings whose command survives when one holds U+FE0F, and the relay omits none', async () => {
    const file = writeDoc([['First Section', paragraph(FIRST_MARKER)], [`Overview${VARIATION_SELECTOR_16}`, paragraph('the withheld sentence under the variation-selector heading')], ['Second Section', paragraph(SECOND_MARKER)]])
    const wire = await relayReadAligned(file)
    expect(wire, 'the relay omits no command').not.toContain('command omitted')
    expect(wire, 'the combined command is dropped whole when one heading would be stripped').not.toContain(`${file}::First Section,`)
    expect(wire, 'the variation-selector heading is named by no combined command').not.toContain(',Overview')
  })

  // Provenance: HAND-DERIVED (a heading holding `$(`, which the relay strips in any quoting: a command substitution).
  it('names only the headings whose command survives when one holds `$(`, and the relay omits none', async () => {
    const file = writeDoc([['First Section', paragraph(FIRST_MARKER)], ['Run $(id) first', paragraph('the withheld sentence under the command-substitution heading')], ['Second Section', paragraph(SECOND_MARKER)]])
    const wire = await relayReadAligned(file)
    expect(wire, 'the relay omits no command').not.toContain('command omitted')
    expect(wire, 'the combined command is dropped whole when one heading would be stripped').not.toContain(`${file}::First Section,`)
    expect(wire, 'the command-substitution heading is named by no combined command').not.toContain(',Run $(id)')
  })

  // Provenance: HAND-DERIVED (a single surviving heading beside one holding U+FE0F: fewer than two survivors, so no combined command is printed and the relay omits none).
  it('prints no combined command and omits none when only one heading survives', async () => {
    const file = writeDoc([['First Section', paragraph(FIRST_MARKER)], [`Overview${VARIATION_SELECTOR_16}`, paragraph('the withheld sentence under the variation-selector heading')]])
    const wire = await relayReadAligned(file)
    expect(wire, 'the relay omits no command').not.toContain('command omitted')
    expect(wire, 'no combined command is printed for one surviving heading').not.toContain('sections with folded paragraphs in one call')
  })
})
