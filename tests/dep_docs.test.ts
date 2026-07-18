/**
 * Unit tests for `dep_docs.ts` (`token-goat dep-docs <package>`).
 *
 * Runs against a real installed package in this repo's own `node_modules` (commander,
 * a direct dependency — see package.json) so README/package.json/types resolution is
 * exercised against the real thing, not just synthetic fixtures, plus a synthetic
 * fixture package for the not-found/truncation/edge-case paths that need controlled input.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(),
}))

import { runDepDocs, extractDtsOutline, setTsModuleForTesting } from '../src/dep_docs.js'
import { loadConfig } from '../src/config.js'
import { ROOT } from './helpers/bundle.js'

const mockLoadConfig = vi.mocked(loadConfig)

const DEFAULT_CONFIG = { overflow_guard: { enabled: true, max_tokens: 25000 } } as unknown as ReturnType<typeof loadConfig>

describe('runDepDocs — real installed package (commander)', () => {
  beforeEach(() => {
    mockLoadConfig.mockReturnValue(DEFAULT_CONFIG)
  })

  it('resolves package.json metadata, README, and a .d.ts declaration outline for a real installed package', () => {
    const { text, code } = runDepDocs({ packageName: 'commander', projectRoot: ROOT })
    expect(code).toBe(0)
    expect(text).toContain('commander')
    expect(text).toContain('# commander')
    expect(text).toMatch(/Types: .*index\.d\.ts/)
    expect(text).toContain('## Type declarations')
    expect(text).toContain('class')
    expect(text).toContain('## README')
  })

  it('emits the same data as structured JSON with package/readme/types/declarations fields', () => {
    const { text, code } = runDepDocs({ packageName: 'commander', projectRoot: ROOT, json: true })
    expect(code).toBe(0)
    const parsed = JSON.parse(text) as {
      package: string
      version: string | null
      description: string | null
      readme: { file: string; text: string; truncated: boolean } | null
      types: { entry: string; source: string } | null
      typescriptAvailable: boolean
      declarations: { items: unknown[]; truncated: boolean; totalCount: number } | null
    }
    expect(parsed.package).toBe('commander')
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(parsed.readme).not.toBeNull()
    expect(parsed.readme?.file).toMatch(/[Rr]eadme/)
    expect(parsed.types).not.toBeNull()
    expect(parsed.types?.source).toBe('bundled')
    expect(parsed.typescriptAvailable).toBe(true)
    expect(parsed.declarations).not.toBeNull()
    expect(parsed.declarations?.totalCount).toBeGreaterThan(0)
    const names = (parsed.declarations?.items as Array<{ name: string }>).map((d) => d.name)
    expect(names).toContain('Command')
  })
})

describe('runDepDocs — package not found', () => {
  let dir: string

  beforeEach(() => {
    mockLoadConfig.mockReturnValue(DEFAULT_CONFIG)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dep-docs-'))
    fs.mkdirSync(path.join(dir, 'node_modules', 'commander-like'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'node_modules', 'commander-like', 'package.json'),
      JSON.stringify({ name: 'commander-like', version: '1.0.0' }),
    )
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('exits non-zero with a clear error including a did-you-mean suggestion for a near-miss name', () => {
    const { text, code } = runDepDocs({ packageName: 'commander-lik', projectRoot: dir })
    expect(code).toBe(1)
    expect(text).toContain("Package 'commander-lik' not found")
    expect(text).toContain('did you mean')
    expect(text).toContain('commander-like')
  })

  it('exits non-zero with no did-you-mean suggestion when nothing is close', () => {
    const { text, code } = runDepDocs({ packageName: 'totally-unrelated-xyz', projectRoot: dir })
    expect(code).toBe(1)
    expect(text).toContain("Package 'totally-unrelated-xyz' not found")
    expect(text).not.toContain('did you mean')
  })

  it('reports not-found (rather than throwing) when there is no node_modules directory at all', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dep-docs-empty-'))
    try {
      const { text, code } = runDepDocs({ packageName: 'anything', projectRoot: emptyDir })
      expect(code).toBe(1)
      expect(text).toContain("Package 'anything' not found")
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})

describe('runDepDocs — README truncation (overflow guard)', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dep-docs-huge-'))
    const pkgDir = path.join(dir, 'node_modules', 'huge-readme-pkg')
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'huge-readme-pkg', version: '1.0.0' }))
    fs.writeFileSync(path.join(pkgDir, 'README.md'), 'x'.repeat(200_000))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('caps the text-mode output at overflow_guard.max_tokens instead of dumping the whole README (regression target: an unbounded README defeats the point of a token-savings tool)', () => {
    mockLoadConfig.mockReturnValue({ overflow_guard: { enabled: true, max_tokens: 50 } } as unknown as ReturnType<typeof loadConfig>)
    const { text, code } = runDepDocs({ packageName: 'huge-readme-pkg', projectRoot: dir })
    expect(code).toBe(0)
    expect(text.length).toBeLessThan(200_000)
    expect(text).toContain('output capped at ~50 tokens')
  })

  it('truncates the README field under --json and sets truncated: true, rather than emitting an unbounded string', () => {
    mockLoadConfig.mockReturnValue({ overflow_guard: { enabled: true, max_tokens: 50 } } as unknown as ReturnType<typeof loadConfig>)
    const { text, code } = runDepDocs({ packageName: 'huge-readme-pkg', projectRoot: dir, json: true })
    expect(code).toBe(0)
    const parsed = JSON.parse(text) as { readme: { text: string; truncated: boolean } | null }
    expect(parsed.readme?.truncated).toBe(true)
    expect(parsed.readme?.text.length).toBeLessThan(200_000)
  })

  it('does not truncate when overflow_guard is disabled', () => {
    mockLoadConfig.mockReturnValue({ overflow_guard: { enabled: false, max_tokens: 50 } } as unknown as ReturnType<typeof loadConfig>)
    const { text, code } = runDepDocs({ packageName: 'huge-readme-pkg', projectRoot: dir, json: true })
    expect(code).toBe(0)
    const parsed = JSON.parse(text) as { readme: { text: string; truncated: boolean } | null }
    expect(parsed.readme?.truncated).toBe(false)
    expect(parsed.readme?.text.length).toBe(200_000)
  })
})

describe('runDepDocs — no bundled types, no @types companion', () => {
  let dir: string

  beforeEach(() => {
    mockLoadConfig.mockReturnValue(DEFAULT_CONFIG)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dep-docs-notypes-'))
    const pkgDir = path.join(dir, 'node_modules', 'no-types-pkg')
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'no-types-pkg', version: '2.0.0', main: 'index.js' }))
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = {}\n')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reports no types found rather than crashing', () => {
    const { text, code } = runDepDocs({ packageName: 'no-types-pkg', projectRoot: dir })
    expect(code).toBe(0)
    expect(text).toContain('Types: none found')
  })

  it('json mode reports types: null and declarations: null', () => {
    const { text, code } = runDepDocs({ packageName: 'no-types-pkg', projectRoot: dir, json: true })
    expect(code).toBe(0)
    const parsed = JSON.parse(text) as { types: unknown; declarations: unknown }
    expect(parsed.types).toBeNull()
    expect(parsed.declarations).toBeNull()
  })
})

describe('runDepDocs — @types/<package> companion resolution', () => {
  let dir: string

  beforeEach(() => {
    mockLoadConfig.mockReturnValue(DEFAULT_CONFIG)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dep-docs-attypes-'))
    const pkgDir = path.join(dir, 'node_modules', 'legacy-js-pkg')
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'legacy-js-pkg', version: '3.0.0', main: 'index.js' }))
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = {}\n')

    const typesDir = path.join(dir, 'node_modules', '@types', 'legacy-js-pkg')
    fs.mkdirSync(typesDir, { recursive: true })
    fs.writeFileSync(typesDir + '/package.json', JSON.stringify({ name: '@types/legacy-js-pkg', types: 'index.d.ts' }))
    fs.writeFileSync(typesDir + '/index.d.ts', 'export declare function doThing(x: string): number;\n')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('resolves the companion @types package when the package itself ships no .d.ts', () => {
    const { text, code } = runDepDocs({ packageName: 'legacy-js-pkg', projectRoot: dir, json: true })
    expect(code).toBe(0)
    const parsed = JSON.parse(text) as { types: { source: string } | null; declarations: { items: Array<{ name: string }> } | null }
    expect(parsed.types?.source).toBe('@types')
    expect(parsed.declarations?.items.map((d) => d.name)).toContain('doThing')
  })
})

describe('runDepDocs — typescript compiler API unavailable', () => {
  let dir: string

  beforeEach(() => {
    mockLoadConfig.mockReturnValue(DEFAULT_CONFIG)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dep-docs-nots-'))
    const pkgDir = path.join(dir, 'node_modules', 'has-dts-pkg')
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'has-dts-pkg', version: '1.0.0', types: 'index.d.ts' }))
    fs.writeFileSync(path.join(pkgDir, 'index.d.ts'), 'export declare function foo(): void;\n')
    setTsModuleForTesting(null)
  })

  afterEach(() => {
    setTsModuleForTesting(undefined)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('degrades to no declaration outline instead of throwing when typescript is unavailable', () => {
    const { text, code } = runDepDocs({ packageName: 'has-dts-pkg', projectRoot: dir })
    expect(code).toBe(0)
    expect(text).toContain('typescript compiler API not installed')
    expect(text).not.toContain('## Type declarations')
    expect(text).toContain('Types: ')
  })
})

describe('extractDtsOutline', () => {
  afterEach(() => {
    setTsModuleForTesting(undefined)
  })

  it('lists top-level exported function/class/interface/type/enum/const declarations as one row each, skipping non-exported ones', () => {
    const content = `
export declare function greet(name: string): string;
declare function internalHelper(): void;
export declare class Widget {
  render(): void;
}
export interface Options {
  label: string;
}
export type Id = string | number;
export declare enum Color { Red, Green, Blue }
export declare const VERSION: string;
`
    const rows = extractDtsOutline('/fake/index.d.ts', content)
    expect(rows).not.toBeNull()
    const names = (rows ?? []).map((r) => r.name)
    expect(names).toContain('greet')
    expect(names).toContain('Widget')
    expect(names).toContain('Options')
    expect(names).toContain('Id')
    expect(names).toContain('Color')
    expect(names).toContain('VERSION')
    expect(names).not.toContain('internalHelper')
  })

  it('captures overloaded function declarations as separate rows', () => {
    const content = `
export declare function parse(x: string): number;
export declare function parse(x: number): string;
`
    const rows = extractDtsOutline('/fake/overload.d.ts', content)
    expect(rows?.filter((r) => r.name === 'parse').length).toBe(2)
  })

  it('returns null when typescript is forced unavailable', () => {
    setTsModuleForTesting(null)
    const rows = extractDtsOutline('/fake/index.d.ts', 'export declare function foo(): void;')
    expect(rows).toBeNull()
  })
})
