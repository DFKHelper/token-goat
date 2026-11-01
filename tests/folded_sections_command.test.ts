/** A Read whose prose fold withholds paragraphs under several headings names one `section` command that returns every one of those sections whose heading holds no comma, and that command, run literally, gives back each withheld sentence. Fixture provenance: HAND-DERIVED. The markdown documents are synthetic prose written for this test, padded past the 8,000 B markdown floor with a fenced block and kept under OUTLINE_MIN_HEADINGS (6) headings so the prose fold, not the heading-tree outline, is what runs; the Read result shapes are the `cat -n` string the post-hook parses (compact layout) and Claude Code's `{type: 'text', file: {filePath, content, ...}}` object, which src/hooks_common.ts documents as CAPTURE from a recorded session corpus (aligned layout). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { UNQUOTABLE } from '../src/hint_suggestion_guard.js'
import type { HookEvent } from '../src/hook_registry.js'
import { postReadHandler } from '../src/hooks_read_post.js'
import { normalizePath } from '../src/paths.js'
import { runSection } from '../src/read_section.js'
import { clearModuleCaches } from '../src/reset.js'
import { POSIX_SH, POWERSHELL, powershellArgv, shArgv } from './helpers/shell_argv.js'

const tmpFiles: string[] = []

const FILLER = 'It then continues for a good while longer, restating the point in more detail than a reader scanning the document has any use for, which is exactly the text this fold exists to remove from the delivered output. '
const FIRST_MARKER = 'the first withheld sentence that only the first section holds'
const SECOND_MARKER = 'the second withheld sentence that only the second section holds'
const COMMA_MARKER = 'the withheld sentence that only the section with a comma in its heading holds'
const COLON_MARKER = 'the withheld sentence that only a section with `::` in its heading holds'
const SENTENCE = /to read (\d+) sections with folded paragraphs in one call/

function paragraph(marker: string): string {
  return `This opening sentence stays visible. ${FILLER.repeat(3)}${marker}.`
}

/** A markdown file holding `sections` as `## heading` / body pairs after a padding block, returned as its normalized path. */
function writeDoc(sections: readonly (readonly [string, string])[]): string {
  const pad = '```\n' + 'filler line to push the file size past the markdown size threshold\n'.repeat(160) + '```'
  const body = ['# Fixture Document', '', pad, '', ...sections.flatMap(([heading, text]) => [`## ${heading}`, '', text, '']), ''].join('\n')
  expect(Buffer.byteLength(body, 'utf-8')).toBeGreaterThan(8000)
  const file = path.join(os.tmpdir(), `tg-fold-sections-${process.pid}-${Math.random().toString(36).slice(2)}.md`)
  fs.writeFileSync(file, body)
  tmpFiles.push(file)
  return normalizePath(file)
}

function numbered(body: string): string {
  return body
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(6, ' ')}\t${l}`)
    .join('\n')
}

function postEvent(filePath: string, toolResponse: unknown): HookEvent {
  return { eventName: 'post_tool_use', toolName: 'Read', toolInput: { file_path: filePath }, sessionId: `fold-sections-${Math.random().toString(36).slice(2)}`, agentId: undefined, raw: { tool_response: toolResponse } }
}

function claudeCodeRead(filePath: string, body: string): unknown {
  const n = body.split('\n').length
  return { type: 'text', file: { filePath, content: body, numLines: n, startLine: 1, totalLines: n } }
}

/** The one-call command a hook output names, or null when it names none. */
function allSectionsCommand(out: unknown): string | null {
  const text = JSON.stringify(out)
  const at = SENTENCE.exec(text)?.index ?? -1
  if (at === -1) return null
  const m = /Run `token-goat section (.+?)` $/.exec(text.slice(Math.max(0, text.lastIndexOf('Run `token-goat section', at)), at))
  return m === null ? null : (JSON.parse(`"${m[1] ?? ''}"`) as string)
}

/** Run a printed `token-goat section "<spec>"` argument the way a shell would hand it over. */
function runPrinted(quoted: string): { text: string; code: number } {
  expect(quoted.startsWith('"') && quoted.endsWith('"'), `printed argument is double-quoted: ${quoted}`).toBe(true)
  return runSection({ spec: quoted.slice(1, -1) })
}

/** A document whose middle folded heading holds `$`, and the combined command its Read prints. */
function dollarDoc(): { file: string; dollarMarker: string; printed: string | null } {
  const dollarMarker = 'the withheld sentence that only the section with a dollar sign in its heading holds'
  const file = writeDoc([['First Section', paragraph(FIRST_MARKER)], ['Cost $5 Plan', paragraph(dollarMarker)], ['Second Section', paragraph(SECOND_MARKER)]])
  const out = postReadHandler(postEvent(file, numbered(fs.readFileSync(file, 'utf-8'))))
  expect(out.hookType).toBe('rewriteOutput')
  return { file, dollarMarker, printed: allSectionsCommand(out) }
}

describe('one command for every section a prose fold withheld paragraphs from', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  afterEach(() => {
    for (const f of tmpFiles.splice(0)) {
      try {
        fs.unlinkSync(f)
      } catch {
        // best effort
      }
    }
  })

  // Provenance: HAND-DERIVED (two plain headings written here; the combined spec is the two headings joined by a comma, in file order, as src/read_section.ts reads a comma list).
  it('names one command on a compact-layout Read, and that command returns both withheld sentences', () => {
    const file = writeDoc([['First Section', paragraph(FIRST_MARKER)], ['Second Section', paragraph(SECOND_MARKER)]])
    const out = postReadHandler(postEvent(file, numbered(fs.readFileSync(file, 'utf-8'))))
    expect(out.hookType).toBe('rewriteOutput')
    const rewritten = out.hookType === 'rewriteOutput' ? out.updatedOutput : ''
    expect(rewritten).not.toContain(FIRST_MARKER)
    expect(rewritten).not.toContain(SECOND_MARKER)
    const command = allSectionsCommand(out)
    expect(command, 'compact Read names one command for every folded section').toBe(`"${file}::First Section,Second Section"`)
    const result = runPrinted(command ?? '""')
    expect(result.code).toBe(0)
    expect(result.text).toContain(FIRST_MARKER)
    expect(result.text).toContain(SECOND_MARKER)
  })

  // Provenance: FORMAT-DERIVED (the aligned Read result is Claude Code's `{type: 'text', file: {...}}` object, documented in src/hooks_common.ts as CAPTURE from a recorded session corpus; the headings are written here).
  it('names the same command in the context of an aligned-layout (harness-numbered) Read', () => {
    const file = writeDoc([['First Section', paragraph(FIRST_MARKER)], ['Second Section', paragraph(SECOND_MARKER)]])
    const out = postReadHandler(postEvent(file, claudeCodeRead(file, fs.readFileSync(file, 'utf-8'))))
    expect(out.hookType).toBe('rewriteOutput')
    const context = (out as { context?: string }).context ?? ''
    expect(context, 'aligned Read context names one command for every folded section').toContain(`Run \`token-goat section "${file}::First Section,Second Section"\` to read 2 sections with folded paragraphs in one call.`)
  })

  // Provenance: HAND-DERIVED (a heading holding a comma, which src/read_section.ts would split into two names; the heading is written here).
  it('leaves a heading holding a comma to its own pointer and still names one command for the other folded sections', () => {
    const commaHeading = 'Launcher (in a script file, run by path)'
    const file = writeDoc([['First Section', paragraph(FIRST_MARKER)], [commaHeading, paragraph(COMMA_MARKER)], ['Second Section', paragraph(SECOND_MARKER)]])
    const out = postReadHandler(postEvent(file, numbered(fs.readFileSync(file, 'utf-8'))))
    expect(out.hookType).toBe('rewriteOutput')
    const rewritten = out.hookType === 'rewriteOutput' ? out.updatedOutput : ''
    expect(rewritten).not.toContain(COMMA_MARKER)
    expect(rewritten, 'the comma heading keeps its own per-paragraph pointer').toContain(`token-goat section "${file}::${commaHeading}"`)
    expect(allSectionsCommand(out), 'a comma heading does not cancel the command for the other folded sections').toBe(`"${file}::First Section,Second Section"`)
    expect(rewritten).toContain('to read 2 sections with folded paragraphs in one call')
    const result = runPrinted(allSectionsCommand(out) ?? '""')
    expect(result.code).toBe(0)
    expect(result.text).toContain(FIRST_MARKER)
    expect(result.text).toContain(SECOND_MARKER)
  })

  // Provenance: HAND-DERIVED (the second section's body is one short line, below any paragraph fold, so one folded heading is left).
  it('names no combined command when only one section had a paragraph folded', () => {
    const file = writeDoc([['First Section', paragraph(FIRST_MARKER)], ['Second Section', 'Short tail content.']])
    const out = postReadHandler(postEvent(file, numbered(fs.readFileSync(file, 'utf-8'))))
    expect(out.hookType).toBe('rewriteOutput')
    expect(JSON.stringify(out)).toContain('rest of paragraph folded')
    expect(allSectionsCommand(out)).toBeNull()
  })

  // Provenance: HAND-DERIVED (one comma heading and one plain heading, written here, so one heading is left for the combined command).
  it('names no combined command when, past a heading holding a comma, which the comma form would split, one section remains', () => {
    const file = writeDoc([['First, Section', paragraph(FIRST_MARKER)], ['Second Section', paragraph(SECOND_MARKER)]])
    const out = postReadHandler(postEvent(file, numbered(fs.readFileSync(file, 'utf-8'))))
    expect(out.hookType).toBe('rewriteOutput')
    expect(JSON.stringify(out)).toContain('rest of paragraph folded')
    expect(allSectionsCommand(out)).toBeNull()
  })

  // Provenance: HAND-DERIVED (headings chosen so a `::` inside one would move the parser's last-separator split, read from src/read_commands.ts::findSpecSeparator).
  it('names no combined command when two `::` headings leave one plain heading, and keeps each `::` heading its own pointer', () => {
    const colonA = 'Config::Keys'
    const colonB = 'Cache::Layer'
    const file = writeDoc([[colonA, paragraph(FIRST_MARKER)], ['Plain Section', paragraph(SECOND_MARKER)], [colonB, paragraph(COLON_MARKER)]])
    const out = postReadHandler(postEvent(file, numbered(fs.readFileSync(file, 'utf-8'))))
    expect(out.hookType).toBe('rewriteOutput')
    const rewritten = out.hookType === 'rewriteOutput' ? out.updatedOutput : ''
    expect(rewritten, 'a `::` heading keeps its own per-paragraph pointer').toContain(`token-goat section "${file}::${colonA}"`)
    expect(rewritten, 'a `::` heading keeps its own per-paragraph pointer').toContain(`token-goat section "${file}::${colonB}"`)
    expect(allSectionsCommand(out), 'one plain heading left is fewer than two, so no combined command').toBeNull()
  })

  // Provenance: HAND-DERIVED (same heading shapes as the row above, with two plain headings left, so the combined command must name exactly those).
  it('names only the plain headings in the combined command when `::` headings sit between them', () => {
    const file = writeDoc([['Config::Keys', paragraph(FIRST_MARKER)], ['First Section', paragraph(SECOND_MARKER)], ['Cache::Layer', paragraph(COLON_MARKER)], ['Second Section', paragraph('the last withheld sentence, under the second plain heading')]])
    const out = postReadHandler(postEvent(file, numbered(fs.readFileSync(file, 'utf-8'))))
    expect(out.hookType).toBe('rewriteOutput')
    expect(allSectionsCommand(out), 'the combined command names the two plain headings and no `::` heading').toBe(`"${file}::First Section,Second Section"`)
    const result = runPrinted(allSectionsCommand(out) ?? '""')
    expect(result.code).toBe(0)
    expect(result.text).toContain(SECOND_MARKER)
    expect(result.text).toContain('the last withheld sentence, under the second plain heading')
  })

  // Provenance: FORMAT-DERIVED (single quotes keep `$` literal in bash, GNU Bash Reference Manual Edition 5.3 (18 May 2025) 3.1.2.2 "Single Quotes", https://www.gnu.org/software/bash/manual/html_node/Single-Quotes.html, and in PowerShell, about_Quoting_Rules "Single-quoted strings" (PowerShell 7.5, ms.date 2024-09-09), https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules?view=powershell-7.5; both read 2026-10-31, and the two oracle rows below also run the printed line through real bash and PowerShell via tests/helpers/shell_argv.ts). The line must run and return every section.
  it('prints a single-quoted combined command that runs when a folded heading holds a dollar sign', () => {
    const { file, dollarMarker, printed } = dollarDoc()
    expect(printed, 'the dollar-sign heading still joins the combined command').toBe(`'${file}::First Section,Cost $5 Plan,Second Section'`)
    const spec = (printed ?? '').slice(1, -1)
    const result = runSection({ spec })
    expect(result.code).toBe(0)
    expect(result.text).toContain(FIRST_MARKER)
    expect(result.text).toContain(dollarMarker)
    expect(result.text).toContain(SECOND_MARKER)
  })

  it.skipIf(POSIX_SH === null)('a POSIX shell hands the dollar-sign combined command its spec unchanged', () => {
    const { file, printed } = dollarDoc()
    expect(shArgv(POSIX_SH!, `token-goat section ${printed ?? '""'}`), 'bash keeps the single-quoted spec literal').toEqual(['section', `${file}::First Section,Cost $5 Plan,Second Section`])
  })

  it.skipIf(POWERSHELL === null)('PowerShell hands the dollar-sign combined command its spec unchanged', () => {
    const { file, printed } = dollarDoc()
    expect(powershellArgv(POWERSHELL!, `token-goat section ${printed ?? '""'}`), 'PowerShell keeps the single-quoted spec literal').toEqual(['section', `${file}::First Section,Cost $5 Plan,Second Section`])
  })

  // Provenance: HAND-DERIVED (a backtick in a heading: quotedArg single-quotes it, and leadWithCommand's backtick fence (src/hint_suggestion_guard.ts::fencedCommand) would close at it, so relay.ts's stripUnsafeSuggestions swaps the whole combined command for a "command omitted" placeholder).
  it('leaves a heading holding a backtick to its own pointer and keeps it out of the fenced combined command', () => {
    const tickHeading = 'Using `config`'
    const tickMarker = 'the withheld sentence that only the section with a backtick in its heading holds'
    const file = writeDoc([['First Section', paragraph(FIRST_MARKER)], [tickHeading, paragraph(tickMarker)], ['Second Section', paragraph(SECOND_MARKER)]])
    const out = postReadHandler(postEvent(file, numbered(fs.readFileSync(file, 'utf-8'))))
    expect(out.hookType).toBe('rewriteOutput')
    const rewritten = out.hookType === 'rewriteOutput' ? out.updatedOutput : ''
    expect(rewritten).not.toContain(tickMarker)
    expect(rewritten, 'the backtick heading keeps its own per-paragraph pointer').toContain(`token-goat section '${file}::${tickHeading}'`)
    expect(allSectionsCommand(out), 'a backtick heading stays out of the backtick-fenced combined command').toBe(`"${file}::First Section,Second Section"`)
    const result = runPrinted(allSectionsCommand(out) ?? '""')
    expect(result.code).toBe(0)
    expect(result.text).toContain(FIRST_MARKER)
    expect(result.text).toContain(SECOND_MARKER)
  })

  // Provenance: HAND-DERIVED (a backtick in the file's own path reaches the spec whatever the headings are, so no heading skip can keep it out of the fence).
  it('names no combined command when the file path itself holds a backtick', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-tick`dir-'))
    const src = writeDoc([['First Section', paragraph(FIRST_MARKER)], ['Second Section', paragraph(SECOND_MARKER)]])
    const file = normalizePath(path.join(dir, 'doc.md'))
    fs.writeFileSync(file, fs.readFileSync(src, 'utf-8'))
    try {
      const out = postReadHandler(postEvent(file, numbered(fs.readFileSync(file, 'utf-8'))))
      expect(out.hookType).toBe('rewriteOutput')
      expect(JSON.stringify(out)).toContain('rest of paragraph folded')
      expect(JSON.stringify(out), 'a backtick path leaves no combined command to be cut out of its fence').not.toMatch(SENTENCE)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // Provenance: HAND-DERIVED (a heading holding an apostrophe and a dollar sign, which no quote mark holds: canQuoteArg("it's $5") is false, pinned in tests/suggestion_single_quoted_args.test.ts).
  it('names the combined command for the quotable headings and delivers the paragraph under an unquotable heading whole', () => {
    const badHeading = "Costs $5 isn't"
    const badMarker = 'the withheld sentence under the heading no quote mark can hold'
    const file = writeDoc([['First Section', paragraph(FIRST_MARKER)], [badHeading, paragraph(badMarker)], ['Second Section', paragraph(SECOND_MARKER)]])
    const out = postReadHandler(postEvent(file, numbered(fs.readFileSync(file, 'utf-8'))))
    expect(out.hookType).toBe('rewriteOutput')
    const rewritten = out.hookType === 'rewriteOutput' ? out.updatedOutput : ''
    expect(allSectionsCommand(out), 'the combined command still names the two quotable headings').toBe(`"${file}::First Section,Second Section"`)
    expect(rewritten, 'the paragraph under the unquotable heading is delivered whole').toContain(badMarker)
    expect(rewritten, 'the quotable paragraphs are still folded').not.toContain(FIRST_MARKER)
    expect(JSON.stringify(out), 'no printed line holds the placeholder for an unquotable value').not.toContain(UNQUOTABLE)
    const result = runPrinted(allSectionsCommand(out) ?? '""')
    expect(result.code).toBe(0)
    expect(result.text).toContain(FIRST_MARKER)
    expect(result.text).toContain(SECOND_MARKER)
  })

  // Provenance: HAND-DERIVED (two sections share a heading, so the reader's ordinal form `Heading#N` (src/read_section.ts, ordinal spec) names each one; the command must run and return both).
  it('names each same-titled section by its ordinal, and that command returns every one of them', () => {
    const repeatMarker = 'the withheld sentence under the repeated heading'
    const file = writeDoc([['First Section', paragraph(FIRST_MARKER)], ['Second Section', paragraph(SECOND_MARKER)], ['First Section', paragraph(repeatMarker)]])
    const out = postReadHandler(postEvent(file, numbered(fs.readFileSync(file, 'utf-8'))))
    expect(out.hookType).toBe('rewriteOutput')
    expect(allSectionsCommand(out), 'each same-titled section keeps its own ordinal, in file order').toBe(`"${file}::First Section#1,Second Section,First Section#2"`)
    expect(JSON.stringify(out)).toContain('to read 3 sections with folded paragraphs in one call')
    const result = runPrinted(allSectionsCommand(out) ?? '""')
    expect(result.code).toBe(0)
    expect(result.text).toContain(FIRST_MARKER)
    expect(result.text).toContain(SECOND_MARKER)
    expect(result.text).toContain(repeatMarker)
  })
})
