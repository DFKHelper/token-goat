import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../src/constants.js'
import type { HookEvent } from '../src/hook_registry.js'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-write-'))
const TEST_CONFIG_PATH = path.join(DATA_DIR, 'config.toml')

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  return { ...actual, dataDir: () => DATA_DIR, configPath: () => TEST_CONFIG_PATH }
})

// vi.mock is hoisted -- spy on recordStat while still calling through, mirroring tests/hooks_glob.test.ts's pattern.
vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const real = original['recordStat'] as (...args: unknown[]) => void
  return { ...original, recordStat: vi.fn((...args: unknown[]) => real(...args)) }
})

const { preWriteRewriteHandler } = await import('../src/hooks_write.js')
const { recordStat } = await import('../src/stats.js')
const { clearModuleCaches } = await import('../src/reset.js')
const { defaultConfig, invalidateConfigCache, saveConfig } = await import('../src/config.js')
const { makeHookEvent } = await import('./helpers/hook-event.js')
const { normalizePayload } = await import('../src/hooks_cli.js')
const { normalizePath } = await import('../src/paths.js')
const { siblingCandidates } = await import('../src/sibling_copy.js')
const { recordReadShape } = await import('../src/read_shape.js')
const { recordFileRead, recordFileLineRange } = await import('../src/session.js')

const FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-write-files-'))

function writeEvent(filePath: string | undefined, content: unknown): HookEvent {
  return makeHookEvent({
    eventName: 'pre_tool_use',
    toolName: 'Write',
    toolInput: filePath === undefined ? { content } : { file_path: filePath, content },
    sessionId: 'test',
  })
}

/** Build a synthetic N-line file body, one distinct line per index so line-level identity is unambiguous for the LCS comparison. */
function makeLines(n: number, prefix = 'line'): string {
  const lines: string[] = []
  for (let i = 0; i < n; i++) lines.push(`${prefix} ${i}`)
  return lines.join('\n') + '\n'
}

beforeEach(() => {
  clearModuleCaches()
  vi.mocked(recordStat).mockClear()
  try { fs.unlinkSync(TEST_CONFIG_PATH) } catch { /* ok */ }
  invalidateConfigCache()
})

afterEach(() => {
  clearModuleCaches()
  try { fs.unlinkSync(TEST_CONFIG_PATH) } catch { /* ok */ }
  invalidateConfigCache()
})

describe('preWriteRewriteHandler', () => {
  it('ignores non-Write events', () => {
    const event = makeHookEvent({ toolName: 'Edit', toolInput: {} })
    expect(preWriteRewriteHandler(event).hookType).toBe('pass')
  })

  it('passes through a Write to a brand-new file with zero comparison attempted', () => {
    const target = path.join(FILES_DIR, 'brand-new.ts')
    expect(fs.existsSync(target)).toBe(false)
    const result = preWriteRewriteHandler(writeEvent(target, makeLines(100)))
    expect(result.hookType).toBe('pass')
    expect(vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'write_rewrite_hint')).toBeUndefined()
  })

  it('passes through when the file exists but is small (below write_rewrite_min_lines)', () => {
    const target = path.join(FILES_DIR, 'small.ts')
    fs.writeFileSync(target, makeLines(10))
    // New content keeps only 1 of the 10 old lines -- would clearly fire on a large file, but this file is trivially small (default floor is 40 lines), so it must pass regardless.
    const newContent = 'line 0\n' + makeLines(9, 'brand-new-line').replace(/\n$/, '')
    const result = preWriteRewriteHandler(writeEvent(target, newContent))
    expect(result.hookType).toBe('pass')
  })

  it('fires the hint for a large file where most lines are unchanged', () => {
    const target = path.join(FILES_DIR, 'mostly-unchanged.ts')
    const oldLines: string[] = []
    for (let i = 0; i < 100; i++) oldLines.push(`line ${i}`)
    fs.writeFileSync(target, oldLines.join('\n') + '\n')

    // Change only 2 of the 100 lines -- 98% unchanged, well above the default 75% floor.
    const newLines = [...oldLines]
    newLines[10] = 'CHANGED line 10'
    newLines[50] = 'CHANGED line 50'
    const result = preWriteRewriteHandler(writeEvent(target, newLines.join('\n') + '\n'))

    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('Edit')
    }
    expect(vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'write_rewrite_hint')).toBeDefined()
  })

  it('does not fire (false positive) for a large file that is a genuine, mostly-different rewrite', () => {
    const target = path.join(FILES_DIR, 'genuine-rewrite.ts')
    fs.writeFileSync(target, makeLines(100, 'old'))

    // Entirely different line content -- a real rewrite, not a small edit.
    const result = preWriteRewriteHandler(writeEvent(target, makeLines(100, 'totally-different-content')))

    expect(result.hookType).toBe('pass')
    expect(vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'write_rewrite_hint')).toBeUndefined()
  })

  it('passes through identical content (no-op write)', () => {
    const target = path.join(FILES_DIR, 'identical.ts')
    const body = makeLines(100)
    fs.writeFileSync(target, body)
    const result = preWriteRewriteHandler(writeEvent(target, body))
    expect(result.hookType).toBe('pass')
  })

  it('fails open when content is missing or non-string', () => {
    const target = path.join(FILES_DIR, 'no-content.ts')
    fs.writeFileSync(target, makeLines(100))
    expect(preWriteRewriteHandler(writeEvent(target, undefined)).hookType).toBe('pass')
    expect(preWriteRewriteHandler(writeEvent(target, 12345)).hookType).toBe('pass')
  })

  it('fails open when file_path is missing', () => {
    expect(preWriteRewriteHandler(writeEvent(undefined, makeLines(100))).hookType).toBe('pass')
  })

  it('fails open when the path is a directory, not a file', () => {
    const dirTarget = fs.mkdtempSync(path.join(FILES_DIR, 'a-dir-'))
    const result = preWriteRewriteHandler(writeEvent(dirTarget, makeLines(100)))
    expect(result.hookType).toBe('pass')
  })

  it('fails open when the file cannot be read (permission-style error simulated via ENOENT after stat)', () => {
    // A path that statSync itself cannot resolve (nonexistent parent dir with trailing slash weirdness is fragile across platforms) -- instead assert the already-covered brand-new-file path and a bogus null-byte path both degrade to pass rather than throwing.
    const bogus = path.join(FILES_DIR, 'does\x00not-exist.ts')
    expect(() => preWriteRewriteHandler(writeEvent(bogus, makeLines(100)))).not.toThrow()
    expect(preWriteRewriteHandler(writeEvent(bogus, makeLines(100))).hookType).toBe('pass')
  })

  it('fails open without reading the old file when it exceeds the byte-size cap, even though its line count is well under MAX_LINES_FOR_DIFF', () => {
    const target = path.join(FILES_DIR, 'huge-few-lines.ts')
    // 200 lines of 30KB each (~6MB total) -- far over the 4MB byte cap, but only 200 lines, well under MAX_LINES_FOR_DIFF (4000). Pre-fix, the only gate was the line-count check performed AFTER the full file was already read and split, so this shape sailed straight through: full readFileSync of ~6MB, followed by a hint firing since 200 < 4000 and most lines are unchanged.
    const oldLines: string[] = []
    for (let i = 0; i < 200; i++) oldLines.push(`line ${i} ` + 'x'.repeat(30_000))
    fs.writeFileSync(target, oldLines.join('\n') + '\n')

    const newLines = [...oldLines]
    newLines[10] = 'CHANGED line 10'
    const result = preWriteRewriteHandler(writeEvent(target, newLines.join('\n') + '\n'))

    expect(result.hookType).toBe('pass')
    expect(vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'write_rewrite_hint')).toBeUndefined()
  })

  // Mutation guard: a lowered write_rewrite_min_lines / write_rewrite_unchanged_pct must actually change behavior, proving the fields drive this gate rather than a hardcoded literal.
  it('write_rewrite_min_lines wiring: a file too small at the default floor fires once the floor is lowered', () => {
    const target = path.join(FILES_DIR, 'wiring-min-lines.ts')
    const oldLines: string[] = []
    for (let i = 0; i < 20; i++) oldLines.push(`line ${i}`)
    fs.writeFileSync(target, oldLines.join('\n') + '\n')

    const newLines = [...oldLines]
    newLines[5] = 'CHANGED'
    const content = newLines.join('\n') + '\n'

    // 20 lines is below the default floor (40) -- passes.
    expect(preWriteRewriteHandler(writeEvent(target, content)).hookType).toBe('pass')

    const cfg = defaultConfig()
    cfg.hints.write_rewrite_min_lines = 10
    saveConfig(cfg)
    invalidateConfigCache()

    // Same file, same content -- now clears the lowered floor and fires.
    expect(preWriteRewriteHandler(writeEvent(target, content)).hookType).toBe('context')
  })

  it('reports the file\'s real line count and unchanged percentage, not the ones a trailing newline inflates (regression: split on a final newline yields a phantom empty element, so a 40-line file was described as 41-line and 30 of 40 kept lines as 76%)', () => {
    const target = path.join(FILES_DIR, 'trailing-newline.ts')
    const oldLines: string[] = []
    for (let i = 0; i < 40; i++) oldLines.push(`line ${i}`)
    fs.writeFileSync(target, oldLines.join('\n') + '\n')

    const newLines = [...oldLines]
    for (let i = 30; i < 40; i++) newLines[i] = `CHANGED ${i}`
    const result = preWriteRewriteHandler(writeEvent(target, newLines.join('\n') + '\n'))

    expect(result.hookType).toBe('context')
    if (result.hookType !== 'context') return
    expect(result.context).toContain('40-line file')
    expect(result.context).not.toContain('41-line file')
    // 30 of 40 lines kept is exactly 75%, not the 76% the phantom element's free match produced.
    expect(result.context).toContain('75% of its lines are unchanged')
  })

  it('counts a file one line short of write_rewrite_min_lines as short (regression: the phantom trailing element let a 39-line file clear a 40-line floor)', () => {
    const target = path.join(FILES_DIR, 'floor-off-by-one.ts')
    const oldLines: string[] = []
    for (let i = 0; i < 39; i++) oldLines.push(`line ${i}`)
    fs.writeFileSync(target, oldLines.join('\n') + '\n')

    const newLines = [...oldLines]
    newLines[0] = 'CHANGED 0'

    const cfg = defaultConfig()
    cfg.hints.write_rewrite_min_lines = 40
    saveConfig(cfg)
    invalidateConfigCache()

    expect(preWriteRewriteHandler(writeEvent(target, newLines.join('\n') + '\n')).hookType).toBe('pass')
  })

  it('write_rewrite_unchanged_pct wiring: raising the threshold suppresses a hint that fired at the default', () => {
    const target = path.join(FILES_DIR, 'wiring-pct.ts')
    const oldLines: string[] = []
    for (let i = 0; i < 100; i++) oldLines.push(`line ${i}`)
    fs.writeFileSync(target, oldLines.join('\n') + '\n')

    // 80% unchanged: 20 of 100 lines change.
    const newLines = [...oldLines]
    for (let i = 0; i < 20; i++) newLines[i] = `CHANGED ${i}`
    const content = newLines.join('\n') + '\n'

    // Default floor is 75% -- 80% clears it and fires.
    expect(preWriteRewriteHandler(writeEvent(target, content)).hookType).toBe('context')

    const cfg = defaultConfig()
    cfg.hints.write_rewrite_unchanged_pct = 90
    saveConfig(cfg)
    invalidateConfigCache()

    // Same 80%-unchanged content no longer clears the raised 90% floor -- passes.
    expect(preWriteRewriteHandler(writeEvent(target, content)).hookType).toBe('pass')
  })
})

// The partial-view guard (hints.write_blind_drop). Payload shapes: Claude Code Write/Edit/MultiEdit tool_input is FORMAT-DERIVED from https://code.claude.com/docs/en/hooks (file_path + content; file_path + old_string + new_string; file_path + edits[]). Copilot CLI `create` {path, file_text} is CAPTURE: the arguments of a real `create` tool call in a Copilot CLI 1.0.x session log (events.jsonl, toolName "create"), run through the real normalizePayload. Codex `apply_patch` {command: <V4A patch>} is FORMAT-DERIVED from codex-rs core/src/tools/handlers/apply_patch.rs (see the comment in hooks_cli.ts::normalizePayload) with the tool name CAPTURE, codex-cli 0.155.0 (tests/install_codex.test.ts). Marker strings and line counts are HAND-DERIVED.
describe('write_blind_drop guard', () => {
  const PLACEHOLDER = '// ... rest of file unchanged ...'

  function editEvent(toolName: string, toolInput: Record<string, unknown>): HookEvent {
    return makeHookEvent({ eventName: 'pre_tool_use', toolName, toolInput, sessionId: 'test' })
  }

  function setPolicy(policy: 'deny' | 'warn' | 'off', quietHours = ''): void {
    const cfg = defaultConfig()
    cfg.hints.write_blind_drop = policy
    cfg.hints.quiet_hours = quietHours
    saveConfig(cfg)
    invalidateConfigCache()
  }

  /** A 100-line file on disk whose last Read the session records as `shape`, with `served` as the windows it was shown. */
  function seedPartialRead(name: string, shape: 'partial' | 'outline' | 'fold', served: Array<[number, number]>): { target: string; lines: string[] } {
    const target = path.join(FILES_DIR, name)
    const lines = makeLines(100).trimEnd().split('\n')
    fs.writeFileSync(target, lines.join('\n') + '\n')
    recordFileRead(target, false)
    for (const [s, e] of served) recordFileLineRange(target, s, e)
    recordReadShape('test', normalizePath(target), shape)
    return { target, lines }
  }

  describe('placeholder lines', () => {
    it('denies a Write whose new content carries a placeholder the file does not hold, naming the line', () => {
      const target = path.join(FILES_DIR, 'ph-existing.ts')
      fs.writeFileSync(target, makeLines(50))
      const result = preWriteRewriteHandler(writeEvent(target, 'line 0\n' + PLACEHOLDER + '\n'))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') expect(result.message).toContain(PLACEHOLDER)
      expect(vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'write_blind_drop')?.[4]).toContain('kind=placeholder')
    })

    it('lets the identical call through on the retry', () => {
      const target = path.join(FILES_DIR, 'ph-retry.ts')
      fs.writeFileSync(target, makeLines(50))
      const event = writeEvent(target, 'line 0\n' + PLACEHOLDER + '\n')
      expect(preWriteRewriteHandler(event).hookType).toBe('deny')
      expect(preWriteRewriteHandler(event).hookType).toBe('pass')
    })

    it('passes a placeholder line the file already holds', () => {
      const target = path.join(FILES_DIR, 'ph-already.ts')
      fs.writeFileSync(target, 'line 0\n' + PLACEHOLDER + '\nline 2\n')
      expect(preWriteRewriteHandler(writeEvent(target, 'line 0\n' + PLACEHOLDER + '\nline 2 changed\n')).hookType).toBe('pass')
    })

    it('flags a brand-new file that is a placeholder, and passes one that is not', () => {
      const target = path.join(FILES_DIR, 'ph-new.ts')
      expect(preWriteRewriteHandler(writeEvent(target, 'import x from "x"\n// existing code\n')).hookType).toBe('deny')
      expect(preWriteRewriteHandler(writeEvent(path.join(FILES_DIR, 'ph-new-clean.ts'), 'import x from "x"\n')).hookType).toBe('pass')
    })

    it.each([
      '// existing code path handles retries',
      '// the rest of the file is generated, do not hand-edit',
      '# unchanged since v1 because the schema froze',
      'const rest = [...remaining]',
      '// ... spread the options here',
    ])('does not mistake ordinary prose or code for a placeholder: %s', (line) => {
      const target = path.join(FILES_DIR, 'ph-prose-' + Math.abs(line.length * 31 + line.charCodeAt(3)) + '.ts')
      expect(preWriteRewriteHandler(writeEvent(target, line + '\n')).hookType).toBe('pass')
    })

    it.each([
      '// ... existing code ...',
      '# ... rest unchanged',
      '/* rest of the file unchanged */',
      '<!-- ... remaining content ... -->',
      '[truncated]',
      '[... remaining content omitted ...]',
      '... 29 more lines of recordEditedFile (46-74) folded -- token-goat read "x::y@38"',
    ])('recognizes the placeholder %s', (line) => {
      const target = path.join(FILES_DIR, 'ph-kind-' + Math.abs(line.length * 17 + line.charCodeAt(4)) + '.ts')
      expect(preWriteRewriteHandler(writeEvent(target, line + '\n')).hookType).toBe('deny')
    })

    it('checks an Edit new_string, passing when old_string already holds the marker', () => {
      const target = path.join(FILES_DIR, 'ph-edit.ts')
      fs.writeFileSync(target, 'a\nb\n')
      expect(preWriteRewriteHandler(editEvent('Edit', { file_path: target, old_string: 'b', new_string: '// ... existing code ...' })).hookType).toBe('deny')
      const held = path.join(FILES_DIR, 'ph-edit-held.ts')
      fs.writeFileSync(held, 'a\n// ... existing code ...\n')
      expect(preWriteRewriteHandler(editEvent('Edit', { file_path: held, old_string: '// ... existing code ...', new_string: '// ... existing code ...\nc' })).hookType).toBe('pass')
    })

    it('checks every edit of a MultiEdit', () => {
      const target = path.join(FILES_DIR, 'ph-multi.ts')
      fs.writeFileSync(target, 'a\nb\n')
      const edits = [{ old_string: 'a', new_string: 'A' }, { old_string: 'b', new_string: '// rest of file unchanged' }]
      expect(preWriteRewriteHandler(editEvent('MultiEdit', { file_path: target, edits })).hookType).toBe('deny')
    })

    it('reads a Copilot CLI create through the real payload normalization', () => {
      const target = path.join(FILES_DIR, 'ph-copilot.ts')
      fs.writeFileSync(target, makeLines(50))
      const wire = { tool_name: 'create', tool_input: { path: target, file_text: 'line 0\n' + PLACEHOLDER + '\n' } }
      const normalized = normalizePayload(wire, 'copilot_cli') as { tool_name: string; tool_input: Record<string, unknown> }
      expect(normalized.tool_name).toBe('Write')
      expect(preWriteRewriteHandler(editEvent(normalized.tool_name, normalized.tool_input)).hookType).toBe('deny')
    })

    it('reads a Copilot CLI edit through the real payload normalization', () => {
      const target = path.join(FILES_DIR, 'ph-copilot-edit.ts')
      fs.writeFileSync(target, 'a\nb\n')
      const wire = { tool_name: 'edit', tool_input: { path: target, old_str: 'b', new_str: '// ... existing code ...' } }
      const normalized = normalizePayload(wire, 'copilot_cli') as { tool_name: string; tool_input: Record<string, unknown> }
      expect(preWriteRewriteHandler(editEvent(normalized.tool_name, normalized.tool_input)).hookType).toBe('deny')
    })

    it('reads the added lines of a Codex apply_patch, and passes a patch that adds none', () => {
      const target = path.join(FILES_DIR, 'ph-codex.ts')
      fs.writeFileSync(target, 'a\nb\n')
      const patch = (added: string): string => `*** Begin Patch\n*** Update File: ${target}\n@@\n-b\n+${added}\n*** End Patch\n`
      const wire = (command: string) => ({ tool_name: 'apply_patch', tool_input: { command } })
      const bad = normalizePayload(wire(patch('// ... existing code ...')), 'codex') as { tool_name: string; tool_input: Record<string, unknown> }
      expect(bad.tool_name).toBe('Edit')
      expect(preWriteRewriteHandler(editEvent(bad.tool_name, bad.tool_input)).hookType).toBe('deny')
      const good = normalizePayload(wire(patch('c')), 'codex') as { tool_name: string; tool_input: Record<string, unknown> }
      expect(preWriteRewriteHandler(editEvent(good.tool_name, good.tool_input)).hookType).toBe('pass')
    })
  })

  describe('whole-file Write after a partial read', () => {
    it('denies a Write that drops lines outside the windows the session was shown, naming them', () => {
      const { target, lines } = seedPartialRead('bd-deny.ts', 'partial', [[1, 40]])
      const result = preWriteRewriteHandler(writeEvent(target, lines.slice(0, 40).join('\n') + '\nnew tail\n'))
      expect(result.hookType).toBe('deny')
      if (result.hookType === 'deny') {
        expect(result.message).toContain('60 lines')
        expect(result.message).toContain('@41-100')
        expect(result.message).toContain('token-goat read')
      }
      expect(vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'write_blind_drop')?.[4]).toContain('kind=blind_drop last_read=partial')
    })

    it('lets the identical Write through on the retry', () => {
      const { target, lines } = seedPartialRead('bd-retry.ts', 'partial', [[1, 40]])
      const event = writeEvent(target, lines.slice(0, 40).join('\n') + '\nnew tail\n')
      expect(preWriteRewriteHandler(event).hookType).toBe('deny')
      expect(preWriteRewriteHandler(event).hookType).toBe('pass')
    })

    it('passes when the dropped lines were inside the served windows', () => {
      const { target, lines } = seedPartialRead('bd-seen.ts', 'partial', [[1, 40], [41, 100]])
      expect(preWriteRewriteHandler(writeEvent(target, lines.slice(0, 40).join('\n') + '\nnew tail\n')).hookType).toBe('pass')
    })

    it('passes when the file was never read in part (no read shape)', () => {
      const target = path.join(FILES_DIR, 'bd-noshape.ts')
      const lines = makeLines(100).trimEnd().split('\n')
      fs.writeFileSync(target, lines.join('\n') + '\n')
      expect(preWriteRewriteHandler(writeEvent(target, lines.slice(0, 40).join('\n') + '\nnew tail\n')).hookType).toBe('pass')
    })

    it('passes when the file was read whole after the partial read', () => {
      const { target, lines } = seedPartialRead('bd-fullread.ts', 'partial', [[1, 40]])
      recordFileRead(target, true)
      expect(preWriteRewriteHandler(writeEvent(target, lines.slice(0, 40).join('\n') + '\nnew tail\n')).hookType).toBe('pass')
    })

    it('passes when fewer than five unseen lines are dropped', () => {
      const { target, lines } = seedPartialRead('bd-few.ts', 'partial', [[1, 96]])
      // Mostly-unchanged content may draw the unrelated rewrite hint; only the guard is under test.
      expect(preWriteRewriteHandler(writeEvent(target, lines.slice(0, 96).join('\n') + '\nline 96\nline 97 changed\n')).hookType).not.toBe('deny')
      expect(vi.mocked(recordStat).mock.calls.some((c) => c[0] === 'write_blind_drop')).toBe(false)
    })

    it('treats a partial shape with no recorded windows as unknown and passes', () => {
      const { target, lines } = seedPartialRead('bd-nowindows.ts', 'partial', [])
      expect(preWriteRewriteHandler(writeEvent(target, lines.slice(0, 40).join('\n') + '\nnew tail\n')).hookType).toBe('pass')
    })

    it('denies after an outline-shaped read, which showed no lines at all', () => {
      const { target, lines } = seedPartialRead('bd-outline.ts', 'outline', [])
      expect(preWriteRewriteHandler(writeEvent(target, lines.slice(0, 40).join('\n') + '\nnew tail\n')).hookType).toBe('deny')
    })

    it('passes after a fold-shaped read, whose shown lines cannot be placed', () => {
      const { target, lines } = seedPartialRead('bd-fold.ts', 'fold', [])
      expect(preWriteRewriteHandler(writeEvent(target, lines.slice(0, 40).join('\n') + '\nnew tail\n')).hookType).toBe('pass')
    })
  })

  describe('hints.write_blind_drop', () => {
    it('warn adds a note instead of refusing, and quiet hours silence it', () => {
      setPolicy('warn')
      const a = path.join(FILES_DIR, 'cfg-warn.ts')
      fs.writeFileSync(a, makeLines(10))
      expect(preWriteRewriteHandler(writeEvent(a, PLACEHOLDER + '\n')).hookType).toBe('context')
      setPolicy('warn', '00:00-23:59')
      const b = path.join(FILES_DIR, 'cfg-warn-quiet.ts')
      fs.writeFileSync(b, makeLines(10))
      expect(preWriteRewriteHandler(writeEvent(b, PLACEHOLDER + '\n')).hookType).toBe('pass')
    })

    it('deny stays in force inside quiet hours', () => {
      setPolicy('deny', '00:00-23:59')
      const a = path.join(FILES_DIR, 'cfg-deny-quiet.ts')
      fs.writeFileSync(a, makeLines(10))
      expect(preWriteRewriteHandler(writeEvent(a, PLACEHOLDER + '\n')).hookType).toBe('deny')
    })

    it('off turns both checks off', () => {
      setPolicy('off')
      const a = path.join(FILES_DIR, 'cfg-off.ts')
      fs.writeFileSync(a, makeLines(10))
      expect(preWriteRewriteHandler(writeEvent(a, PLACEHOLDER + '\n')).hookType).toBe('pass')
      const { target, lines } = seedPartialRead('cfg-off-bd.ts', 'partial', [[1, 40]])
      expect(preWriteRewriteHandler(writeEvent(target, lines.slice(0, 40).join('\n') + '\nnew tail\n')).hookType).toBe('pass')
    })
  })
})

// The sibling-copy advice (hints.write_sibling_copy). File names, line counts and the 75% / 40-line defaults are HAND-DERIVED from the brief and src/config_defaults.ts. The Copilot CLI `create` payload {path, file_text} is CAPTURE: the arguments of a real `create` tool call in a Copilot CLI 1.0.x session log (events.jsonl), run through the real normalizePayload. Claude Code's Write {file_path, content} is FORMAT-DERIVED from https://code.claude.com/docs/en/hooks.
describe('siblingCandidates', () => {
  const dir = path.join(FILES_DIR, 'cand')
  it.each([
    ['solver_v2.py', ['solver.py']],
    ['solver-v3.py', ['solver.py']],
    ['solverv2.py', ['solver.py']],
    ['solver_fixed.py', ['solver.py']],
    ['solver_new.ts', ['solver.ts']],
    ['solver_copy.ts', ['solver.ts']],
    ['solver_old.ts', ['solver.ts']],
    ['solver_orig.ts', ['solver.ts']],
    ['solver_backup.ts', ['solver.ts']],
    ['solver copy.ts', ['solver.ts']],
    ['solver (1).ts', ['solver.ts']],
    ['solver.py.bak', ['solver.py']],
    ['solver.py.orig', ['solver.py']],
    ['solver.py.new', ['solver.py']],
    ['solver_v2_fixed.py', ['solver_v2.py']],
    ['v2.py', []],
    ['solver.py', []],
    ['notes.bak', []],
    ['solver_v.py', []],
    ['Solver_V2.PY', ['Solver.PY']],
  ])('%s names %j', (name, expected) => {
    expect(siblingCandidates(path.join(dir, name))).toEqual(expected.map((e) => path.join(dir, e)))
  })
})

describe('sibling-copy advice', () => {
  /** A directory (optionally nested under `parts`) holding `original` of `lines` lines. */
  function setup(original: string, lines: number, ...parts: string[]): { dir: string; original: string } {
    const dir = path.join(fs.mkdtempSync(path.join(FILES_DIR, 'sib-')), ...parts)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, original), makeLines(lines))
    return { dir, original: path.join(dir, original) }
  }

  /** `makeLines(n)` with its last line replaced, so the copy is 98% unchanged for n = 50. */
  const nearCopy = (n: number): string => makeLines(n - 1) + 'changed last line\n'

  it.each([
    ['solver_v2.py', 'solver.py'],
    ['solver-v3.py', 'solver.py'],
    ['solver_fixed.py', 'solver.py'],
    ['solver_new.py', 'solver.py'],
    ['solver_copy.py', 'solver.py'],
    ['solver copy.py', 'solver.py'],
    ['solver (1).py', 'solver.py'],
    ['solver.py.bak', 'solver.py'],
  ])('advises editing the original when %s repeats %s', (copy, original) => {
    const { dir } = setup(original, 50)
    const result = preWriteRewriteHandler(writeEvent(path.join(dir, copy), nearCopy(50)))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('98%')
      expect(result.context).toContain('token-goat outline')
      expect(result.context).toContain('solver.py')
    }
    expect(vi.mocked(recordStat).mock.calls.find((c) => c[0] === 'write_sibling_copy')?.[4]).toBe('unchanged_pct=98')
  })

  it('speaks once per original, not once per copy', () => {
    const { dir } = setup('solver.py', 50)
    expect(preWriteRewriteHandler(writeEvent(path.join(dir, 'solver_v2.py'), nearCopy(50))).hookType).toBe('context')
    expect(preWriteRewriteHandler(writeEvent(path.join(dir, 'solver_v3.py'), nearCopy(50))).hookType).toBe('pass')
  })

  it('passes a copy that shares too little with the original', () => {
    const { dir } = setup('solver.py', 50)
    expect(preWriteRewriteHandler(writeEvent(path.join(dir, 'solver_v2.py'), makeLines(50, 'other'))).hookType).toBe('pass')
  })

  it('passes when the original is below the minimum line count', () => {
    const { dir } = setup('solver.py', 30)
    expect(preWriteRewriteHandler(writeEvent(path.join(dir, 'solver_v2.py'), nearCopy(30))).hookType).toBe('pass')
  })

  it('passes when the file the name points at does not exist', () => {
    const { dir } = setup('other.py', 50)
    expect(preWriteRewriteHandler(writeEvent(path.join(dir, 'solver_v2.py'), nearCopy(50))).hookType).toBe('pass')
  })

  it('passes a new file whose name is not a copy of anything', () => {
    const { dir } = setup('solver.py', 50)
    expect(preWriteRewriteHandler(writeEvent(path.join(dir, 'solver_extra.py'), nearCopy(50))).hookType).toBe('pass')
  })

  it.each([
    ['migrations'],
    ['versions'],
    ['fixtures'],
    ['__snapshots__'],
  ])('stays silent inside a %s directory', (series) => {
    const { dir } = setup('solver.py', 50, series)
    expect(preWriteRewriteHandler(writeEvent(path.join(dir, 'solver_v2.py'), nearCopy(50))).hookType).toBe('pass')
  })

  it('stays silent inside an api/vN directory', () => {
    const { dir } = setup('solver.py', 50, 'api', 'v2')
    expect(preWriteRewriteHandler(writeEvent(path.join(dir, 'solver_v2.py'), nearCopy(50))).hookType).toBe('pass')
  })

  it('stays silent for a path matching hints.write_sibling_copy_allow', () => {
    const cfg = defaultConfig()
    cfg.hints.write_sibling_copy_allow = ['legacy/*_v2.py']
    saveConfig(cfg)
    invalidateConfigCache()
    const { dir } = setup('solver.py', 50, 'legacy')
    expect(preWriteRewriteHandler(writeEvent(path.join(dir, 'solver_v2.py'), nearCopy(50))).hookType).toBe('pass')
    expect(preWriteRewriteHandler(writeEvent(path.join(dir, 'solver_v3.py'), nearCopy(50))).hookType).toBe('context')
  })

  it('is off when hints.write_sibling_copy is false', () => {
    const cfg = defaultConfig()
    cfg.hints.write_sibling_copy = false
    saveConfig(cfg)
    invalidateConfigCache()
    const { dir } = setup('solver.py', 50)
    expect(preWriteRewriteHandler(writeEvent(path.join(dir, 'solver_v2.py'), nearCopy(50))).hookType).toBe('pass')
  })

  it('leaves a Write to an existing versioned file to the rewrite check', () => {
    const { dir } = setup('solver.py', 50)
    fs.writeFileSync(path.join(dir, 'solver_v2.py'), makeLines(50, 'other'))
    expect(preWriteRewriteHandler(writeEvent(path.join(dir, 'solver_v2.py'), nearCopy(50))).hookType).toBe('pass')
  })

  it('lets a placeholder refusal win over the advice', () => {
    const { dir } = setup('solver.py', 50)
    expect(preWriteRewriteHandler(writeEvent(path.join(dir, 'solver_v2.py'), nearCopy(50) + '// ... existing code ...\n')).hookType).toBe('deny')
  })

  it('reads a Copilot CLI create through the real payload normalization', () => {
    const { dir } = setup('solver.py', 50)
    const wire = { tool_name: 'create', tool_input: { path: path.join(dir, 'solver_v2.py'), file_text: nearCopy(50) } }
    const normalized = normalizePayload(wire, 'copilot_cli') as { tool_name: string; tool_input: Record<string, unknown> }
    expect(preWriteRewriteHandler(makeHookEvent({ eventName: 'pre_tool_use', toolName: normalized.tool_name, toolInput: normalized.tool_input, sessionId: 'test' })).hookType).toBe('context')
  })
})
