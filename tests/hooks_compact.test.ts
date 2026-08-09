import { tempConfigPath } from './helpers/temp-config.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted -- this redirects configPath() to a per-test-file temp file so the
// compact_assist.max_manifest_chars wiring test below can set a non-default config value
// deterministically. Mirrors tests/hooks_read.test.ts's config.toml mock.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
  }
})

const _testConfigPath = tempConfigPath('tg-hooks-compact-config-test.toml')

import type { HookEvent } from '../src/hook_registry.js'
import { buildManifest, preCompactHandler } from '../src/hooks_compact.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordFileEdit, recordFileRead, recordWebFetch, recordBashOutput, recordBashRerun } from '../src/session.js'
import { storeBashOutput } from '../src/bash_output_cache.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'

// `mem epoch` (Item I) shells out via spawnSync -- mocked so the suite is deterministic
// regardless of whether a real `mem` binary happens to be on the machine running it, and so
// the ENOENT/non-zero/timeout fail-open paths can be exercised without a real absent/hanging
// binary.
const spawnSyncMock = vi.fn()
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}))

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
  agentId: undefined,
  raw: {},
}

beforeEach(() => {
  clearModuleCaches()
  spawnSyncMock.mockReset()
  // Default: `mem` absent from PATH (ENOENT), matching most dev/CI machines and keeping
  // pre-existing tests that don't care about mem epoch from seeing the new section.
  spawnSyncMock.mockReturnValue({ error: new Error('ENOENT'), status: null, stdout: '' })
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

// Regression: compact_assist.enabled was defined, validated, persisted, exported, and even had
// an env-var override (TOKEN_GOAT_COMPACT_ASSIST) wired in config.ts, but preCompactHandler
// injected the manifest unconditionally -- nothing ever read the flag, so disabling it had zero
// effect on the actual pre_compact hook.
describe('compact_assist.enabled wiring', () => {
  afterEach(() => {
    invalidateConfigCache()
    try {
      fs.unlinkSync(_testConfigPath)
    } catch {
      // ok -- may not exist
    }
  })

  it('returns pass and injects no manifest when compact_assist.enabled is false', () => {
    const cfg = defaultConfig()
    cfg.compact_assist.enabled = false
    saveConfig(cfg)

    const result = preCompactHandler(compactEvent)
    expect(result.hookType).toBe('pass')
  })

  it('still injects the manifest when compact_assist.enabled is true (default)', () => {
    const cfg = defaultConfig()
    cfg.compact_assist.enabled = true
    saveConfig(cfg)

    const result = preCompactHandler(compactEvent)
    expect(result.hookType).toBe('context')
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

  it('collapses an embedded newline in a rerun command so the row stays on one line', async () => {
    const multiline = 'echo one\necho two'
    const rerunId = await storeBashOutput(multiline, 'one\ntwo', 0)
    recordBashOutput('multiline-hash', rerunId, 20)
    recordBashRerun('multiline-hash')

    const manifest = buildManifest()
    const lines = manifest.split('\n')
    const rerunLine = lines.find((l) => l.includes('echo one'))
    expect(rerunLine).toBeDefined()
    expect(rerunLine).toContain('echo two')
  })

  it('collapses an embedded newline in a non-rerun cached command so the row stays on one line', async () => {
    const multiline = 'echo a\necho b'
    const id = await storeBashOutput(multiline, 'a\nb', 0)
    recordBashOutput('multiline-hash2', id, 5)

    const manifest = buildManifest()
    const lines = manifest.split('\n')
    const row = lines.find((l) => l.includes('echo a'))
    expect(row).toBeDefined()
    expect(row).toContain('echo b')
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

describe('mem epoch section', () => {
  it('includes the epoch value when `mem epoch` succeeds', () => {
    spawnSyncMock.mockReturnValue({ error: undefined, status: 0, stdout: '42\n' })

    const manifest = buildManifest()

    expect(manifest).toContain('### mem epoch')
    expect(manifest).toContain('mem epoch: 42')
    expect(manifest).toContain('no live TGMEM block is tracked')
    expect(spawnSyncMock).toHaveBeenCalledWith('mem', ['epoch'], expect.objectContaining({ timeout: expect.any(Number) }))
  })

  it('omits the section cleanly when `mem` is absent from PATH (ENOENT)', () => {
    spawnSyncMock.mockReturnValue({ error: new Error('spawnSync mem ENOENT'), status: null, stdout: '' })

    const manifest = buildManifest()

    expect(manifest).not.toContain('mem epoch')
  })

  it('omits the section cleanly when `mem epoch` exits non-zero', () => {
    spawnSyncMock.mockReturnValue({ error: undefined, status: 1, stdout: '' })

    const manifest = buildManifest()

    expect(manifest).not.toContain('mem epoch')
  })

  it('omits the section cleanly when `mem epoch` times out', () => {
    // node's spawnSync surfaces a timeout as result.error with code ETIMEDOUT and status null.
    const err = Object.assign(new Error('spawnSync mem ETIMEDOUT'), { code: 'ETIMEDOUT' })
    spawnSyncMock.mockReturnValue({ error: err, status: null, stdout: '', signal: 'SIGTERM' })

    const manifest = buildManifest()

    expect(manifest).not.toContain('mem epoch')
  })

  it('omits the section cleanly when spawnSync itself throws', () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error('unexpected spawn failure')
    })

    const manifest = buildManifest()

    expect(manifest).not.toContain('mem epoch')
  })

  it('omits the section cleanly when stdout is not a bare integer', () => {
    spawnSyncMock.mockReturnValue({ error: undefined, status: 0, stdout: 'not-a-number\n' })

    const manifest = buildManifest()

    expect(manifest).not.toContain('mem epoch')
  })

  it('never throws or hangs the manifest build when mem is absent', () => {
    spawnSyncMock.mockReturnValue({ error: new Error('ENOENT'), status: null, stdout: '' })

    expect(() => buildManifest()).not.toThrow()
  })
})

// Regression: compact_assist.max_manifest_chars was defined, validated, persisted, and
// displayed in config.ts but had zero consumers -- buildManifest() concatenated every section
// unconditionally with no overall length cap, contradicting this module's own doc comment
// promising a manifest "well under 2000 chars".
describe('compact_assist.max_manifest_chars wiring', () => {
  afterEach(() => {
    invalidateConfigCache()
    try {
      fs.unlinkSync(_testConfigPath)
    } catch {
      // ok -- may not exist
    }
  })

  it('truncates a manifest that exceeds the configured cap', () => {
    const cfg = defaultConfig()
    cfg.compact_assist.max_manifest_chars = 200
    saveConfig(cfg)

    for (let i = 0; i < 40; i++) {
      recordFileRead(makeTmpFile(`file-${i}`))
    }

    const manifest = buildManifest()
    // Cap (200) plus the appended truncation-note suffix, generously bounded.
    expect(manifest.length).toBeLessThanOrEqual(260)
    expect(manifest).toContain('manifest truncated at 200 chars')
  })

  it('does not truncate a manifest within the configured cap', () => {
    const cfg = defaultConfig()
    cfg.compact_assist.max_manifest_chars = 100_000
    saveConfig(cfg)

    const p = makeTmpFile('hello')
    recordFileRead(p)

    const manifest = buildManifest()
    expect(manifest).not.toContain('manifest truncated at')
  })

  it('max_manifest_chars <= 0 disables the cap entirely', () => {
    const cfg = defaultConfig()
    cfg.compact_assist.max_manifest_chars = 0
    saveConfig(cfg)

    for (let i = 0; i < 40; i++) {
      recordFileRead(makeTmpFile(`file-${i}`))
    }

    const manifest = buildManifest()
    expect(manifest).not.toContain('manifest truncated at')
  })
})
