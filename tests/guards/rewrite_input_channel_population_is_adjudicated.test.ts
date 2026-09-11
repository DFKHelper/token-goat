/**
 * Guard for a third channel a hook can speak on: constructing `{ hookType: 'rewriteInput', ... }`
 * directly, rather than through a shared helper like contextOutput() or emitRewrite(). This bypasses
 * both of the sibling guards in this directory, which each anchor on a named helper call and cannot
 * see a raw object literal that reaches the same output. It is exactly this shape that let
 * hooks_agent_spawn.ts::preAgentHandler build a duplicate-spawn advisory embedding a prior outstanding
 * prompt (duplicateOf, truncated to 80 chars) behind a raw, unescaped `[token-goat]` prefix -- a
 * prompt relayed from untrusted content could forge that marker into text shaped as token-goat
 * speaking, and nothing here noticed because no guard walked this literal at all.
 *
 * Every top-level function that reaches this literal, directly or by calling a same-file function
 * that does, must appear below with what it interpolates and why that is safe. A new arrival fails
 * until someone answers the question, the same discipline context_channel_population_is_adjudicated
 * enforces for contextOutput().
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { calleeNames, functionMap, parseTopLevelFunctions, type FnInfo } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** The emit boundary this guard walks: a literal rewriteInput object, not the shared helpers the sibling guards anchor on. */
const REWRITE_INPUT_LITERAL = "hookType: 'rewriteInput'"

/**
 * Every function that reaches the literal, with what it interpolates and why that is safe.
 * Keyed `file.ts::function`.
 */
const ADJUDICATED: Readonly<Record<string, string>> = {
  'hooks_agent_spawn.ts::preAgentHandler':
    'Builds the duplicate-spawn advisory, which embeds a prior outstanding prompt (duplicateOf, truncated to 80 chars) -- a value the caller controls and may itself relay from untrusted content. Escaped with neutralizeSpokenMarkers before interpolation; the advisory prefix itself is now the pre-escaped `&#91;token-goat]` spelling rather than a raw bracket, matching the other advisories in this file.',
  'hooks_bash.ts::maybeCompressRewrite':
    'Rewrites the Bash tool_input to wrap the command in `token-goat compress`, quoted with shellQuoteSingle. This is an executed shell command, not prose spoken in token-goat\'s voice, and contains no `[token-goat]`/`[tg]` marker literal for a caller-supplied bracket to forge.',
  'hooks_bash.ts::preBashHandlerInner': 'Reaches maybeCompressRewrite, adjudicated above. Interpolates nothing of its own on this channel.',
  'hooks_bash.ts::preBashHandler': 'Wrapper over preBashHandlerInner. Interpolates nothing of its own.',
  'image_shrink.ts::finalizeShrinkResult':
    'VS Code only: points view_image at the shrunk temp copy. The one new value is a path token-goat built from pid, time and a random UUID, with a suffix whose character class admits no separator or bracket; the rest is the tool\'s own original input passed back unchanged. It is a tool argument, not prose in token-goat\'s voice, and carries no `[token-goat]`/`[tg]` marker for a caller-supplied bracket to forge.',
  'image_shrink.ts::preReadImageHandler': 'Reaches finalizeShrinkResult, adjudicated above. Interpolates nothing of its own on this channel.',
}

/**
 * How many functions must reach the channel for this file to be saying anything.
 *
 * CAPTURE: 4 reached it against the build at the time this was written (hooks_agent_spawn.ts's
 * preAgentHandler, and hooks_bash.ts's maybeCompressRewrite plus its two callers). Pinned at 3 so an
 * ordinary refactor that collapses one wrapper does not fire it, while a scan that starts matching
 * nothing still fails loudly.
 */
const POPULATION_FLOOR = 3

function srcFiles(): string[] {
  return fs
    .readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => path.join(SRC_DIR, e.name))
}

/**
 * Same traversal shape as reachability.ts's `reaches`, but walking RAW bodies rather than
 * `codeOnly`'d ones. `codeOnly` blanks every quoted string literal (not just template literals,
 * for parity with the other guard that strips both), so a plain single-quoted marker like
 * `hookType: 'rewriteInput'` is invisible to it -- the exact "stripping hides the very thing being
 * scanned for" trap this repo's own guard notes warn about, just one layer further than usual.
 */
export function reachesRaw(fn: FnInfo, byName: Map<string, string>, predicate: (body: string) => boolean): boolean {
  const visited = new Set<string>()
  const stack: string[] = [fn.name]
  while (stack.length > 0) {
    const name = stack.pop()!
    if (visited.has(name)) continue
    visited.add(name)
    const body = byName.get(name)
    if (body === undefined) continue
    if (predicate(body)) return true
    for (const callee of calleeNames(body)) {
      if (!visited.has(callee) && byName.has(callee)) stack.push(callee)
    }
  }
  return false
}

/** Every `file.ts::function` whose body, or a same-file function it calls, reaches the rewriteInput literal. */
function rewriteInputSites(): string[] {
  const out: string[] = []
  for (const file of srcFiles()) {
    const source = fs.readFileSync(file, 'utf8')
    if (!source.includes(REWRITE_INPUT_LITERAL)) continue
    const fns: FnInfo[] = parseTopLevelFunctions(source)
    const map = functionMap(fns)
    for (const fn of fns) {
      if (reachesRaw(fn, map, (body) => body.includes(REWRITE_INPUT_LITERAL))) out.push(`${path.basename(file)}::${fn.name}`)
    }
  }
  return out.sort()
}

describe('every function on the raw rewriteInput channel has been adjudicated', () => {
  it('finds a real population rather than passing on an empty scan', () => {
    pinnedPopulation({
      what: "functions constructing a bare { hookType: 'rewriteInput', ... } in src/*.ts",
      items: rewriteInputSites(),
      floor: POPULATION_FLOOR,
      mustInclude: ['hooks_agent_spawn.ts::preAgentHandler', 'hooks_bash.ts::maybeCompressRewrite'],
    })
  })

  it('has an entry for each one, and no entry for a function that has gone', () => {
    const found = rewriteInputSites()
    const unadjudicated = found.filter((k) => ADJUDICATED[k] === undefined)
    expect(
      unadjudicated,
      'These reach a bare rewriteInput literal, a channel that neither contextOutput() nor emitRewrite() ' +
        "guards this directory already runs can see, and nobody has said what they interpolate. Read each " +
        'one and ask what in the emitted string token-goat did not author. If it forges token-goat\'s own ' +
        '`[tg]`/`[token-goat: ...]` voice, route it through neutralizeSpokenMarkers (or displaySafeText) and ' +
        'add a line to ADJUDICATED saying so. If none, add the line saying that instead.\n  ' +
        unadjudicated.join('\n  '),
    ).toEqual([])

    const stale = Object.keys(ADJUDICATED).filter((k) => !found.includes(k))
    expect(stale, `ADJUDICATED names functions that no longer reach the rewriteInput literal:\n  ${stale.join('\n  ')}`).toEqual([])
  })

  it('keeps the escaping call reachable from the site that promised to use it', () => {
    // Prose above cannot fail on its own; the mechanism preAgentHandler promised is asserted directly, so removing the neutralizeSpokenMarkers call turns the ADJUDICATED entry into a false exemption rather than tripping silently.
    const spawn = fs.readFileSync(path.join(SRC_DIR, 'hooks_agent_spawn.ts'), 'utf8')
    expect(spawn).toContain('neutralizeSpokenMarkers(truncateForWarning(duplicateOf, 80))')
    expect(spawn).not.toMatch(/\\n\\n\[token-goat\] A similar subagent/)
  })
})
