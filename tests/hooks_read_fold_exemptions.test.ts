/** A completed Read is left whole, with no paragraph fold and no partial view, where the reader would only fetch the withheld text again: a Claude Code memory note, a file in Claude Code's session temp tree (the scratchpad an agent writes its reports to), and a document under the 4,000 B the read hook first looks at a markdown file's structure (MARKDOWN_SIZE_THRESHOLD). Measured in session transcripts (findings_markers.md "9. LOW: paragraph folding"): 2 of 2 memory notes read through the Read tool came back with "... rest of paragraph folded" and were unfolded with `sed` in the very next call, and of two agent-written 18-26 KB scratchpad reports one was cut to its headings and fetched again with sed. PROVENANCE: the paths are FORMAT-DERIVED from claude.exe 2.1.296, which keeps memory under `<config dir>/projects/<project slug>/memory/` and joins `CLAUDE_CODE_TMPDIR` (or the system temp dir), `claude`, the project slug, the session id and `scratchpad` for the scratchpad; the Read envelope `{type: 'text', file: {content, startLine, ...}}` is the one Claude Code hands a PostToolUse hook. The documents are HAND-DERIVED prose. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { preReadHandler } from '../src/hooks_read.js'
import { postReadHandler } from '../src/hooks_read_post.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'

const HEADINGS = ['Introduction', 'Getting Started', 'Configuration', 'API Reference', 'Troubleshooting', 'Changelog']
const FILLER = 'This paragraph pads the section well past the byte floor the outline needs, repeating harmless prose that a reader of the outline would never need to see. '.repeat(10)
const LONG_PARAGRAPH = `The note opens with this sentence. ${'It goes on at length about the intake decision, restating the reasons in more detail than a skim would need, which is the text a paragraph fold withholds. '.repeat(6)}It ends on the one fact that matters later.`

/** Six sections past the 8,000 B floor: on a project path this is cut down to its lead-in and headings. */
function bigDoc(): string {
  const body = `# Notes\n\nA one-line lead-in.\n\n${HEADINGS.map((h) => `## ${h}\n\n${FILLER}\n`).join('\n')}`
  expect(Buffer.byteLength(body, 'utf-8')).toBeGreaterThan(8_000)
  return body
}

/** A short note: under the 4,000 B floor, with one paragraph long enough for the prose fold to take. */
function shortNote(): string {
  const body = `# Intake\n\n## Decision\n\n${LONG_PARAGRAPH}\n\n## Follow-up\n\nNothing else yet.\n`
  expect(Buffer.byteLength(body, 'utf-8')).toBeLessThan(4_000)
  return body
}

let root: string
const savedConfigDir = process.env['CLAUDE_CONFIG_DIR']
const savedTmpdir = process.env['CLAUDE_CODE_TMPDIR']

beforeEach(() => {
  clearModuleCaches()
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fold-exempt-')))
  process.env['CLAUDE_CONFIG_DIR'] = path.join(root, 'claude-config')
  delete process.env['CLAUDE_CODE_TMPDIR']
})

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = savedConfigDir
  if (savedTmpdir === undefined) delete process.env['CLAUDE_CODE_TMPDIR']
  else process.env['CLAUDE_CODE_TMPDIR'] = savedTmpdir
  fs.rmSync(root, { recursive: true, force: true })
})

function write(file: string, body: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  return normalizePath(file)
}

/** A whole-file Read as Claude Code completes it: the pre hook lets it through, then the post hook sees the numbered envelope. */
function readThrough(file: string, body: string): ReturnType<typeof postReadHandler> {
  const sessionId = `fold-exempt-${Math.random().toString(36).slice(2)}`
  const pre: HookEvent = { eventName: 'pre_tool_use', toolName: 'Read', toolInput: { file_path: file }, sessionId, agentId: undefined, raw: {} }
  expect(preReadHandler(pre).hookType).not.toBe('deny')
  const lines = body.split('\n')
  return postReadHandler({ eventName: 'post_tool_use', toolName: 'Read', toolInput: { file_path: file }, sessionId, agentId: undefined, raw: { tool_response: { type: 'text', file: { filePath: file, content: body, numLines: lines.length, startLine: 1, totalLines: lines.length } } } })
}

describe('reads the post-read folds leave whole', () => {
  it('cuts a large document in a project down to its headings, the control every case below is measured against', () => {
    const out = readThrough(write(path.join(root, 'project', 'docs', 'guide.md'), bigDoc()), bigDoc())
    expect(out.hookType).toBe('rewriteOutput')
    expect(out.hookType === 'rewriteOutput' ? out.updatedOutput : '').not.toContain('repeating harmless prose')
  })

  it('leaves a memory note whole, however large', () => {
    const file = write(path.join(root, 'claude-config', 'projects', 'C--Projects-shop', 'memory', 'project_intake.md'), bigDoc())
    expect(readThrough(file, bigDoc()).hookType).toBe('pass')
  })

  it('leaves a report in the session scratchpad whole', () => {
    const file = write(path.join(os.tmpdir(), 'claude', 'C--Projects-shop', '126db975-2a6b-4b59-b07e-c4549a8a2c24', 'scratchpad', 'findings_markers.md'), bigDoc())
    try {
      expect(readThrough(file, bigDoc()).hookType).toBe('pass')
    } finally {
      fs.rmSync(path.join(os.tmpdir(), 'claude'), { recursive: true, force: true })
    }
  })

  it('finds the scratchpad under CLAUDE_CODE_TMPDIR when the user moved Claude Code\'s temp root', () => {
    process.env['CLAUDE_CODE_TMPDIR'] = path.join(root, 'cc-tmp')
    const file = write(path.join(root, 'cc-tmp', 'claude', 'C--Projects-shop', 's1', 'scratchpad', 'report.md'), bigDoc())
    expect(readThrough(file, bigDoc()).hookType).toBe('pass')
  })

  it('leaves a document under the 4,000 B floor whole instead of folding its long paragraph', () => {
    const out = readThrough(write(path.join(root, 'project', 'notes', 'intake.md'), shortNote()), shortNote())
    expect(out.hookType === 'rewriteOutput' ? out.updatedOutput : '').not.toContain('rest of paragraph folded')
    expect(out.hookType).toBe('pass')
  })
})
