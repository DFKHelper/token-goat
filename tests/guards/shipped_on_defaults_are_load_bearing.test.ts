/**
 * Every lever that ships ON must be exercised by at least one test that sets nothing.
 *
 * The gap this closes. Each read-shrinking lever has a dedicated test file, and every one of them
 * forces its own setting on in a `beforeEach`: `TOKEN_GOAT_OUTLINE_LARGE_DOCUMENTS = '1'`,
 * `TOKEN_GOAT_SKELETON_LARGE_SOURCES = '1'`, `TOKEN_GOAT_FOLD_COMMENT_BLOCKS = '1'`. That is correct
 * for what those files test, which is the behaviour of the lever. It leaves the shipped default
 * covered by nothing at all: the env var and the config default are two ways to reach the same
 * boolean, and a test that supplies one never observes the other. Verified rather than argued --
 * flipping `fold_prose_paragraphs` from true to false in src/config.ts, disabling a fold credited
 * with 43.4% of markdown read bytes, left the full suite at 596 files and 12,268 tests all passing.
 *
 * This is the injected-seam trap CLAUDE.md names, in the shape it takes for configuration rather than
 * for a callback: the test always supplies the dependency the shipping path omits. It is the same
 * failure that once let the worker drain the queue into a stub, with every worker test injecting its
 * own callback and the suite staying green while nothing wrote to the `symbols` table.
 *
 * Each case below asserts the product contract rather than the boolean. Reading a config value back
 * and comparing it to `true` restates the source; delivering a real file through the real hook with
 * nothing setting that lever, and finding the lever's own notice in what comes back, does not.
 *
 * Isolation: a case turns the OTHER levers off through the environment and leaves its own unset, so
 * the only thing that can produce its marker is the shipped default. Without that, a document large
 * enough for the heading tree also folds paragraphs, and either notice would satisfy a loose
 * assertion for the wrong reason.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { postReadHandler } from '../../src/hooks_read.js'
import type { HookEvent } from '../../src/hook_registry.js'

/**
 * Marker each lever prints, and the environment keys that must be silenced around it.
 *
 * Provenance: FORMAT-DERIVED. Every `marker` was read off the notice template in the producer's own
 * source at this revision, with the file and symbol named beside it, not recalled and not written
 * from what the matcher wanted to see. That distinction has already cost this repo a result once: a
 * prose-fold pattern written from memory as "N more lines of this paragraph folded" matches nothing
 * the code emits, so a replay counted every paragraph fold as a miss and reported a working lever as
 * dead. FORMAT-DERIVED is weaker than a capture: it proves agreement with that template, not that a
 * shipped build emits it. The built-bundle e2e tests cover the shipped-build half.
 */
const ENV_KEYS = [
  'TOKEN_GOAT_FOLD_CODE_BODIES',
  'TOKEN_GOAT_FOLD_COMMENT_BLOCKS',
  'TOKEN_GOAT_FOLD_PROSE_PARAGRAPHS',
  'TOKEN_GOAT_SKELETON_LARGE_SOURCES',
  'TOKEN_GOAT_OUTLINE_LARGE_DOCUMENTS',
] as const

describe('every lever that ships on is reachable without an environment override', () => {
  const tmpFiles: string[] = []
  const saved = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const k of ENV_KEYS) saved.set(k, process.env[k])
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved.get(k)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    for (const f of tmpFiles.splice(0)) {
      try {
        fs.unlinkSync(f)
      } catch {
        // A fixture the case already removed, or one a failing case never wrote. Cleanup must not turn a real failure into a second, noisier one.
      }
    }
  })

  /** Silence every lever except the one under test, which is left unset so it takes its shipped default. */
  function onlyDefault(under: (typeof ENV_KEYS)[number]): void {
    for (const k of ENV_KEYS) {
      if (k === under) delete process.env[k]
      else process.env[k] = '0'
    }
  }

  function write(ext: string, body: string): string {
    const file = path.join(os.tmpdir(), `tg-default-guard-${process.pid}-${Math.random().toString(36).slice(2)}${ext}`)
    fs.writeFileSync(file, body)
    tmpFiles.push(file)
    return file
  }

  /** The `cat -n` rendering the Read tool delivers, which is what the hook parses. */
  function numbered(body: string): string {
    return body
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(6, ' ')}\t${l}`)
      .join('\n')
  }

  function deliver(file: string, body: string): string {
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: file },
      sessionId: `default-guard-${Math.random().toString(36).slice(2)}`,
      agentId: undefined,
      raw: { tool_response: numbered(body) },
    }
    return JSON.stringify(postReadHandler(event))
  }

  it('folds a long comment block with nothing setting fold_comment_blocks', () => {
    onlyDefault('TOKEN_GOAT_FOLD_COMMENT_BLOCKS')
    const lines = ['export const BEFORE_THE_BLOCK = 1', '']
    // Comfortably past COMMENT_FOLD_MIN_BLOCK (12) so the case cannot fail on sitting one line under a floor it does not name.
    for (let i = 0; i < 24; i++) lines.push(`// Design rationale line ${i}, long enough to be worth folding but short of any other lever's floor.`)
    lines.push('', 'export const AFTER_THE_BLOCK = 2', '')
    const body = lines.join('\n')
    // Under SKELETON_MIN_BODY_BYTES (12,000), so the skeleton cannot be what produced a notice here even were its env key ignored.
    expect(Buffer.byteLength(body, 'utf-8')).toBeLessThan(12_000)

    const text = deliver(write('.ts', body), body)
    // Marker: commentFoldNotice, src/fold_delivery.ts.
    expect(text).toMatch(/more comment lines \(\d+-\d+\) folded/)
    // Must-not-drop: a fold keeps the block's opening lines and everything outside it. Without these, collapsing the file wholesale satisfies the line above.
    expect(text).toContain('BEFORE_THE_BLOCK')
    expect(text).toContain('AFTER_THE_BLOCK')
    expect(text).toContain('Design rationale line 0')
  })

  it('folds a long paragraph with nothing setting fold_prose_paragraphs', () => {
    onlyDefault('TOKEN_GOAT_FOLD_PROSE_PARAGRAPHS')
    // One opening sentence well clear of PROSE_FOLD_MIN_SENTENCE, then a remainder long enough that the sentence ends far inside PROSE_FOLD_MAX_KEEP_RATIO of the line.
    const paragraph =
      'The heading below exists only so this file parses as a document rather than as loose text. ' +
      'It continues with a great deal of further prose whose only job is to run the physical line well past the four hundred character floor the paragraph fold requires, so that the opening sentence is a small fraction of the whole and the fold has something substantial to withhold behind its pointer. '.repeat(3)
    const body = ['# Guard Fixture', '', paragraph, '', 'A short closing line the fold must leave alone.', ''].join('\n')
    // Under the 8,000 B document floor and short of six headings, so the heading tree cannot be what answered.
    expect(Buffer.byteLength(body, 'utf-8')).toBeLessThan(8_000)

    const text = deliver(write('.md', body), body)
    // Marker: proseFoldNotice, src/fold_delivery.ts.
    expect(text).toMatch(/rest of paragraph folded \(line \d+\)/)
    expect(text).toContain('Guard Fixture')
    expect(text).toContain('A short closing line the fold must leave alone.')
  })

  it('replaces a large source file with its skeleton with nothing setting skeleton_large_sources', () => {
    onlyDefault('TOKEN_GOAT_SKELETON_LARGE_SOURCES')
    const lines = ["import { helper } from './helper.js'", '']
    // SKELETON_MIN_SYMBOLS is 8; twelve leaves room for the gate to reject one or two without emptying the population.
    for (let f = 0; f < 12; f++) {
      lines.push(`export function declaredFunction${f}(n: number): number {`)
      for (let i = 0; i < 30; i++) lines.push(`  const padding${f}_${i} = n + ${i} // filler that carries the file past the byte floor`)
      lines.push('  return n', '}', '')
    }
    const body = lines.join('\n')
    // Past SKELETON_MIN_BODY_BYTES (12,000), which is the gate this case exists to reach.
    expect(Buffer.byteLength(body, 'utf-8')).toBeGreaterThan(12_000)

    const text = deliver(write('.ts', body), body)
    // Marker: the notice built in planSourceSkeleton, src/fold_structure.ts.
    expect(text).toContain('replaced with its structural skeleton')
    // Must-not-drop: a skeleton keeps the preamble and every declaration by name, and withholds bodies.
    expect(text).toContain('declaredFunction0')
    expect(text).toContain('declaredFunction11')
    expect(text).not.toContain('padding11_29')
  })

  it('replaces a large document with its heading tree with nothing setting outline_large_documents', () => {
    onlyDefault('TOKEN_GOAT_OUTLINE_LARGE_DOCUMENTS')
    const filler = 'Section body text repeated to carry this document past the byte floor the heading tree requires before it will replace anything. '.repeat(12)
    const headings = ['Introduction', 'Installation', 'Configuration', 'Commands', 'Troubleshooting', 'Contributing', 'Licence']
    const body = ['Lead-in prose that says what this document is, which the replacement keeps.', '', ...headings.map((h) => `## ${h}\n\n${filler}\n`)].join('\n')
    // Past the 8,000 B floor and the six-heading floor, which together are the gate this case exists to reach.
    expect(Buffer.byteLength(body, 'utf-8')).toBeGreaterThan(8_000)
    expect(headings.length).toBeGreaterThanOrEqual(6)

    const text = deliver(write('.md', body), body)
    // Marker: the two notices built in planDocumentOutline, src/fold_structure.ts. Either wording is a pass; which one fires depends on whether a lead-in survived, and that is not what this case is asserting.
    expect(text).toMatch(/replaced with its lead-in \(the content before its first section\) and a heading tree|replaced with a heading tree alone/)
    // Must-not-drop: the tree names every section, and the lead-in survives.
    expect(text).toContain('Lead-in prose that says what this document is')
    expect(text).toContain('Troubleshooting')
    // The bodies are what the replacement withholds; finding one means it delivered the document instead.
    expect(text).not.toContain('Section body text repeated to carry')
  })
})
