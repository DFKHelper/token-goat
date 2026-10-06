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
import { normalizePath } from '../src/paths.js'
import { ROOT, runBundle } from './helpers/bundle.js'
import { DOTENV_VALUE_PLACEHOLDER } from '../src/dotenv_redact.js'

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

describe('hintTarget for a symbol a Grep pattern names', () => {
  const SRC = 'export function alpha() { return 1 }\nexport function beta() { return 2 }\nexport class Box {\n  open() { return 4 }\n}\n'

  // HAND-DERIVED: the symbol each pattern targets is read off the pattern text against SRC, not off the resolver.
  it.each([
    ['function beta', 'beta'],
    ['function Box.open', 'Box.open'],
    ['open', 'open'],
    ['function nothingHere', 'alpha'],
    ['', 'alpha'],
  ])('resolves pattern %j to %s in an indexed file', (pattern, expected) => {
    indexed('a.ts', SRC)
    expect(hintTarget('a.ts', 'symbol', { cwd: dir, pattern })).toEqual(real(expected, 'symbol'))
  })

  it('resolves the pattern against the file head when the file was never indexed', () => {
    write('b.ts', SRC)
    expect(hintTarget('b.ts', 'symbol', { cwd: dir, pattern: 'function beta' })).toEqual(real('beta', 'symbol'))
  })

  it('ignores the pattern when the call carries none', () => {
    indexed('a.ts', SRC)
    expect(hintTarget('a.ts', 'symbol', { cwd: dir })).toEqual(real('alpha', 'symbol'))
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
    expect(hint).toBe('Run `token-goat config-get "app.properties" "db.url"` to read a specific value.')
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
    expect(surgicalHintFor('.env', true, false, false, false, real('DATABASE_URL', 'key'))).toBe('Run `token-goat config-get ".env" "DATABASE_URL"` to read a specific variable.')
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

// FIXTURE PROVENANCE for the describes below. Properties lines are FORMAT-DERIVED from the java.util.Properties#load(Reader) javadoc (https://docs.oracle.com/javase/8/docs/api/java/util/Properties.html): a key ends at the first unescaped `=`, `:` or white space, a line may start with white space, `#` and `!` open a comment line, and the javadoc's own examples `Truth = Beauty`, ` Truth:Beauty` and `fruits                           apple, banana, pear` all define one key each (the last one with value "apple, banana, pear"); there is no inline comment, so `#` inside a value stays in it. The `export KEY=value` .env line is FORMAT-DERIVED from the python-dotenv README ("export" prefix, https://github.com/theskumar/python-dotenv#file-format). The hint shapes asserted are CAPTURE: a PreToolUse payload piped to the built bundle on 2026-10-03, before this change `config-get "application.properties" spring.datasource.url` exited 1 with "Key 'spring.datasource.url' not found in application.properties" and `outline application.properties` exited 1 with "token-goat has no symbol extractor for this file type (.properties)".
describe('the commands a deny names run against the file', () => {
  let home: string
  let proj: string

  const env = (): NodeJS.ProcessEnv => ({ ...process.env, TOKEN_GOAT_HOME: home, LOCALAPPDATA: home, XDG_DATA_HOME: home })

  /** Splits a printed `token-goat ARG "ARG"` command into argv, honouring the double quotes the hint guard requires. */
  function argvOf(command: string): string[] {
    return Array.from(command.slice('token-goat '.length).matchAll(/"([^"]*)"|(\S+)/g), (m) => m[1] ?? m[2] ?? '')
  }

  /** Every fenced command in a hook's output text. */
  function namedCommands(stdout: string): string[] {
    const parsed = JSON.parse(stdout) as { reason?: string; hookSpecificOutput?: { additionalContext?: string } }
    const text = parsed.reason ?? parsed.hookSpecificOutput?.additionalContext ?? ''
    return Array.from(text.matchAll(/`(token-goat [^`\r\n]+)`/g), (m) => m[1]!)
  }

  function hook(tool: string, input: Record<string, unknown>): string {
    const payload = { session_id: 'deny-runs', hook_event_name: 'PreToolUse', tool_name: tool, cwd: proj, tool_input: input }
    return runBundle(['hook', 'pre_tool_use'], { cwd: proj, env: env(), input: JSON.stringify(payload) }).stdout
  }

  function run(command: string): { status: number | null; stdout: string; stderr: string } {
    return runBundle(argvOf(command), { cwd: proj, env: env() })
  }

  function configGet(file: string, key: string): { status: number | null; stdout: string } {
    const r = runBundle(['config-get', file, key], { cwd: proj, env: env() })
    return { status: r.status, stdout: r.stdout.trim() }
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-deny-run-home-'))
    // Under the repo's ignored .tmp, not the system temp: the Bash hook lets a read of a system-temp file through, so a project there would never be denied.
    fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true })
    proj = fs.mkdtempSync(path.join(ROOT, '.tmp', 'tg-deny-run-proj-'))
  })

  afterEach(() => {
    for (const d of [home, proj]) fs.rmSync(d, { recursive: true, force: true })
  })

  it.each([
    ['application.properties', 'spring.datasource.url=jdbc:x\nserver.port=8080\n', 'jdbc:x'],
    ['.env.local', 'export API_KEY=abc\nexport PORT=1\n', DOTENV_VALUE_PLACEHOLDER],
    ['.env', 'DATABASE_URL=postgres://h/db\nPORT=2\n', DOTENV_VALUE_PLACEHOLDER],
  ])('cat of %s is denied with commands that all exit 0, the first returning the value', (file, body, value) => {
    fs.writeFileSync(path.join(proj, file), body, 'utf8')
    const commands = namedCommands(hook('Bash', { command: 'cat ' + file }))
    expect(commands.length).toBeGreaterThan(0)
    const results = commands.map((c) => ({ c, ...run(c) }))
    // The hint names only commands that run; a command nobody executed is how `outline app.properties` shipped.
    expect(results.filter((r) => r.status !== 0).map((r) => r.c + ' => ' + r.stderr)).toEqual([])
    expect(results[0]?.stdout.trim()).toBe(value)
  })

  it('never offers outline for a .properties file, which has no extractor', () => {
    fs.writeFileSync(path.join(proj, 'app.properties'), 'a.b=1\n', 'utf8')
    expect(namedCommands(hook('Bash', { command: 'cat app.properties' })).join('\n')).not.toContain('outline')
  })

  it('names no config-get or placeholder key for an empty .properties file, where no key exists to name', () => {
    fs.writeFileSync(path.join(proj, 'empty.properties'), '# nothing here\n', 'utf8')
    const joined = namedCommands(hook('Bash', { command: 'cat empty.properties' })).join('\n')
    expect(joined).not.toContain('KEY_NAME')
    expect(joined).not.toContain('config-get')
    expect(joined).not.toContain('outline')
  })

  // CAPTURE 2026-10-03 against the built bundle: `section "d.rst::Sub"` returns the section, `outline d.rst` exits 1 (no extractor), `section` on a .txt exits 1 ("has no headings").
  it('cat of a .rst file names section but never outline, and the named commands run', () => {
    fs.writeFileSync(path.join(proj, 'd.rst'), 'Title\n=====\n\nIntro\n\nSub\n---\n\nbody\n'.repeat(1), 'utf8')
    const commands = namedCommands(hook('Bash', { command: 'cat d.rst' }))
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.join('\n')).not.toContain('outline')
    expect(commands.filter((c) => run(c).status !== 0)).toEqual([])
  })

  it('cat of a .txt file names no section or outline, only a grep that runs', () => {
    fs.writeFileSync(path.join(proj, 'n.txt'), 'alpha\nbeta\n'.repeat(400), 'utf8')
    const commands = namedCommands(hook('Bash', { command: 'cat n.txt' }))
    const joined = commands.join('\n')
    expect(joined).not.toContain('outline')
    expect(joined).not.toContain('token-goat section')
    expect(commands.filter((c) => run(c.replace('<pattern>', 'beta')).status !== 0)).toEqual([])
  })

  it('the Grep tool on a .txt file gets no structural hint', () => {
    fs.writeFileSync(path.join(proj, 'n.txt'), 'class A\n'.repeat(400), 'utf8')
    const out = hook('Grep', { pattern: 'class A', path: path.join(proj, 'n.txt') })
    expect(namedCommands(out || '{}').join('\n')).not.toMatch(/section|outline/)
  })

  describe('config-get on flat key/value files', () => {
    it.each([
      ['a dotted key held whole', 'app.properties', 'spring.datasource.url=jdbc:x\nserver.port=8080\n', 'server.port', '8080'],
      ['a colon separator', 'app.properties', 'name : bob\n', 'name', 'bob'],
      ['a colon with no spaces', 'app.properties', ' Truth:Beauty\n', 'Truth', 'Beauty'],
      ['a whitespace separator keeping the rest of the line', 'app.properties', 'fruits                           apple, banana, pear\n', 'fruits', 'apple, banana, pear'],
      ['an equals with spaces', 'app.properties', 'Truth = Beauty\n', 'Truth', 'Beauty'],
      ['no inline comment in a value', 'app.properties', 'url=jdbc:x#frag;more\n', 'url', 'jdbc:x#frag;more'],
      ['a bracket line that is not a section', 'app.properties', '[x]\nafter=1\n', 'after', '1'],
      // A .env value is redacted by config-get (src/dotenv_redact.ts), so finding the export line shows as the placeholder and a miss shows as exit 1.
      ['an export prefix', '.env', 'export PORT=1\n', 'PORT', DOTENV_VALUE_PLACEHOLDER],
      ['an export prefix in a named env file', 'prod.env', 'export PORT=3\n', 'PORT', DOTENV_VALUE_PLACEHOLDER],
    ])('reads %s', (_, file, body, key, expected) => {
      fs.writeFileSync(path.join(proj, file), body, 'utf8')
      expect(configGet(file, key)).toEqual({ status: 0, stdout: expected })
    })

    it('still splits a dotted key into INI section and leaf, after trying it whole', () => {
      fs.writeFileSync(path.join(proj, 'c.ini'), '[sec.sub]\nk=v\n', 'utf8')
      expect(configGet('c.ini', 'sec.sub.k')).toEqual({ status: 0, stdout: 'v' })
    })

    it('prefers the whole key over a section split when both exist', () => {
      fs.writeFileSync(path.join(proj, 'app.properties'), 'a.b=flat\n', 'utf8')
      expect(configGet('app.properties', 'a.b')).toEqual({ status: 0, stdout: 'flat' })
    })

    it('does not give an INI file the properties separators, so a prefix-sharing key is not mistaken for it', () => {
      fs.writeFileSync(path.join(proj, 'c.ini'), 'name extra = v\n', 'utf8')
      expect(configGet('c.ini', 'name').status).toBe(1)
    })

    it('does not accept an export prefix outside an env file', () => {
      fs.writeFileSync(path.join(proj, 'c.ini'), 'export K=v\n', 'utf8')
      expect(configGet('c.ini', 'K').status).toBe(1)
    })

    it('still reports a missing key', () => {
      fs.writeFileSync(path.join(proj, 'app.properties'), 'a=1\n', 'utf8')
      expect(configGet('app.properties', 'b').status).toBe(1)
    })
  })

  describe('the Grep structural-search hint', () => {
    const SRC = 'export function alpha() { return 1 }\nexport function beta() { return 2 }\nexport function gamma() { return 3 }\nexport class Box {\n  open() { return 4 }\n}\n'

    // HAND-DERIVED: which symbol each pattern targets is read off the pattern text, not off the resolver.
    it.each([
      ['function beta', 'a.ts::beta'],
      ['export function gamma', 'a.ts::gamma'],
      ['class Box', 'a.ts::Box'],
      ['^class Box', 'a.ts::Box'],
      ['function nothingHere', 'a.ts::alpha'],
    ])('for pattern %s names the symbol it targets, and the command runs', (pattern, spec) => {
      fs.writeFileSync(path.join(proj, 'a.ts'), SRC, 'utf8')
      const commands = namedCommands(hook('Grep', { pattern, path: 'a.ts' }))
      expect(commands[0]).toBe('token-goat read "' + spec + '"')
      expect(run(commands[0]!).status).toBe(0)
    })

    it('names the targeted Python def, whatever order the file defines them in', () => {
      fs.writeFileSync(path.join(proj, 'b.py'), 'def alpha():\n    return 1\n\ndef beta():\n    return 2\n', 'utf8')
      expect(namedCommands(hook('Grep', { pattern: 'def beta', path: 'b.py' }))[0]).toBe('token-goat read "b.py::beta"')
    })
  })

  describe('a large indexed file, hinted through the built bundle', () => {
    const FILLER = '  # filler comment line\n'.repeat(6)
    const count = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

    const shown = normalizePath

    function indexProject(): void {
      fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"p"}', 'utf8')
      expect(runBundle(['index', '.', '--walk'], { cwd: proj, env: env() }).status).toBe(0)
    }

    // HAND-DERIVED: the names are the ones written into the fixtures below, 0..119 of each family, so `Get-Thing3` and `Heading 3` also prefix `Get-Thing30` and `Heading 30`.
    it.each([
      ['function Get-Thing3', 'read "big.ps1::Get-Thing3"'],
      ['function Get-Thing30', 'read "big.ps1::Get-Thing30"'],
      ['function Get-Thing3$', 'read "big.ps1::Get-Thing3"'],
    ])('Grep %s on a PowerShell file names the hyphenated function it targets', (pattern, command) => {
      fs.writeFileSync(path.join(proj, 'big.ps1'), count(120).map((i) => `function Get-Thing${i} {\n${FILLER}  Write-Output ${i}\n}\n`).join(''), 'utf8')
      indexProject()
      const commands = namedCommands(hook('Grep', { pattern, path: 'big.ps1' }))
      expect(commands[0]).toBe('token-goat ' + command)
      expect(run(commands[0]!).status).toBe(0)
    })

    it.each([
      ['^## Heading 3', 'Heading 3'],
      ['^## Heading 3$', 'Heading 3'],
      ['^## Heading 30$', 'Heading 30'],
      ['^## Heading 30', 'Heading 30'],
    ])('Grep %s on a markdown file names the heading it targets', (pattern, heading) => {
      fs.writeFileSync(path.join(proj, 'big.md'), count(120).map((i) => `## Heading ${i}\n\n${'prose line for padding the section out\n'.repeat(4)}\n`).join(''), 'utf8')
      indexProject()
      const commands = namedCommands(hook('Grep', { pattern, path: 'big.md' }))
      expect(commands[0]).toBe('token-goat section "big.md::' + heading + '"')
      expect(run(commands[0]!).status).toBe(0)
    })

    it('the Read hint for a shell script holding only functions leads with read, not a section that exits 1', () => {
      const file = path.join(proj, 'big.sh')
      fs.writeFileSync(file, '#!/bin/bash\n' + count(120).map((i) => `func_${i}() {\n${FILLER}  echo ${i}\n}\n`).join(''), 'utf8')
      indexProject()
      const commands = namedCommands(hook('Read', { file_path: file }))
      expect(commands[0]).toBe('token-goat read "' + shown(file) + '::func_0"')
      expect(commands.filter((c) => c.startsWith('token-goat section'))).toEqual([])
      expect(run(commands[0]!).status).toBe(0)
    })

    it('the Read hint for a shell script with banner headings still offers section, and it runs', () => {
      const file = path.join(proj, 'banner.sh')
      const body = count(120).map((i) => `# === Step ${i} ===\nfunc_${i}() {\n${FILLER}  echo ${i}\n}\n`).join('')
      fs.writeFileSync(file, '#!/bin/bash\n' + body, 'utf8')
      indexProject()
      const commands = namedCommands(hook('Read', { file_path: file }))
      expect(commands[0]).toBe('token-goat section "' + shown(file) + '::Step 0"')
      expect(run(commands[0]!).status).toBe(0)
    })
  })
})
