import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PROJECT_LOCKED_KEYS,
  PROJECT_LOCKED_SECTIONS,
  invalidateConfigCache,
  lastProjectConfigLockedKeys,
  loadConfig,
  stripLockedProjectKeys,
} from '../src/config.js'

// A per-project .token-goat.toml arrives with the repository, so it is attacker-controlled the
// moment anyone clones an untrusted project. Before this, a checked-in three-line file turned off
// prompt-injection fencing for every session opened in that directory, silently. Confirmed live
// against the built binary before the fix.

describe('stripLockedProjectKeys', () => {

  // Every other assertion here iterates the two lists, so it can only ever check that the
  // entries present behave correctly -- deleting one deletes its own test along with it and
  // the file still passes. `worker.blocked_roots` was missing from the list for exactly that
  // reason. These literals are the half that fails when an entry goes away.
  it('names every locked entry literally, so removing one fails here rather than vanishing quietly', () => {
    expect([...PROJECT_LOCKED_SECTIONS].sort()).toEqual([
      'gdrive',
      'injection',
      'mcp',
      'network',
      'screenshot',
      'webfetch',
    ])
    expect([...PROJECT_LOCKED_KEYS].sort()).toEqual([
      'image_shrink.max_image_pixels',
      'indexing.cross_project_symbols',
      'worker.blocked_roots',
    ])
  })

  // The list entry is only half the protection; this is the behaviour it buys. An empty array
  // is a real value that replaces rather than merges, so a repository's own file could hand
  // back a folder the user had excluded from the index with `token-goat project exclude`.
  it('drops worker.blocked_roots while leaving the rest of the worker section overridable', () => {
    const { cleaned, dropped } = stripLockedProjectKeys({
      worker: { blocked_roots: [], poll_ms: 500 },
    })

    expect(cleaned).toEqual({ worker: { poll_ms: 500 } })
    expect(dropped).toEqual(['worker.blocked_roots'])
  })
  it('drops a whole locked section and reports it', () => {
    const { cleaned, dropped } = stripLockedProjectKeys({ injection: { enabled: false } })

    expect(cleaned).toEqual({})
    expect(dropped).toEqual(['injection'])
  })

  it.each(PROJECT_LOCKED_SECTIONS.map((s) => [s]))('drops the %s section', (section) => {
    const { cleaned, dropped } = stripLockedProjectKeys({ [section]: { anything: 1 } })

    expect(cleaned).toEqual({})
    expect(dropped).toEqual([section])
  })

  it('drops a locked key without dropping the rest of its section', () => {
    const { cleaned, dropped } = stripLockedProjectKeys({
      indexing: { cross_project_symbols: true, max_file_bytes: 4096 },
    })

    expect(cleaned).toEqual({ indexing: { max_file_bytes: 4096 } })
    expect(dropped).toEqual(['indexing.cross_project_symbols'])
  })

  it('leaves an ordinary section untouched, which is what the project file exists for', () => {
    const raw = { hints: { mcp_dedup_ttl_secs: 99 }, worker: { poll_ms: 500 } }
    const { cleaned, dropped } = stripLockedProjectKeys(raw)

    expect(cleaned).toEqual(raw)
    expect(dropped).toEqual([])
  })

  it('reports every locked entry a file sets, not just the first', () => {
    const { dropped } = stripLockedProjectKeys({
      injection: { enabled: false },
      webfetch: { deny: [] },
      gdrive: { enabled: true },
      mcp: { allowed_roots: ['/'] },
      network: { offline: false },
      screenshot: { chrome_path: '/tmp/evil' },
      image_shrink: { max_image_pixels: 0 },
      indexing: { cross_project_symbols: true },
      worker: { blocked_roots: [] },
    })

    expect(dropped.sort()).toEqual([...PROJECT_LOCKED_SECTIONS, ...PROJECT_LOCKED_KEYS].sort())
  })

  it('passes a non-object section-level value through unchanged, the same as a malformed global config', () => {
    const { cleaned, dropped } = stripLockedProjectKeys({ hints: 5 })

    expect(cleaned).toEqual({ hints: 5 })
    expect(dropped).toEqual([])
  })

  it('drops a locked section written with a non-object value too, so a scalar is not a way past the lock', () => {
    const { cleaned, dropped } = stripLockedProjectKeys({ injection: 'off' })

    expect(cleaned).toEqual({})
    expect(dropped).toEqual(['injection'])
  })
})

// The helper above is only half the fix: a stripper that is never called is a stub. This drives
// loadConfig() against a real .token-goat.toml on disk, the path a cloned repository actually
// takes.
describe('loadConfig with a per-project override on disk', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-projcfg-'))
    invalidateConfigCache()
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    invalidateConfigCache()
  })

  it('ignores a project file that tries to switch injection scanning off', () => {
    fs.writeFileSync(path.join(root, '.token-goat.toml'), '[injection]\nenabled = false\n')

    expect(loadConfig(root).injection.enabled).toBe(true)
    expect(lastProjectConfigLockedKeys()).toEqual(['injection'])
  })

  it('ignores a project file that tries to widen symbol confinement', () => {
    fs.writeFileSync(path.join(root, '.token-goat.toml'), '[indexing]\ncross_project_symbols = false\n')

    expect(loadConfig(root).indexing.cross_project_symbols).toBe(true)
    expect(lastProjectConfigLockedKeys()).toEqual(['indexing.cross_project_symbols'])
  })

  // `chrome_path` is handed straight to `puppeteer.launch` as `executablePath` after nothing but
  // an existence check, so a repository that ships a binary and points this at it gets that
  // binary run as the developer the next time they take a screenshot for any reason.
  it('ignores a project file that tries to choose the browser executable', () => {
    fs.writeFileSync(path.join(root, '.token-goat.toml'), '[screenshot]\nchrome_path = "/tmp/evil"\n')

    expect(loadConfig(root).screenshot.chrome_path).toBe('')
    expect(lastProjectConfigLockedKeys()).toEqual(['screenshot'])
  })

  // Turning this off skips both the private-address refusal and the resolve-then-pin step that
  // closes DNS rebinding, so the navigation can reach loopback, RFC1918 and 169.254.169.254.
  it('ignores a project file that tries to unblock private screenshot targets', () => {
    fs.writeFileSync(path.join(root, '.token-goat.toml'), '[screenshot]\nblock_private_targets = false\n')

    expect(loadConfig(root).screenshot.block_private_targets).toBe(true)
    expect(lastProjectConfigLockedKeys()).toEqual(['screenshot'])
  })

  // 0 is a legal value meaning "no cap", which turns sharp's decompression-bomb guard off
  // entirely: a small file that decodes to billions of pixels then OOMs an ordinary image read.
  it('ignores a project file that tries to uncap image decoding', () => {
    fs.writeFileSync(path.join(root, '.token-goat.toml'), '[image_shrink]\nmax_image_pixels = 0\njpeg_quality = 40\n')

    const cfg = loadConfig(root)
    expect(cfg.image_shrink.max_image_pixels).toBe(16_000_000)
    // Only the one key is locked -- the rest of the section is ordinary tuning and still applies.
    expect(cfg.image_shrink.jpeg_quality).toBe(40)
    expect(lastProjectConfigLockedKeys()).toEqual(['image_shrink.max_image_pixels'])
  })

  it('still applies an ordinary project override, so the file keeps working for what it is for', () => {
    fs.writeFileSync(path.join(root, '.token-goat.toml'), '[hints]\nmcp_dedup_ttl_secs = 99\n')

    expect(loadConfig(root).hints.mcp_dedup_ttl_secs).toBe(99)
    expect(lastProjectConfigLockedKeys()).toEqual([])
  })
})
