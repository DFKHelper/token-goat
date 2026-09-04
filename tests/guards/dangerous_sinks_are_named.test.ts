/**
 * The in-suite static pass: an inventory of every construct in `src/` that hands a string to an
 * interpreter, forced to be either absent or named with a reason.
 *
 * This repo already has eighty-odd structural guards, and every one of them encodes a defect
 * somebody already found. That is the gap this file exists to cover: it is not keyed on a bug, it
 * is keyed on a *shape*, so a sink introduced next year fails here whether or not anyone has
 * thought about it. It is the cheap half of a security scan -- the half that answers "where are the
 * sinks" exhaustively. The expensive half, "does untrusted data reach one", needs interprocedural
 * dataflow and runs in CI (see the CodeQL job in `.github/workflows/codeql.yml`), because it cannot
 * be made fast, offline and cross-platform enough to sit in `npm test`.
 *
 * On why this is hand-rolled rather than `eslint-plugin-security`, which is the obvious candidate:
 * it was measured on this codebase on 2026-09-04 and produces 1,691 findings across 177 of 255
 * source files. Three rules account for 96% of them and none is usable here. `detect-unsafe-regex`
 * (260) is the star-height heuristic, strictly weaker than the automaton analysis
 * `eslint-plugin-regexp`'s `no-super-linear-backtracking` already runs in `npm run lint`.
 * `detect-non-literal-fs-filename` (511) flags reading a file whose name came from a variable,
 * which is what token-goat *is*. `detect-object-injection` (848) flags every computed index,
 * including `arr[i]`. The remaining `detect-possible-timing-attacks` hits (4) are name matches --
 * a lock-file token compare and a variable called `auth` that holds a hostname -- against a product
 * with no secret-comparison surface at all. A gate nobody can turn on is not a gate, and a
 * suppression file with 1,691 entries is worse than no rule, because it reads like a decision.
 *
 * What survives that filter is the part `detect-object-injection` was gesturing at and could not
 * express: a computed lookup is only interesting when it reaches a sink. So the sinks are the
 * population, and the list below is the contract.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { stripComments } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

interface SrcFile {
  readonly rel: string
  readonly code: string
}

function srcFiles(): readonly SrcFile[] {
  const out: string[] = []
  ;(function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) out.push(p)
    }
  })(SRC_DIR)
  const pinned = pinnedPopulation({
    what: 'src/**/*.ts files scanned for interpreter sinks',
    items: out,
    floor: 150,
    mustInclude: ['bash_runner.ts', 'cli_doctor.ts', path.join('bridges', 'copilot_cli.ts')],
  })
  return pinned.map((p) => ({
    rel: path.relative(SRC_DIR, p).split(path.sep).join('/'),
    code: stripComments(fs.readFileSync(p, 'utf8')),
  }))
}

/** `file:line` for every match of `re` in the scanned population. */
function sites(re: RegExp): string[] {
  const out: string[] = []
  for (const { rel, code } of srcFiles()) {
    const lines = code.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const fresh = new RegExp(re.source, re.flags.replace('g', ''))
      if (fresh.test(lines[i]!)) out.push(`${rel}:${i + 1}`)
    }
  }
  return out
}

/**
 * Sinks this product has no use for, asserted absent rather than allowlisted.
 *
 * All four are at zero today, and nothing says so anywhere -- which means the first one to be added
 * would arrive in an ordinary review with nothing objecting. `eval` and `new Function` compile a
 * string; `vm` does the same behind a nicer name and its "sandbox" is not a security boundary on
 * the Node platform. `child_process.exec` takes a command *string* rather than an argv array, which
 * is the difference between passing an argument and writing a shell script, so it is excluded by
 * shape even where the string is currently constant.
 *
 * Deliberately not exemptible. A genuine need for one of these is a design conversation, not a line
 * in a map, and it should have to delete an assertion that says so.
 */
const FORBIDDEN: ReadonlyMap<string, RegExp> = new Map([
  ['eval()', /(^|[^.\w$])eval\s*\(/],
  ['new Function()', /\bnew\s+Function\s*\(/],
  ['node:vm', /\bfrom\s+['"]node:vm['"]|\brequire\(['"]node:vm['"]\)/],
  ['child_process.exec() (string command, not argv)', /(^|[^.\w$])exec\s*\(\s*[`'"]/],
])

/**
 * `shell: true` sites, each with the reason it cannot be an argv array.
 *
 * `shell: true` means the string is parsed by cmd.exe or /bin/sh before anything runs, so every one
 * of these is a place where the *value* has to carry the safety -- there is no argv boundary left
 * to do it. The seven bridge entries are where the value check lives, enforced separately by
 * `shell_concat_is_constrained.test.ts`; this map exists so the inventory itself cannot grow
 * silently, which is the failure the bridges guard cannot see (it only looks at what is already
 * there).
 */
const SHELL_TRUE_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  [
    'bridges/claudecode.ts',
    'Generated hook shim. Runs "token-goat hook <event>" as a last resort; a global npm install ' +
      'puts a .cmd on PATH on Windows and spawnSync cannot exec that without a shell. The event is ' +
      'checked against a closed Set first -- enforced by shell_concat_is_constrained.test.ts.',
  ],
  ['bridges/codex.ts', 'Generated hook shim, same shape and same closed-Set check as claudecode.ts.'],
  ['bridges/grok.ts', 'Generated hook shim, same shape and same closed-Set check as claudecode.ts.'],
  ['bridges/kimi.ts', 'Generated hook shim, same shape and same closed-Set check as claudecode.ts.'],
  [
    'bridges/copilot_cli.ts',
    'Generated hook shim. Reads its event from argv and now gates on hasOwnProperty rather than a ' +
      'bare map lookup, which eight Object.prototype names satisfied.',
  ],
  [
    'bridges/relay_block.ts',
    'Generated hook shim shared by opencode and openclaw. Validates nothing itself; safe because ' +
      'every call site passes a literal, which shell_concat_is_constrained.test.ts checks at both hops.',
  ],
  ['bridges/pi.ts', 'Generated hook shim, same two-hop literal-only argument as relay_block.ts.'],
  [
    'cli_doctor.ts',
    'Spawns the Copilot hook command the user configured in their own hooks.json. Anyone who can ' +
      'write that file already has execution through Copilot, so the shell adds no reachability; ' +
      'doctor exists to run it exactly as Copilot would.',
  ],
])

/**
 * `execSync` sites. Separate from the map above because `execSync` is a shell by definition -- there
 * is no options flag to turn it off -- so the reason has to be about the command string itself.
 */
const EXEC_SYNC_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  [
    'cli_doctor.ts',
    'Two calls, both fixed strings. One runs "token-goat --version". The other interpolates a ' +
      'hardcoded local const holding a Get-CimInstance query into a powershell.exe command line. ' +
      'Nothing external reaches either. Parameterising one is what this entry is here to catch.',
  ],
])

describe('every interpreter sink in src is absent or named', () => {
  it('scans a real population, so an empty scan cannot pass', () => {
    const files = srcFiles()
    expect(files.length).toBeGreaterThanOrEqual(150)
    // A sink the scan is known to find. If this stops matching, the regexes below are reporting
    // "nothing found" about a scan that is no longer looking, and every assertion here goes vacuous.
    expect(
      sites(/\bshell:\s*true/),
      'The scan found no "shell: true" anywhere in src. There are eight, so the scan broke rather ' +
        'than the code improving.',
    ).not.toEqual([])
  })

  it.each([...FORBIDDEN.keys()])('src contains no %s', (label) => {
    const re = FORBIDDEN.get(label)!
    expect(
      sites(re),
      `${label} takes a string and hands it to an interpreter. token-goat has never needed one, ` +
        'and this assertion is the only thing recording that. If you genuinely need it, deleting ' +
        'this line is the change to justify in review -- do not add an exemption map here, because ' +
        'the point of the list is that it has no members.',
    ).toEqual([])
  })

  it('every shell: true site is named with the reason it cannot be an argv array', () => {
    const found = sites(/\bshell:\s*true/)
    const unnamed = found.filter((s) => !SHELL_TRUE_BY_DESIGN.has(s.split(':')[0]!))
    expect(
      unnamed,
      'These pass a command string to a shell with nothing named as the reason. With shell: true ' +
        'there is no argv boundary left, so the safety has to live in the value -- say which check ' +
        'provides it in SHELL_TRUE_BY_DESIGN, or pass an argv array and drop the flag. Note that ' +
        'an args array does not help here: Node joins it into one command line when shell is set.',
    ).toEqual([])
  })

  it('every execSync site is named', () => {
    const found = sites(/(^|[^.\w$])execSync\s*\(/)
    const unnamed = found.filter((s) => !EXEC_SYNC_BY_DESIGN.has(s.split(':')[0]!))
    expect(
      unnamed,
      'execSync always goes through a shell and has no flag to turn that off, so the reason has to ' +
        'be about the command string. Name it in EXEC_SYNC_BY_DESIGN, or use execFileSync with an ' +
        'argv array.',
    ).toEqual([])
  })

  it.each([...SHELL_TRUE_BY_DESIGN.keys()])('%s is still a real shell: true site', (file) => {
    expect(
      sites(/\bshell:\s*true/).some((s) => s.startsWith(`${file}:`)),
      `${file} is exempted in SHELL_TRUE_BY_DESIGN but no longer has a shell: true. A stale name ` +
        'hides behind its siblings: the map still looks complete while covering one fewer real ' +
        'site. Remove the entry.',
    ).toBe(true)
  })

  it.each([...EXEC_SYNC_BY_DESIGN.keys()])('%s is still a real execSync site', (file) => {
    expect(
      sites(/(^|[^.\w$])execSync\s*\(/).some((s) => s.startsWith(`${file}:`)),
      `${file} is exempted in EXEC_SYNC_BY_DESIGN but no longer calls execSync. Remove the entry.`,
    ).toBe(true)
  })

  it('every exemption carries a reason rather than a name alone', () => {
    for (const [file, reason] of [...SHELL_TRUE_BY_DESIGN, ...EXEC_SYNC_BY_DESIGN]) {
      expect(reason.length, `${file}: the exemption reason is too short to be one`).toBeGreaterThan(60)
    }
  })
})
