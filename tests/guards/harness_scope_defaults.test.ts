/**
 * Every harness install/uninstall call in `src/cli.ts` must have a CLASSIFIED scope default.
 *
 * `--vscode` is the one harness that installs into the project by default; every other harness
 * defaults to user scope and takes `-p`/`--project` to do otherwise. An inverted default is the
 * kind of thing that reads as a bug to the next person, gets "fixed" back, and takes the multi-root
 * defect with it -- VS Code resolves a user-scope hook's working directory to `folders[0]` and
 * nothing else, so read hints, image shrinking and edit interception go silently inert for every
 * folder past the first (captured live against 1.137.0; see `src/vscode_duplicate.ts`).
 *
 * So the classification lives here, next to an assertion, rather than in a comment. The guard fails
 * on THREE distinct shapes, and only the first is the one people expect:
 *
 *  1. A harness whose scope argument does not match any known shape -- an unclassified member.
 *  2. A harness that is not named in EXPECTED at all -- a new integration arriving with a scope
 *     default nobody adjudicated.
 *  3. A harness whose observed default disagrees with EXPECTED -- including `--vscode` quietly
 *     reverting to user scope, which is the specific regression this exists for.
 *
 * Static analysis over `src/cli.ts` only: one `readFileSync`, no DB, no spawn, no network, because
 * `lefthook.yml` runs the guards pre-commit.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', '..', 'src', 'cli.ts')

type ScopeDefault = 'user-default' | 'project-default' | 'no-scope'

/**
 * The adjudicated default for every harness that has an install or uninstall call site. Adding a
 * harness without adding it here fails the guard, which is the point: the entry is the decision.
 */
const EXPECTED: Readonly<Record<string, ScopeDefault>> = {
  // The one inversion. See vscodeScopeFromFlags in src/bridges/vscode_install.ts for why.
  Vscode: 'project-default',
  VisualStudio: 'user-default',
  Cursor: 'user-default',
  CopilotCli: 'user-default',
  Pi: 'user-default',
  Codex: 'no-scope',
  Gemini: 'no-scope',
  Qwen: 'no-scope',
  Kimi: 'no-scope',
  Opencode: 'no-scope',
  Openclaw: 'no-scope',
  Grok: 'no-scope',
  Zed: 'no-scope',
  Hooks: 'no-scope',
  ClaudeMd: 'no-scope',
  Skill: 'no-scope',
}

/** One call site: `installVscode(vscodeScopeFromFlags(opts))` -> { harness: 'Vscode', arg: '...' }. */
interface CallSite {
  readonly harness: string
  readonly arg: string
  readonly text: string
}

/** Allows exactly one level of nested parentheses, so `f(g(x))` is captured whole. */
const CALL_RE = /\b(?:install|uninstall)([A-Z]\w*)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g

/**
 * `install`-prefixed helpers that are not harness installers. Named individually rather than
 * filtered by shape, and asserted to still exist below, so a rename empties this list loudly
 * instead of quietly re-admitting a false positive.
 */
const NOT_A_HARNESS: readonly string[] = ['VerificationNotice']

function callSites(code: string): CallSite[] {
  const sites: CallSite[] = []
  for (const m of code.matchAll(CALL_RE)) {
    const harness = m[1] ?? ''
    if (NOT_A_HARNESS.includes(harness)) continue
    sites.push({ harness, arg: (m[2] ?? '').trim(), text: m[0] ?? '' })
  }
  return sites
}

/** null means "no known shape matched" -- an unclassified member, which is a failure, not a default. */
function classify(arg: string): ScopeDefault | null {
  const normalized = arg.replace(/\s+/g, ' ').trim()
  if (normalized === '') return 'no-scope'
  // The inverted default is expressed through one named helper, never an inline ternary, so that
  // this guard has a single token to key on and a second inversion cannot slip in unnamed.
  if (/^vscodeScopeFromFlags\(opts\)$/.test(normalized)) return 'project-default'
  if (/^\{ project: opts\.project === true \}$/.test(normalized)) return 'user-default'
  if (/^\{ project: true \}$/.test(normalized)) return 'user-default'
  if (/^\{ local: (?:true|opts\.local === true) \}$/.test(normalized)) return 'user-default'
  if (/^scope$/.test(normalized)) return 'no-scope'
  return null
}

describe('harness scope defaults are classified', () => {
  const code = fs.readFileSync(CLI, 'utf8')
  const sites = callSites(code)

  it('finds a non-empty population of harness install/uninstall call sites', () => {
    pinnedPopulation({
      what: 'harness install/uninstall call sites in src/cli.ts',
      items: sites.map((s) => s.text),
      floor: 12,
      mustInclude: ['installVscode(', 'uninstallVscode('],
    })
  })

  it('classifies every call site, and every harness is adjudicated in EXPECTED', () => {
    const unclassified: string[] = []
    const unknownHarness: string[] = []
    const disagreements: string[] = []
    for (const site of sites) {
      const observed = classify(site.arg)
      if (observed === null) {
        unclassified.push(`${site.text} (argument: ${site.arg || '<empty>'})`)
        continue
      }
      const expected = EXPECTED[site.harness]
      if (expected === undefined) {
        unknownHarness.push(`${site.harness} -> observed ${observed} in ${site.text}`)
        continue
      }
      // A bare call (`uninstallPi()`) passes no scope and so takes the callee's own default, which
      // for every user-default harness is the same claim EXPECTED makes. The asymmetry is
      // deliberate: for a PROJECT-default harness a bare call is NOT equivalent, because
      // installVscode()'s own parameter default is still user scope -- the inversion lives in
      // vscodeScopeFromFlags at the call site. So a bare installVscode() silently installs user
      // scope, and that must fail here rather than ship.
      const compatible = observed === expected || (expected === 'user-default' && observed === 'no-scope')
      if (!compatible) {
        disagreements.push(`${site.harness}: EXPECTED ${expected}, source says ${observed} (${site.text})`)
      }
    }
    expect(
      unclassified,
      'A harness install/uninstall call passes a scope argument in a shape this guard does not know. ' +
        'Classify it in classify() and adjudicate the harness in EXPECTED — do not widen the regex to make this pass.',
    ).toEqual([])
    expect(
      unknownHarness,
      'A harness has an install/uninstall call site but no entry in EXPECTED. Add it with the scope default you intend.',
    ).toEqual([])
    expect(
      disagreements,
      'A harness\'s scope default changed. If --vscode is in this list, note that user scope is the defect this project fixed: ' +
        'VS Code pins a user-scope hook to folders[0], so everything past the first folder of a multi-root workspace goes silently inert.',
    ).toEqual([])
  })

  it('keeps --vscode as the only project-default harness', () => {
    const projectDefaults = Object.entries(EXPECTED)
      .filter(([, v]) => v === 'project-default')
      .map(([k]) => k)
    expect(projectDefaults).toEqual(['Vscode'])
    // Anchored on a non-word char before `install`, because a plain substring check for
    // `installVscode(vscodeScopeFromFlags(opts))` is satisfied by the UNINSTALL call site --
    // `uninstallVscode(...)` contains it. A mutation of the install call alone stayed green here
    // until this was anchored.
    const installCall = /(?<!\w)installVscode\(vscodeScopeFromFlags\(opts\)\)/
    const uninstallCall = /\buninstallVscode\(vscodeScopeFromFlags\(opts\)\)/
    expect(installCall.test(code), 'the install call site must route through vscodeScopeFromFlags').toBe(true)
    expect(uninstallCall.test(code), 'the uninstall call site must route through vscodeScopeFromFlags').toBe(true)
  })

  it('keeps every NOT_A_HARNESS exemption pointing at a symbol that still exists', () => {
    // An exemption for a symbol nobody calls any more is an exemption that silently starts
    // covering something else the day a real installer is named similarly.
    for (const name of NOT_A_HARNESS) {
      expect(code, `NOT_A_HARNESS lists ${name}, which src/cli.ts no longer calls — drop the entry`).toContain(`install${name}(`)
    }
  })

  it('keeps the --user opt-out registered on both install and uninstall', () => {
    // Without this flag the inverted default has no escape hatch and a user who wants the old
    // behaviour has no way to ask for it. Two registrations, one per command.
    const registrations = [...code.matchAll(/\.option\('--user',/g)]
    expect(registrations.length, 'expected --user on both the install and uninstall commands').toBe(2)
  })
})
