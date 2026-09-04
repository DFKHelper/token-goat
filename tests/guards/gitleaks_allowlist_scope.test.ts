/**
 * `.gitleaks.toml` allowlists four path prefixes so a secrets scan of this repository does not
 * drown in its own redaction fixtures -- AWS's documented example key, PEM blocks whose body is the
 * literal text `first-key-body`, GitHub tokens written as split keyboard runs. That suppression is
 * only safe because of what it deliberately does not cover: a credential committed anywhere the
 * shipping code lives still fails the scan.
 *
 * Nothing held that boundary. The config file's own comment claimed this test held it, and this
 * test did not exist -- the claim was written alongside the allowlist and never checked, so the
 * only thing standing between `'''^tests/'''` and `'''^src/'''` was that nobody had typed it. The
 * failure shape is silent by construction: widening an allowlist makes a scan *quieter*, so the
 * scan going green is what the mistake looks like.
 *
 * A second gap sat underneath the first. The config was never executed by anything -- no workflow,
 * no hook, no script invoked gitleaks at all -- so the "control" was a document describing a scan
 * that never ran. The CI assertions below exist so that stays fixed: a config nothing runs suppresses
 * nothing, and a run that skips this config is not the scan the comment describes.
 *
 * Provenance: every expectation here is HAND-DERIVED from gitleaks' documented allowlist semantics
 * and then CAPTURE-checked against gitleaks v8.30.1 run over probe files. That run confirmed all
 * five directions this file asserts -- `private-key` silent in both changelog paths, flagged in an
 * uncarved file and under `src/`, and `github-pat` still flagged inside a carved changelog, which is
 * what proves `targetRules` narrows the carve-out to one rule rather than muting the file.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseToml } from 'smol-toml'
import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

interface Allowlist {
  description?: string
  paths?: string[]
  targetRules?: string[]
}

interface GitleaksConfig {
  extend?: { useDefault?: boolean }
  allowlist?: Allowlist
  allowlists?: Allowlist[]
}

function readConfig(): GitleaksConfig {
  const raw = fs.readFileSync(path.join(repoRoot, '.gitleaks.toml'), 'utf8')
  return parseToml(raw) as GitleaksConfig
}

/**
 * Only `[[allowlists]]` entries are read. gitleaks 8.30 refuses to load a config carrying both
 * forms, and the singular `[allowlist]` is deprecated, so a stray one is a config that does not
 * load rather than a rule this test needs to cover.
 */
function allowlists(): Allowlist[] {
  return readConfig().allowlists ?? []
}

/** Every path pattern that applies to a given rule, across all allowlist entries. */
function pathsSuppressing(ruleId: string): string[] {
  return allowlists()
    .filter((entry) => entry.targetRules === undefined || entry.targetRules.includes(ruleId))
    .flatMap((entry) => entry.paths ?? [])
}

/**
 * Gitleaks matches an allowlist entry with Go's `regexp.MatchString`, which searches rather than
 * anchoring. An unanchored entry therefore matches anywhere in the path, and that is the mutation
 * this test has to survive: `'''src/'''` covers every shipping file while looking like a typo.
 */
function matchesAny(patterns: string[], candidate: string): string | undefined {
  return patterns.find((pattern) => new RegExp(pattern).test(candidate))
}

/** Repo-relative, forward-slashed -- the form gitleaks tests a path in, on every platform. */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(path.relative(repoRoot, full).split(path.sep).join('/'))
    }
  }
  walk(path.join(repoRoot, dir))
  return out
}

/**
 * Every directory that ships code or configuration a credential could hide in. `dist/` and
 * `coverage/` are allowlisted on purpose and are reproducible from source, so they are absent here
 * by design rather than by oversight.
 *
 * Each carries a floor and an anchor file. A walk that silently returns nothing -- a renamed
 * directory, a drifted filter -- would make the "does not suppress" assertion below true of an
 * empty set, which is the exact shape a widened allowlist is supposed to be caught by.
 */
const PROTECTED_DIRS: readonly { dir: string; floor: number; mustInclude: readonly string[] }[] = [
  { dir: 'src', floor: 200, mustInclude: ['src/parser.ts', 'src/secret_redact.ts'] },
  { dir: 'scripts', floor: 8, mustInclude: [] },
  { dir: '.github', floor: 4, mustInclude: ['.github/workflows/ci.yml'] },
  { dir: 'vscode-extension/src', floor: 2, mustInclude: [] },
]

/**
 * Checked against every protected directory rather than only against `private-key`, so a new
 * narrowly-scoped carve-out cannot quietly reach into shipping code the way a blanket one would.
 */
const RULES_TO_CHECK = ['private-key', 'aws-access-token', 'github-pat', 'generic-api-key']

describe('.gitleaks.toml allowlist scope', () => {
  it('declares at least one allowlist, so the assertions below have a population to test', () => {
    // Without this, deleting the allowlists wholesale would make every "does not suppress"
    // assertion below vacuously true and the suite would go green on a config that suppresses
    // nothing while the comment still claims it suppresses fixtures.
    expect(allowlists().length).toBeGreaterThan(0)
    expect(allowlists().flatMap((entry) => entry.paths ?? []).length).toBeGreaterThan(0)
  })

  it('uses only the [[allowlists]] form, because gitleaks refuses a config carrying both', () => {
    // Mixing them is not a lint nit: gitleaks 8.30 exits with "Failed to load config" and the
    // scan never runs, which reads in CI as a broken job rather than as a secrets finding.
    expect(readConfig().allowlist).toBeUndefined()
  })

  it.each(PROTECTED_DIRS)('does not suppress any rule for files under $dir/', ({ dir, floor, mustInclude }) => {
    const files = pinnedPopulation({
      what: `${dir}/ files a credential could be committed into`,
      items: filesUnder(dir),
      floor,
      mustInclude,
    })

    const suppressed = RULES_TO_CHECK.flatMap((rule) => {
      const patterns = pathsSuppressing(rule)
      return files
        .map((file) => ({ rule, file, pattern: matchesAny(patterns, file) }))
        .filter((hit): hit is { rule: string; file: string; pattern: string } => hit.pattern !== undefined)
    })

    expect(
      suppressed.map((hit) => `${hit.file} (${hit.rule} suppressed by ${hit.pattern})`),
      `.gitleaks.toml suppresses shipping code under ${dir}/. A credential committed there would ` +
        `not fail the scan. Narrow the allowlist entry rather than widening this test.`,
    ).toEqual([])
  })

  it('scopes the changelog carve-out to one rule, so a token in a release note still fails', () => {
    // The changelog quotes armored key headers as prose, which `private-key` cannot distinguish
    // from a key. Suppressing that one rule there is defensible; suppressing the file is not,
    // because release notes are exactly where a copied-in token would look unremarkable.
    const changelogEntries = allowlists().filter((entry) =>
      (entry.paths ?? []).some((pattern) => /CHANGELOG/.test(pattern)),
    )
    expect(changelogEntries.length).toBeGreaterThan(0)
    for (const entry of changelogEntries) {
      expect(entry.targetRules, `changelog allowlist "${entry.description}" must name its rules`).toBeDefined()
      expect(entry.targetRules).toEqual(['private-key'])
    }
  })

  it('keeps the default rule pack, so the allowlists narrow a real ruleset rather than an empty one', () => {
    // `useDefault = false` with no `[[rules]]` of our own is a scan that finds nothing and reports
    // success -- the same green as a clean repository.
    expect(readConfig().extend?.useDefault).toBe(true)
  })

  it('is executed by CI, because a config nothing runs is a document and not a control', () => {
    const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
    expect(workflow).toContain('gitleaks')
    // Pointed at this file specifically: a default-config run applies none of the fixture
    // allowlisting above, fails on all 26 fixtures, and gets muted or deleted within a week.
    expect(workflow).toMatch(/--config[= ]\.gitleaks\.toml/)
    // A scan whose exit code is ignored is a log line, not a gate.
    expect(workflow).toMatch(/--exit-code[= ]1/)
  })
})
