import { describe, expect, it } from 'vitest'

import { buildProgram } from '../src/cli.js'
import { buildCommandManifest, flattenCommandNames, formatCommandManifest } from '../src/cli_commands.js'
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
    expect(jsonOpt?.description.length).toBeGreaterThan(0)
  })

  it('captures a real command\'s required argument', () => {
    const manifest = buildCommandManifest(buildProgram())
    const symbol = manifest.find((e) => e.name === 'symbol')
    expect(symbol).toBeDefined()
    expect(symbol?.arguments.length).toBeGreaterThan(0)
    expect(symbol?.arguments[0]?.required).toBe(true)
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
})
