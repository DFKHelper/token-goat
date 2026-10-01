import { tempConfigPath } from './helpers/temp-config.js'
import * as fs from 'node:fs'
import { parse } from 'smol-toml'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath, projectConfigPath: () => _testProjectConfigPath }
})

const _testConfigPath = tempConfigPath('tg-config-sparse-test.toml')
const _testProjectConfigPath = tempConfigPath('tg-config-sparse-project-test.toml')

import { defaultConfig, invalidateConfigCache, loadConfig, loadPersistedConfig, saveConfig } from '../src/config.js'
import { cmdConfig } from '../src/config_commands.js'

// Provenance: HAND-DERIVED. Counts are of TOML assignment lines computed from the input, independent of the serializer; the 123-assignment figure for the old full snapshot is a CAPTURE of `config set bash_compress.max_lines 200` on an empty isolated home against the 2.9.29 bundle.
function assignmentLines(text: string): string[] {
  return text.split('\n').filter((l) => /^[A-Za-z0-9_]+\s*=/.test(l))
}

describe('saveConfig writes sparsely', () => {
  beforeEach(() => {
    invalidateConfigCache()
    try { fs.unlinkSync(_testConfigPath) } catch { /* ok */ }
    try { fs.unlinkSync(_testProjectConfigPath) } catch { /* ok */ }
  })
  afterEach(() => {
    invalidateConfigCache()
    try { fs.unlinkSync(_testConfigPath) } catch { /* ok */ }
  })

  it('config set from an empty config writes exactly one assignment', () => {
    cmdConfig({ action: 'set', key: 'bash_compress.max_lines', value: '200' })
    const text = fs.readFileSync(_testConfigPath, 'utf8')
    expect(assignmentLines(text)).toEqual(['max_lines = 200'])
    expect(text).not.toMatch(/latency_budget_ms|max_image_pixels|confine_reads_to_project_root/)
  })

  it('config set to a value equal to the default still writes it (the user chose it explicitly)', () => {
    const def = defaultConfig().bash_compress.max_lines
    cmdConfig({ action: 'set', key: 'bash_compress.max_lines', value: String(def) })
    expect(assignmentLines(fs.readFileSync(_testConfigPath, 'utf8'))).toEqual([`max_lines = ${def}`])
  })

  it('a default-equal key already present in the raw file survives an unrelated save', () => {
    const def = defaultConfig().hooks.latency_budget_ms
    fs.writeFileSync(_testConfigPath, `[hooks]\nlatency_budget_ms = ${def}\n`, 'utf8')
    invalidateConfigCache()
    const cfg = loadPersistedConfig()
    cfg.compact_assist.max_manifest_chars = 4242
    saveConfig(cfg)
    const raw = parse(fs.readFileSync(_testConfigPath, 'utf8')) as Record<string, Record<string, unknown>>
    expect(raw['hooks']?.['latency_budget_ms']).toBe(def)
    expect(raw['compact_assist']?.['max_manifest_chars']).toBe(4242)
    expect(assignmentLines(fs.readFileSync(_testConfigPath, 'utf8'))).toHaveLength(2)
  })

  it('a sparse save round-trips: loadConfig before and after is deep-equal for a mixed default and non-default file', () => {
    fs.writeFileSync(_testConfigPath, '[bash_compress]\nmax_lines = 321\nenabled = true\n[hooks]\nlatency_budget_ms = 777\n', 'utf8')
    invalidateConfigCache()
    const before = structuredClone(loadConfig())
    saveConfig(loadPersistedConfig())
    invalidateConfigCache()
    expect(loadConfig()).toEqual(before)
  })

  it('image_shrink.max_image_pixels: the stale 16000000 snapshot loads as the current default, other values are kept', () => {
    fs.writeFileSync(_testConfigPath, '[image_shrink]\nmax_image_pixels = 16000000\n', 'utf8')
    invalidateConfigCache()
    expect(loadConfig().image_shrink.max_image_pixels).toBe(64_000_000)
    fs.writeFileSync(_testConfigPath, '[image_shrink]\nmax_image_pixels = 20000000\n', 'utf8')
    invalidateConfigCache()
    expect(loadConfig().image_shrink.max_image_pixels).toBe(20_000_000)
  })
})
