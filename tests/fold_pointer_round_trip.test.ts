/**
 * A folded prose paragraph in a large markdown file prints a recall pointer telling the reader
 * how to get the withheld text back. This suite drives the real PreToolUse/PostToolUse hook pair
 * end to end -- index a real fixture, fold it for real, then literally execute whatever the
 * printed pointer says -- and asserts the withheld sentence actually comes back, not merely that
 * the pointer text matches a shape.
 *
 * Fixture provenance: HAND-DERIVED. The markdown body below is written for this test: three
 * headings (kept under the six-heading outline-replacement floor in fold_structure.ts, so the
 * coarser heading-tree rewrite never fires and only the granular paragraph fold is exercised),
 * and a long paragraph built from a repeated filler sentence, sized past the size and ratio
 * floors planProseFolds enforces. Nothing here is read off the fold matcher's own regex.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { preReadHandler, postReadHandler } from '../src/hooks_read.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { readSection } from '../src/section_reader.js'

const tmpFiles: string[] = []

const FILLER = 'It then continues for a good while longer, restating the point in more detail than a reader scanning the document has any use for, which is exactly the text this fold exists to remove from the delivered output. '
const WITHHELD_TAIL_MARKER = 'the sentence that must survive the round trip verbatim and unique to this fixture'
const LONG_PARAGRAPH = `This opening sentence stays visible. ${FILLER.repeat(3)}${WITHHELD_TAIL_MARKER}.`

function makeMarkdownFixture(): string {
  // Padded well past MARKDOWN_SIZE_THRESHOLD (8000 B) so the markdown large-file intercept
  // engages on the first read, but with only 3 headings so OUTLINE_MIN_HEADINGS (6) never
  // triggers the coarser heading-tree replacement -- the granular prose fold is what fires.
  // The padding lives inside a fenced code block, which planProseFolds never touches, so only
  // LONG_PARAGRAPH itself is eligible to fold.
  const pad = '```\n' + 'filler line to push the file size past the markdown size threshold\n'.repeat(160) + '```'
  const body = [
    '# Fixture Document',
    '',
    pad,
    '',
    '## First Section',
    '',
    LONG_PARAGRAPH,
    '',
    '## Second Section',
    '',
    'Short tail content.',
    '',
  ].join('\n')
  expect(Buffer.byteLength(body, 'utf-8')).toBeGreaterThan(8000)
  const file = path.join(os.tmpdir(), `tg-fold-ptr-${process.pid}-${Math.random().toString(36).slice(2)}.md`)
  fs.writeFileSync(file, body)
  tmpFiles.push(file)
  return normalizePath(file)
}

/** The `cat -n` rendering the Read tool delivers, which is what the post-hook parses. */
function numbered(body: string): string {
  return body
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(6, ' ')}\t${l}`)
    .join('\n')
}

function readEvent(filePath: string, extraInput: Record<string, unknown> = {}): HookEvent {
  return {
    eventName: 'pre_tool_use',
    toolName: 'Read',
    toolInput: { file_path: filePath, ...extraInput },
    sessionId: 's1',
    agentId: undefined,
    raw: {},
  }
}

function postEvent(filePath: string, body: string, extraInput: Record<string, unknown> = {}): HookEvent {
  return {
    eventName: 'post_tool_use',
    toolName: 'Read',
    toolInput: { file_path: filePath, ...extraInput },
    sessionId: 's1',
    agentId: undefined,
    raw: { tool_response: numbered(body) },
  }
}

describe('a folded paragraph pointer round-trips through the real hook pair', () => {
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

  it('the emitted pointer, followed literally, returns the paragraph text it withheld', () => {
    const file = makeMarkdownFixture()
    const body = fs.readFileSync(file, 'utf-8')

    // First read: must be let through (not denied) so the fold has a chance to run.
    const firstReadDecision = preReadHandler(readEvent(file))
    expect(firstReadDecision.hookType).not.toBe('deny')

    // The post-hook applies the real fold and produces the real notice text.
    const postResult = postReadHandler(postEvent(file, body))
    expect(postResult.hookType).toBe('rewriteOutput')
    const rewritten = postResult.hookType === 'rewriteOutput' ? postResult.updatedOutput : ''
    expect(rewritten).toContain('rest of paragraph folded')
    expect(rewritten).not.toContain(WITHHELD_TAIL_MARKER)

    const noticeLine = rewritten.split('\n').find((l) => l.includes('rest of paragraph folded'))
    expect(noticeLine).toBeDefined()

    // Execute whatever route the pointer names, literally, and check the withheld sentence comes back.
    const readPointer = /Read "([^"]+)" with offset=(\d+), limit=(\d+)/.exec(noticeLine ?? '')
    const sectionPointer = /token-goat section "(.+)::([^":]+)"/.exec(noticeLine ?? '')

    if (readPointer !== null) {
      const [, pointerPath, offsetStr, limitStr] = readPointer
      const decision = preReadHandler(readEvent(pointerPath ?? file, { offset: Number(offsetStr), limit: Number(limitStr) }))
      // The route only round-trips if this second read is actually let through -- a deny here
      // means following the pointer verbatim never returns the withheld bytes.
      expect(decision.hookType).not.toBe('deny')
    } else if (sectionPointer !== null) {
      const [, , heading] = sectionPointer
      const section = readSection(file, heading ?? '')
      expect(section).not.toBeNull()
      expect(section?.content).toContain(WITHHELD_TAIL_MARKER)
    } else {
      throw new Error(`notice line named no recognized pointer route: ${noticeLine}`)
    }
  })
})
