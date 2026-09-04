/**
 * Guard for the one place token-goat builds a shell command string: the bridge hook shims.
 *
 * Every bridge ships a generated shim whose last resort is `spawnSync('token-goat hook ' + event,
 * { shell: true })`. The `shell: true` is not removable -- on Windows a global npm install puts a
 * `.cmd` shim on PATH, which `spawnSync` cannot exec without a shell -- so what has to hold instead
 * is that the value glued onto that string was never free-form. Seven shims do it three different
 * ways, and an audit by hand found that only four of the seven actually check anything: the other
 * three are safe because their call sites all happen to pass a literal, which is a property of
 * today's call sites rather than of the code. One of the four turned out to check with a plain
 * object lookup, which returns a truthy Function for every name on `Object.prototype`.
 *
 * So this file asserts both halves by surface, not by reading:
 *
 *  - a shim that interpolates a variable must constrain it first, by a closed `Set` or by an
 *    own-property check;
 *  - a shim whose value arrives from a caller must be called with a literal at every call site.
 *
 * The guard is deliberately conservative about what counts as constraining. Adding a new way to
 * validate means adding it to `CONSTRAINTS` with a line saying why it is sound, which is the point:
 * the next bridge should have to make that argument rather than inherit a pass.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGES_DIR = path.join(HERE, '..', '..', 'src', 'bridges')

/** `spawnSync("token-goat hook " + <identifier>` in either quote style. */
const SHELL_CONCAT_RE = /spawnSync\(\s*['"]token-goat hook ['"]\s*\+\s*([A-Za-z_$][\w$]*)/g

/**
 * Ways a shim may constrain the interpolated value, and why each is sound.
 *
 * - A closed `Set` membership test: the value can only be one of the literals in the set.
 * - `hasOwnProperty.call` before a map lookup: the value can only be one of the map's own values,
 *   with no inherited member able to satisfy the check.
 *
 * A bare `MAP[key]` is deliberately NOT here. It reads like a lookup table but answers truthily for
 * `constructor`, `toString`, `__proto__` and five more, so it constrains nothing.
 */
const CONSTRAINTS: readonly RegExp[] = [
  /VALID_HOOK_EVENTS\.has\(/,
  /SHIM_VALID_HOOK_EVENTS/,
  /hasOwnProperty\.call\(/,
]

/**
 * Shims that interpolate a value passed in by a caller rather than read from argv.
 *
 * Both reach the concatenation through two hops -- `callHook(event, …)` decides between an
 * in-process relay and `callHookViaSpawn(event, …)`, and only the second builds the shell string --
 * so the entry point is `callHook` and the delegation between them is a pass-through of `callHook`'s
 * own parameter. `entry` is what every caller must invoke with a literal; `delegate` is checked
 * separately below, because a future edit that passes something other than the parameter through
 * that hop would slip past a check aimed only at the entry point.
 */
const CALLER_SUPPLIED: ReadonlyMap<
  string,
  { readonly entry: string; readonly delegate: string; readonly param: string; readonly callers: readonly string[] }
> = new Map([
  [
    'relay_block.ts',
    { entry: 'callHook', delegate: 'callHookViaSpawn', param: 'event', callers: ['opencode.ts', 'openclaw.ts'] },
  ],
  ['pi.ts', { entry: 'callHook', delegate: 'callHookViaSpawn', param: 'event', callers: ['pi.ts'] }],
])

/** Calls to `fn`, skipping its own declaration, capturing the first character of the first argument. */
function callsTo(fn: string): RegExp {
  return new RegExp(`(?<!\\bfunction\\s)\\b${fn}\\s*\\(\\s*([^\\s)])`, 'g')
}

/**
 * Comments removed, everything else kept verbatim.
 *
 * Deliberately not `reachability.ts`'s `codeOnly`, which also blanks template literals: every shim
 * body in this directory *is* a template literal, so that helper would erase the exact text this
 * guard exists to read. Prose mentioning `callHookViaSpawn` in a comment is the only thing that has
 * to go, and it is the thing that made this scan report a call that was not one.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
}

function bridgeFiles(): readonly string[] {
  return pinnedPopulation({
    what: 'src/bridges/*.ts scanned for shell command-string concatenation',
    items: fs
      .readdirSync(BRIDGES_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join(BRIDGES_DIR, f)),
    floor: 10,
    mustInclude: ['copilot_cli.ts', 'relay_block.ts', 'shim_common.ts'],
  })
}

interface ConcatSite {
  readonly file: string
  readonly variable: string
  readonly src: string
}

function concatSites(): ConcatSite[] {
  const out: ConcatSite[] = []
  for (const file of bridgeFiles()) {
    const src = fs.readFileSync(file, 'utf8')
    SHELL_CONCAT_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = SHELL_CONCAT_RE.exec(src)) !== null) {
      out.push({ file: path.basename(file), variable: m[1]!, src })
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

describe('a value concatenated into a shell command string is constrained first', () => {
  it('finds the concatenation sites, so the scan itself is working', () => {
    const files = concatSites().map((s) => s.file)
    expect(
      files,
      'No bridge builds a "token-goat hook <event>" shell string any more. Either the shims moved ' +
        'to an argv array everywhere (delete this guard and say so), or SHELL_CONCAT_RE stopped ' +
        'matching the shape they use -- in which case this file is now green against an unchecked ' +
        'surface.',
    ).not.toEqual([])
    // The three shapes the audit found, one representative each. A rename that hides one of these
    // from the scan is what an aggregate count cannot show.
    expect(files).toContain('copilot_cli.ts')
    expect(files).toContain('relay_block.ts')
    expect(files).toContain('claudecode.ts')
  })

  it('every shim that reads its event from argv validates it against a closed set', () => {
    const unconstrained = concatSites()
      .filter((s) => !CALLER_SUPPLIED.has(s.file))
      .filter((s) => !CONSTRAINTS.some((re) => re.test(s.src)))
      .map((s) => `${s.file} (interpolates ${s.variable})`)
    expect(
      unconstrained,
      'These shims glue a value straight into a shell command string with no check that it is one ' +
        'of the hook events. Add a closed-Set membership test before the concatenation, the way ' +
        'shim_common.ts\'s SHIM_VALID_HOOK_EVENTS does, or an own-property check if the value ' +
        'comes from a map -- a bare MAP[key] does not count, because Object.prototype answers it.',
    ).toEqual([])
  })

  it.each([...CALLER_SUPPLIED.entries()])(
    '%s only ever receives a literal event name from its callers',
    (_file, { entry, callers }) => {
      const offenders: string[] = []
      for (const caller of callers) {
        const src = stripComments(fs.readFileSync(path.join(BRIDGES_DIR, caller), 'utf8'))
        const callRe = callsTo(entry)
        let m: RegExpExecArray | null
        while ((m = callRe.exec(src)) !== null) {
          if (m[1] === '"' || m[1] === "'" || m[1] === '`') continue
          offenders.push(`${caller}: ${entry}(${m[1]!}...`)
        }
      }
      expect(
        offenders,
        `${entry} reaches a shell command string by concatenation and has no validation of its own, ` +
          'so today it is safe only because every caller passes a quoted literal. This call does ' +
          'not. Either pass a literal, or add a closed-set check inside the shim and list it in ' +
          'CONSTRAINTS.',
      ).toEqual([])
    },
  )

  it.each([...CALLER_SUPPLIED.entries()])(
    '%s passes only its own parameter down to the hop that builds the string',
    (file, { delegate, param }) => {
      const src = stripComments(fs.readFileSync(path.join(BRIDGES_DIR, file), 'utf8'))
      const callRe = new RegExp(`(?<!\\bfunction\\s)\\b${delegate}\\s*\\(\\s*([A-Za-z_$][\\w$]*|["'\`])`, 'g')
      const args: string[] = []
      let m: RegExpExecArray | null
      while ((m = callRe.exec(src)) !== null) args.push(m[1]!)
      expect(args, `${file}: found no ${delegate}( calls, so this check is vacuous`).not.toEqual([])
      const wrong = args.filter((a) => a !== param && !['"', "'", '`'].includes(a))
      expect(
        wrong,
        `${delegate} is the hop that concatenates into the shell string. It is safe only while it ` +
          `receives ${param} -- the parameter the check above constrains -- or a literal. Passing ` +
          'anything else routes a value into the command string around that check.',
      ).toEqual([])
    },
  )

  it('each caller-supplied shim really does have call sites, so the checks above are not vacuous', () => {
    for (const [file, { entry, callers }] of CALLER_SUPPLIED) {
      const total = callers.reduce((n, caller) => {
        const src = stripComments(fs.readFileSync(path.join(BRIDGES_DIR, caller), 'utf8'))
        return n + (src.match(callsTo(entry)) ?? []).length
      }, 0)
      expect(total, `${file}: found no ${entry}( call sites in ${callers.join(', ')}`).toBeGreaterThan(0)
    }
  })
})
