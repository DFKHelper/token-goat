/**
 * Guard for the third emit channel, the one the other two guards do not walk.
 *
 * token-goat speaks to the model on three channels and they are not equally defended.
 * `denyOutput` neutralizes its message and puts the `[tg]` prefix outside the neutralized region.
 * `emitRewrite` is the boundary `substituted_output_reaches_fence.test.ts` walks. `contextOutput`
 * does neither: its callers carry their own `[token-goat]` prefix INSIDE the payload, so the model
 * reads the whole block as tooling, and nothing escapes a marker that arrived in a value token-goat
 * did not author.
 *
 * That asymmetry produced nine live findings in one release, plus two more sites escaped as a
 * survival layer where an unrelated upstream gate happens to close the path today. The live nine: a
 * filename in a shell command, an agent name from a project roster, a fetched URL in the compaction
 * manifest, a stale-evidence path, an MCP tool name, an image basename, a skill's declared name, a
 * search pattern, and a manifest re-read basename. In every case the helper that fixes it
 * (`displaySafeText`, or `displaySafePath` which delegates to it) already existed and the call site
 * simply did not use it, while its siblings did.
 *
 * The two unreachable ones are worth as much as the nine, because each was reported as live and
 * refuted only by reading the callers. Assume a site is live and you ship a changelog entry claiming
 * a hole that was already closed; assume it is safe and you ship the hole.
 *
 * Fencing is the wrong remedy here and that is why this is a separate guard rather than a wider
 * population for the existing one. A fence around a `contextOutput` payload would run the marker
 * neutralizer over token-goat's own prefix and hand the model `&#91;token-goat]`. The remedy is
 * per-value escaping, which no structural scan can confirm: whether `'... ' + x + ' ...'` is safe
 * depends on where `x` came from, and that is a judgement.
 *
 * So this guard does the one thing a scan can do honestly. It pins WHO is on the channel. Every
 * function reaching `contextOutput` must appear below with a one-line adjudication saying what it
 * interpolates and why that is safe. A new arrival fails until someone answers the question.
 *
 * That is not hypothetical. The grep hook in ADJUDICATED below landed on main from another machine
 * while the other eight were being fixed, carrying the same shape into a file with no sanitizing
 * call in it. Nothing in the suite noticed. This is the test that would have.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'
import { functionMap, parseTopLevelFunctions, reaches, type FnInfo } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** The emit boundary this guard walks. */
const CONTEXT_CALL = 'contextOutput('

/**
 * Every function that reaches `contextOutput`, with what it interpolates and why that is safe.
 * Keyed `file.ts::function`. A function here is a promise that someone read it, not that it is
 * inert: three of these entries describe a value that IS third-party and IS escaped on the way in.
 */
const ADJUDICATED: Readonly<Record<string, string>> = {
  'hooks_bash.ts::preBashHandlerInner':
    'The surgical-read hints quote the path out of the shell command, which a repository names. All fifteen sites that build that path wrap it in displaySafePath, which is why the escaping is checkable in one grep rather than at the thirty places that print it. Widening this to a sixteenth unwrapped assignment reopens it.',
  'hooks_grep.ts::preGrepHandler':
    'The structural-search hint quotes the Grep path, also repository-chosen, and it is escaped. Unreachable today for a different reason: extractGrepStructuralSearch refuses any path containing a bracket, which every spoken marker needs, though it refuses it as a glob character rather than for this. tests/hooks_grep.test.ts pins that refusal.',
  'hooks_glob.ts::preGlobHandler':
    'The broad recursive glob hint echoes the search pattern, which is model-influenced and escaped with displaySafeText. The fallback delegates to preGlobDedupHandler, adjudicated via makeDedupHintHandlers.',
  'hooks_common.ts::makeDedupHintHandlers':
    'Echoes the search pattern back, and a model very often greps for a literal it just read out of a file, so the value is repository-influenced. Escaped with displaySafeText. The tool name beside it is hardcoded by both call sites.',
  'hooks_session.ts::userPromptSubmitHandler':
    'Two third-party values. The skill name in the repeated-body advisory is escaped in resident_context.ts, since a skill declares its own name and nothing upstream constrains it. The git branch name is not escaped and does not need to be: git refuses a ref containing a bracket, so it cannot carry a marker.',
  'image_shrink.ts::finalizeShrinkResult':
    'Names the image it shrank, and a repository names its images. The basename is escaped once where it is computed, which also covers the stats label it feeds. The OCR text beside it was already fenced separately.',
  'hooks_tool_failure.ts::postToolUseFailureHandler':
    'Names the tool that failed twice, and an MCP server chooses the names it advertises. Escaped in repeatFailureNotice.',
  'hooks_session_start.ts::sessionStartHandler':
    'Three contributors. reconcileNote emits counts only. The delta capsule lists paths from files a Read touched, escaped in evidence_cache.ts. The DB health message is text token-goat authored itself.',
  'hooks_edit.ts::postEditHandlerInner':
    'Names the edited file. Already routed through displaySafePath before the backtick escaping, with a comment saying why that order matters.',
  'hooks_write.ts::preWriteRewriteHandler':
    'Interpolates only a line count and a percentage. The path and both file contents are read for arithmetic and never echoed.',
  'hooks_compact.ts::preCompactHandler':
    'Emits the manifest, every row of which routes its file-derived text through displaySafePath or displaySafeText, the web-fetch row included since 2.9.7, and the SAFE_TO_DISCARD bash-command rows (entry.command only ever passes through redactSecrets, never marker neutralization) run through neutralizeSpokenMarkers as of the security-loop fix that closed this same gap.',
  'hooks_session.ts::pendingContextHandler':
    'Forwards a payload another handler already composed and adjudicated; interpolates nothing of its own.',
  'hooks_read.ts::quietContextOutput':
    'A pure wrapper over contextOutput, the same class as the exempted emitRewriteIfChanged in the sibling guard. Interpolates nothing.',
  'hooks_read.ts::preReadHandlerInner':
    'The densest set of hints in the codebase. `shown` was already displaySafePath(normalized) everywhere. `basename` was not, and it is live: isManifestFile matches manifest extensions as well as fixed names, so the manifest re-read hint quotes an arbitrary repository-chosen file name. Escaped at its derivation, which also covers the tsconfig branch beside it. The skill directory name out of detectSkillFile is escaped too but is not reachable today, gated upstream by safeSkillName; see the note there.',
  'hooks_read.ts::postReadHandlerInner':
    'One site, reached through quietContextOutput. Its path comes through the same displaySafePath-derived `shown` the pre-read hints use.',
  'hooks_agent_spawn.ts::postAgentHandler':
    'The unrestricted-spawn advisory names agent definitions from a roster that includes the project you are in. AGENT_NAME_RE constrains the name at the parser and neutralizeSpokenMarkers escapes it again at the sentence, so widening the character set cannot quietly reopen it.',
  // The six below are outer handlers whose whole contribution is a try/catch and a dispatch to the
  // Inner adjudicated above them. They are in the population because the walk is transitive, which
  // is the right default: a wrapper that started composing its own text would otherwise be invisible.
  'hooks_bash.ts::preBashHandler': 'Wrapper over preBashHandlerInner. Interpolates nothing of its own.',
  'hooks_bash.ts::postBashHandler': 'Wrapper over the post-Bash path. Interpolates nothing of its own.',
  'hooks_edit.ts::postEditHandler': 'Wrapper over postEditHandlerInner. Interpolates nothing of its own.',
  'hooks_read.ts::preReadHandler': 'Wrapper over preReadHandlerInner. Interpolates nothing of its own.',
  'hooks_read.ts::postReadHandler': 'Wrapper over postReadHandlerInner. Interpolates nothing of its own.',
  'image_shrink.ts::preReadImageHandler':
    'Wrapper that dispatches to finalizeShrinkResult, adjudicated above. Interpolates nothing of its own.',
}

/**
 * How many functions must reach the channel for this file to be saying anything.
 *
 * CAPTURE: 21 reached it against the build at the time this was written. The floor sits below that
 * so an ordinary refactor merging two handlers does not fire it, and far enough above zero that the
 * failure this guard exists to prevent -- the scan matching nothing and every assertion passing on
 * an empty set -- cannot come back quietly.
 */
const POPULATION_FLOOR = 15

function srcFiles(): string[] {
  return fs
    .readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => path.join(SRC_DIR, e.name))
}

/** Every `file.ts::function` whose body, or a same-file function it calls, reaches contextOutput. */
function contextSites(): string[] {
  const out: string[] = []
  for (const file of srcFiles()) {
    const source = fs.readFileSync(file, 'utf8')
    if (!source.includes(CONTEXT_CALL)) continue
    const fns: FnInfo[] = parseTopLevelFunctions(source)
    const map = functionMap(fns)
    for (const fn of fns) {
      if (reaches(fn, map, (body) => body.includes(CONTEXT_CALL))) out.push(`${path.basename(file)}::${fn.name}`)
    }
  }
  return out.sort()
}

describe('every function on the context channel has been adjudicated', () => {
  it('finds a real population rather than passing on an empty scan', () => {
    pinnedPopulation({
      what: 'functions reaching contextOutput in src/*.ts',
      items: contextSites(),
      floor: POPULATION_FLOOR,
      // Named individually rather than trusted to the count: a rename leaves the total intact while
      // silently dropping the one entry that mattered, and the union being non-empty hides it.
      mustInclude: ['hooks_bash.ts::preBashHandlerInner', 'image_shrink.ts::finalizeShrinkResult'],
    })
  })

  it('has an entry for each one, and no entry for a function that has gone', () => {
    const found = contextSites()
    const unadjudicated = found.filter((k) => ADJUDICATED[k] === undefined)
    expect(
      unadjudicated,
      'These reach contextOutput, the channel that neither fences its payload nor escapes the ' +
        'markers token-goat speaks in, and nobody has said what they interpolate. Read each one and ' +
        'ask what in the emitted string token-goat did not author: a path, a URL, a symbol or tool ' +
        'or skill or agent name, a shell command, a search pattern. If any, route it through ' +
        'displaySafeText (or displaySafePath) and add a line to ADJUDICATED saying so. If none, add ' +
        'the line saying that instead. Do not bulk-exempt: nine live findings in one release came ' +
        'from ' +
        'this question being asked one function at a time.\n  ' +
        unadjudicated.join('\n  '),
    ).toEqual([])

    // The other direction, so the list cannot rot into a description of a codebase that has moved.
    // A stale key reads as coverage of something that no longer exists.
    const stale = Object.keys(ADJUDICATED).filter((k) => !found.includes(k))
    expect(stale, `ADJUDICATED names functions that no longer reach contextOutput:\n  ${stale.join('\n  ')}`).toEqual([])
  })

  it('keeps the escaping helper reachable from the sites that promised to use it', () => {
    // The entries above are prose, and prose cannot fail. These four promised a specific mechanism,
    // so the mechanism is asserted directly: if someone removes the call the entry describes, the
    // entry becomes a false exemption, which is worse than no entry at all because it reads as a
    // decision somebody made.
    const bash = fs.readFileSync(path.join(SRC_DIR, 'hooks_bash.ts'), 'utf8')
    expect(bash).not.toMatch(/const hintPath = cdStripped \?/)
    expect(bash.match(/const hintPath = displaySafePath\(cdStripped \?/g) ?? []).not.toHaveLength(0)

    for (const [file, call] of [
      ['image_shrink.ts', 'displaySafePath(path.basename(filePath))'],
      ['resident_context.ts', 'displaySafeText(worst.skill)'],
      ['evidence_cache.ts', 'displaySafePath(entry.source)'],
      ['hooks_tool_failure.ts', 'displaySafeText(toolName)'],
      ['hooks_read.ts', 'displaySafePath(path.basename(normalized))'],
      ['hooks_read.ts', 'displaySafePath(match[1]!)'],
      ['hooks_common.ts', "displaySafeText(typeof toolInput['pattern']"],
      ['hooks_glob.ts', 'displaySafeText(pattern)'],
    ] as const) {
      expect(fs.readFileSync(path.join(SRC_DIR, file), 'utf8'), `${file} no longer contains ${call}`).toContain(call)
    }
  })
})
