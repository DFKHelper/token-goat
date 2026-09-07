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
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

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
    // The recall command is exact and copy-pasteable, per symbol.
    expect(text).toContain(`token-goat read "${normalizePath(file)}::fixtureSymbol3"`)
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
