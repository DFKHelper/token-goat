import { describe, expect, it } from 'vitest'

import { buildProgram } from '../src/cli.js'
import { buildCommandManifest, filterCommandManifest, flattenCommandNames, formatCommandManifest } from '../src/cli_commands.js'
import { allCommandNames } from './registry.js'

describe('buildCommandManifest', () => {
  it('excludes the built-in help command', () => {
    const manifest = buildCommandManifest(buildProgram())
    expect(manifest.some((e) => e.name === 'help')).toBe(false)
    const worker = manifest.find((e) => e.name === 'worker')
    expect(worker?.subcommands.some((s) => s.name === 'help')).toBe(false)
  })

  it('gives every top-level entry a name, a description, and an options array', () => {
    const manifest = buildCommandManifest(buildProgram())
    expect(manifest.length).toBeGreaterThan(10)
    for (const entry of manifest) {
      expect(entry.name.length).toBeGreaterThan(0)
      expect(entry.description.length).toBeGreaterThan(0)
      expect(Array.isArray(entry.options)).toBe(true)
      expect(Array.isArray(entry.arguments)).toBe(true)
      expect(Array.isArray(entry.subcommands)).toBe(true)
    }
  })

  it('nests subcommands, matching worker start/stop/status', () => {
    const manifest = buildCommandManifest(buildProgram())
    const worker = manifest.find((e) => e.name === 'worker')
    expect(worker).toBeDefined()
    expect(worker?.subcommands.map((s) => s.name).sort()).toEqual(['start', 'status', 'stop'])
  })

  it('captures a real command\'s options with flags and description', () => {
    const manifest = buildCommandManifest(buildProgram())
    const bridgesStatus = manifest.find((e) => e.name === 'bridges-status')
    expect(bridgesStatus).toBeDefined()
    const jsonOpt = bridgesStatus?.options.find((o) => o.flags.includes('--json'))
    expect(jsonOpt).toBeDefined()
    // Pin the real registered description text instead of just ">0", so a regression that
    // swapped in the wrong option's description (still non-empty) is caught too.
    expect(jsonOpt?.description).toBe('emit the matrix as JSON instead of text')
  })

  it('captures a real command\'s required argument', () => {
    const manifest = buildCommandManifest(buildProgram())
    const symbol = manifest.find((e) => e.name === 'symbol')
    expect(symbol).toBeDefined()
    // `symbol <name>` takes exactly one required argument -- pin the exact count so a
    // regression that dropped or duplicated the argument list (still non-empty) is caught too.
    expect(symbol?.arguments.length).toBe(1)
    expect(symbol?.arguments[0]?.required).toBe(true)
  })

  it('captures a real command\'s registered aliases', () => {
    const manifest = buildCommandManifest(buildProgram())
    const compress = manifest.find((e) => e.name === 'compress')
    expect(compress).toBeDefined()
    expect(compress?.aliases).toEqual(['bash', 'run'])
  })

  it('gives a command with no aliases an empty aliases array', () => {
    const manifest = buildCommandManifest(buildProgram())
    const symbol = manifest.find((e) => e.name === 'symbol')
    expect(symbol).toBeDefined()
    expect(symbol?.aliases).toEqual([])
  })
})

describe('flattenCommandNames', () => {
  it('produces the exact same flat name set as the pre-existing allCommandNames() helper', () => {
    const manifest = buildCommandManifest(buildProgram())
    const flattened = flattenCommandNames(manifest).sort()
    const legacy = allCommandNames().sort()
    expect(flattened).toEqual(legacy)
  })

  it('includes parent-sub entries for subcommands', () => {
    const manifest = buildCommandManifest(buildProgram())
    const names = flattenCommandNames(manifest)
    expect(names).toContain('worker start')
    expect(names).toContain('worker stop')
    expect(names).toContain('worker status')
  })

  it('does not surface aliases as separate flattened names (README/matrix guards stay name-only)', () => {
    const manifest = buildCommandManifest(buildProgram())
    const names = flattenCommandNames(manifest)
    expect(names).toContain('compress')
    expect(names).not.toContain('bash')
    expect(names).not.toContain('run')
  })
})

describe('filterCommandManifest', () => {
  it('matches a name substring, dropping unrelated entries', () => {
    const manifest = buildCommandManifest(buildProgram())
    const filtered = filterCommandManifest(manifest, 'symbol')
    expect(filtered.map((e) => e.name)).toContain('symbol')
    expect(filtered.map((e) => e.name)).not.toContain('install')
  })

  it('matches on description alone, with no substring hit in the name', () => {
    const manifest = buildCommandManifest(buildProgram())
    const bashOutput = manifest.find((e) => e.name === 'bash-output')
    expect(bashOutput?.description.toLowerCase()).toContain('cached')
    const filtered = filterCommandManifest(manifest, 'cached')
    expect(filtered.map((e) => e.name)).toContain('bash-output')
  })

  it('matches on a registered alias (compress via its "bash" alias)', () => {
    const manifest = buildCommandManifest(buildProgram())
    const filtered = filterCommandManifest(manifest, '^bash$')
    expect(filtered.map((e) => e.name)).toContain('compress')
  })

  it('keeps every subcommand when the parent itself matches', () => {
    const manifest = buildCommandManifest(buildProgram())
    const filtered = filterCommandManifest(manifest, 'worker')
    const worker = filtered.find((e) => e.name === 'worker')
    expect(worker?.subcommands.map((s) => s.name).sort()).toEqual(['start', 'status', 'stop'])
  })

  it('keeps only the matching subcommand when the parent itself does not match', () => {
    const manifest = buildCommandManifest(buildProgram())
    const filtered = filterCommandManifest(manifest, 'start')
    const worker = filtered.find((e) => e.name === 'worker')
    expect(worker).toBeDefined()
    expect(worker?.subcommands.map((s) => s.name)).toEqual(['start'])
  })

  it('returns an empty array for a pattern matching nothing', () => {
    const manifest = buildCommandManifest(buildProgram())
    expect(filterCommandManifest(manifest, 'zzz-no-such-command-exists')).toEqual([])
  })

  it('falls back to a literal substring match on an invalid regex pattern', () => {
    const manifest = buildCommandManifest(buildProgram())
    // "(" alone is an invalid regex; the fallback path does a literal substring search instead
    // of throwing, and this nonsense pattern (still containing an unbalanced "(") matches nothing.
    expect(filterCommandManifest(manifest, 'zzz-no-such-command-exists(')).toEqual([])
  })
})

describe('formatCommandManifest', () => {
  it('renders a heading, every top-level command name, and its options', () => {
    const manifest = buildCommandManifest(buildProgram())
    const text = formatCommandManifest(manifest)
    expect(text).toContain('# token-goat commands')
    for (const entry of manifest) {
      expect(text).toContain(entry.name)
    }
    expect(text).toContain('--json')
  })

  it('round-trips through JSON.stringify without losing any field', () => {
    const manifest = buildCommandManifest(buildProgram())
    const json = JSON.parse(JSON.stringify(manifest)) as typeof manifest
    expect(json).toEqual(manifest)
  })

  it('renders a command\'s aliases in the text listing', () => {
    const manifest = buildCommandManifest(buildProgram())
    const text = formatCommandManifest(manifest)
    expect(text).toContain('## compress (alias: bash, run)')
  })

  it('does not add an alias marker for a command with no aliases', () => {
    const manifest = buildCommandManifest(buildProgram())
    const text = formatCommandManifest(manifest)
    expect(text).toContain('## symbol -- ')
    expect(text).not.toMatch(/## symbol \(alias:/)
  })
})
