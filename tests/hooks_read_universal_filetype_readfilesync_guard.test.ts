import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Regression: the "Universal file type handler" block in hooks_read.ts (the catch-all for non-code, non-markdown large files -- .csv/.txt/.html/etc) used to call fs.readFileSync(normalized, 'utf8') unconditionally, with no size guard, before it had even computed ftEffectiveLength (the requested-slice-aware size the per-type handlers actually gate on). Every OTHER full-content fs.readFileSync in this file guards behind `size <= SLICE_ESTIMATE_SCAN_CAP_BYTES` (2MB) first -- this call site was the one exception. Known-dispatched file types (isKnownFileType, via DISPATCHED_FILE_TYPE_EXTS) are unconditional on size and are explicitly excluded from the earlier whole-file LARGE_FILE_BYTES deny gate, so a multi-GB .csv/.txt/.html file reaches this block regardless of size -- meaning a cheap, bounded offset/limit Read request against such a file triggered a full synchronous read of the entire file into a JS string, even though the resulting small ftEffectiveLength was always going to make the handler return shouldBlock: false without ever touching that content.
//
// vi.spyOn cannot patch node:fs (its namespace exports are non-configurable: "Cannot redefine property"), so a module mock with a hoisted call-count is the portable way to assert readFileSync was never invoked for the oversized file, matching the pattern used in parser_read_failure_swallow.test.ts / index_prune.test.ts.
const mockState = vi.hoisted(() => ({ watchedPath: '', callCount: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const guardedReadFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const target = args[0]
    if (typeof target === 'string' && target === mockState.watchedPath) {
      mockState.callCount++
    }
    return actual.readFileSync(...args)
  }) as typeof actual.readFileSync
  return { ...actual, default: actual, readFileSync: guardedReadFileSync }
})

import * as fs from 'node:fs'

import type { HookEvent } from '../src/hook_registry.js'
import { preReadHandler } from '../src/hooks_read.js'
import { postReadHandler } from '../src/hooks_read_post.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { makeHookEvent } from './helpers/hook-event.js'

const SLICE_ESTIMATE_SCAN_CAP_BYTES = 2 * 1024 * 1024

const tmpFiles: string[] = []

function readEventWithRange(filePath: string, offset?: number, limit?: number): HookEvent {
  const toolInput: Record<string, unknown> = { file_path: filePath }
  if (offset !== undefined) toolInput['offset'] = offset
  if (limit !== undefined) toolInput['limit'] = limit
  return makeHookEvent({
    toolName: 'Read',
    toolInput,
    sessionId: 'test',
  })
}

function makeTmpCsv(totalBytes: number): string {
  const lineTemplate = (i: number) => `line ${i.toString().padStart(6, '0')}: some sample content here\n`
  const perLine = lineTemplate(0).length
  const lineCount = Math.ceil(totalBytes / perLine)
  let content = 'a,b\n'
  for (let i = 0; i < lineCount; i++) content += lineTemplate(i)
  const p = path.join(os.tmpdir(), `tg-read-uft-${process.pid}-${Math.random().toString(36).slice(2)}.csv`)
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

function makeTmpXml(totalBytes: number): string {
  let content = '<root>\n'
  let i = 0
  while (Buffer.byteLength(content, 'utf8') < totalBytes) {
    content += `  <entry id="${i++}">sample content for the read hook</entry>\n`
  }
  content += '</root>\n'
  const p = path.join(os.tmpdir(), `tg-read-uft-${process.pid}-${Math.random().toString(36).slice(2)}.xml`)
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

function makeTmpSource(lineCount: number): string {
  const content = Array.from({ length: lineCount }, (_, i) =>
    `// synthetic source line ${i + 1}: enough content to clear the hint savings floor`,
  ).join('\n') + '\n'
  const p = path.join(os.tmpdir(), `tg-read-post-${process.pid}-${Math.random().toString(36).slice(2)}.ts`)
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

describe('universal file-type handler readFileSync guard (regression)', () => {
  beforeEach(() => {
    clearModuleCaches()
    mockState.watchedPath = ''
    mockState.callCount = 0
  })

  afterEach(() => {
    for (const p of tmpFiles.splice(0)) {
      try {
        fs.unlinkSync(p)
      } catch {
        // best-effort cleanup
      }
    }
  })

  it('does not read a CSV bigger than SLICE_ESTIMATE_SCAN_CAP_BYTES (2MB) into memory just to serve a small bounded offset/limit slice', () => {
    const p = makeTmpCsv(SLICE_ESTIMATE_SCAN_CAP_BYTES + 100_000)
    mockState.watchedPath = normalizePath(p)

    const sliced = preReadHandler(readEventWithRange(p, 1, 50))

    expect(sliced.hookType).not.toBe('deny')
    expect(mockState.callCount).toBe(0)
  })

  it('still reads a CSV at or under SLICE_ESTIMATE_SCAN_CAP_BYTES (2MB) to serve its per-type handler', () => {
    const p = makeTmpCsv(50 * 1024)
    mockState.watchedPath = normalizePath(p)

    preReadHandler(readEventWithRange(p, 1, 50))

    expect(mockState.callCount).toBe(1)
  })

  it('reuses the XML preimage for the type scan and later line-count check', () => {
    const p = makeTmpXml(50 * 1024)
    mockState.watchedPath = normalizePath(p)

    const output = preReadHandler(readEventWithRange(p, 1, 50))

    expect(output.hookType).not.toBe('deny')
    // The type scan's bounded full preimage is shared with the line-count nudge.
    expect(mockState.callCount).toBe(1)
  })

  it('reuses the source preimage for snapshot and structural-navigation checks after a Read', () => {
    const p = makeTmpSource(250)
    mockState.watchedPath = normalizePath(p)

    postReadHandler(makeHookEvent({
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: `post-read-preimage-${process.pid}-${Math.random().toString(36).slice(2)}`,
      raw: { tool_response: 'source read result' },
    }))

    // The fold scan and served-window reconciliation each read independently; the snapshot and
    // structural-navigation gates share their single preimage.
    expect(mockState.callCount).toBe(3)
  })
})
