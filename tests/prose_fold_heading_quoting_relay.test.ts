/** A Markdown Read's per-paragraph `token-goat section` pointer, driven end to end through relay.ts::relayInProcess (the hook entry, with stripUnsafeSuggestions applied as on the wire), for headings whose quoting is hard: one no quote mark can hold, and one single quotes hold. Fixture provenance: HAND-DERIVED. The documents are synthetic prose padded past the 8,000 B markdown floor with a fenced block and kept under the heading-tree outline's 6-heading floor, as tests/folded_sections_command.test.ts builds them; the Read result shapes are the `cat -n` string the post-hook parses (compact layout) and Claude Code's `{type: 'text', file: {filePath, content, ...}}` object, which src/hooks_common.ts documents as CAPTURE from a recorded session corpus (aligned layout). No clearModuleCaches here: it runs hook_registry.ts::clearHooks, which empties the registry that relay.ts's import side effects filled once, and the relay then answers every call with `{}`. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { UNQUOTABLE } from '../src/hint_suggestion_guard.js'
import { normalizePath } from '../src/paths.js'
import { runSection } from '../src/read_section.js'
import { relayInProcess } from '../src/relay.js'
import { POSIX_SH, shArgv } from './helpers/shell_argv.js'

const FILLER = 'It then continues for a good while longer, restating the point in more detail than a reader scanning the document has any use for, which is exactly the text this fold exists to remove from the delivered output. '
const FIRST_MARKER = 'the first withheld sentence that only the first section holds'
const SECOND_MARKER = 'the second withheld sentence that only the second section holds'

const dirs: string[] = []

function paragraph(marker: string): string {
  return `This opening sentence stays visible. ${FILLER.repeat(3)}${marker}.`
}

/** A markdown file holding `sections` as `## heading` / body pairs after a padding block, in a directory of its own, returned as its normalized path. */
function writeDoc(sections: readonly (readonly [string, string])[]): string {
  const pad = '```\n' + 'filler line to push the file size past the markdown size threshold\n'.repeat(160) + '```'
  const body = ['# Fixture Document', '', pad, '', ...sections.flatMap(([heading, text]) => [`## ${heading}`, '', text, '']), ''].join('\n')
  expect(Buffer.byteLength(body, 'utf-8')).toBeGreaterThan(8000)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fold-quoting-'))
  dirs.push(dir)
  const file = path.join(dir, 'doc.md')
  fs.writeFileSync(file, body)
  return normalizePath(file)
}

/** The wire text the relay hands back for a whole-file Read of `file` in the given layout. */
async function relayRead(file: string, layout: 'compact' | 'aligned'): Promise<string> {
  const body = fs.readFileSync(file, 'utf-8')
  const n = body.split('\n').length
  const numbered = body
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(6, ' ')}\t${l}`)
    .join('\n')
  const response = layout === 'compact' ? numbered : { type: 'text', file: { filePath: file, content: body, numLines: n, startLine: 1, totalLines: n } }
  const sessionId = `fold-quoting-${Math.random().toString(36).slice(2)}`
  return relayInProcess('post_tool_use', { session_id: sessionId, cwd: path.dirname(file), tool_name: 'Read', hook_event_name: 'PostToolUse', tool_input: { file_path: file }, tool_response: response })
}

describe('a per-paragraph section pointer through the relay', () => {
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  // Provenance: HAND-DERIVED (a heading holding a backtick and an apostrophe: quotedArg (src/hint_suggestion_guard.ts) needs single quotes for the backtick, and the apostrophe ends them, so no quote mark holds the spec).
  it.each(['compact', 'aligned'] as const)('delivers a paragraph under a heading no quote mark can hold whole on a %s-layout Read, and prints no placeholder command', async (layout) => {
    const marker = 'the withheld sentence under the heading no quote mark can hold'
    const file = writeDoc([['First Section', paragraph(FIRST_MARKER)], ["Don't use `x`", paragraph(marker)], ['Second Section', paragraph(SECOND_MARKER)]])
    const wire = await relayRead(file, layout)
    expect(wire, 'the relay rewrote the Read').toContain('rest of paragraph folded')
    expect(wire, 'no printed line holds the placeholder for an unquotable value').not.toContain(UNQUOTABLE)
    expect(wire, 'the paragraph under the unquotable heading is delivered whole').toContain(marker)
    expect(wire, 'the other paragraphs are still folded').not.toContain(FIRST_MARKER)
  })

  // Provenance: HAND-DERIVED (a backtick heading with no apostrophe, so quotedArg single-quotes it). A pin of current behaviour, not a regression guard for a fixed defect: it records what is observed end to end: relay.ts::safeSuggestions runs stripUnsafeSuggestions over a rewrite's out-of-band context only, never its updatedOutput, so the single-quoted pointer reaches the model as printed in both layouts.
  it.each(['compact', 'aligned'] as const)('keeps the single-quoted pointer of a backtick heading as printed on a %s-layout Read, and it runs', async (layout) => {
    const tickHeading = 'Using `config`'
    const tickMarker = 'the withheld sentence that only the section with a backtick in its heading holds'
    const file = writeDoc([['First Section', paragraph(FIRST_MARKER)], [tickHeading, paragraph(tickMarker)], ['Second Section', paragraph(SECOND_MARKER)]])
    const wire = await relayRead(file, layout)
    const pointer = `token-goat section '${file}::${tickHeading}'`
    expect(wire, 'the relay keeps the single-quoted backtick pointer as printed').toContain(pointer)
    expect(wire, 'the relay omits no command').not.toContain('command omitted')
    expect(wire, 'the paragraph is folded behind that pointer').not.toContain(tickMarker)
    if (POSIX_SH !== null) expect(shArgv(POSIX_SH, pointer), 'bash hands the single-quoted spec over literally').toEqual(['section', `${file}::${tickHeading}`])
    const result = runSection({ spec: `${file}::${tickHeading}` })
    expect(result.code).toBe(0)
    expect(result.text, 'the pointer returns the withheld sentence').toContain(tickMarker)
  })
})
