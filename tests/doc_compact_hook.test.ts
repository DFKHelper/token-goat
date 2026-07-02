/**
 * Integration tests for the stable-doc compact sidecar wired into the real
 * pre_read hook (`preReadHandler` in `hooks_read.ts`).
 *
 * Deliberately kept out of `tests/hooks_read.test.ts` (a large, Tier-1
 * critical-path suite) so this feature's own config-path/data-dir mocking
 * can't perturb that file's existing coverage. `tests/hooks_read.test.ts`
 * is run unmodified and in full as the regression check for this change.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../src/constants.js'
import type { HookEvent } from '../src/hook_registry.js'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-doccompacthook-'))
const TEST_CONFIG_PATH = path.join(DATA_DIR, 'config.toml')

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  return { ...actual, dataDir: () => DATA_DIR, configPath: () => TEST_CONFIG_PATH }
})

const { preReadHandler } = await import('../src/hooks_read.js')
const { invalidateConfigCache } = await import('../src/config.js')
const { compactPathFor, isCompactFresh, writeCompact, buildExtractiveCompact } = await import(
  '../src/doc_compact.js'
)
const { clearModuleCaches } = await import('../src/reset.js')

const tmpFiles: string[] = []

function makeMdFile(content = '# Title\nLine 1\nLine 2\nLine 3\n'): string {
  const p = path.join(DATA_DIR, `doc-${process.pid}-${Math.random().toString(36).slice(2)}.md`)
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

function readEvent(filePath: string): HookEvent {
  return {
    eventName: 'pre_tool_use',
    toolName: 'Read',
    toolInput: { file_path: filePath },
    sessionId: 'test',
    raw: {},
  }
}

/** Extract whatever text a hook result carries, regardless of which branch fired. */
function resultText(result: { hookType: string; message?: string; context?: string }): string {
  if (result.hookType === 'deny') return result.message ?? ''
  if (result.hookType === 'context') return result.context ?? ''
  return ''
}

beforeEach(() => {
  clearModuleCaches()
  try {
    fs.unlinkSync(TEST_CONFIG_PATH)
  } catch {
    // ok — no config file from a previous test
  }
  invalidateConfigCache()
})

afterEach(() => {
  clearModuleCaches()
  try {
    fs.unlinkSync(TEST_CONFIG_PATH)
  } catch {
    // ok
  }
  invalidateConfigCache()
  while (tmpFiles.length > 0) {
    const p = tmpFiles.pop()
    if (p === undefined) continue
    try {
      fs.unlinkSync(p)
    } catch {
      // best-effort cleanup
    }
  }
})

describe('preReadHandler — stable-doc compact serving', () => {
  it('serves the compact body in place of the full file when a fresh sidecar exists', () => {
    const src = makeMdFile('# Title\nLine 1\nLine 2\nLine 3\nLine 4\n')
    const compactPath = compactPathFor(src)
    const body = buildExtractiveCompact(fs.readFileSync(src, 'utf-8'))
    writeCompact(compactPath, src, body)
    expect(isCompactFresh(compactPath, src)).toBe(true)

    const result = preReadHandler(readEvent(src))

    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('# Title')
      expect(result.message).toContain('Line 1')
      // Default sentences-per-section is 2, so lines beyond that are dropped —
      // proves the compact (not the raw full file) is what got served.
      expect(result.message).not.toContain('Line 4')
      expect(result.message).toContain('compact-doc')
    }
  })

  it('does not serve a compact when no sidecar exists for the file', () => {
    const src = makeMdFile()
    const result = preReadHandler(readEvent(src))
    expect(resultText(result)).not.toContain('Serving the extractive compact sidecar')
  })

  it('does not serve the compact when stable_doc_compacts is disabled', () => {
    fs.writeFileSync(TEST_CONFIG_PATH, '[hints]\nstable_doc_compacts = false\n')
    invalidateConfigCache()

    const src = makeMdFile('# Title\nLine 1\nLine 2\nLine 3\nLine 4\n')
    const compactPath = compactPathFor(src)
    writeCompact(compactPath, src, buildExtractiveCompact(fs.readFileSync(src, 'utf-8')))
    expect(isCompactFresh(compactPath, src)).toBe(true)

    const result = preReadHandler(readEvent(src))
    expect(resultText(result)).not.toContain('Serving the extractive compact sidecar')
  })

  it('does not serve a stale compact (source changed since the sidecar was built)', () => {
    const src = makeMdFile('# Title\nLine 1\n')
    const compactPath = compactPathFor(src)
    writeCompact(compactPath, src, buildExtractiveCompact(fs.readFileSync(src, 'utf-8')))
    expect(isCompactFresh(compactPath, src)).toBe(true)

    fs.writeFileSync(src, '# Title\nChanged line entirely.\n')
    expect(isCompactFresh(compactPath, src)).toBe(false)

    const result = preReadHandler(readEvent(src))
    expect(resultText(result)).not.toContain('Serving the extractive compact sidecar')
  })

  it('re-serves the compact on every read attempt while it stays fresh (not just the first)', () => {
    const src = makeMdFile('# Title\nLine 1\nLine 2\n')
    const compactPath = compactPathFor(src)
    writeCompact(compactPath, src, buildExtractiveCompact(fs.readFileSync(src, 'utf-8')))

    const first = preReadHandler(readEvent(src))
    const second = preReadHandler(readEvent(src))

    expect(first.hookType).toBe('deny')
    expect(second.hookType).toBe('deny')
    if (first.hookType === 'deny' && second.hookType === 'deny') {
      expect(second.message).toBe(first.message)
    }
  })

  it('does not affect non-doc files even when a same-named compact directory exists', () => {
    const src = path.join(DATA_DIR, `doc-${process.pid}-${Math.random().toString(36).slice(2)}.ts`)
    fs.writeFileSync(src, 'export const x = 1\n')
    tmpFiles.push(src)

    const result = preReadHandler(readEvent(src))
    expect(resultText(result)).not.toContain('Serving the extractive compact sidecar')
  })
})
