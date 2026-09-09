/**
 * Large-source structural-skeleton replacement coverage (hooks_read.ts foldSourceSkeleton).
 *
 * Fixture provenance: HAND-DERIVED. Every source body below is synthetic TypeScript/C# written for
 * this test, sized and shaped to sit either side of this feature's own thresholds; nothing in it is
 * read off the implementation under test, and the declaration lines the must-not-drop assertions
 * name are chosen from the fixture text rather than from anything the fold produces.
 *
 * The `N\tline` numbered rendering is FORMAT-DERIVED from the shape READ_NUMBERED_ROW_RE accepts
 * (the same `numbered` helper tests/hooks_read_markdown_outline.test.ts and tests/code_fold.test.ts
 * use), which is the Read tool's own `cat -n` delivery shape, not this fold's output shape.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { BUNDLE } from './helpers/bundle.js'

import { postReadHandler } from '../src/hooks_read.js'
import { normalizePath } from '../src/util.js'
import { getFileServedOutputs } from '../src/session.js'
import { getBashOutput } from '../src/bash_output_cache.js'
import { getDb } from '../src/db.js'
import { globalDbPath } from '../src/constants.js'
import type { HookEvent } from '../src/hook_registry.js'

describe('large-source structural-skeleton replacement on the real Read hook path', () => {
  const tmpFiles: string[] = []
  const prevFlag = process.env['TOKEN_GOAT_SKELETON_LARGE_SOURCES']

  const IMPORT_LINES = [
    "import * as fs from 'node:fs'",
    "import * as path from 'node:path'",
    "import { createHash } from 'node:crypto'",
    "import { fileURLToPath } from 'node:url'",
  ]
  /** The one string that must NOT survive a fold: it is body text and nothing else. */
  const BODY_FILLER =
    '  const padding = "this body line exists only to push the fixture past the byte floor, and a skeleton that keeps it is not a skeleton"'

  function declLine(i: number): string {
    return `export function fixtureSymbol${i}(input: string, count: number): number {`
  }

  /** One function: a declaration line, `bodyLines` of filler, a return, a closing brace. */
  function fn(i: number, bodyLines: number): string {
    return [declLine(i), ...Array.from({ length: bodyLines }, () => BODY_FILLER), '  return input.length + count', '}'].join('\n')
  }

  /** A TypeScript file with four imports and `count` top-level functions. */
  function tsFile(count: number, bodyLines: number): string {
    return `${IMPORT_LINES.join('\n')}\n\n${Array.from({ length: count }, (_, i) => fn(i, bodyLines)).join('\n\n')}\n`
  }

  function writeSource(body: string, ext: string): string {
    const file = path.join(os.tmpdir(), `tg-skeleton-${process.pid}-${Math.random().toString(36).slice(2)}${ext}`)
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

  function postEvent(file: string, body: string, extraInput: Record<string, unknown> = {}): HookEvent {
    return {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: file, ...extraInput },
      sessionId: `skeleton-${Math.random().toString(36).slice(2)}`,
      agentId: undefined,
      raw: { tool_response: numbered(body) },
    }
  }

  /** The rewritten body text a `rewriteOutput` hook result carries, or '' for any other hookType. */
  function rewrittenText(out: unknown): string {
    const o = out as { hookType?: string; updatedOutput?: string }
    return o.hookType === 'rewriteOutput' ? (o.updatedOutput ?? '') : ''
  }

  beforeEach(() => {
    process.env['TOKEN_GOAT_SKELETON_LARGE_SOURCES'] = '1'
  })

  afterEach(() => {
    if (prevFlag === undefined) delete process.env['TOKEN_GOAT_SKELETON_LARGE_SOURCES']
    else process.env['TOKEN_GOAT_SKELETON_LARGE_SOURCES'] = prevFlag
    for (const f of tmpFiles.splice(0)) {
      try {
        fs.unlinkSync(f)
      } catch {
        /* best effort */
      }
    }
  })

  it('replaces a large untargeted source read with its imports and every declaration, dropping the bodies', () => {
    const body = tsFile(12, 12)
    expect(Buffer.byteLength(numbered(body), 'utf-8')).toBeGreaterThan(12_000)
    const file = writeSource(body, '.ts')
    const text = rewrittenText(postReadHandler(postEvent(file, body)))

    // Must-not-drop, named line by line rather than as a ratio: a fold that over-collapsed would
    // score BETTER on any size assertion while losing the exact thing the skeleton exists to keep.
    for (const imp of IMPORT_LINES) expect(text).toContain(imp)
    for (let i = 0; i < 12; i++) expect(text).toContain(declLine(i))
    // The bodies do not survive: that is the whole point of the replacement.
    expect(text).not.toContain(BODY_FILLER)
    // The recall command is exact and copy-pasteable, per symbol, and carries the @LINE anchor that picks out this declaration: without it a file holding two symbols of the same name emits two byte-identical commands, and running either lands on the ambiguity error instead of a body. The line number is matched as a digit rather than pinned, since it is a property of the fixture builder and not of the contract under test.
    const recall = text.split('\n').find((l) => l.includes('::fixtureSymbol3@'))
    expect(recall, 'no anchored recall command for fixtureSymbol3').toBeDefined()
    expect(recall).toContain(`token-goat read "${normalizePath(file)}::fixtureSymbol3@`)
    expect(recall).toMatch(/::fixtureSymbol3@\d+"/)
    // And the whole-file escape hatch, plus the disclosure itself.
    expect(text).toContain(`Read "${normalizePath(file)}" with offset=1, limit=`)
    expect(text).toContain('Partial view')
    expect(Buffer.byteLength(text, 'utf-8')).toBeLessThan(Buffer.byteLength(numbered(body), 'utf-8') * 0.4)
  })

  it('does not fire on a windowed read (offset/limit present)', () => {
    const body = tsFile(12, 12)
    const file = writeSource(body, '.ts')
    for (const input of [{ offset: 1, limit: 20 }, { offset: 5 }, { limit: 40 }]) {
      const out = postReadHandler(postEvent(file, body, input))
      expect(rewrittenText(out)).not.toContain('structural skeleton')
    }
  })

  it('leaves a source file under the byte floor alone even with enough declarations', () => {
    // Sized against the DELIVERED text, which is what the floor is measured on: the numbered `cat -n`
    // rendering the Read tool hands back, never the file's own bytes. Bodies deep enough that every
    // other gate (declaration count, ratio, net savings) is comfortably clear, so the floor is the
    // only thing that can be declining this.
    const body = tsFile(12, 5)
    expect(Buffer.byteLength(numbered(body), 'utf-8')).toBeLessThan(12_000)
    const file = writeSource(body, '.ts')
    expect(JSON.stringify(postReadHandler(postEvent(file, body)))).not.toContain('structural skeleton')
  })

  it('leaves a large source file with too few declarations alone', () => {
    const body = tsFile(6, 40)
    expect(Buffer.byteLength(numbered(body), 'utf-8')).toBeGreaterThan(12_000)
    const file = writeSource(body, '.ts')
    expect(JSON.stringify(postReadHandler(postEvent(file, body)))).not.toContain('structural skeleton')
  })

  it('does not fire when the flag is off -- the calibration for every positive assertion above', () => {
    const body = tsFile(12, 12)
    const file = writeSource(body, '.ts')
    process.env['TOKEN_GOAT_SKELETON_LARGE_SOURCES'] = '0'
    expect(JSON.stringify(postReadHandler(postEvent(file, body)))).not.toContain('structural skeleton')
  })

  /*
   * The regex extractors would find every one of these C# declarations, and a skeleton built from
   * them would look perfectly well formed while omitting whatever they missed. C# has no tree-sitter
   * grammar here, so this is the exact case where a fallback would produce a partial map with
   * nothing in the output to signal the omission. The fold must return null and deliver the file.
   */
  it('returns null rather than a partial skeleton on a language tree-sitter cannot parse', () => {
    const methods = Array.from(
      { length: 14 },
      (_, i) =>
        `    public int FixtureMethod${i}(string input, int count)\n    {\n${Array.from({ length: 10 }, () => '        var padding = "csharp body filler that pushes this fixture past the byte floor for the skeleton fold";').join('\n')}\n        return input.Length + count;\n    }`,
    ).join('\n\n')
    const body = `using System;\nusing System.Collections.Generic;\n\nnamespace Fixture\n{\n  public class FixtureClass\n  {\n${methods}\n  }\n}\n`
    expect(Buffer.byteLength(numbered(body), 'utf-8')).toBeGreaterThan(12_000)
    const file = writeSource(body, '.cs')
    const out = postReadHandler(postEvent(file, body))

    expect(JSON.stringify(out)).not.toContain('structural skeleton')
    // And nothing was withheld by some other path either: a fold that declined here must leave the
    // C# bodies reachable, which is what "deliver the file whole" means.
    expect(rewrittenText(out)).not.toContain('withheld from the skeleton')
  })

  it('records only the delivered lines as served, never the withheld bodies or the notices', () => {
    const body = tsFile(12, 12)
    const file = writeSource(body, '.ts')
    expect(JSON.stringify(postReadHandler(postEvent(file, body)))).toContain('structural skeleton')

    const ids = getFileServedOutputs(normalizePath(file))
    expect(ids.length).toBeGreaterThan(0)
    const stored = (getBashOutput(ids[ids.length - 1] ?? '')?.output ?? '').split('\n')
    expect(stored.length).toBeGreaterThan(1)

    const fileLines = new Set(body.split('\n'))
    // Every recorded line is a line of the file as delivered: no notice, no reformatting, nothing
    // the reader was not actually shown.
    for (const line of stored) expect(fileLines.has(line)).toBe(true)
    // And nothing withheld was recorded: a body line in the store would make a later read elide a
    // line this read never delivered.
    expect(stored).not.toContain(BODY_FILLER)
    for (let i = 0; i < 12; i++) expect(stored).toContain(declLine(i))
    expect(stored.length).toBeLessThan(body.split('\n').length)
  })

  /**
   * Fixture provenance: HAND-DERIVED for the quoting line (a source line written for this test, of
   * the same shape as the guard lines in src/hooks_read.ts), CAPTURE for the notice constant below.
   *
   * The guard against folding a truncated delivery used to scan the whole body for `[Truncated:`
   * anywhere in it, so any file whose own text discussed truncation became permanently unfoldable:
   * src/hooks_read.ts and tests/hooks_read.test.ts, the two files an agent working on this subsystem
   * reads most, were the largest casualties.
   */
  it('still folds a source file whose own body quotes the truncation marker inside a string', () => {
    const quoting = "  if (respText.includes('[Truncated: PARTIAL view')) return null"
    const body = tsFile(12, 12).replace(BODY_FILLER, `${BODY_FILLER}\n${quoting}`)
    expect(body).toContain(quoting)
    const file = writeSource(body, '.ts')
    const text = rewrittenText(postReadHandler(postEvent(file, body)))

    expect(text).toContain('structural skeleton')
    for (const imp of IMPORT_LINES) expect(text).toContain(imp)
    for (let i = 0; i < 12; i++) expect(text).toContain(declLine(i))
  })

  /**
   * Fixture provenance: CAPTURE. Produced by generating a 1,601-line scratch file (97,600 bytes of
   * random hex) and calling Claude Code's Read tool on it with no offset/limit, which overran the
   * 25,000-token cap; this is the notice byte-for-byte as the harness emitted it.
   */
  const HARNESS_TRUNCATION_NOTICE =
    '[Truncated: PARTIAL view — C:\\Users\\zelys\\AppData\\Local\\Temp\\tg_trunc_probe\\probe.text: showing lines 1-529 of 1601 total (64247 tokens, cap 25000). Call Read with offset=530 limit=529 for the next page, or Grep to find a specific section. Do NOT answer from this page alone if the answer may be further in the file.]'

  it('declines to fold when the harness truncation notice opens the delivered body', () => {
    const body = tsFile(12, 12)
    const file = writeSource(body, '.ts')
    const event: HookEvent = { ...postEvent(file, body), raw: { tool_response: `${HARNESS_TRUNCATION_NOTICE}\n${numbered(body)}` } }
    expect(JSON.stringify(postReadHandler(event))).not.toContain('structural skeleton')
  })

  /**
   * Fixture provenance: CAPTURE. The `tool_response.file` shape and the `truncatedByTokenCap` key
   * are taken from the stored `toolUseResult.file` object of real Claude Code Read results: across
   * 13,904 of them the key is present on 159 and `true` on all 159, and those 159 are exactly the
   * reads the harness cut at its token cap. On that harness the notice text never reaches the hook
   * through `tool_response` at all, so this flag is the guard's only live true positive.
   */
  it('declines to fold when tool_response.file.truncatedByTokenCap is set, with no marker in the body', () => {
    const body = tsFile(12, 12)
    const file = writeSource(body, '.ts')
    const fileField = (truncated: boolean): Record<string, unknown> => ({
      filePath: file,
      content: numbered(body),
      numLines: body.split('\n').length,
      startLine: 1,
      totalLines: body.split('\n').length,
      ...(truncated ? { truncatedByTokenCap: true } : {}),
    })

    const truncatedEvent: HookEvent = { ...postEvent(file, body), raw: { tool_response: { type: 'text', file: fileField(true) } } }
    expect(JSON.stringify(postReadHandler(truncatedEvent))).not.toContain('structural skeleton')

    // Calibration: the identical payload without the flag folds, so the decline above is the flag
    // and not the nested `tool_response.file` shape going unread.
    const completeEvent: HookEvent = { ...postEvent(file, body), raw: { tool_response: { type: 'text', file: fileField(false) } } }
    expect(JSON.stringify(postReadHandler(completeEvent))).toContain('structural skeleton')
  })

  it('writes a read:source_skeleton row so the ledger reflects the rewrite', () => {
    const body = tsFile(12, 12)
    const file = writeSource(body, '.ts')
    const db = getDb(globalDbPath())
    const countOf = (): number => (db.prepare("SELECT count(*) c FROM stats WHERE kind='read:source_skeleton'").get() as { c: number }).c
    const before = countOf()

    expect(JSON.stringify(postReadHandler(postEvent(file, body)))).toContain('structural skeleton')
    expect(countOf()).toBe(before + 1)
  })
})

/*
 * The shipping Read path for the same fold: the built bundle, driven the way the settings.json hook drives it, with NO environment override of the flag under test.
 *
 * Every case in the describe block above sets TOKEN_GOAT_SKELETON_LARGE_SOURCES=1 in its beforeEach, so for as long as they were the only coverage this fold had, they exercised a configuration no install has and the shipped default was covered by nothing: flipping `skeleton_large_sources` in src/config.ts changed no test result in either direction. That is the injected-seam trap CLAUDE.md names, in its exact shape, and it is the same repair tests/code_fold.test.ts made for the sibling body fold. They also all call postReadHandler from source in-process, where `tree-sitter` resolves off the repo's own node_modules; planSourceSkeleton needs a live tree-sitter parse and returns null at src/fold_structure.ts:227 without one, so a shipping artifact that cannot reach the native module folds nothing here while every source-level test stays green. Spawning the built bundle is what puts that resolution under test.
 *
 * The Bash sibling of this fold already had both halves (tests/bash_structural_fold.test.ts drives BUNDLE on a stock environment); the Read surface had neither, which is the gap this block closes.
 *
 * Fixture provenance: the TypeScript body is HAND-DERIVED, built by this file's own tsFile()/declLine() helpers from text written for this test and read off nothing in the implementation. The hook payload shape is FORMAT-DERIVED from the CAPTURE fixture in tests/rewrite_output_shape.test.ts:116, which records `tool_response` as `{type:'text',file:{filePath,content,numLines,startLine,totalLines}}` over 13,324 real results, and `content` is the file's own unnumbered text because that is the rendering the harness actually sends.
 */
describe('large-source structural skeleton through the built bundle on stock defaults', () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-skel-bundle-'))

  afterAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true })
  })

  const IMPORT_LINES = ["import * as fs from 'node:fs'", "import * as path from 'node:path'", "import { createHash } from 'node:crypto'", "import { fileURLToPath } from 'node:url'"]
  const BODY_FILLER = '  const padding = "this body line exists only to push the fixture past the byte floor, and a skeleton that keeps it is not a skeleton"'

  function declLine(i: number): string {
    return `export function bundleSymbol${i}(input: string, count: number): number {`
  }

  function tsFile(count: number, bodyLines: number): string {
    const fns = Array.from({ length: count }, (_, i) => [declLine(i), ...Array.from({ length: bodyLines }, () => BODY_FILLER), '  return input.length + count', '}'].join('\n'))
    return `${IMPORT_LINES.join('\n')}\n\n${fns.join('\n\n')}\n`
  }

  /** One `token-goat hook post_tool_use` run against the built bundle on its own TOKEN_GOAT_HOME, with the flag under test explicitly absent from the child environment. */
  function deliveredViaBundle(session: string, file: string, body: string): string {
    const env: NodeJS.ProcessEnv = { ...process.env, TOKEN_GOAT_HOME: path.join(TMP, `home-${session}`) }
    // Deleted rather than set: the whole point of this block is that the shipped default fires on its own, and an inherited value from the developer's shell or from the describe block above would silently make that assertion vacuous.
    delete env['TOKEN_GOAT_SKELETON_LARGE_SOURCES']
    const lineCount = body.split('\n').length
    const payload = {
      session_id: session,
      hook_event_name: 'PostToolUse',
      cwd: TMP,
      tool_name: 'Read',
      tool_input: { file_path: file },
      tool_response: { type: 'text', file: { filePath: file, content: body, numLines: lineCount, startLine: 1, totalLines: lineCount } },
    }
    const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], { input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env })
    expect(res.status, `bundle hook exited ${String(res.status)}: ${res.stderr.slice(0, 400)}`).toBe(0)
    const parsed = JSON.parse(res.stdout || '{}') as { hookSpecificOutput?: { updatedToolOutput?: { file?: { content?: string } } } }
    return parsed.hookSpecificOutput?.updatedToolOutput?.file?.content ?? ''
  }

  it('emits the skeleton notice for a large untargeted source read with no flag forced', () => {
    const body = tsFile(16, 14)
    const file = path.join(TMP, 'bundle_fixture.ts')
    fs.writeFileSync(file, body)
    // The floor is measured on the delivered text, which on this payload shape is the file's own unnumbered bytes.
    expect(Buffer.byteLength(body, 'utf-8')).toBeGreaterThan(12_000)

    const delivered = deliveredViaBundle('skel-bundle-default', file, body)

    // The notice this whole investigation was about: its absence, with a body fold firing in its place, is exactly the symptom a tree-sitter-less shipping artifact produces.
    expect(delivered).toContain('was replaced with its structural skeleton')
    // Must-not-drop, named line by line rather than as a ratio: an over-collapse that dropped declarations would score BETTER on any size assertion while losing the exact thing the skeleton exists to keep.
    for (const imp of IMPORT_LINES) expect(delivered).toContain(imp)
    for (let i = 0; i < 16; i++) expect(delivered).toContain(declLine(i))
    // And the bodies are gone, which is what makes it a skeleton rather than a pass-through.
    expect(delivered).not.toContain(BODY_FILLER)
    expect(Buffer.byteLength(delivered, 'utf-8')).toBeLessThan(Buffer.byteLength(body, 'utf-8') * 0.4)
  })

  it('does not fire through the bundle when the flag is off, the calibration for the case above', () => {
    const body = tsFile(16, 14)
    const file = path.join(TMP, 'bundle_fixture_off.ts')
    fs.writeFileSync(file, body)
    const env = { ...process.env, TOKEN_GOAT_HOME: path.join(TMP, 'home-off'), TOKEN_GOAT_SKELETON_LARGE_SOURCES: '0' }
    const lineCount = body.split('\n').length
    const payload = {
      session_id: 'skel-bundle-off',
      hook_event_name: 'PostToolUse',
      cwd: TMP,
      tool_name: 'Read',
      tool_input: { file_path: file },
      tool_response: { type: 'text', file: { filePath: file, content: body, numLines: lineCount, startLine: 1, totalLines: lineCount } },
    }
    const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'post_tool_use'], { input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env })
    expect(res.status).toBe(0)
    expect(res.stdout).not.toContain('was replaced with its structural skeleton')
  })
})
