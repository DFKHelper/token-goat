/** Guard for the substitution rule: a hook that replaces a tool result with text of token-goat's own composition must delimit the third-party bytes it kept, or say in one line why it does not. The sibling guard `third_party_content_reaches_fence.test.ts` asks the provenance question -- did these bytes come from outside. This one asks the harder half, which is the one that was actually wrong: `hooks_bash.ts` handed the model a rewritten body with no fence at all for the whole life of the compression feature, and the provenance guard could not see it, because Bash output is not fetched from any of the sources that guard watches. It reaches the handler as a tool result the harness already delivered. The rule is substitution, not provenance. A fence is owed wherever token-goat puts words of its own in a block beside bytes it did not write, because that is the only situation in which the model has to tell two voices apart. Where token-goat adds nothing -- a path that emits the command's own bytes minus terminal escapes -- there is no second voice, and a fence there is a tax the net-benefit gate then charges against the rewrite itself, so the rewrite is declined and the raw output ships unfenced anyway. Those cases are listed below with that reasoning attached, one entry per emit site, because an exemption whose reason is written down can be argued with and an exemption that is merely absent cannot. Do not add a function here to make this pass. Either fence what it substitutes, or write the sentence explaining why the block contains nothing of ours -- and if that sentence is hard to write, that is the finding. */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { codeOnly, functionMap, parseTopLevelFunctions, reaches, type FnInfo } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** The emit boundary. Every one of these hands the model a body token-goat composed. */
const SUBSTITUTION_CALLS: readonly string[] = ['emitRewrite(', 'emitRewriteIfChanged(', 'emitRewriteWithContext(']

/** The in-place form a harness-numbered Read uses instead of a fence. Deliberately not a FENCE_TERMINAL: it neutralises the fence markers in the file bytes but adds no enclosing tags (they would sit on numbered lines), so it is checked by name at its own call sites below rather than counted as delimiting anything. */
const NUMBERED_FENCE_CALL = 'fenceNumberedFileContent('

/** Same terminals the provenance guard uses; kept in sync by the cross-check test below. */
const FENCE_TERMINALS: readonly string[] = [
  'fenceUntrustedContent(',
  'fenceUntrusted(',
  // Spelled out rather than left to `fenceUntrusted(` to cover: that entry is a whole call including its own `(`, so it does not match a longer name sharing its prefix. This is the fencer most of the read path actually calls, and it was matching nothing.
  'fenceUntrustedFileContent(',
  'fenceWithMatches(',
  'fenceUntrustedOcrText(',
  // The interleaved-body fencer. It takes spans rather than one string, so a caller declares which spans token-goat wrote and the neutralizer runs on the rest -- which is what makes a fence possible around a block our markers are spliced into. See the class note below.
  'fenceUntrustedSpans(',
]

/** Emit sites that substitute without fencing, each with the reason. Keyed `file.ts::function`. Two classes, and the difference is worth stating because only one of them is settled. (a) There is nothing to separate. Either the emitted block carries no words of token-goat's, so there is no second voice for the model to mistake, or it carries nothing BUT token-goat's words, so there are no third-party bytes to delimit. Both are closed questions. (b) Our text and theirs are interleaved by construction: an elision marker sits between the lines it replaced, so there is no cut point that puts our voice outside a tag. Wrapping the whole body in ONE call would run the marker neutraliser over token-goat's own markers and hand the model `&#91;token-goat: 40 lines elided]` -- our voice, mangled, which is the same defect the Bash cap notice produced before it was moved outside the tag. That is solved, and the fix is `fenceUntrustedSpans`. It takes the body already split into spans, each marked with whether token-goat wrote it, and runs the neutraliser on the others and on nothing else. Authorship is positional -- declared by the producer that emitted the span -- and never recognised from the text, because a rule that spotted our markers by their spelling would exempt a forged one just as readily. Both `hooks_bash_post.ts` elision sites fence through it now and are no longer listed below. The three that remain are OPEN, and what keeps them open is not a missing mechanism. It is the round-trip risk: an untrusted span containing the literal `[token-goat` comes back escaped, and these three feed the surfaces a model is most likely to copy back into a file (a read the editor round-trips, a subagent report, a browser block carrying data URLs). The Bash sites do not have that property, which is why they went first. See CLAUDE.arch.md, "Decision, 2026-09-04", for the measurement and the reopen condition. */
const UNFENCED_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  [
    'hooks_common.ts::emitRewriteIfChanged',
    'The wrapper itself, not a site. It forwards whatever its caller composed, so the question ' +
      'belongs to the callers -- which is what the rest of this list is.',
  ],
  [
    'hooks_read_post.ts::emitStructuralFold',
    'Also a wrapper, one file further out: it joins a StructuralFold that a producer already built ' +
      'and fenced. The producers are planMarkdownOutline and planSourceSkeleton, both in ' +
      'fold_structure.ts, and both are pinned by the fold-producer test below so this exemption ' +
      'cannot outlive them. This walk is same-file, which is exactly why the two real unfenced ' +
      'sites here went unnoticed for a release: an exemption resting on a cross-file call needs ' +
      'its own assertion, not a sentence.',
  ],
  [
    'hooks_common.ts::emitRewriteWithContext',
    'A wrapper like emitRewriteIfChanged, for the rewrite whose body the harness numbers by ' +
      'position. There a fence cannot wrap the body, because its tags would occupy numbered lines ' +
      'and shift every file line under the wrong number, so its callers neutralise the fence ' +
      'markers in the file bytes in place (fenceNumberedFileContent) and send the data-not-' +
      'instructions preamble as the context this wrapper carries. Its callers are pinned to that ' +
      'form by the aligned-rewrite test below.',
  ],
  [
    'hooks_read_post.ts::elideAlreadyServedLines',
    'Neutralises in place (fenceNumberedFileContent) the same way emitRewriteWithContext\'s other ' +
      'callers do, and for the same reason, but for both layouts rather than only the aligned one: ' +
      'this rewrite\'s whole saving is often a single small cut, so the three lines ' +
      'fenceUntrustedFileContent would add to a compact-layout rewrite could turn a real saving ' +
      'into a net loss, the same "without changing line count" constraint aligned layout has ' +
      'unconditionally. A `[token-goat] lines N-M were already served` notice sits between the ' +
      'file lines it replaced, same as before; the notice and every verbatim row around it are now ' +
      'neutralised together, so a hostile file line spelling out this exact notice is escaped like ' +
      'any other marker rather than reaching the model as our own voice. Pinned by the ' +
      'aligned-rewrite test below.',
  ],
  // (a) nothing to separate
  [
    'hooks_bash_post.ts::maybeStripAnsiOnly',
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
    'hooks_exitplanmode.ts::postExitPlanModeHandler',
    "Keeps the harness's own fixed approval line and replaces the plan echo below it with a " +
      'pointer. The plan was written by this session, not by a third party, and the retained ' +
      'prefix is a constant the harness emits -- neither is content an attacker can author.',
  ],
  // (b) interleaved, open -- see the class note above
  [
    'hooks_agent_spawn.ts::postAgentHandler',
    'Two bodies, one key, and the second one is why this reason is written out at length. The ' +
      'report path is interleaved: collapseFencedBlocks and dedupeFencedBlocks splice ' +
      "`[token-goat: N lines elided]` markers into the middle of the subagent report, so a fence " +
      "around the result would escape token-goat's own markers. Open, not settled. The spawn-restrict " +
      'advisory is a different body through a different channel (contextOutput, which unlike ' +
      'denyOutput neutralises nothing), and it interpolates agent names that became ' +
      'repository-authored when <cwd>/.claude/agents was added as a scan root. It is unfenced ' +
      'because nothing of unbounded shape survives into it: parseAgentDefinition admits only ' +
      'AGENT_NAME_RE-shaped names and drops the definition otherwise, and the joined names are ' +
      'neutralised before interpolation. Both halves are load-bearing; widening either one puts ' +
      'this site back in the offenders list, which is the intent.',
  ],
  [
    'hooks_agent_spawn.ts::subagentReportRewriteHandler',
    "The same interleaved report body as postAgentHandler, sent through Copilot CLI's " +
      'subagentStop modifiedResponse instead of the post-tool result, and built by the same ' +
      'planReportCompaction: collapseFencedBlocks and dedupeFencedBlocks splice ' +
      '`[token-goat: N lines elided]` markers into the middle of the subagent report, so a fence ' +
      "around it would escape token-goat's own markers. Open, not settled, and it settles with " +
      'postAgentHandler: the two share one planner so they cannot drift.',
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

/** Pinned: the whole claim is "every substitution site is accounted for", which a walk returning nothing would also report. Anchors are the two files that most define the question -- the one where the rule was broken, and the one that defines the emit boundary. */
function srcFiles(): readonly string[] {
  return pinnedPopulation({
    what: 'src/**/*.ts files scanned for unfenced output substitution',
    items: fs
      .readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join(SRC_DIR, f)),
    floor: 150,
    mustInclude: ['hooks_bash_post.ts', 'hooks_common.ts'],
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
    // The site the whole rule came from. If this one stops being found, the search is broken in a way an aggregate count cannot show.
    expect(sites.map((s) => s.key)).toContain('hooks_bash_post.ts::maybeCompressCompoundOutput')
  })

  // Per name, not in aggregate: a stale exemption key matches nothing and narrows the guard silently while every other check stays green.
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

  // Backs the hooks_read_post.ts::emitStructuralFold exemption, whose whole claim is that fencing happened one file away. Provenance: HAND-DERIVED -- the producer names are read off fold_structure.ts's exports and the assertion is that each fences, computed independently of the same-file walk above rather than from its output.
  it('every StructuralFold producer fences the file bytes it keeps', () => {
    const src = fs.readFileSync(path.join(SRC_DIR, 'fold_structure.ts'), 'utf-8')
    const producers = parseTopLevelFunctions(src).filter((f) => f.body.includes('kind: '))
    expect(
      producers.map((f) => f.name).sort(),
      'The set of functions building a StructuralFold changed. emitStructuralFold is exempted from ' +
        'the fencing walk on the grounds that these producers fence for it, so a new one has to be ' +
        'named here before that exemption means anything.',
    ).toEqual(['planMarkdownOutline', 'planSourceSkeleton'])
    for (const fn of producers) {
      expect(
        callsFence(fn.body),
        `${fn.name} builds a StructuralFold that emitStructuralFold hands to the model unfenced. ` +
          'That wrapper is exempted only because this function fences; fence here, or drop the ' +
          'exemption and fence at the emit site.',
      ).toBe(true)
    }
  })

  // Backs the hooks_common.ts::emitRewriteWithContext exemption. Provenance: HAND-DERIVED -- the caller set is read off the source by name, and each caller must neutralise in place itself or be emitStructuralFold, whose producers must. The same-file walk above cannot see this: foldCodeBodies also reaches fenceUntrustedFileContent through its compact branch, so it reads as fenced whatever its aligned branch does.
  it('every aligned rewrite neutralises the file bytes it keeps in place', () => {
    const readPost = parseTopLevelFunctions(fs.readFileSync(path.join(SRC_DIR, 'hooks_read_post.ts'), 'utf-8'))
    const callers = readPost.filter((f) => codeOnly(f.body).includes('emitRewriteWithContext(')).map((f) => f.name).sort()
    expect(callers, 'The set of emitRewriteWithContext callers changed; name the new one here with how it neutralises.').toEqual([
      'elideAlreadyServedLines',
      'emitStructuralFold',
      'foldCodeBodies',
    ])
    const foldCodeBodies = readPost.find((f) => f.name === 'foldCodeBodies')
    expect(foldCodeBodies?.body.includes(NUMBERED_FENCE_CALL)).toBe(true)
    // elideAlreadyServedLines fences the same way in both layouts, not only its aligned branch (unlike foldCodeBodies, whose compact branch reaches fenceUntrustedFileContent instead): the fenced body is built once and shared, so a hostile file line spelling out its own served-elision notice is neutralised regardless of which layout emits it.
    const elideAlreadyServedLines = readPost.find((f) => f.name === 'elideAlreadyServedLines')
    expect(elideAlreadyServedLines?.body.includes(NUMBERED_FENCE_CALL)).toBe(true)
    const structural = parseTopLevelFunctions(fs.readFileSync(path.join(SRC_DIR, 'fold_structure.ts'), 'utf-8')).filter((f) => f.body.includes('context: '))
    expect(structural.map((f) => f.name).sort(), 'The set of StructuralFold producers setting `context` changed.').toEqual(['planMarkdownOutline', 'planSourceSkeleton'])
    for (const fn of structural) expect(fn.body.includes(NUMBERED_FENCE_CALL), `${fn.name} sets an aligned fold's context without neutralising the file bytes`).toBe(true)
  })
})
