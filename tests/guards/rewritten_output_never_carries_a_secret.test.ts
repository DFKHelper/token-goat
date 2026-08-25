/**
 * Behavioral guard on "text token-goat authors for the model is redacted"
 * (CLAUDE.arch.md's Security Boundaries).
 *
 * `postAgentHandler` in `hooks_agent_spawn.ts` shipped building its compacted envelope from the
 * RAW subagent report while the sibling `storeMcpOutput` call on the very next line redacted the
 * same string for disk. One source, two destinations, one sanitized: a credential a subagent
 * pasted into its report was scrubbed in the cache and intact in the model's context. That is the
 * seventh instance of the redaction-bypass class this repo has found, and the fourth where the
 * bypassing path sat inside a function whose other path did the right thing.
 *
 * A `pass` result is out of scope by construction: it means the harness's own untouched tool
 * result reaches the model, which token-goat neither authored nor can alter. The invariant worth
 * guarding is narrower and absolute -- whenever token-goat REPLACES a tool result with text it
 * composed itself (`rewriteOutput`), that text must not carry a credential.
 *
 * Why this is behavioral rather than structural, deliberately: the obvious static version --
 * "every function reaching `rewriteOutput` must also reach `redactSecrets`" -- was built and
 * measured first, and flags three files today, of which at least `hooks_bash.ts` is provably a
 * false positive. Its compression rewrite IS redacted, inside `compressOutput()` in another
 * module, which the same-file transitive-call analysis the sibling fence guard uses cannot see.
 * Silencing that needs a hand-maintained suppression list, which is precisely the invisible-
 * omission failure mode `third_party_content_reaches_fence.test.ts`'s header exists to avoid.
 * Firing the real handlers and reading what they actually emit has no such blind spot: it does not
 * care which module the redaction lives in, only whether it happened.
 *
 * Population is derived from the hook registry, never enumerated here. `toolMatcherFor` reports
 * every tool name with a registered `post_tool_use` handler, so a new hook joins this guard the
 * same turn it calls `registerHook`, with nobody needing to remember.
 *
 * Disclosed scope limit, stated rather than quietly accepted: a handler only gets checked on the
 * fixtures below, so one that returns `pass` for all of them contributes nothing. This proves the
 * handlers that DO rewrite keep redacting; it does not prove a handler that rewrites only under
 * some condition these fixtures never reach would redact there too.
 *
 * That limit is not hypothetical -- it has bitten twice. Grep sat in this guard's population while
 * carrying a real leak, because the fixture gave it one match per file and its fold only engages
 * when a file has two. ExitPlanMode contributed nothing until its fixture was made a genuine plan
 * echo. Both were invisible because the pass/fail signal aggregated: the other handlers' rewrites
 * kept the floor satisfied. So the assertion at the end pins the exact SET of tools that reached a
 * rewrite, not just a count -- a handler dropping out of coverage now fails by name.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Importing relay registers every hook module for its side effects, so both the matcher below and
// runHook dispatch through the real production registry rather than a test-local subset.
import { buildEvent } from '../../src/relay.js'
import { runHook, toolMatcherFor } from '../../src/hook_registry.js'

/** A live-shaped AWS access key id — `secret_redact.ts`'s `aws_access_key` pattern. */
const SECRET = 'AKIAABCDEFGHIJKLMNOP'

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-guard-redact-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

/** Every tool name with a registered `post_tool_use` handler, read off the registry. */
function registeredPostToolNames(): string[] {
  const matcher = toolMatcherFor('post_tool_use')
  if (matcher === null) return []
  return matcher
    .split('|')
    .map((part) => part.replace(/^\^/, '').replace(/\$$/, ''))
    .filter((name) => name.length > 0)
    // `^mcp__` is a prefix pattern, not an exact name; give it a concrete tool to dispatch on.
    .map((name) => (name === 'mcp__' ? 'mcp__server__query' : name))
}

/** Filler long enough to clear the size floors several handlers gate their rewrite on. */
const FILLER = Array.from(
  { length: 400 },
  (_, i) => `npm WARN deprecated pkg-${i}@1.0.0: no longer supported, use another package`,
).join('\n')

/**
 * The plan body `ExitPlanMode` echoes back. It has to be both long enough to clear that handler's
 * net-benefit floor and byte-identical to the `plan` tool input, or the handler declines to rewrite
 * and the tool contributes nothing to this guard -- which is what it did until the credential was
 * moved into the pre-marker region below, the only part its rewrite actually keeps.
 */
const PLAN_BODY = Array.from(
  { length: 40 },
  (_, i) => `step ${i}: do the thing carefully and completely, with enough text to matter`,
).join('\n')

/** A fenced block long enough for the agent-report handler's fence collapse to engage. */
const FENCE = '```\n' + 'a filler line of captured build output, long enough to collapse\n'.repeat(90) + '```\n'

/**
 * Response shapes to try per tool, each as a two-call sequence under one session id.
 *
 * The pair is not padding. The poll-diff handlers (`BashOutput`, `TaskOutput`) pass their FIRST
 * sight of a task through untouched and only rewrite once they have a prior snapshot to diff
 * against, so a single call leaves their entire rewrite branch unexercised -- verified by mutating
 * `hooks_bashoutput.ts`'s redaction away and watching a one-call version of this guard stay green.
 * The first call seeds a clean snapshot; the second appends the credential, so it lands in the
 * delta the handler composes. Handlers with no poll state simply see the same shape twice, and
 * both results are checked either way.
 */
function responseShapePairs(): { first: Record<string, unknown>; second: Record<string, unknown> }[] {
  const clean = `starting the build\n${FILLER}\n`
  const withSecret = `${clean}export AWS_ACCESS_KEY_ID=${SECRET}\n${FILLER}\n`
  const report = `Findings.\n\n${FENCE}\nThe key is ${SECRET}.\n\n${FENCE}\n${FENCE}\n`
  // Repeated files, not 300 distinct ones: the grep fold only rewrites when some file has at
  // least two matches to group, so one-match-per-file output leaves its whole rewrite branch
  // unreached -- which is how a real leak in that handler initially slipped past this guard.
  const grepHits: string[] = []
  for (const f of ['src/config.ts', 'src/deploy.ts', 'src/env.ts']) {
    for (let i = 1; i <= 60; i++) {
      grepHits.push(`${f}:${i}:  const key = "${SECRET}" // occurrence ${i} with padding to clear the floor`)
    }
  }
  // The credential goes BEFORE the `## Approved Plan:` marker on purpose. That handler's rewrite
  // keeps the text up to the marker and discards the echoed body after it, so a secret placed in
  // the body would be dropped by the truncation rather than by any redaction -- the assertion would
  // pass while proving nothing about whether the handler redacts.
  const plan = `User has approved your plan. Context: AWS_ACCESS_KEY_ID=${SECRET}\n\n## Approved Plan:\n${PLAN_BODY}`
  return [
    { first: { output: clean, exit_code: 0 }, second: { output: withSecret, exit_code: 0 } },
    { first: { content: [{ type: 'text', text: report }] }, second: { content: [{ type: 'text', text: report }] } },
    { first: { output: plan }, second: { output: plan } },
    { first: { output: grepHits.join('\n') }, second: { output: grepHits.join('\n') } },
  ]
}

/** Tool inputs picked so each handler's own command/id gate is satisfied where it has one. */
function toolInputFor(toolName: string): Record<string, unknown> {
  switch (toolName) {
    // Compound, so it reaches the post-hook's generic compressor rather than the pre-hook wrapper.
    case 'Bash':
      return { command: 'npm install && npm run build' }
    case 'BashOutput':
      return { bash_id: 'bash-1' }
    case 'TaskOutput':
      return { task_id: 'task-1' }
    case 'Agent':
      return { subagent_type: 'general-purpose', prompt: 'audit the deploy path' }
    case 'Grep':
      return { pattern: 'k', output_mode: 'content' }
    case 'WebFetch':
    case 'WebSearch':
      return { url: 'https://example.com/page', prompt: 'summarize' }
    // Must match the echoed body in the fixture exactly: the handler verifies the echo really
    // corresponds to this call's own plan before truncating, so a placeholder here would send it
    // down a pass branch and quietly drop the tool out of this guard's coverage.
    case 'ExitPlanMode':
      return { plan: PLAN_BODY }
    default:
      return { file_path: 'src/index.ts' }
  }
}

describe('no post_tool_use handler rewrites a tool result into text carrying a credential', () => {
  it('redacts every credential out of every rewriteOutput it produces', async () => {
    const toolNames = registeredPostToolNames()
    // Guards the guard: an empty or unparsed matcher would make every assertion below vacuous.
    expect(toolNames.length, 'registry must report post_tool_use tools').toBeGreaterThan(5)

    const leaked: string[] = []
    let rewrote = 0
    const rewroteTools = new Set<string>()

    for (const toolName of toolNames) {
      for (const [i, pair] of responseShapePairs().entries()) {
        // One session id across the pair so poll-diff handlers see the second call as a follow-up
        // to the first; distinct across shapes so one shape's bookkeeping never diverts the next
        // onto an early-return path it would not take in isolation.
        const sessionId = `guard-${toolName}-${i}`
        for (const [call, toolResponse] of [pair.first, pair.second].entries()) {
          const result = await runHook(
            buildEvent('post_tool_use', {
              tool_name: toolName,
              tool_input: toolInputFor(toolName),
              session_id: sessionId,
              tool_response: toolResponse,
            }),
          )
          if (result.hookType !== 'rewriteOutput') continue
          rewrote++
          rewroteTools.add(toolName)
          if (result.updatedOutput.includes(SECRET)) leaked.push(`${toolName} (shape ${i}, call ${call + 1})`)
        }
      }
    }

    expect(
      leaked,
      'these handlers replaced a tool result with text they composed themselves and left a live ' +
        'credential in it, so the secret reached the model in token-goat-authored output: ' +
        leaked.join(', '),
    ).toEqual([])

    // Guards the guard again: if the fixtures above stopped reaching any rewrite branch (a raised
    // size floor, a changed response key), every handler would return `pass` and the assertion
    // above would hold without having tested anything.
    // Guards the guard again, and specifically: a bare `rewrote > 0` floor would stay green if any
    // single handler silently stopped reaching its rewrite branch, because the other eight would
    // hold the count up -- which is exactly how Grep sat in this guard's population contributing
    // nothing while carrying a real leak. Pinning the set makes a coverage loss fail by name.
    // The remaining registered tools (Read, Glob, Write, Edit, MultiEdit, NotebookEdit, Skill) hint
    // or annotate but never substitute a tool result, so they have no rewrite branch to reach.
    expect([...rewroteTools].sort(), 'a handler that stopped rewriting has silently left this guard').toEqual([
      'Agent',
      'Bash',
      'BashOutput',
      'ExitPlanMode',
      'Grep',
      'TaskOutput',
      'WebFetch',
      'WebSearch',
      'mcp__server__query',
    ])
    expect(rewrote, 'fixtures must actually reach at least one handler rewrite branch').toBeGreaterThan(0)
  })
})
