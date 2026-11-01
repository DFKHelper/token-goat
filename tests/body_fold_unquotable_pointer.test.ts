/** A folded function body names `token-goat read "file::symbol@LINE"`; when that spec holds `'` together with `$` no quote mark holds it, and quotedArg (src/hint_suggestion_guard.ts) would print a placeholder that runs nothing. The fold path keeps such a body (foldDelivery) or names a ranged Read instead (planSourceSkeleton), and no printed line holds the placeholder. Fixture provenance: HAND-DERIVED. The source is synthetic TypeScript generated here (twelve 30-line functions, past SKELETON_MIN_BODY_BYTES and SKELETON_MIN_SYMBOLS in src/fold_structure.ts); the unquotable spelling comes from the file's directory name, an apostrophe plus a dollar sign, which the same suite's `canQuoteArg("it's $5")` row (tests/suggestion_single_quoted_args.test.ts) pins as unquotable. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { foldDelivery, type FoldRow } from '../src/fold_delivery.js'
import { planSourceSkeleton } from '../src/fold_structure.js'
import { canQuoteArg, UNQUOTABLE } from '../src/hint_suggestion_guard.js'
import { postReadHandler } from '../src/hooks_read_post.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'

const dirs: string[] = []

/** Twelve functions of 30 lines each; the last body line of each is unique to it. */
function source(): string {
  const parts: string[] = []
  for (let f = 1; f <= 12; f++) {
    parts.push(`export function computeTotal${f}(input: number): number {`)
    parts.push(`  let total = input + ${f}`)
    for (let i = 1; i <= 26; i++) parts.push(`  total = total * ${i} + ${f * 1000 + i} // accumulate step ${i} of function ${f}`)
    parts.push(`  return total - ${f}`)
    parts.push('}')
    parts.push('')
  }
  return parts.join('\n')
}

/** `source()` written as `big.ts` in a fresh directory whose name starts with `prefix`, returned as its normalized path. */
function writeSource(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  const file = path.join(dir, 'big.ts')
  fs.writeFileSync(file, source())
  return normalizePath(file)
}

function rowsOf(file: string): FoldRow[] {
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .map((text, i) => ({ no: i + 1, text, raw: `${String(i + 1).padStart(6, ' ')}\t${text}` }))
}

const DEEP_LINE = 'total = total * 20 + 1020 // accumulate step 20 of function 1'

describe('a folded body whose read pointer no quote mark can hold', () => {
  beforeEach(() => {
    clearModuleCaches()
  })
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  // Provenance: HAND-DERIVED (positive control: the same source under a plain directory name, so the fold path is shown to fold these bodies at all).
  it('folds the bodies of the source under a plain path (positive control)', () => {
    const file = writeSource('tg-body-plain-')
    const folded = foldDelivery(rowsOf(file), file, file)
    expect(folded, 'a plain path folds the long bodies').not.toBeNull()
    expect(folded!.numbered.join('\n'), 'a plain path prints the read pointer').toContain('folded -- token-goat read "')
  })

  // Provenance: HAND-DERIVED (directory name holding an apostrophe and a dollar sign; see the file header).
  it('keeps every body whole on a Read of a path no quote mark can hold, and prints no placeholder', () => {
    const file = writeSource("tg-it's$body-")
    expect(canQuoteArg(`${file}::computeTotal1@1`), 'fixture: the spec is unquotable').toBe(false)
    const folded = foldDelivery(rowsOf(file), file, file)
    const printed = (folded?.numbered ?? rowsOf(file).map((r) => r.raw)).join('\n')
    expect(printed, 'no printed line holds the placeholder for an unquotable value').not.toContain(UNQUOTABLE)
    expect((folded?.folds ?? []).filter((f) => f.kind === 'body'), 'a body with no printable pointer is never counted as folded').toEqual([])
    expect(printed, 'the body is delivered whole').toContain(DEEP_LINE)
  })

  // Provenance: HAND-DERIVED (same unquotable directory name; the Read result is the `cat -n` string the post-hook parses, as tests/folded_sections_command.test.ts builds it). The file is past post_read_code_compress.min_lines (200), so the structural-navigation hint in src/hooks_read_post.ts is in reach as well as the fold.
  it('prints no placeholder anywhere in the post-Read output for a source file at a path no quote mark can hold', () => {
    const file = writeSource("tg-it's$hook-")
    const body = fs.readFileSync(file, 'utf-8')
    const response = rowsOf(file)
      .map((r) => r.raw)
      .join('\n')
    expect(body.split('\n').length, 'fixture: past the structural hint floor').toBeGreaterThan(200)
    const out = postReadHandler({ eventName: 'post_tool_use', toolName: 'Read', toolInput: { file_path: file }, sessionId: `unquotable-${Math.random().toString(36).slice(2)}`, agentId: undefined, raw: { tool_response: response } })
    expect(JSON.stringify(out), 'no hook output holds the placeholder for an unquotable value').not.toContain(UNQUOTABLE)
  })

  // Provenance: HAND-DERIVED (positive control for the skeleton: a plain path names the read pointer per body).
  it('names a read pointer per body in the skeleton of a plain path (positive control)', () => {
    const file = writeSource('tg-skel-plain-')
    const plan = planSourceSkeleton(rowsOf(file), file, file, fs.statSync(file).size, 'aligned')
    expect(plan, 'the skeleton runs on the fixture').not.toBeNull()
    expect(plan!.numbered.join('\n'), 'a plain path prints the read pointer').toContain('folded -- token-goat read "')
    expect(plan!.context ?? '', 'a plain path names the read command in the skeleton notice').toContain('::SymbolName')
  })

  // Provenance: HAND-DERIVED (same unquotable directory name as above).
  it('names a ranged Read instead of a placeholder read pointer in the skeleton of a path no quote mark can hold', () => {
    const file = writeSource("tg-it's$skel-")
    const plan = planSourceSkeleton(rowsOf(file), file, file, fs.statSync(file).size, 'aligned')
    expect(plan, 'the skeleton runs on the fixture').not.toBeNull()
    const body = plan!.numbered.join('\n')
    expect(body, 'no skeleton row holds the placeholder for an unquotable value').not.toContain(UNQUOTABLE)
    expect(plan!.context ?? '', 'the skeleton notice holds no placeholder for an unquotable value').not.toContain(UNQUOTABLE)
    expect(plan!.context ?? '', 'the skeleton notice still names the whole-file Read').toContain('with offset=1, limit=')
    expect(body, 'each body run names the ranged Read that returns it').toContain('withheld from the skeleton -- Read "')
  })
})
