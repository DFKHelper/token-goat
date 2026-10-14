import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { resolveEntry, satisfies } from '../../scripts/lock-consistency.mjs'
import { consumerTree } from '../helpers/lock_tree.js'

/** An `overrides` pin replaces the range a dependent declares, and nothing else checks that the dependent still works with what it is handed. `lock_file_is_self_consistent.test.ts` cannot: it holds each entry to the forced spec on purpose, because forcing is what an override is for, so a pin that moves a package off its dependent's own range reads as consistent by construction. Commit 5c43197e pinned `tesseract.js-core` to 6.1.2 to drop a Socket alert on the Emscripten glue in 7.0.0 while `tesseract.js` stayed at 7.0.0, which declares `tesseract.js-core@^7.0.0`. tesseract.js 7 loads `tesseract.js-core/tesseract-core-relaxedsimd-lstm` whenever the engine supports relaxed SIMD, which Node 24 does, and core 6.1.2 does not ship that file, so every `token-goat image-text` call in this repository's own install failed as an unreadable image while the suite stayed green: the OCR tests run against a stub entry, never the real package. So this holds every pin that reaches a package a consumer install can load to the range that package's own manifest declares, both the version the lock resolves for it and the pin itself when the pin is an exact version. Development-only dependents are deliberately left out: four of the overrides (`protobufjs`, `uuid`, `sharp`, `unzipper`) force a dev-tree package past its dependent's declared major as security pins, and none of those dependents is in the tree a consumer installs. The tesseract.js-core pin itself is gone: the alert it dropped is the minifier output of a newer Emscripten (the 7.0.0 glue embeds byte-for-byte the `.wasm` the package also ships), which socket.yml accepts as a known instance, so both packages moved to 7 together and the pair check below holds them there. */

interface LockEntry {
  readonly version?: string
  readonly dependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
}

const FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** Every edge from a listed dependent to an overridden package, checked against the dependent's declared spec rather than the forced one. `checked` names each edge seen, so a caller can tell "nothing broke" from "nothing was looked at". */
function pinViolations(packages: Record<string, LockEntry>, overrides: Record<string, unknown>, dependents: Iterable<string>): { checked: string[]; problems: string[] } {
  const checked: string[] = []
  const problems: string[] = []
  for (const dependent of dependents) {
    const entry = packages[dependent]
    if (!entry) continue
    for (const field of FIELDS) {
      for (const [name, spec] of Object.entries(entry[field] ?? {})) {
        const pin = overrides[name]
        if (typeof pin !== 'string') continue
        checked.push(`${dependent} -> ${name}`)
        if (EXACT_VERSION.test(pin) && satisfies(pin, spec) !== true) problems.push(`${dependent} declares ${field} ${name}@${spec}, but overrides pins ${pin}`)
        const resolved = resolveEntry(packages, dependent, name)
        const version = resolved?.entry['version']
        if (!resolved || typeof version !== 'string') continue
        if (satisfies(version, spec) !== true) problems.push(`${dependent} declares ${field} ${name}@${spec}, but the lock resolves ${resolved.path}@${version}`)
      }
    }
  }
  return { checked, problems }
}

/** Packages released in lockstep with a companion that only the same major can load. A declared range is not enough to hold these together: an override can force the companion outside it (5c43197e did), and a hold on one of the pair has to move the other with it, so each side is checked by major against the other as the lock resolves it and as `overrides` pins it. */
const MATCHED_MAJOR: Readonly<Record<string, string>> = { 'tesseract.js': 'tesseract.js-core' }

function majorOf(text: string): number | null {
  const match = /\d+/.exec(text)
  return match ? Number(match[0]) : null
}

/** Every listed dependent in {@link MATCHED_MAJOR} whose companion resolves to, or is pinned at, a different major. */
function pairMismatches(packages: Record<string, LockEntry>, overrides: Record<string, unknown>, dependents: Iterable<string>): { checked: string[]; problems: string[] } {
  const checked: string[] = []
  const problems: string[] = []
  for (const dependent of dependents) {
    const name = dependent.slice(dependent.lastIndexOf('node_modules/') + 'node_modules/'.length)
    const companion = MATCHED_MAJOR[name]
    const version = packages[dependent]?.version
    if (!companion || typeof version !== 'string') continue
    checked.push(`${dependent} -> ${companion}`)
    const fix = `move ${name} and ${companion} to the same major together, in dependencies and in overrides`
    const resolved = resolveEntry(packages, dependent, companion)
    const resolvedVersion = resolved?.entry['version']
    if (typeof resolvedVersion !== 'string') problems.push(`${dependent}@${version} has no ${companion} in the lock`)
    else if (majorOf(resolvedVersion) !== majorOf(version)) problems.push(`${dependent}@${version} resolves ${resolved?.path}@${resolvedVersion}; ${fix}`)
    const pin = overrides[companion]
    if (typeof pin === 'string' && majorOf(pin) !== majorOf(version)) problems.push(`${dependent}@${version} but overrides pins ${companion} ${pin}; ${fix}`)
  }
  return { checked, problems }
}

const lock = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../package-lock.json', import.meta.url)), 'utf8')) as { packages: Record<string, LockEntry> }
const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { overrides?: Record<string, unknown> }
const consumers = [...consumerTree({ includeOptional: true })]
const real = pinViolations(lock.packages, manifest.overrides ?? {}, consumers)
const realPairs = pairMismatches(lock.packages, manifest.overrides ?? {}, consumers)

describe('an overrides pin stays inside the range its runtime dependent declares', () => {
  it('holds every pinned package to the range the package that loads it declares', () => {
    expect(real.problems, 'an override hands a runtime package a version outside its own declared range; move the dependent to a release that accepts the pin, or drop the pin').toEqual([])
  })

  it('keeps tesseract.js and tesseract.js-core on one major', () => {
    expect(realPairs.checked, 'tesseract.js is no longer in the consumer tree, so this compared nothing').toContain('node_modules/tesseract.js -> tesseract.js-core')
    expect(realPairs.problems).toEqual([])
  })

  it('accepts a matched pair on either major and rejects a split one', () => {
    const tree = (js: string, core: string): Record<string, LockEntry> => ({
      'node_modules/tesseract.js': { version: js, dependencies: { 'tesseract.js-core': `^${js}` } },
      'node_modules/tesseract.js-core': { version: core },
    })
    const dependents = ['node_modules/tesseract.js']
    expect(pairMismatches(tree('6.0.1', '6.1.2'), { 'tesseract.js-core': '6.1.2' }, dependents).problems).toEqual([])
    expect(pairMismatches(tree('7.0.0', '7.0.0'), {}, dependents).problems).toEqual([])
    expect(pairMismatches(tree('7.0.0', '7.0.0'), { 'tesseract.js-core': '6.1.2' }, dependents).problems).toEqual([
      'node_modules/tesseract.js@7.0.0 but overrides pins tesseract.js-core 6.1.2; move tesseract.js and tesseract.js-core to the same major together, in dependencies and in overrides',
    ])
    expect(pairMismatches(tree('6.0.1', '7.0.0'), {}, dependents).problems).toEqual([
      'node_modules/tesseract.js@6.0.1 resolves node_modules/tesseract.js-core@7.0.0; move tesseract.js and tesseract.js-core to the same major together, in dependencies and in overrides',
    ])
  })

  it('reports the pairing the lock carried at f68a3bda', () => {
    // CAPTURE: package-lock.json at f68a3bda, trimmed to the two entries the check reads, with the overrides pin from package.json at the same commit.
    const packages: Record<string, LockEntry> = {
      'node_modules/tesseract.js': {
        version: '7.0.0',
        dependencies: {
          'bmp-js': '^0.1.0',
          'idb-keyval': '^6.2.0',
          'is-url': '^1.2.4',
          'node-fetch': '^2.6.9',
          'opencollective-postinstall': '^2.0.3',
          'regenerator-runtime': '^0.13.3',
          'tesseract.js-core': '^7.0.0',
          'wasm-feature-detect': '^1.8.0',
          zlibjs: '^0.3.1',
        },
      },
      'node_modules/tesseract.js/node_modules/tesseract.js-core': { version: '6.1.2' },
    }
    expect(pinViolations(packages, { 'tesseract.js-core': '6.1.2' }, ['node_modules/tesseract.js']).problems).toEqual([
      'node_modules/tesseract.js declares dependencies tesseract.js-core@^7.0.0, but overrides pins 6.1.2',
      'node_modules/tesseract.js declares dependencies tesseract.js-core@^7.0.0, but the lock resolves node_modules/tesseract.js/node_modules/tesseract.js-core@6.1.2',
    ])
    expect(pairMismatches(packages, { 'tesseract.js-core': '6.1.2' }, ['node_modules/tesseract.js']).problems).toHaveLength(2)
  })
})
