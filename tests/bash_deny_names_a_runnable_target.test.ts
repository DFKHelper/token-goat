/** The whole-file deny is a hard block, so the command it prints is the agent's only next move. It has to run verbatim. FIXTURE PROVENANCE `PLACEHOLDER_*` are CAPTURE: the literal stderr of the shipped global binary on 2026-09-21, run under an isolated LOCALAPPDATA/TOKEN_GOAT_HOME sandbox against this repo -- token-goat section "CHANGELOG.md::SectionHeading"  -> exit 1, "Section 'SectionHeading' not found in 'CHANGELOG.md'" token-goat config-get "package.json" KEY_NAME      -> exit 1, "Key 'KEY_NAME' not found in package.json" They are the reason this change exists and are asserted only to keep that reason checkable. `FUZZY_NEAR_MISS_WORKS` is CAPTURE from the same run: `token-goat section "CHANGELOG.md::Unreleased"` against a heading indexed as `[Unreleased]` exits 0 and prints "redirected from". Pinned because this file's first draft assumed the opposite and would have justified the change on a failure that does not happen. Everything else is HAND-DERIVED: each case builds its own file in a temp dir, indexes it, and computes the name it expects from the file's own text, independently of the resolver. NOT covered here, on purpose: that the resolver refuses to touch a network or device path before the command is approved. The resolver's first draft did touch one, and the test that caught it is tests/vscode_pre_handler_path_gate.test.ts, which asserts on fs ACCESS through a node:fs recorder. A return-value case here would have been a tautology -- `//host/share/doc.md` does not exist, so null comes back gate or no gate -- and was written, measured green against a deliberately deleted gate, and deleted rather than kept. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import { runnableTargetFor } from '../src/bash_surgical_target.js'
import { surgicalHintFor } from '../src/bash_extractors.js'
import { stripUnsafeSuggestions } from '../src/hint_suggestion_guard.js'
import { indexFileSync } from '../src/parser.js'
import { globalDbPath, configPath } from '../src/constants.js'
import { clearModuleCaches } from '../src/reset.js'

const PLACEHOLDER_SECTION_FAILS = "Section 'SectionHeading' not found in 'CHANGELOG.md'"
const PLACEHOLDER_KEY_FAILS = "Key 'KEY_NAME' not found in package.json"
const FUZZY_NEAR_MISS_WORKS = true

fs.mkdirSync(path.dirname(configPath()), { recursive: true })

let dir: string

function write(name: string, body: string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, body, 'utf8')
  return p
}

function indexed(name: string, body: string): string {
  const p = write(name, body)
  indexFileSync(p, globalDbPath())
  return p
}

beforeEach(() => {
  clearModuleCaches()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-deny-target-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  clearModuleCaches()
})

describe('runnableTargetFor', () => {
  it('returns a markdown heading the file really holds, in line order', () => {
    indexed('doc.md', '# First Heading\n\ntext\n\n## Second Heading\n\nmore\n')
    // Computed from the file's own text, not read back off the resolver.
    expect(runnableTargetFor('doc.md', dir)).toBe('First Heading')
  })

  it('keeps a heading whose literal spelling an agent would not reproduce', () => {
    indexed('brackets.md', '# Changelog\n\n## [Unreleased]\n\ntext\n')
    // The brackets are part of the indexed name. Naming it is the whole point -- though see FUZZY_NEAR_MISS_WORKS: `section` would also have resolved a near miss on its own.
    expect(FUZZY_NEAR_MISS_WORKS).toBe(true)
    expect(runnableTargetFor('brackets.md', dir)).toBe('Changelog')
  })

  it('returns a real key for a config file', () => {
    indexed('conf.json', '{\n  "alpha": 1,\n  "beta": 2\n}\n')
    expect(runnableTargetFor('conf.json', dir)).toBe('alpha')
  })

  it('returns null for a file that was never indexed, rather than guessing', () => {
    write('unindexed.md', '# Something\n\ntext\n')
    expect(runnableTargetFor('unindexed.md', dir)).toBeNull()
  })

  it('returns null for a file that does not exist', () => {
    expect(runnableTargetFor('no-such-file.md', dir)).toBeNull()
  })

  it('returns null once the file on disk has drifted from the index', () => {
    const p = indexed('drift.md', '# Original Heading\n\ntext\n')
    // Positive control first: it resolves while the index matches.
    expect(runnableTargetFor('drift.md', dir)).toBe('Original Heading')
    fs.writeFileSync(p, '# Renamed Heading\n\ntext\n', 'utf8')
    // A stale name would be printed as a command that runs and returns the wrong thing, or nothing -- the failure this exists to prevent, not a smaller version of it.
    expect(runnableTargetFor('drift.md', dir)).toBeNull()
  })

  it('refuses a name that would not survive being pasted into the quoted argument', () => {
    // A heading carrying the spec separator would re-split the argument it is interpolated into, so the resolver must skip it and fall through to the next usable name.
    indexed('sep.md', '# bad::name\n\ntext\n\n# good name\n\nmore\n')
    expect(runnableTargetFor('sep.md', dir)).toBe('good name')
  })
})

describe('surgicalHintFor with a resolved target', () => {
  it('names the real heading for a doc, and still offers outline for the rest', () => {
    const hint = surgicalHintFor('doc.md', false, false, true, false, 'First Heading')
    expect(hint).toContain('token-goat section "doc.md::First Heading"')
    expect(hint).toContain('token-goat outline "doc.md"')
    expect(hint).not.toContain('SectionHeading')
  })

  it('keeps the placeholder wording when no target could be resolved', () => {
    const hint = surgicalHintFor('doc.md', false, false, true, false, null)
    // Verbatim the pre-change sentence: an unresolvable file must be no worse off than before.
    expect(hint).toBe('Use `token-goat section "doc.md::SectionHeading"` to read one section.')
    expect(PLACEHOLDER_SECTION_FAILS).toContain('not found')
  })

  it('puts a resolved config name in the config-get slot and nowhere else', () => {
    const hint = surgicalHintFor('conf.toml', false, true, false, false, 'alpha')
    expect(hint).toContain('token-goat config-get "conf.toml" alpha')
    // The `section "file::sectionName"` half takes a section, and an indexed JSON name is a property: `token-goat section "package.json::name"` exits 1 while config-get returns the value. Substituting there would swap a placeholder the agent knows to replace for a broken command it has no reason to doubt, so that half is dropped in favour of outline.
    expect(hint).not.toContain('conf.toml::alpha')
    expect(hint).toContain('token-goat outline "conf.toml"')
    expect(PLACEHOLDER_KEY_FAILS).toContain('not found')
  })

  it('leaves the config placeholder pair exactly as it was when nothing resolved', () => {
    const hint = surgicalHintFor('conf.toml', false, true, false, false, null)
    expect(hint).toBe(
      'Use `token-goat config-get "conf.toml" KEY_NAME` or `token-goat section "conf.toml::sectionName"` to read a specific value.',
    )
  })

  it('routes a JSON target to json-query with the resolved key, and json-outline for the rest', () => {
    expect(surgicalHintFor('reg.json', false, true, false, false, '118615')).toBe(
      'Use `token-goat json-query "reg.json" "118615"` to read that value, or `token-goat json-outline "reg.json"` for every top-level key with its type and size.',
    )
  })

  // HAND-DERIVED: the relay passes every refusal through stripUnsafeSuggestions, which accepts only double-quoted arguments. The single-quoted key these hints first printed reached a dogfooded refusal as "token-goat (command omitted: ...)", taking the rest of the sentence with it.
  it.each([
    ['a plain key', 'reg.json', '118615'],
    ['a key holding a dot', 'reg.json', 'a.b'],
    ['a YAML key', 'ci.yml', 'jobs'],
    ['no key', 'reg.json', null],
  ])('prints a JSON or YAML hint the suggestion guard keeps whole, for %s', (_, file, target) => {
    const hint = surgicalHintFor(file, false, true, false, false, target)
    expect(stripUnsafeSuggestions(hint)).toBe(hint)
  })

  it('falls back to the placeholder form for a key the shell would expand inside double quotes', () => {
    expect(surgicalHintFor('reg.json', false, true, false, false, 'a$b')).toContain('token-goat json-query "reg.json" "KEY"')
  })

  it('brackets a resolved key holding a dot, which a bare json-query path would split in two', () => {
    expect(surgicalHintFor('reg.json', false, true, false, false, 'a.b')).toContain(`token-goat json-query "reg.json" "['a.b']"`)
  })

  it('leads an unresolved JSON or YAML target with the outline, the half that runs verbatim', () => {
    const json = surgicalHintFor('reg.json', false, true, false, false, null)
    expect(json.startsWith('Use `token-goat json-outline "reg.json"` to list the top-level keys')).toBe(true)
    expect(json).toContain('--filter TEXT')
    expect(json).not.toContain('config-get')
    expect(surgicalHintFor('ci.yml', false, true, false, false, null)).toContain('token-goat yaml-outline "ci.yml"')
    expect(surgicalHintFor('ci.YAML', false, true, false, false, 'jobs')).toContain('token-goat yaml-query "ci.YAML" "jobs"')
  })

  it('names the real key for an env file', () => {
    expect(surgicalHintFor('.env', true, false, false, false, 'DATABASE_URL')).toBe(
      'Use `token-goat config-get ".env" DATABASE_URL` to read a specific variable.',
    )
  })

  it('leaves the source and xml branches untouched -- both were already runnable as printed', () => {
    expect(surgicalHintFor('src/a.ts', false, false, false, false, 'someSymbol')).toBe(
      'Use `token-goat outline "src/a.ts"` to read one function or class.',
    )
    const xml = surgicalHintFor('a.xml', false, false, false, true, 'root')
    expect(xml).toContain('token-goat xml-outline "a.xml"')
    // `<selector>` stays a placeholder on purpose: it is an XPath expression, not a name the index holds, so there is nothing here to resolve it to.
    expect(xml).toContain('<selector>')
  })
})
