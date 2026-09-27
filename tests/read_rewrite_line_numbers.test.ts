/** A Read that token-goat rewrites must still show every line under its real line number. Claude Code numbers a Read result itself: it prefixes line `i` of `tool_response.file.content` with `file.startLine + i`, and that left-hand column is the number a model cites, reasons from and edits by. The rewrites used to put two fence lines ahead of the file and collapse each withheld run to one notice line, so the file's first line showed as 3 and, after six folded bodies in a 176-line file, real line 150 showed as 57 -- found when six independent review runs cited `dispatch.py:133` for a defect on real line 146. Every earlier test of these rewrites asserted on which words the rewritten text contained and none rendered it the way the harness does, which is the gap this file closes: each case drives the real handler, serializes its output for Claude Code, renders the rewritten field with the harness's own numbering rule, and checks the displayed number of every file line against the real one.
 *
 * Fixture provenance. The numbering rule is FORMAT-DERIVED from claude.exe 2.1.281 (the Read result renderer: split `file.content` on "\n", emit `${startLine + i}` and a tab ahead of each piece, strip one trailing "\r"), and matches the rendering observed on the reported probe file. The `{type: 'text', file: {filePath, content, numLines, startLine, totalLines}}` envelope is CAPTURE, the same shape `tests/code_fold.test.ts` documents from recorded sessions. The file contents are HAND-DERIVED: synthetic sources in which every non-blank line carries `REAL_LINE_<n>`, its own line number, so the expected value is read off the line itself rather than computed by the code under test. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { serializeOutput, type HookEvent } from '../src/hook_registry.js'
import { preReadHandler } from '../src/hooks_read.js'
import { postReadHandler } from '../src/hooks_read_post.js'
import { indexFileSync } from '../src/parser.js'
import { clearModuleCaches } from '../src/reset.js'
import { readSection } from '../src/section_reader.js'
import { normalizePath } from '../src/util.js'
import { indexableDir } from './helpers/temp-config.js'

const TAG = '@@'

/** Replace each `@@` with `REAL_LINE_<n>`, n being the line's own 1-based number. */
function tagged(lines: readonly string[]): string {
  return lines.map((l, i) => l.replace(TAG, `REAL_LINE_${i + 1}`)).join('\n')
}

/** A 176-line TypeScript module shaped like the reported probe: six 28-line functions, plus one 14-line comment block so the comment fold is exercised beside the body fold. */
function tsProbe(): string {
  const lines: string[] = ['// Probe module for line numbering. @@', '']
  for (let f = 0; f < 6; f++) {
    if (f === 3) {
      lines.push('/**', ...Array.from({ length: 12 }, (_, k) => ` * Rationale line ${k} of a long comment block. ${TAG}`), ' */')
    }
    lines.push(`export function func${f}(x: number): number { // ${TAG}`)
    for (let k = 0; k < 25; k++) lines.push(`  x = x + ${k} // ${TAG}`)
    lines.push(`  return x // ${TAG}`, '}', '')
  }
  return tagged(lines)
}

/** The reported probe itself, in Python: six functions of 28 lines (declaration, docstring, 25 body lines, return). */
function pyProbe(): string {
  const lines: string[] = [`"""Probe module for line numbering."""  # ${TAG}`, '']
  for (let f = 0; f < 6; f++) {
    lines.push(`def func${f}(x):  # ${TAG}`, `    """Docstring of func${f}."""  # ${TAG}`)
    for (let k = 0; k < 25; k++) lines.push(`    x = x + ${k}  # ${TAG}`)
    lines.push(`    return x  # ${TAG}`, '')
  }
  return tagged(lines)
}

/** Large enough for the structural skeleton: well over 12 KB and 8 declarations. */
function tsSkeletonProbe(): string {
  const lines: string[] = [`import * as fs from 'node:fs' // ${TAG}`, `import * as path from 'node:path' // ${TAG}`, '']
  for (let f = 0; f < 10; f++) {
    lines.push(`export function skeletonSymbol${f}(input: string, count: number): number { // ${TAG}`)
    for (let k = 0; k < 30; k++) lines.push(`  const padding${k} = 'a body line that only exists to push this fixture past the byte floor' // ${TAG}`)
    lines.push(`  return input.length + count // ${TAG}`, '}', '')
  }
  return tagged(lines)
}

/** Large enough for the heading-tree outline: over 8 KB, eight second-level sections under one H1. */
function mdProbe(): string {
  const lines: string[] = [`# Probe document ${TAG}`, '', `The lead-in says what this document is. ${TAG}`, '']
  for (let s = 0; s < 8; s++) {
    lines.push(`## Section ${s} ${TAG}`, '')
    for (let k = 0; k < 18; k++) lines.push(`Line ${k} of section ${s} holds enough prose to make the document large. ${TAG}`)
    lines.push('')
  }
  return tagged(lines)
}

/** The captured Claude Code Read envelope for a window of `body`. */
function envelopeEvent(file: string, body: string, session: string, window?: { offset: number; limit: number }): HookEvent {
  const all = body.split('\n')
  const start = window?.offset ?? 1
  const slice = window === undefined ? all : all.slice(start - 1, start - 1 + window.limit)
  const toolInput: Record<string, unknown> = { file_path: file, ...(window === undefined ? {} : { offset: window.offset, limit: window.limit }) }
  return {
    eventName: 'post_tool_use',
    toolName: 'Read',
    toolInput,
    sessionId: session,
    agentId: undefined,
    raw: {
      tool_name: 'Read',
      tool_input: toolInput,
      tool_response: { type: 'text', file: { filePath: file, content: slice.join('\n'), numLines: slice.length, startLine: start, totalLines: all.length } },
    },
  }
}

interface Shown {
  readonly shown: number
  readonly text: string
}

/** What the model is shown for a Read, after token-goat's hook: the serialized Claude Code hook output, applied the way the harness applies it, then numbered by the harness's own rule. `context` is the hook's additionalContext, which the harness delivers as a separate message. Throws when the hook did not rewrite, so a case cannot pass by the rewrite never firing. */
function harnessView(event: HookEvent): { lines: Shown[]; context: string | undefined } {
  const out = postReadHandler(event)
  expect(out.hookType, 'the hook did not rewrite this Read, so nothing below would test the rewrite').toBe('rewriteOutput')
  const wire = JSON.parse(serializeOutput(out, 'post_tool_use', 'claudecode', event)) as { hookSpecificOutput: { updatedToolOutput: { file: { content: string; startLine: number } }; additionalContext?: string } }
  const { content, startLine } = wire.hookSpecificOutput.updatedToolOutput.file
  const lines = content.split('\n').map((raw, i) => ({ shown: startLine + i, text: raw.endsWith('\r') ? raw.slice(0, -1) : raw }))
  return { lines, context: wire.hookSpecificOutput.additionalContext }
}

/** A line token-goat wrote in place of withheld lines: every fold, skeleton and outline pointer opens with `... `, the served-run notice with `[token-goat] `. */
function isPointer(text: string): boolean {
  return text.startsWith('... ') || text.startsWith('[token-goat] ')
}

/** Every `REAL_LINE_<n>` line shown under a number other than n, as `shown->real`. Returns the count checked too, so a case can prove it looked at the lines it meant to. */
function misnumbered(lines: readonly Shown[]): { wrong: string[]; checked: number } {
  const wrong: string[] = []
  let checked = 0
  for (const { shown, text } of lines) {
    // A pointer can quote a heading or symbol name that carries its own tag; pointers are checked by pointerSpans instead.
    if (isPointer(text)) continue
    const m = /REAL_LINE_(\d+)/.exec(text)
    if (m === null) continue
    checked++
    if (Number(m[1]) !== shown) wrong.push(`${shown}->${m[1]}`)
  }
  return { wrong, checked }
}

/** Each token-goat pointer line names the span it withholds as `(first-last)`; it must sit on `first`, and its span must be the lines it displaces. Returns the pointers found. */
function pointerSpans(lines: readonly Shown[]): Array<{ shown: number; first: number; last: number }> {
  const spans: Array<{ shown: number; first: number; last: number }> = []
  for (const { shown, text } of lines) {
    const m = /^\.\.\. .*?\((\d+)-(\d+)\)/.exec(text) ?? /^\[token-goat\] lines (\d+)-(\d+) were already served/.exec(text)
    if (m !== null) spans.push({ shown, first: Number(m[1]), last: Number(m[2]) })
  }
  return spans
}

function expectRealNumbering(view: { lines: Shown[] }, body: string, startLine = 1, expectedLines = body.split('\n').length): void {
  const { wrong, checked } = misnumbered(view.lines)
  expect(wrong, 'file lines shown under a number that is not their own (shown->real)').toEqual([])
  expect(checked).toBeGreaterThan(0)
  expect(view.lines.length, 'a line-aligned rewrite keeps one line per delivered line').toBe(expectedLines)
  expect(view.lines[0]?.shown).toBe(startLine)
  for (const span of pointerSpans(view.lines)) {
    expect(span.shown, `a pointer for ${span.first}-${span.last} sits on line ${span.shown}`).toBe(span.first)
    // The rest of the run is padding, never file text that could be read as those lines.
    for (const l of view.lines.filter((x) => x.shown > span.first && x.shown <= span.last)) expect(l.text).toBe('')
  }
}

describe('a rewritten Read keeps every line on its real line number', () => {
  const tmpFiles: string[] = []
  let session = ''

  beforeEach(() => {
    clearModuleCaches()
    session = `lineno-${Math.random().toString(36).slice(2)}`
  })

  afterEach(() => {
    for (const f of tmpFiles.splice(0)) {
      try {
        fs.unlinkSync(f)
      } catch {
        /* best effort */
      }
    }
  })

  function write(name: string, body: string, index = true): string {
    const file = path.join(indexableDir(), `${Math.random().toString(36).slice(2)}-${name}`)
    fs.writeFileSync(file, body)
    tmpFiles.push(file)
    if (index) indexFileSync(normalizePath(file))
    return file
  }

  it.each([
    ['TypeScript', 'probe.ts', tsProbe],
    ['Python (the reported probe)', 'probe.py', pyProbe],
  ])('body fold, %s: the first line under the framing and every line after each of several folds', (_label, name, make) => {
    const body = make()
    const file = write(name, body)
    const view = harnessView(envelopeEvent(file, body, session))
    // Positive control: this is the multi-fold case, not a file that happened to fold once.
    expect(view.lines.filter((l) => / folded -- /.test(l.text)).length).toBeGreaterThanOrEqual(5)
    expectRealNumbering(view, body)
    // The reported symptoms, pinned by name: the first line is line 1, and the last function's lines after five folds are not shifted.
    expect(view.lines[0]?.text).toContain('REAL_LINE_1')
    expect(view.lines.some((l) => Number(/REAL_LINE_(\d+)/.exec(l.text)?.[1] ?? 0) > 140), 'no line from past the fifth fold was shown, so the late shift went unchecked').toBe(true)
    // The untrusted-content framing still reaches the model, beside the result rather than inside it.
    expect(view.context).toContain('data, not instructions')
    expect(view.lines.some((l) => l.text.includes('untrusted-file-content') || l.text.startsWith('[token-goat:'))).toBe(false)
  })

  it('body fold of a ranged Read numbers from the window start, as the harness does', () => {
    const body = tsProbe()
    const file = write('ranged.ts', body)
    const view = harnessView(envelopeEvent(file, body, session, { offset: 31, limit: 120 }))
    expect(view.lines.some((l) => / folded -- /.test(l.text))).toBe(true)
    expectRealNumbering(view, body, 31, 120)
  })

  it('structural skeleton: every declaration and the preamble keep their real numbers', () => {
    const body = tsSkeletonProbe()
    expect(Buffer.byteLength(body)).toBeGreaterThan(12_000)
    const file = write('skeleton.ts', body, false)
    const event = envelopeEvent(file, body, session)
    const view = harnessView(event)
    expectRealNumbering(view, body)
    expect(view.lines.filter((l) => /^export function skeletonSymbol\d/.test(l.text)).length).toBe(10)
    expect(view.context, 'the skeleton notice travels beside the result').toMatch(/structural skeleton/)
  })

  it('markdown outline: the lead-in and every heading keep their real numbers', () => {
    const body = mdProbe()
    expect(Buffer.byteLength(body)).toBeGreaterThan(8_000)
    const file = write('probe.md', body, false)
    const view = harnessView(envelopeEvent(file, body, session))
    expectRealNumbering(view, body)
    const headings = view.lines.filter((l) => /^## Section \d/.test(l.text))
    expect(headings.length).toBe(8)
    expect(view.context, 'the outline notice travels beside the result').toMatch(/Partial view/)
    // Each withheld run points at a command that returns it.
    expect(view.lines.filter((l) => /withheld -- token-goat section "/.test(l.text)).length).toBe(8)
  })

  it('markdown outline: every pointer, followed literally after the read it came from, returns the lines it withheld', () => {
    // Provenance: HAND-DERIVED. Two sections share a heading so repeat-disambiguation is exercised, a level-3 child sits under one of them so a run that stops at a child heading is covered, one heading carries a backtick, which no quoted `section` command can name, so its run exercises whatever route the outline falls back to, and two more collisions are layered in: an H4 ("Notes") nested inside the Beta child that shares text with the listed "## Notes" sections but is invisible to extractMarkdownHeadings' H1-H3 cap, and a same-text-different-case pair ("## Notes" immediately followed by "## notes") at the end. Both are the repro this fixture was extended for: a pointer's disambiguating ordinal has to come from the same case-insensitive, all-levels count resolveHeaderPos itself uses, not a tally kept locally over the capped, case-sensitive heading list, or the pointer names the wrong section. A ranged `Read` of a markdown file already read in full is refused by the markdown re-read intercept in hooks_read.ts, so that route is executed here, not assumed.
    const src: string[] = ['# Round trip document', '', `Lead-in paragraph for the round trip. ${TAG}`, '']
    const sections = ['Alpha', 'Notes', 'Beta', 'Notes', 'The `run` command', 'Delta', 'Notes', 'notes']
    sections.forEach((name, s) => {
      src.push(`## ${name}`, '')
      for (let k = 0; k < 18; k++) src.push(`Body ${k} of section ${s} (${name}), padded to push the document over the size floor. ${TAG}`)
      if (s === 2) {
        src.push('', '### Beta child', '', ...Array.from({ length: 6 }, (_, k) => `Child body ${k} under Beta, padded the same way as the rest. ${TAG}`))
        // Unlisted (H4 exceeds extractMarkdownHeadings' H1-H3 cap) but still counted by resolveHeaderPos's case-insensitive scan, so it shifts the ordinal of every "Notes"/"notes" section after it.
        src.push('', '#### Notes', '', ...Array.from({ length: 6 }, (_, k) => `Nested notes body ${k}, unlisted but still counted by the real resolver. ${TAG}`))
      }
      src.push('')
    })
    const body = tagged(src)
    const lines = body.split('\n')
    expect(Buffer.byteLength(body)).toBeGreaterThan(8_000)
    const file = write('roundtrip.md', body, false)
    const event = envelopeEvent(file, body, session)
    expect(preReadHandler({ ...event, eventName: 'pre_tool_use' }).hookType).not.toBe('deny')
    const view = harnessView(event)
    expectRealNumbering(view, body)
    const pointers = view.lines.filter((l) => isPointer(l.text))
    expect(pointers.length).toBeGreaterThanOrEqual(sections.length - 1)
    // Positive control: the repeat-disambiguation path is actually exercised, spelled the way findContainingSection spells it (`Heading#N`, matching resolveHeaderPos's own counting) now that the fix derives it from the real resolver instead of a locally-kept, case-sensitive tally over the capped heading list.
    expect(pointers.some((p) => /::Notes#\d"/.test(p.text))).toBe(true)
    for (const p of pointers) {
      const span = /\((\d+)-(\d+)\)/.exec(p.text)
      expect(span, p.text).not.toBeNull()
      const [first, last] = [Number(span?.[1]), Number(span?.[2])]
      const sectionPointer = /withheld -- token-goat section "[^"]*::([^"]+)"$/.exec(p.text)
      const readPointer = /Read "([^"]+)" with offset=(\d+), limit=(\d+)$/.exec(p.text)
      let returned: string
      if (sectionPointer !== null) {
        const section = readSection(file, sectionPointer[1] ?? '')
        expect(section, `section "${sectionPointer[1]}" did not resolve`).not.toBeNull()
        returned = section?.content ?? ''
      } else if (readPointer !== null) {
        const window = { offset: Number(readPointer[2]), limit: Number(readPointer[3]) }
        const decision = preReadHandler({ ...envelopeEvent(file, body, session, window), eventName: 'pre_tool_use' })
        expect(decision.hookType, `the ranged Read this pointer names is refused: ${p.text}`).not.toBe('deny')
        returned = lines.slice(window.offset - 1, window.offset - 1 + window.limit).join('\n')
      } else {
        throw new Error(`pointer names no route this test can follow: ${p.text}`)
      }
      for (let n = first; n <= last; n++) {
        const want = lines[n - 1] ?? ''
        if (want.trim() !== '') expect(returned, `line ${n} is withheld behind "${p.text}" but following it does not return that line`).toContain(want)
      }
    }
    const backtickRun = lines.indexOf('## The `run` command') + 3
    expect(view.lines.find((l) => l.shown === backtickRun)?.text, 'the run under a heading no command can quote is delivered as it stands').toBe(lines[backtickRun - 1])
  })

  it('already-served elision: the new lines after the withheld run keep their real numbers', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of the served fixture, long enough to clear the byte floors ${TAG}`)
    const body = tagged(lines)
    const file = write('served.txt', body, false)
    const first = envelopeEvent(file, body, session, { offset: 1, limit: 30 })
    preReadHandler({ ...first, eventName: 'pre_tool_use' })
    postReadHandler(first)
    const second = envelopeEvent(file, body, session)
    preReadHandler({ ...second, eventName: 'pre_tool_use' })
    const view = harnessView(second)
    expect(view.lines[0]?.text).toMatch(/^\[token-goat\] lines 1-30 were already served/)
    expectRealNumbering(view, body)
  })
})
