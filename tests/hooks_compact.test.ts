import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { buildManifest, preCompactHandler } from '../src/hooks_compact.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordFileEdit, recordFileRead, recordWebFetch, recordBashOutput, recordBashRerun } from '../src/session.js'
import { storeBashOutput } from '../src/bash_output_cache.js'

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
    recordWebFetch('https://example.com', '', 'abc123')
    const manifest = buildManifest()
    expect(manifest).toContain('### Web URLs fetched')
    expect(manifest).toContain('https://example.com')
    expect(manifest).toContain('cacheId: abc123')
  })

  it('does not clobber same-url fetches made with different prompts', () => {
    recordWebFetch('https://example.com/doc', 'prompt A', 'cache-a')
    recordWebFetch('https://example.com/doc', 'prompt B', 'cache-b')
    const manifest = buildManifest()
    expect(manifest).toContain('cacheId: cache-a')
    expect(manifest).toContain('cacheId: cache-b')
  })

  it('stays under 2000 chars for a typical session', () => {
    for (let i = 0; i < 10; i++) {
      const p = makeTmpFile(`content-${i}`)
      recordFileRead(p)
      if (i % 2 === 0) recordFileEdit(p)
    }
    recordWebFetch('https://example.com/docs', '', 'cache-xyz')
    const manifest = buildManifest()
    expect(manifest.length).toBeLessThan(2000)
  })

  it('does not list a file twice in the Read files / Edited files sections if it was both read and edited', () => {
    const p = makeTmpFile('data')
    recordFileRead(p)
    recordFileEdit(p)
    const manifest = buildManifest()
    // The "### Read files"/"### Edited files" sections are mutually exclusive per file (a file
    // is either read-only or edited, never both); the SAFE_TO_DISCARD section added afterward
    // may separately reference the same file (a read followed by an edit is exactly what its
    // "superseded file reads" class flags), so isolate the manifest to before that section.
    const beforeSafeToDiscard = manifest.split('### SAFE_TO_DISCARD')[0]!
    const basename = path.basename(p)
    const matches = beforeSafeToDiscard.match(new RegExp(basename, 'g')) || []
    expect(matches.length).toBeLessThanOrEqual(1)
  })
})

describe('SAFE_TO_DISCARD section', () => {
  it('is absent for an empty session', () => {
    const manifest = buildManifest()
    expect(manifest).not.toContain('SAFE_TO_DISCARD')
  })

  it('lists a superseded rerun with its recall command, and does not list a single, non-rerun cached output as a rerun', async () => {
    const rerunId = await storeBashOutput('pytest', 'all passed (latest)', 0)
    recordBashOutput('pytest-hash', rerunId, 20)
    recordBashRerun('pytest-hash')

    const singleId = await storeBashOutput('eslint src', 'clean', 0)
    recordBashOutput('eslint-hash', singleId, 5)

    const manifest = buildManifest()
    expect(manifest).toContain('SAFE_TO_DISCARD')
    expect(manifest).toContain('Superseded reruns (1):')
    expect(manifest).toContain('pytest')
    expect(manifest).toContain('bash-output ' + rerunId)
    expect(manifest).toContain('Other cached bash outputs (1):')
    expect(manifest).toContain('eslint src')
    expect(manifest).toContain('bash-output ' + singleId)
  })

  it('does not double-list a rerun command under "Other cached bash outputs"', async () => {
    const id = await storeBashOutput('vitest run', 'ok', 0)
    recordBashOutput('vitest-hash', id, 2)
    recordBashRerun('vitest-hash')

    const manifest = buildManifest()
    // The command should appear exactly once total across the two bash sub-sections.
    const matches = manifest.match(/vitest run/g) ?? []
    expect(matches.length).toBe(1)
    expect(manifest).not.toContain('Other cached bash outputs')
  })

  it('lists a re-read file as a superseded read', () => {
    const p = makeTmpFile('hello')
    recordFileRead(p)
    recordFileRead(p)
    const manifest = buildManifest()
    expect(manifest).toContain('SAFE_TO_DISCARD')
    expect(manifest).toContain('Superseded file reads (1):')
    expect(manifest).toContain('re-read 2x')
  })

  it('lists a read-then-edited file as a superseded read', () => {
    const p = makeTmpFile('hello')
    recordFileRead(p)
    recordFileEdit(p)
    const manifest = buildManifest()
    expect(manifest).toContain('Superseded file reads (1):')
    expect(manifest).toContain('edited after being read')
  })

  it('does not flag a file read exactly once and never edited', () => {
    const p = makeTmpFile('hello')
    recordFileRead(p)
    const manifest = buildManifest()
    expect(manifest).not.toContain('Superseded file reads')
  })

  it('includes an explicit total item count in the section header', async () => {
    const p = makeTmpFile('hello')
    recordFileRead(p)
    recordFileRead(p)
    const id = await storeBashOutput('npm run build', 'built', 0)
    recordBashOutput('build-hash', id, 5)
    recordBashRerun('build-hash')

    const manifest = buildManifest()
    expect(manifest).toContain('SAFE_TO_DISCARD (2 items')
  })
})
