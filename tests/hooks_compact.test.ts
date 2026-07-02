import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { buildManifest, preCompactHandler } from '../src/hooks_compact.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordFileEdit, recordFileRead, recordWebFetch } from '../src/session.js'

const tmpFiles: string[] = []

function makeTmpFile(content = 'data'): string {
  const p = path.join(
    os.tmpdir(),
    `tg-compact-${process.pid}-${Math.random().toString(36).slice(2)}.txt`,
  )
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

const compactEvent: HookEvent = {
  eventName: 'pre_compact',
  toolName: undefined,
  toolInput: {},
  sessionId: 'test',
  raw: {},
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

describe('preCompactHandler', () => {
  it('returns a context output', () => {
    const result = preCompactHandler(compactEvent)
    expect(result.hookType).toBe('context')
  })

  it('manifest contains a "Files read:" line even for an empty session', () => {
    const result = preCompactHandler(compactEvent)
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('Files read:')
      expect(result.context).toContain('Files edited:')
    }
  })
})

describe('buildManifest', () => {
  it('lists read files with a count', () => {
    const p = makeTmpFile('hello')
    recordFileRead(p)
    recordFileRead(p)
    const manifest = buildManifest()
    expect(manifest).toContain('### Read files')
    expect(manifest).toContain('2 reads')
  })

  it('includes an edited-files section only when edits exist', () => {
    const noEdits = buildManifest()
    expect(noEdits).not.toContain('### Edited files')

    const p = makeTmpFile('hello')
    recordFileEdit(p)
    const withEdits = buildManifest()
    expect(withEdits).toContain('### Edited files')
    expect(withEdits).toContain('Files edited: 1')
  })

  it('includes a web URLs section when fetches exist', () => {
    recordWebFetch('https://example.com', 'abc123')
    const manifest = buildManifest()
    expect(manifest).toContain('### Web URLs fetched')
    expect(manifest).toContain('https://example.com')
    expect(manifest).toContain('cacheId: abc123')
  })

  it('stays under 2000 chars for a typical session', () => {
    for (let i = 0; i < 10; i++) {
      const p = makeTmpFile(`content-${i}`)
      recordFileRead(p)
      if (i % 2 === 0) recordFileEdit(p)
    }
    recordWebFetch('https://example.com/docs', 'cache-xyz')
    const manifest = buildManifest()
    expect(manifest.length).toBeLessThan(2000)
  })

  it('does not list a file twice if it was both read and edited', () => {
    const p = makeTmpFile('data')
    recordFileRead(p)
    recordFileEdit(p)
    const manifest = buildManifest()
    // Find the basename since paths are rendered with slashes
    const basename = path.basename(p)
    // Count occurrences of the basename in the manifest
    const matches = manifest.match(new RegExp(basename, 'g')) || []
    // Should appear in exactly one section, not both
    expect(matches.length).toBeLessThanOrEqual(1)
  })
})
