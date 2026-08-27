/**
 * A per-project `.token-goat.toml` arrives with the repository, so it is attacker-controlled the
 * moment anyone clones an untrusted project. `stripLockedProjectKeys` removes the individual keys
 * a project file is not allowed to set, but it can only walk a plain-object section: a TOML
 * array-of-tables (`[[worker]]`) parses to an array, and a bare `worker = 5` to a number, so
 * neither shape has any keys to strip and both passed straight through to the merge.
 *
 * The merge then assigned that value over the global config.toml's section, and `section()`
 * reduced the result to `{}` when the section was read -- so every key in that section fell back
 * to its compiled-in default, including the locked ones. Three lines in a cloned repository were
 * enough to reset `worker.blocked_roots` to `[]` and hand back a folder the user had excluded
 * from the index with `token-goat project exclude`.
 *
 * These tests assert the merged config value, not that the strip ran.
 */

import { tempConfigPath } from './helpers/temp-config.js'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Redirects configPath() at a per-test-file temp file so writing a global config.toml here can never disturb the real per-worker DATA_DIR/config.toml that other test files sharing this Vitest worker read.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath }
})

const _testConfigPath = tempConfigPath('tg-project-config-section-clobber.toml')

const { invalidateConfigCache, loadConfig } = await import('../src/config.js')
const { tempDir } = await import('./helpers/temp-config.js')

const GLOBAL_CONFIG = '[worker]\nblocked_roots = ["secrets", "vendor"]\n\n[hints]\nmcp_dedup_ttl_secs = 99\n'

describe('a project config cannot erase a global section by writing a non-object at its key', () => {
  let root: string

  beforeEach(() => {
    root = tempDir()
    fs.mkdirSync(path.dirname(_testConfigPath), { recursive: true })
    fs.writeFileSync(_testConfigPath, GLOBAL_CONFIG)
    invalidateConfigCache()
  })

  afterEach(() => {
    fs.rmSync(_testConfigPath, { force: true })
    invalidateConfigCache()
  })

  it('keeps the global blocked_roots when the project file has no override at all', () => {
    expect(loadConfig(root).worker.blocked_roots).toEqual(['secrets', 'vendor'])
  })

  it('keeps the global blocked_roots when a project file writes worker as an array-of-tables', () => {
    fs.writeFileSync(path.join(root, '.token-goat.toml'), '[[worker]]\nmax_pool_workers = 8\n')

    expect(loadConfig(root).worker.blocked_roots).toEqual(['secrets', 'vendor'])
  })

  it('keeps the global blocked_roots when a project file writes worker as a bare scalar', () => {
    fs.writeFileSync(path.join(root, '.token-goat.toml'), 'worker = 5\n')

    expect(loadConfig(root).worker.blocked_roots).toEqual(['secrets', 'vendor'])
  })

  // The same shape against an unlocked section: the damage is not specific to a locked key, any global section could be reset to defaults by a cloned repository.
  it('keeps an unlocked global section too when the project file writes an array-of-tables at its key', () => {
    fs.writeFileSync(path.join(root, '.token-goat.toml'), '[[hints]]\nmcp_dedup_ttl_secs = 1\n')

    expect(loadConfig(root).hints.mcp_dedup_ttl_secs).toBe(99)
  })

  // The over-fix control: ignoring a malformed value must not turn into ignoring a well-formed one. A real `[hints]` table still overrides the global value key by key.
  it('still applies a well-formed project override on top of the global section', () => {
    fs.writeFileSync(path.join(root, '.token-goat.toml'), '[hints]\nmcp_dedup_ttl_secs = 42\n')

    expect(loadConfig(root).hints.mcp_dedup_ttl_secs).toBe(42)
    expect(loadConfig(root).worker.blocked_roots).toEqual(['secrets', 'vendor'])
  })

  // The second over-fix control: a project override at a section the global config does not define at all must still reach the merged tree rather than being dropped along with the malformed shapes.
  it('still applies a well-formed project override at a section the global config never mentions', () => {
    fs.writeFileSync(path.join(root, '.token-goat.toml'), '[bash_diff]\nmax_hunks_per_file = 3\n')

    expect(loadConfig(root).bash_diff.max_hunks_per_file).toBe(3)
  })
})
