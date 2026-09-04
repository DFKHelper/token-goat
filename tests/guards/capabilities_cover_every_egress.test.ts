/**
 * Every module that can open a network socket must be named by the capability inventory.
 *
 * The inventory in `src/capabilities.ts` is what a reviewer runs to decide whether this tool is
 * allowed near their source code. An inventory nobody checks drifts the moment a feature reaches
 * the network without being added to it, and the drift is silent -- the command keeps printing a
 * confident, complete-looking list that is missing the one entry that mattered.
 *
 * So the set is not maintained by hand. This derives it from the source tree and fails when the
 * two disagree in either direction: a new networking module fails until it is classified, and a
 * module that stops networking fails until it is removed, so the list cannot quietly rot into a
 * set of names that no longer do anything.
 *
 * PROVENANCE
 *
 * HAND-DERIVED. The detector looks for Node's own networking imports and the global `fetch`,
 * which are facts about Node, not about token-goat's code -- so it does not agree with the
 * implementation by construction the way a pattern copied out of our own source would.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { EGRESS_MODULES, collectCapabilities } from '../../src/capabilities.js'
import { pinnedPopulation } from './population.js'

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

/**
 * A module reaches the network if it holds a socket itself, or if it declares that it does.
 *
 * The first clause is the obvious one. The second exists because two of the four egress paths do
 * not touch a socket in their own file: `image_ocr.ts` spawns a child that downloads language
 * data, and `screenshot.ts` drives a browser over CDP and lets the browser do the fetching. A
 * socket-only detector reports both as harmless, which is the wrong answer about the two paths a
 * reviewer would most want flagged.
 *
 * What both do have is the offline gate, and that is the honest signal: the only reason to ask
 * whether the machine is meant to be offline is that you are about to leave it. So consulting
 * `loadConfig().network.offline` counts as declaring egress, and the converse assertion below
 * turns that into the property worth proving -- every egress path is gated, not merely listed.
 *
 * The limit, stated plainly: a future module that egresses through a delegate AND omits the gate
 * matches neither clause. That is precisely the omission the converse assertion is there to make
 * expensive, since such a module cannot be added to the inventory without failing it.
 */
const NETWORK_IMPORT = /from\s+'node:(https?|net|dns)'|from\s+'(https?|net|dns)'|require\('node:(https?|net|dns)'\)/
const GLOBAL_FETCH = /(?<![\w.])fetch\s*\(/
const OFFLINE_GATE = /loadConfig\(\)\.network\.offline/

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** Source with comments and string literals removed, so a mention in prose is not a finding. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => (NETWORK_IMPORT.test(`from ${m}`) ? m : "''"))
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
}

describe('the capability inventory', () => {
  it('names every module in src/ that can open a network socket, and nothing that cannot', () => {
    const modules = pinnedPopulation({
      what: 'src/ modules scanned for network egress',
      items: walk(srcDir),
      floor: 200,
      // Anchored on the module that holds the one function every self-initiated fetch passes
      // through: if the walk still returns 200 files but no longer includes this one, the guard is
      // scanning something, just not the thing it exists to cover.
      mustInclude: ['webfetch.ts'],
    })

    const found = new Set<string>()
    for (const file of modules) {
      const c = code(fs.readFileSync(file, 'utf8'))
      if (NETWORK_IMPORT.test(c) || GLOBAL_FETCH.test(c) || OFFLINE_GATE.test(c)) found.add(path.basename(file))
    }

    // A detector that matches nothing would make every assertion below pass. This repo has shipped
    // exactly that: a guard whose population silently emptied and went on reporting success.
    expect(found.size, 'the detector found no networking modules at all, so it is not detecting').toBeGreaterThan(0)

    const declared = new Set(EGRESS_MODULES)
    const undeclared = [...found].filter((f) => !declared.has(f)).sort()
    const stale = [...declared].filter((f) => !found.has(f)).sort()

    expect(
      undeclared,
      `these modules can reach the network but are not in EGRESS_MODULES, so ` +
        `\`token-goat capabilities\` would under-report what this build can do: ${undeclared.join(', ')}`,
    ).toEqual([])
    expect(
      stale,
      `these are listed in EGRESS_MODULES but no longer reach the network: ${stale.join(', ')}`,
    ).toEqual([])
  })

  it('gates every egress module on network.offline, so the switch is enforced and not merely offered', () => {
    // The claim a reviewer cares about is not "there is an offline setting" -- it is "no path
    // leaves this machine without consulting it". This is that claim, checked against the source
    // rather than against the setting's own docstring.
    const ungated: string[] = []
    for (const m of EGRESS_MODULES) {
      const p = path.join(srcDir, m)
      expect(fs.existsSync(p), `EGRESS_MODULES names a file that does not exist: ${m}`).toBe(true)
      if (!/loadConfig\(\)\.network\.offline/.test(code(fs.readFileSync(p, 'utf8')))) ungated.push(m)
    }
    expect(
      ungated,
      `these modules can reach the network without consulting network.offline, so offline mode ` +
        `would not actually stop them: ${ungated.join(', ')}`,
    ).toEqual([])
  })

  it('points every capability at a file that exists, so "enforced at" can actually be opened', () => {
    const caps = collectCapabilities()
    expect(caps.length).toBeGreaterThan(0)
    for (const c of caps) {
      const file = c.enforcedAt.split('::')[0]!.trim()
      expect(fs.existsSync(path.resolve(srcDir, '..', file)), `${c.id} points at a missing file: ${file}`).toBe(true)
    }
  })

  it('gives every capability a distinct id, since a pipeline asserts on these', () => {
    const ids = collectCapabilities().map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
