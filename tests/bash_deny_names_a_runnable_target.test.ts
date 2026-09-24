/** The whole-file deny is a hard block, so the command it prints is the agent's only next move. It has to run verbatim. FIXTURE PROVENANCE `PLACEHOLDER_*` are CAPTURE: the literal stderr of the shipped global binary on 2026-09-21, run under an isolated LOCALAPPDATA/TOKEN_GOAT_HOME sandbox against this repo -- token-goat section "CHANGELOG.md::SectionHeading"  -> exit 1, "Section 'SectionHeading' not found in 'CHANGELOG.md'" token-goat config-get "package.json" KEY_NAME      -> exit 1, "Key 'KEY_NAME' not found in package.json" They are the reason this change exists and are asserted only to keep that reason checkable. `FUZZY_NEAR_MISS_WORKS` is CAPTURE from the same run: `token-goat section "CHANGELOG.md::Unreleased"` against a heading indexed as `[Unreleased]` exits 0 and prints "redirected from". Pinned because this file's first draft assumed the opposite and would have justified the change on a failure that does not happen. Everything else is HAND-DERIVED: each case builds its own file in a temp dir, indexes it where the case is about the index, and computes the name it expects from the file's own text, independently of the resolver. NOT covered here, on purpose: that the resolver refuses to touch a network or device path before the command is approved. The test that covers it is tests/vscode_pre_handler_path_gate.test.ts, which asserts on fs ACCESS through a node:fs recorder. A return-value case here would be a tautology -- `//host/share/doc.md` does not exist, so the placeholder comes back gate or no gate. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import { hintTarget, type HintTarget } from '../src/hint_target.js'
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

/** What a Bash command naming `name` resolves to, the way hooks_bash.ts asks: relative to the command's directory. */
function fromCommand(name: string, slice: HintTarget['slice'] = 'section'): HintTarget {
  return hintTarget(name, slice, { cwd: dir })
}

const real = (name: string, slice: HintTarget['slice']): HintTarget => ({ name, real: true, slice })
const none = (slice: HintTarget['slice'], name: string): HintTarget => ({ name, real: false, slice })

beforeEach(() => {
  clearModuleCaches()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-deny-target-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  clearModuleCaches()
})

describe('hintTarget for a path written in a command', () => {
  it('returns the first real heading after a lone title, in line order', () => {
    indexed('doc.md', '# First Heading\n\ntext\n\n## Second Heading\n\nmore\n')
    // The lone `#` title's section is the whole file the deny just refused, so the heading after it is named.
    expect(fromCommand('doc.md')).toEqual(real('Second Heading', 'section'))
  })

  it('keeps a heading whose literal spelling an agent would not reproduce', () => {
    indexed('brackets.md', '# Changelog\n\n## [Unreleased]\n\ntext\n')
    // The brackets are part of the indexed name. Naming it is the whole point -- though see FUZZY_NEAR_MISS_WORKS: `section` would also have resolved a near miss on its own.
    expect(FUZZY_NEAR_MISS_WORKS).toBe(true)
    expect(fromCommand('brackets.md').name).toBe('[Unreleased]')
  })

  it('returns a real key for a config file', () => {
    indexed('conf.json', '{\n  "alpha": 1,\n  "beta": 2\n}\n')
    expect(fromCommand('conf.json', 'key')).toEqual(real('alpha', 'key'))
  })

  it('reads the index for a heading past the bounded head read', () => {
    // 40 KB of prose before the only heading: the 32 KiB head read cannot see it, so only the index can name it.
    indexed('deep.md', 'intro line of prose that pads the file\n'.repeat(1100) + '\n## Deep Heading\n\ntext\n')
    expect(fromCommand('deep.md').name).toBe('Deep Heading')
  })

  it('reads the head of a file that was never indexed', () => {
    write('unindexed.md', '## Something\n\ntext\n')
    expect(fromCommand('unindexed.md')).toEqual(real('Something', 'section'))
  })

  it('falls back to the placeholder for a file that does not exist', () => {
    expect(fromCommand('no-such-file.md')).toEqual(none('section', 'SectionHeading'))
  })

  it('names what is on disk once the file has drifted from the index, never the stale name', () => {
    const p = indexed('drift.md', '## Original Heading\n\ntext\n')
    // Positive control first: it resolves while the index matches.
    expect(fromCommand('drift.md').name).toBe('Original Heading')
    fs.writeFileSync(p, '## Renamed Heading\n\ntext\n', 'utf8')
    // A stale name would be printed as a command that runs and returns the wrong thing, or nothing.
    expect(fromCommand('drift.md').name).toBe('Renamed Heading')
  })

  it('refuses a name that would not survive being pasted into the quoted argument', () => {
    // A heading carrying the spec separator would re-split the argument it is interpolated into, so the resolver skips it and falls through to the next usable name.
    indexed('sep.md', '# bad::name\n\ntext\n\n# good name\n\nmore\n')
    expect(fromCommand('sep.md').name).toBe('good name')
  })
})

describe('surgicalHintFor with a resolved target', () => {
  it('leads with the real heading for a doc, and still offers outline for the rest', () => {
    const hint = surgicalHintFor('doc.md', false, false, true, false, real('First Heading', 'section'), '`cat` loads the entire file into context.')
    expect(hint).toBe('Run `token-goat section "doc.md::First Heading"` to read one section, or `token-goat outline "doc.md"` for every heading with line ranges.\n`cat` loads the entire file into context.')
  })

  it('keeps the placeholder name when no target could be resolved', () => {
    const hint = surgicalHintFor('doc.md', false, false, true, false, none('section', 'SectionHeading'))
    expect(hint).toBe('Run `token-goat section "doc.md::SectionHeading"` to read one section, or `token-goat outline "doc.md"` for every heading with line ranges.')
    expect(PLACEHOLDER_SECTION_FAILS).toContain('not found')
  })

  it('sends a TOML table to section, which config-get cannot read', () => {
    const hint = surgicalHintFor('conf.toml', false, true, false, false, real('server', 'section'))
    expect(hint).toBe('Run `token-goat section "conf.toml::server"` to read one table, or `token-goat outline "conf.toml"` for every key with line ranges.')
  })

  it('sends a .properties key to config-get', () => {
    const hint = surgicalHintFor('app.properties', false, true, false, false, real('db.url', 'key'))
    expect(hint).toBe('Run `token-goat config-get "app.properties" db.url` to read a specific value, or `token-goat outline "app.properties"` for every key with line ranges.')
    expect(PLACEHOLDER_KEY_FAILS).toContain('not found')
  })

  it('routes a JSON target to json-query with the resolved key, and json-outline for the rest', () => {
    expect(surgicalHintFor('reg.json', false, true, false, false, real('118615', 'key'))).toBe(
      'Run `token-goat json-query "reg.json" "118615"` to read that value, or `token-goat json-outline "reg.json"` for every top-level key with its type and size.',
    )
  })

  // HAND-DERIVED: the relay passes every refusal through stripUnsafeSuggestions, which accepts only double-quoted arguments. The single-quoted key these hints first printed reached a dogfooded refusal as "token-goat (command omitted: ...)", taking the rest of the sentence with it.
  it.each([
    ['a plain key', 'reg.json', real('118615', 'key')],
    ['a key holding a dot', 'reg.json', real('a.b', 'key')],
    ['a YAML key', 'ci.yml', real('jobs', 'key')],
    ['no key', 'reg.json', none('key', 'KEY_NAME')],
  ])('prints a JSON or YAML hint the suggestion guard keeps whole, for %s', (_, file, target) => {
    const hint = surgicalHintFor(file, false, true, false, false, target, '`cat` loads the entire file into context.')
    expect(stripUnsafeSuggestions(hint)).toBe(hint)
  })

  it('brackets a resolved key holding a dot, which a bare json-query path would split in two', () => {
    expect(surgicalHintFor('reg.json', false, true, false, false, real('a.b', 'key'))).toContain(`token-goat json-query "reg.json" "['a.b']"`)
  })

  it('leads an unresolved JSON or YAML target with the outline, the half that runs verbatim', () => {
    const json = surgicalHintFor('reg.json', false, true, false, false, none('key', 'KEY_NAME'))
    expect(json.startsWith('Run `token-goat json-outline "reg.json"` to list the top-level keys')).toBe(true)
    expect(json).toContain('--filter TEXT')
    expect(json).not.toContain('config-get')
    expect(surgicalHintFor('ci.yml', false, true, false, false, none('key', 'KEY_NAME'))).toContain('token-goat yaml-outline "ci.yml"')
    expect(surgicalHintFor('ci.YAML', false, true, false, false, real('jobs', 'key'))).toContain('token-goat yaml-query "ci.YAML" "jobs"')
  })

  it('names the real key for an env file', () => {
    expect(surgicalHintFor('.env', true, false, false, false, real('DATABASE_URL', 'key'))).toBe('Run `token-goat config-get ".env" DATABASE_URL` to read a specific variable.')
  })

  it('reads a real symbol out of a source file, and leads with outline when there is none', () => {
    expect(surgicalHintFor('src/a.ts', false, false, false, false, real('someSymbol', 'symbol'))).toBe(
      'Run `token-goat read "src/a.ts::someSymbol"` to read one function or class, or `token-goat outline "src/a.ts"` for all of them.',
    )
    expect(surgicalHintFor('src/a.ts', false, false, false, false, none('symbol', 'SymbolName'))).toBe(
      'Run `token-goat outline "src/a.ts"` to list every function and class with its line range.',
    )
  })

  it('leaves the xml selector a placeholder: it is an XPath expression, not a name the index holds', () => {
    const xml = surgicalHintFor('a.xml', false, false, false, true, real('root', 'section'))
    expect(xml.startsWith('Run `token-goat xml-outline "a.xml"`')).toBe(true)
    expect(xml).toContain('<selector>')
  })
})
