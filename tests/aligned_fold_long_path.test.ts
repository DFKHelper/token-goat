/** An aligned-layout (harness-numbered) prose fold survives a long absolute path. The path is printed once per pointer and once in the combined command, so a long temp directory (macOS puts one under /private/var/folders) used to push the net saving of a two-paragraph fold under the net-benefit floor and the hook passed on that platform alone. Fixture provenance: HAND-DERIVED (the document and headings are written here; the path is padded to a fixed length so the row does not depend on the platform's temp directory). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { postReadHandler } from '../src/hooks_read_post.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'

const FILLER = 'It then continues for a good while longer, restating the point in more detail than a reader scanning the document has any use for, which is exactly the text this fold exists to remove from the delivered output. '
const TARGET_PATH_LENGTH = 112
const roots: string[] = []

function paragraph(marker: string): string {
  return `This opening sentence stays visible. ${FILLER.repeat(3)}${marker}.`
}

/** A two-section markdown file whose normalized path is `TARGET_PATH_LENGTH` characters long (a longer temp directory is left as it is). */
function writeDocAtLongPath(): string {
  const pad = '```\n' + 'filler line to push the file size past the markdown size threshold\n'.repeat(160) + '```'
  const body = ['# Fixture Document', '', pad, '', '## First Section', '', paragraph('the first withheld sentence that only the first section holds'), '', '## Second Section', '', paragraph('the second withheld sentence that only the second section holds'), ''].join('\n')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-aligned-long-'))
  roots.push(root)
  const fixed = normalizePath(path.join(root, 'x', 'doc.md')).length
  const dir = path.join(root, 'x'.repeat(Math.max(1, TARGET_PATH_LENGTH - fixed + 1)))
  fs.mkdirSync(dir)
  const file = path.join(dir, 'doc.md')
  fs.writeFileSync(file, body)
  return normalizePath(file)
}

describe('an aligned-layout prose fold with a long absolute path', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
  })

  // Provenance: HAND-DERIVED (two paragraphs of about 700 bytes each fold to one sentence plus a pointer; at a 112-character path the pointers and the combined command leave a net saving near 140 bytes against the 100-byte floor, so the fold is delivered).
  it('still delivers the fold and names both sections in one command', () => {
    const file = writeDocAtLongPath()
    expect(file.length, 'the fixture path is the length this row is sized for (or longer, when the temp directory already is)').toBeGreaterThanOrEqual(TARGET_PATH_LENGTH)
    const body = fs.readFileSync(file, 'utf-8')
    const n = body.split('\n').length
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: file },
      sessionId: `aligned-long-${Math.random().toString(36).slice(2)}`,
      agentId: undefined,
      raw: { tool_response: { type: 'text', file: { filePath: file, content: body, numLines: n, startLine: 1, totalLines: n } } },
    }
    const out = postReadHandler(event)
    expect(out.hookType, 'the fold is delivered, not declined').toBe('rewriteOutput')
    const context = (out as { context?: string }).context ?? ''
    expect(context).toContain(`token-goat section "${file}::First Section,Second Section"`)
  })
})
