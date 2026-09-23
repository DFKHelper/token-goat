import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from '../helpers/bundle.js'

/**
 * Every check CI runs must also run locally, so a push that passed the hooks cannot be the one that turns the build red.
 *
 * This is not a fixture test: both sides are read from the files that actually drive the two systems -- `.github/workflows/ci.yml` is what GitHub executes, and `lefthook.yml` plus the scripts it names are what the hooks execute. Nothing here is transcribed from either, which is the only reason the comparison means anything.
 *
 * It exists because the gap was real and silent. `typecheck:vscode-extension`, `typecheck:vscode-extension:tests`, `test:vscode-extension` and the gitleaks scan ran in CI and nowhere else, so the extension could stop compiling, its suite could break, or a credential could be committed, and every local gate would still report success. The three npm checks together cost under four seconds and the scan under three, so the gap was never about expense -- nothing was comparing the two lists.
 */

const CI_YML = path.join(ROOT, '.github', 'workflows', 'ci.yml')
const LEFTHOOK_YML = path.join(ROOT, 'lefthook.yml')
const SCRIPTS_DIR = path.join(ROOT, '.lefthook-scripts')

/**
 * CI steps that are not checks and so have no local counterpart to require.
 *
 * Each reason has to be true of the step itself, because an exemption that merely sounds plausible reads as a decision someone made and stops anyone re-examining it -- a worse outcome than an uncovered check, which at least looks like an omission.
 */
const NOT_A_CHECK: ReadonlyMap<string, string> = new Map([
  // Installs the dependencies the checks then run against. A local tree already has them, which is what lets the hooks run at all.
  ['ci', 'dependency install, not a check'],
  // Downloads the embedding model into CI's cache. Locally the model lives in TOKEN_GOAT_MODEL_CACHE_DIR already and the suite gates on modelFilesPresent().
  ['run model:warm', 'fetches the model into CI cache; the local machine already has it'],
])

/** Every `npm ...` invocation CI runs, normalized to the part that names what it does. */
function ciNpmCommands(): string[] {
  const text = fs.readFileSync(CI_YML, 'utf8')
  const out = new Set<string>()
  // Matches both `- run: npm ci` and the `command: npm test -- --shard=...` form the retry action takes.
  for (const m of text.matchAll(/^\s*(?:-\s*)?(?:run|command):\s*npm\s+(.+)$/gm)) {
    const rest = m[1]!.trim()
    // Drop argument tails so `test -- --shard=${{ matrix.shard }}/3` and `ci --prefix vscode-extension` compare as the command they are.
    const normalized = rest.startsWith('run ') ? rest.split(/\s+/).slice(0, 2).join(' ') : rest.split(/\s+/)[0]!
    out.add(normalized)
  }
  return [...out].sort()
}

/**
 * Everything the local hook tiers execute: the lefthook commands plus the bodies of the scripts those commands actually name.
 *
 * A script is pulled in only when lefthook.yml references it, and transitively when an included script does. Reading the whole directory instead was this guard's own first bug: deleting the `secrets` command from lefthook.yml left run-secrets.sh on disk, so the scan's text was still found and the guard stayed green over a gate that no longer ran. Only mutating the config caught it, which is the same shape as the gap the guard was written for -- a check present in the tree and absent from the pipeline.
 */
function localTierText(): string {
  // Only the `run:` values, never the surrounding YAML comments -- a check described in a comment is not a check that runs.
  const root = [...fs.readFileSync(LEFTHOOK_YML, 'utf8').matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => m[1]!).join('\n')
  const seen = new Set<string>()
  const pending = [root]
  let text = root
  while (pending.length) {
    // Any `.sh` name rather than a `.lefthook-scripts/`-prefixed one, because run-all-checks.sh reaches its children through a `"$SCRIPT_DIR/run-test.sh"` variable; requiring the directory literal lost the whole pre-push tier and reported `npm test` uncovered. Comment lines are stripped first: run-guards.sh's header names run-all-checks.sh in prose, which pulled that entire tier back in and left the guard green over a pre-push hook that had been deleted.
    for (const m of pending.pop()!.matchAll(/([\w.-]+\.sh)/g)) {
      const name = m[1]!
      if (seen.has(name)) continue
      seen.add(name)
      const file = path.join(SCRIPTS_DIR, name)
      if (!fs.existsSync(file)) continue
      const body = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('#'))
        .join('\n')
      text += '\n' + body
      pending.push(body)
    }
  }
  return text
}

describe('local hook tiers cover every CI check', () => {
  it('runs every npm check CI runs', () => {
    const ci = ciNpmCommands()
    // Non-vacuous: a parser that stopped matching would report an empty set and pass against anything.
    expect(ci.length, 'no npm commands parsed out of ci.yml -- the step pattern has drifted').toBeGreaterThan(5)
    expect(ci, 'ci.yml no longer runs the checks this guard was written against').toEqual(
      expect.arrayContaining(['run lint', 'run typecheck', 'test']),
    )

    const local = localTierText()
    const uncovered = ci.filter((c) => !NOT_A_CHECK.has(c) && !local.includes(`npm ${c}`))
    expect(
      uncovered,
      `CI runs these and no local hook tier does, so a green push can still fail the build: ${uncovered.join(', ')}`,
    ).toEqual([])
  })

  it('scans for secrets locally, the way CI does', () => {
    const ciText = fs.readFileSync(CI_YML, 'utf8')
    // Non-vacuous: if CI ever stops scanning, requiring a local scan to mirror it is the wrong assertion, so read CI first.
    expect(ciText, 'ci.yml no longer runs a gitleaks scan; this guard mirrors that job and must be revisited').toContain(
      'gitleaks dir .',
    )
    expect(
      localTierText(),
      'CI scans for committed secrets and no local hook tier does -- a credential would only be caught after it reached the remote',
    ).toContain('gitleaks dir .')
  })

  it('passes the same gitleaks config and flags in both places', () => {
    // The scan is only equivalent if the config is: a local run with default rules would pass on fixtures CI's config allowlists, and fail on ones it does not.
    const flags = '--config=.gitleaks.toml --redact --exit-code 1 --no-banner'
    expect(fs.readFileSync(CI_YML, 'utf8')).toContain(flags)
    expect(localTierText(), 'the local scan and CI disagree on config or flags, so they can reach different verdicts').toContain(flags)
  })
})
