/** Guard that every host config-home variable src/ reads is either deleted or assigned by tests/setup/isolate-home.ts, so a test run on a machine that exports one (CODEX_HOME, COPILOT_HOME, KIMI_CODE_HOME, CLAUDE_CONFIG_DIR) cannot read or write the developer's real host config; a variable not handled there fails by name, so a new host variable cannot slip past. Provenance: HAND-DERIVED. The sample sources are written here from the rule, not from the scanner's regexes; the real-tree row reads src/ as shipped. */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..')
const SRC_DIR = path.join(REPO, 'src')
const ISOLATE_HOME = path.join(REPO, 'tests', 'setup', 'isolate-home.ts')

/** A string literal, in any quote style, that is exactly a host config-home variable name. */
const HOST_VAR_LITERAL = /(['"`])([A-Z][A-Z0-9_]*(?:_HOME|_CONFIG_DIR))\1/g
/** A dotted read, `process.env.X`, which has no quotes for the literal scan to find. */
const HOST_VAR_DOT = /process\.env\.([A-Z][A-Z0-9_]*(?:_HOME|_CONFIG_DIR))\b/g
/** `delete process.env['X']` or `delete process.env.X`. */
const DELETED = /delete\s+process\.env(?:\[\s*['"]([A-Z0-9_]+)['"]\s*\]|\.([A-Z0-9_]+))/g
/** `process.env['X'] = value` or `process.env.X = value`; `==` and `===` are not assignments. */
const ASSIGNED = /process\.env(?:\[\s*['"]([A-Z0-9_]+)['"]\s*\]|\.([A-Z0-9_]+))\s*=(?!=)/g

/** Keyed `file::NAME`, one site per entry, each with a one-line reason. These are data literals in a keep-list, never read as a path. */
const EXEMPT = new Map<string, string>([
  ['src/tool_filters/misc.ts::CARGO_HOME', 'toolchain root named in the EnvFilter keep-list ENV_KEEP_VARS; compared to variable names, never read'],
  ['src/tool_filters/misc.ts::RUSTUP_HOME', 'toolchain root named in the EnvFilter keep-list ENV_KEEP_VARS; compared to variable names, never read'],
  ['src/tool_filters/misc.ts::GEM_HOME', 'toolchain root named in the EnvFilter keep-list ENV_KEEP_VARS; compared to variable names, never read'],
  ['src/tool_filters/misc.ts::JAVA_HOME', 'toolchain root named in the EnvFilter keep-list ENV_KEEP_VARS; compared to variable names, never read'],
])

function namesOf(source: string, re: RegExp): Set<string> {
  const names = new Set<string>()
  for (const m of source.matchAll(re)) names.add((m[1] ?? m[2])!)
  return names
}

/** Every .ts file under src/, keyed by its repo-relative path with forward slashes. */
function collectTs(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        out.set(path.relative(REPO, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8'))
      }
    }
  }
  walk(dir)
  return out
}

/** `NAME in file` for each host variable literal no handled name covers and no exemption explains. */
function unhandledHostVars(
  sources: ReadonlyMap<string, string>,
  handled: ReadonlySet<string>,
  exempt: ReadonlyMap<string, string>,
): string[] {
  const found: string[] = []
  for (const [file, source] of sources) {
    const names = [...source.matchAll(HOST_VAR_LITERAL)].map((m) => m[2]!)
    names.push(...[...source.matchAll(HOST_VAR_DOT)].map((m) => m[1]!))
    for (const name of names) {
      if (handled.has(name) || exempt.has(`${file}::${name}`)) continue
      found.push(`${name} in ${file}`)
    }
  }
  return [...new Set(found)].sort()
}

/** Every src/ .ts file, with its population pinned so an empty or collapsed walk fails instead of passing. */
function srcTsFiles(): Map<string, string> {
  const all = collectTs(SRC_DIR)
  pinnedPopulation({
    what: 'TypeScript files under src/',
    items: [...all.keys()],
    floor: 400,
    mustInclude: ['copilot_home.ts', 'bridges/kimi_install.ts', 'bridges/registry.ts'],
  })
  return all
}

describe('isolate-home pins every host config-home variable src reads', () => {
  const isolate = fs.readFileSync(ISOLATE_HOME, 'utf8')
  const deleted = namesOf(isolate, DELETED)
  const assigned = namesOf(isolate, ASSIGNED)
  const handled = new Set([...deleted, ...assigned])
  // TOKEN_GOAT_HOME is deleted only inside a conditional and then assigned, so it is pinned by the assignment and not checked as unset.
  const mustBeUnset = [...deleted].filter((name) => !assigned.has(name))

  it('finds the host variables src reads, so the scan is not vacuous', () => {
    const literals = new Set<string>()
    for (const source of srcTsFiles().values()) {
      for (const m of source.matchAll(HOST_VAR_LITERAL)) literals.add(m[2]!)
    }
    expect([...literals]).toEqual(expect.arrayContaining(['CODEX_HOME', 'COPILOT_HOME', 'KIMI_CODE_HOME', 'CLAUDE_CONFIG_DIR']))
  })

  it('every host variable src reads is deleted or assigned by isolate-home', () => {
    expect(unhandledHostVars(srcTsFiles(), handled, EXEMPT)).toEqual([])
  })

  it('each variable isolate-home deletes is unset at test time', () => {
    expect(mustBeUnset.length).toBeGreaterThan(0)
    for (const name of mustBeUnset) {
      expect(process.env[name], `${name} must be unset`).toBeUndefined()
    }
  })

  it('the scanner flags a host read it is fed that isolate-home does not handle', () => {
    const sample = new Map([['sample.ts', "const home = process.env['FOO_HOME']"]])
    expect(unhandledHostVars(sample, handled, EXEMPT)).toEqual(['FOO_HOME in sample.ts'])
  })

  it('the scanner accepts a read isolate-home handles through either access form', () => {
    const sample = new Map([['sample.ts', "const a = process.env.CODEX_HOME; const b = fn('CLAUDE_CONFIG_DIR')"]])
    expect(unhandledHostVars(sample, handled, EXEMPT)).toEqual([])
  })

  it('the scanner flags an unhandled dotted read', () => {
    const sample = new Map([['sample.ts', 'const b = process.env.BAR_HOME']])
    expect(unhandledHostVars(sample, handled, EXEMPT)).toEqual(['BAR_HOME in sample.ts'])
  })
})
