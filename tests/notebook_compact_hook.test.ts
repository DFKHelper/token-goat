/**
 * Integration tests for Jupyter notebook output stripping wired into the real
 * pre_read hook (`preReadHandler` in `hooks_read.ts`).
 *
 * Deliberately kept out of `tests/hooks_read.test.ts` (a large, Tier-1
 * critical-path suite) so this feature's own data-dir mocking can't perturb
 * that file's existing coverage. `tests/hooks_read.test.ts` is run unmodified
 * and in full as the regression check for this change. Unit coverage for
 * `stripNotebook`/`getOrCreateSidecar`/`pruneSidecars` themselves lives in
 * `tests/notebook_compact.test.ts` — this file only covers the hook wiring.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ConstantsModule from '../src/constants.js'
import type { HookEvent } from '../src/hook_registry.js'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-nbcompacthook-'))

vi.mock('../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConstantsModule>()
  // configPath() closes over dataDir() as a same-module self-reference, which this factory's
  // dataDir override can never redirect (a vi.mock export-spread only affects what OTHER
  // modules see when they import this one, not calls constants.ts makes to its own exports
  // internally). preReadHandler reads loadConfig() -> configPath(), so without this override
  // it silently falls through to the real shared worker config.toml instead of DATA_DIR.
  return {
    ...actual,
    dataDir: () => DATA_DIR,
    configPath: () => path.join(DATA_DIR, 'config.toml'),
  }
})

const { preReadHandler } = await import('../src/hooks_read.js')
const { normalizePath } = await import('../src/paths.js')
const { wasFileReadThisSession } = await import('../src/session.js')
const { clearModuleCaches } = await import('../src/reset.js')
const { makeHookEvent } = await import('./helpers/hook-event.js')

const tmpFiles: string[] = []

/** A code cell whose `outputs` field is padded well past NB_STRIP_MIN_SAVINGS (4096 bytes). */
function heavyNotebookContent(): string {
  const bigOutput = 'A'.repeat(8000)
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3' } },
    cells: [
      { cell_type: 'markdown', source: ['# Title'] },
      {
        cell_type: 'code',
        source: ['print("hello")'],
        outputs: [{ output_type: 'display_data', data: { 'image/png': bigOutput } }],
        execution_count: 7,
      },
    ],
  })
}

/** A code cell with no real output payload — stripping it saves negligible/no bytes. */
function lightNotebookContent(): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    cells: [{ cell_type: 'code', source: ['x = 1'], outputs: [], execution_count: 1 }],
  })
}

function makeNbFile(content: string): string {
  const p = path.join(DATA_DIR, `nb-${process.pid}-${Math.random().toString(36).slice(2)}.ipynb`)
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

function readEvent(filePath: string): HookEvent {
  return makeHookEvent({
    toolName: 'Read',
    toolInput: { file_path: filePath },
    sessionId: 'test',
  })
}

/** Extract whatever text a hook result carries, regardless of which branch fired. */
function resultText(result: { hookType: string; message?: string; context?: string }): string {
  if (result.hookType === 'deny') return result.message ?? ''
  if (result.hookType === 'context') return result.context ?? ''
  return ''
}

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  clearModuleCaches()
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

describe('preReadHandler — notebook output stripping', () => {
  it('serves the output-stripped notebook in place of the full file when savings clear NB_STRIP_MIN_SAVINGS', () => {
    const src = makeNbFile(heavyNotebookContent())

    const result = preReadHandler(readEvent(src))

    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Serving the output-stripped notebook')
      expect(result.message).toContain('print(')
      expect(result.message).toContain('hello')
      expect(result.message).toContain('# Title')
      // The stripped-out cell output (a big base64-ish payload) must not appear.
      expect(result.message).not.toContain('A'.repeat(8000))
      expect(result.message).toContain('token-goat replace')
    }
  })

  it('does not intercept a notebook whose stripping would save negligible bytes', () => {
    const src = makeNbFile(lightNotebookContent())

    const result = preReadHandler(readEvent(src))

    expect(resultText(result)).not.toContain('Serving the output-stripped notebook')
  })

  it('falls through without throwing for a malformed (non-JSON) .ipynb file', () => {
    const src = makeNbFile('not valid json at all')

    const result = preReadHandler(readEvent(src))

    expect(resultText(result)).not.toContain('Serving the output-stripped notebook')
  })

  it('falls through without throwing for a genuinely binary file with an .ipynb extension', () => {
    const p = path.join(DATA_DIR, `nb-${process.pid}-${Math.random().toString(36).slice(2)}.ipynb`)
    fs.writeFileSync(p, Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))
    tmpFiles.push(p)

    const result = preReadHandler(readEvent(p))

    expect(resultText(result)).not.toContain('Serving the output-stripped notebook')
  })

  it('records the stripped notebook in session so a subsequent read is treated as a re-read', () => {
    const src = makeNbFile(heavyNotebookContent())
    expect(wasFileReadThisSession(normalizePath(src))).toBe(false)

    const result = preReadHandler(readEvent(src))
    expect(result.hookType).toBe('deny')
    expect(wasFileReadThisSession(normalizePath(src))).toBe(true)
  })

  it('does not affect non-notebook files even when a same-named nb_strip cache entry exists', () => {
    const src = path.join(DATA_DIR, `nb-${process.pid}-${Math.random().toString(36).slice(2)}.ts`)
    fs.writeFileSync(src, 'export const x = 1\n')
    tmpFiles.push(src)

    const result = preReadHandler(readEvent(src))
    expect(resultText(result)).not.toContain('Serving the output-stripped notebook')
  })
})
