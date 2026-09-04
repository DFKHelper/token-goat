/**
 * Guard for the substitution rule: a hook that replaces a tool result with text of token-goat's
 * own composition must delimit the third-party bytes it kept, or say in one line why it does not.
 *
 * The sibling guard `third_party_content_reaches_fence.test.ts` asks the provenance question --
 * did these bytes come from outside. This one asks the harder half, which is the one that was
 * actually wrong: `hooks_bash.ts` handed the model a rewritten body with no fence at all for the
 * whole life of the compression feature, and the provenance guard could not see it, because Bash
 * output is not fetched from any of the sources that guard watches. It reaches the handler as a
 * tool result the harness already delivered.
 *
 * The rule is substitution, not provenance. A fence is owed wherever token-goat puts words of its
 * own in a block beside bytes it did not write, because that is the only situation in which the
 * model has to tell two voices apart. Where token-goat adds nothing -- a path that emits the
 * command's own bytes minus terminal escapes -- there is no second voice, and a fence there is a
 * tax the net-benefit gate then charges against the rewrite itself, so the rewrite is declined and
 * the raw output ships unfenced anyway. Those cases are listed below with that reasoning attached,
 * one entry per emit site, because an exemption whose reason is written down can be argued with
 * and an exemption that is merely absent cannot.
 *
 * Do not add a function here to make this pass. Either fence what it substitutes, or write the
 * sentence explaining why the block contains nothing of ours -- and if that sentence is hard to
 * write, that is the finding.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { codeOnly, functionMap, parseTopLevelFunctions, reaches, type FnInfo } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** The emit boundary. Every one of these hands the model a body token-goat composed. */
const SUBSTITUTION_CALLS: readonly string[] = ['emitRewrite(', 'emitRewriteIfChanged(']

/** Same terminals the provenance guard uses; kept in sync by the cross-check test below. */
const FENCE_TERMINALS: readonly string[] = [
  'fenceUntrustedContent(',
  'fenceUntrusted(',
  'fenceWithMatches(',
  'fenceUntrustedOcrText(',
]

/**
 * Emit sites that substitute without fencing, each with the reason. Keyed `file.ts::function`.
 *
 * Two classes, and the difference is worth stating because only one of them is settled.
 *
 * (a) There is nothing to separate. Either the emitted block carries no words of token-goat's, so
 * there is no second voice for the model to mistake, or it carries nothing BUT token-goat's words,
 * so there are no third-party bytes to delimit. Both are closed questions.
 *
 * (b) Our text and theirs are interleaved by construction: an elision marker sits between the lines
 * it replaced, so there is no cut point that puts our voice outside a tag. Wrapping the whole body
 * would run the marker neutraliser over token-goat's own markers and hand the model
 * `&#91;token-goat: 40 lines elided]` -- our voice, mangled, which is the same defect the Bash cap
 * notice produced before it was moved outside the tag. These three are OPEN, not settled: the
 * defence that would work is escaping each third-party span before our markers are spliced in,
 * which is a different change with its own risk (a span containing the literal `[token-goat` comes
 * back escaped, and a model that round-trips it writes the escape into a file). See CLAUDE.arch.md,
 * "Decision, 2026-09-04", for the measurement and the reopen condition.
 */
const UNFENCED_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  [
    'hooks_common.ts::emitRewriteIfChanged',
    'The wrapper itself, not a site. It forwards whatever its caller composed, so the question ' +
      'belongs to the callers -- which is what the rest of this list is.',
  ],
  // (a) nothing to separate
  [
    'hooks_bash.ts::maybeStripAnsiOnly',
    'Emits the command bytes minus terminal escapes and nothing else: no marker, no pointer, no ' +
      'summary. Fencing it prices ~123 bytes into a rewrite whose entire saving is the escape ' +
      'bytes, so the gate declines and the raw output ships unfenced regardless.',
  ],
  [
    'hooks_grep.ts::foldGrepContentHandler',
    'Regroups the tool\'s own match lines under a filename header. The structure is ours, the ' +
      'words are entirely the tool\'s -- no marker, no notice, no pointer -- so there is no second ' +
      'voice in the block to tell apart from the first.',
  ],
  [
    'hooks_bash.ts::maybeCollapseIdenticalRead',
    'The inverse case: the emitted body is a pointer token-goat wrote, start to finish, with none ' +
      'of the command output left in it. Nothing third-party survives to be delimited.',
  ],
  [
    'hooks_exitplanmode.ts::postExitPlanModeHandler',
    "Keeps the harness's own fixed approval line and replaces the plan echo below it with a " +
      'pointer. The plan was written by this session, not by a third party, and the retained ' +
      'prefix is a constant the harness emits -- neither is content an attacker can author.',
  ],
  // (b) interleaved, open -- see the class note above
  [
    'hooks_agent_spawn.ts::postAgentHandler',
    'Interleaved: collapseFencedBlocks and dedupeFencedBlocks splice `[token-goat: N lines ' +
      'elided]` markers into the middle of the subagent report, so a fence around the result would ' +
      "escape token-goat's own markers. Open, not settled.",
  ],
  [
    'hooks_read.ts::elideAlreadyServedLines',
    'Interleaved: a `[token-goat] lines N-M were already served` notice sits between the file ' +
      'lines it replaced. Also the surface most likely to be round-tripped back into an edit, ' +
      'which is what makes escaping the retained lines the wrong trade here. Open, not settled.',
  ],
  [
    'hooks_browser_image.ts::postBrowserImageHandler',
    'Interleaved across blocks: our repeat-screenshot and tab-dedup notices are joined to blocks ' +
      'that passed through untouched, and to base64 data URLs a fence would corrupt. Open, not ' +
      'settled.',
  ],
])

/** True when `body` reaches a fence boundary. */
function callsFence(body: string): boolean {
  return FENCE_TERMINALS.some((t) => body.includes(t))
}

/** True when `body` reaches the substitution boundary. */
function substitutes(body: string): boolean {
  return SUBSTITUTION_CALLS.some((t) => body.includes(t))
}

/**
 * Pinned: the whole claim is "every substitution site is accounted for", which a walk returning
 * nothing would also report. Anchors are the two files that most define the question -- the one
 * where the rule was broken, and the one that defines the emit boundary.
 */
function srcFiles(): readonly string[] {
  return pinnedPopulation({
    what: 'src/**/*.ts files scanned for unfenced output substitution',
    items: fs
      .readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join(SRC_DIR, f)),
    floor: 150,
    mustInclude: ['hooks_bash.ts', 'hooks_common.ts'],
  })
}

interface Site {
  readonly key: string
  readonly fenced: boolean
}

/** Every `file.ts::function` that reaches a substitution call, and whether it also reaches a fence. */
function substitutionSites(): Site[] {
  const out: Site[] = []
  for (const file of srcFiles()) {
    const src = fs.readFileSync(file, 'utf8')
    if (!SUBSTITUTION_CALLS.some((t) => src.includes(t))) continue
    const fns: FnInfo[] = parseTopLevelFunctions(src)
    const byName = functionMap(fns)
    for (const fn of fns) {
      if (!substitutes(codeOnly(fn.body))) continue
      out.push({
        key: `${path.basename(file)}::${fn.name}`,
        fenced: reaches(fn, byName, callsFence),
      })
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

describe('output token-goat substitutes is fenced or exempted by name', () => {
  it('finds the substitution sites, so the search itself is working', () => {
    const sites = substitutionSites()
    expect(
      sites.map((s) => s.key),
      'No function in src/ reaches emitRewrite. Either the hooks stopped substituting output, or ' +
        'the emit boundary was renamed and SUBSTITUTION_CALLS now names nothing -- in which case ' +
        'this guard would pass against a codebase with no fencing at all.',
    ).not.toEqual([])
    // The site the whole rule came from. If this one stops being found, the search is broken in a
    // way an aggregate count cannot show.
    expect(sites.map((s) => s.key)).toContain('hooks_bash.ts::maybeCompressCompoundOutput')
  })

  // Per name, not in aggregate: a stale exemption key matches nothing and narrows the guard
  // silently while every other check stays green.
  it.each([...UNFENCED_BY_DESIGN.keys()])('%s is still a real substitution site', (key) => {
    expect(
      substitutionSites().map((s) => s.key),
      `"${key}" is exempted from fencing but no longer substitutes anything. Either it was ` +
        'renamed and the exemption needs the current name, or the exemption is dead and should go.',
    ).toContain(key)
  })

  it('every exemption carries a reason', () => {
    for (const [key, reason] of UNFENCED_BY_DESIGN) {
      expect(reason.length, `${key} is exempted with no reason written down`).toBeGreaterThan(40)
    }
  })

  it('no site substitutes output without either fencing it or being exempted by name', () => {
    const offenders = substitutionSites()
      .filter((s) => !s.fenced && !UNFENCED_BY_DESIGN.has(s.key))
      .map((s) => s.key)
    expect(
      offenders,
      'These functions replace a tool result with a body token-goat composed, and the third-party ' +
        'bytes inside it are not delimited. The model cannot tell which words are ours, and ' +
        'anyone who guesses the marker wording gets to write a line it reads as ours. Fence what ' +
        'the function keeps -- our marker and any recall pointer stay OUTSIDE the closing tag -- ' +
        'or add the site to UNFENCED_BY_DESIGN with the sentence explaining what of ours is in ' +
        'that block. If that sentence is hard to write, the fence is the answer.',
    ).toEqual([])
  })
})
