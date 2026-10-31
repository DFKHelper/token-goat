/** A Read whose prose fold withholds paragraphs under several headings names one `section` command that returns every one of those sections whose heading holds no comma, and that command, run literally, gives back each withheld sentence. Fixture provenance: HAND-DERIVED. The markdown documents are synthetic prose written for this test, padded past the 8,000 B markdown floor with a fenced block and kept under OUTLINE_MIN_HEADINGS (6) headings so the prose fold, not the heading-tree outline, is what runs; the Read result shapes are the `cat -n` string the post-hook parses (compact layout) and Claude Code's `{type: 'text', file: {filePath, content, ...}}` object, which src/hooks_common.ts documents as CAPTURE from a recorded session corpus (aligned layout). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { postReadHandler } from '../src/hooks_read_post.js'
import { normalizePath } from '../src/paths.js'
import { runSection } from '../src/read_section.js'
import { clearModuleCaches } from '../src/reset.js'

const tmpFiles: string[] = []

const FILLER = 'It then continues for a good while longer, restating the point in more detail than a reader scanning the document has any use for, which is exactly the text this fold exists to remove from the delivered output. '
const FIRST_MARKER = 'the first withheld sentence that only the first section holds'
const SECOND_MARKER = 'the second withheld sentence that only the second section holds'
const COMMA_MARKER = 'the withheld sentence that only the section with a comma in its heading holds'
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

  it('names the same command in the context of an aligned-layout (harness-numbered) Read', () => {
    const file = writeDoc([['First Section', paragraph(FIRST_MARKER)], ['Second Section', paragraph(SECOND_MARKER)]])
    const out = postReadHandler(postEvent(file, claudeCodeRead(file, fs.readFileSync(file, 'utf-8'))))
    expect(out.hookType).toBe('rewriteOutput')
    const context = (out as { context?: string }).context ?? ''
    expect(context, 'aligned Read context names one command for every folded section').toContain(`Run \`token-goat section "${file}::First Section,Second Section"\` to read 2 sections with folded paragraphs in one call.`)
  })

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

  it('names no combined command when only one section had a paragraph folded', () => {
    const file = writeDoc([['First Section', paragraph(FIRST_MARKER)], ['Second Section', 'Short tail content.']])
    const out = postReadHandler(postEvent(file, numbered(fs.readFileSync(file, 'utf-8'))))
    expect(out.hookType).toBe('rewriteOutput')
    expect(JSON.stringify(out)).toContain('rest of paragraph folded')
    expect(allSectionsCommand(out)).toBeNull()
  })

  it('names no combined command when, past a heading holding a comma, which the comma form would split, one section remains', () => {
    const file = writeDoc([['First, Section', paragraph(FIRST_MARKER)], ['Second Section', paragraph(SECOND_MARKER)]])
    const out = postReadHandler(postEvent(file, numbered(fs.readFileSync(file, 'utf-8'))))
    expect(out.hookType).toBe('rewriteOutput')
    expect(JSON.stringify(out)).toContain('rest of paragraph folded')
    expect(allSectionsCommand(out)).toBeNull()
  })
})
