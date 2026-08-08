import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// Importing relay registers EVERY hook module (including hooks_agent_spawn) for its
// side-effects, so runHook dispatches through the real production registry.
// buildEvent maps a Claude Code payload onto a HookEvent exactly as relay() does.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { recordBashOutput, MAX_OUTSTANDING_AGENT_SPAWNS, getOutstandingAgentSpawns, importSessionState } from '../src/session.js'
import { storeBashOutput, getBashOutput } from '../src/bash_output_cache.js'
import { summarize } from '../src/stats.js'
import { _resetDataDirCacheForTesting, dataDirForHome } from '../src/constants.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import { collapseFencedBlocks, dedupeFencedBlocks } from '../src/hooks_agent_spawn.js'

// Lets one test force buildProjectMap()'s formatted output to be huge, so the briefing's
// over-budget truncation path (see the "keeps the surgical-read reminder ... when the briefing
// as a whole exceeds budget" test below) is actually exercised -- this real repo's own compact
// project map is far too small to trip BRIEFING_TARGET_TOKENS on its own.
// Fixed-size project maps (not derived from this repo's own live index) so both the
// over-budget path and the cache-ids-block regression path are exercised deterministically,
// regardless of the host machine's index state or repo size -- see cycle 121: a test that reads
// buildProjectMap()'s live output for this repo passes or fails depending on ambient index
// staleness, not on the actual budget-vs-reminder-size coupling being tested.
let _hugeProjectMapOverride = false
let _realisticProjectMapOverride = false
vi.mock('../src/baseline.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    formatProjectMap: (...args: unknown[]) => {
      if (_hugeProjectMapOverride) {
        // Sized so map+reminder+report-contract alone fits BRIEFING_TARGET_TOKENS but
        // map+cache-ids+reminder+report-contract does not -- exercises the "drop cache-ids first,
        // keep the reminder and report contract" path specifically, not the further last-resort
        // tail-trim fallback for a still-oversized map alone.
        return 'huge-project-map-line '.repeat(40)
      }
      if (_realisticProjectMapOverride) {
        // A fixed, realistic mid-size project's compact map (measured ~140 tokens): together with
        // the current reminder text this lands right at the old 300-token budget's edge -- the
        // exact shape of the cycle 121 regression, where the cache-ids block silently vanished on
        // essentially every real indexed project, not just huge outliers.
        return [
          '# Project map: example-app',
          'Files: 640',
          'Languages: typescript 480, markdown 60, json 40, yaml 20, python 20, css 12, html 8',
          '',
          '## Top symbols',
          '- UserService (class)',
          '- OrderController (class)',
          '- PaymentGateway (class)',
          '- AuthMiddleware (class)',
          '- InventoryManager (class)',
          '- NotificationQueue (class)',
          '- ReportGenerator (class)',
          '- CacheLayer (class)',
          '- ApiClient (class)',
          '- SchemaValidator (class)',
        ].join('\n')
      }
      return (original['formatProjectMap'] as (...a: unknown[]) => string)(...args)
    },
  }
})

let tmpHome: string
let prevHome: string | undefined
let sessionId: string

// Clears session.ts's in-memory state without touching the hook registry (clearModuleCaches()
// from reset.ts would also wipe hook_registry.ts's registered handlers, which are only ever
// registered once at module-import time via top-level registerHook() calls in hooks_agent_spawn.ts
// -- clearing them mid-file would silently unregister every hook for the rest of this test file,
// since nothing re-imports/re-registers afterward).
function resetSessionState(): void {
  importSessionState({
    files: [],
    hintsShown: [],
    webFetches: [],
    bashOutputs: [],
    curlDownloads: [],
    outstandingAgentSpawns: [],
  })
}

beforeEach(() => {
  resetSessionState()
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hooks-agent-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  sessionId = `agent-${path.basename(tmpHome)}`
})

afterEach(() => {
  resetSessionState()
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

/**
 * Run a hook event the way relay.ts's relayInProcess does for a real Claude Code call: load the
 * named session's persisted state, dispatch through the real registered handlers, then persist
 * whatever the handlers mutated. hooks_agent_spawn's pre/post handlers fire as separate
 * `token-goat hook` processes in production, so exercising the duplicate-brief feature through
 * this load/dispatch/save cycle (rather than bare back-to-back runHook calls sharing one
 * process's module state) is what actually proves the cross-process tracking works.
 *
 * Resets in-memory session state to empty before loading, so that switching `sid` between calls
 * faithfully simulates a brand-new `token-goat hook` process (which always starts with empty
 * module state before loadSessionState populates it from that session's own file) rather than
 * leaking a previous call's in-process module state into a session that has no on-disk file yet.
 */
async function callAgentHook(
  eventName: 'pre_tool_use' | 'post_tool_use',
  toolInput: Record<string, unknown>,
  sid: string,
  toolResponse?: unknown,
) {
  resetSessionState()
  loadSessionState(sid)
  const payload: Record<string, unknown> = { tool_name: 'Agent', tool_input: toolInput, session_id: sid }
  if (toolResponse !== undefined) payload['tool_response'] = toolResponse
  const result = await runHook(buildEvent(eventName, payload))
  saveSessionState(sid)
  return result
}

describe('Agent spawn briefing hook (real runHook dispatch)', () => {
  it('appends a briefing to an Agent tool prompt', async () => {
    const prompt = 'Build a feature that does X.'
    const payload = {
      tool_name: 'Agent',
      tool_input: { prompt, description: 'Test agent' },
      session_id: sessionId,
    }
    const result = await runHook(buildEvent('pre_tool_use', payload))
    expect(result.hookType).toBe('rewriteInput')
    if (result.hookType === 'rewriteInput') {
      const updatedPrompt = result.updatedInput['prompt']
      expect(typeof updatedPrompt).toBe('string')
      expect(updatedPrompt).toContain(prompt) // Original prompt still there
      expect(updatedPrompt).toContain('## Session briefing') // Briefing was appended
      // Pin the imperative gate wording (not the old advisory "prefer surgical reads" phrasing).
      expect(updatedPrompt).toContain('Before your first read of any file')
      expect(updatedPrompt).toContain('instead of a full-file read or wide grep')
      expect(updatedPrompt).toContain('is a violation, not an oversight')
      // Report contract: pin by concept (cite evidence by handle, fence only when load-bearing,
      // state unverified claims explicitly), not by exact wording -- brittle-string-coupling
      // lesson from this repo's own hint-text tests.
      expect(updatedPrompt).toContain('Report contract')
      expect(updatedPrompt).toContain('cite evidence')
      expect(updatedPrompt).toContain('load-bearing')
      expect(updatedPrompt).toContain('state every unverified claim explicitly')
    }
  })

  it('passes through non-Agent tool calls unchanged', async () => {
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      session_id: sessionId,
    }
    const result = await runHook(buildEvent('pre_tool_use', payload))
    expect(result.hookType).toBe('pass')
  })

  it('passes through Agent calls with missing prompt unchanged', async () => {
    const payload = {
      tool_name: 'Agent',
      tool_input: { description: 'Test agent' }, // no prompt field
      session_id: sessionId,
    }
    const result = await runHook(buildEvent('pre_tool_use', payload))
    expect(result.hookType).toBe('pass')
  })

  it('passes through Agent calls with empty prompt unchanged', async () => {
    const payload = {
      tool_name: 'Agent',
      tool_input: { prompt: '   ' }, // whitespace only
      session_id: sessionId,
    }
    const result = await runHook(buildEvent('pre_tool_use', payload))
    expect(result.hookType).toBe('pass')
  })

  it('includes cached bash output ids in the briefing when available', async () => {
    // Store a bash output in this session
    const outputId = await storeBashOutput('echo test', 'test output', 0)
    // Record it in the session state
    recordBashOutput('hash1', outputId, Buffer.byteLength('test output', 'utf-8'))

    const prompt = 'Check the previous build output.'
    const payload = {
      tool_name: 'Agent',
      tool_input: { prompt },
      session_id: sessionId,
    }
    const result = await runHook(buildEvent('pre_tool_use', payload))
    expect(result.hookType).toBe('rewriteInput')
    if (result.hookType === 'rewriteInput') {
      const updatedPrompt = result.updatedInput['prompt']
      expect(typeof updatedPrompt).toBe('string')
      expect(updatedPrompt).toContain('token-goat bash-output') // Cached output hint
    }
  })

  it('includes the cache-ids block against a realistic mid-size project map, independent of the host repo\'s own index state (regression test for cycle 121: BRIEFING_TARGET_TOKENS left near-zero headroom once the reminder grew, so a modest map + 1 cached id silently dropped the cache-ids block on essentially every real spawn)', async () => {
    _realisticProjectMapOverride = true
    try {
      const outputId = await storeBashOutput('echo test', 'test output', 0)
      recordBashOutput('hash1', outputId, Buffer.byteLength('test output', 'utf-8'))

      const prompt = 'Check the previous build output.'
      const payload = {
        tool_name: 'Agent',
        tool_input: { prompt },
        session_id: sessionId,
      }
      const result = await runHook(buildEvent('pre_tool_use', payload))
      expect(result.hookType).toBe('rewriteInput')
      if (result.hookType === 'rewriteInput') {
        const updatedPrompt = result.updatedInput['prompt']
        expect(typeof updatedPrompt).toBe('string')
        expect(updatedPrompt).toContain('token-goat bash-output')
        expect(updatedPrompt).toContain('Cached outputs this session')
        // At a realistic mid-size project's map, there is still enough headroom for the report
        // contract to survive alongside the cache-ids block -- it is not the first thing dropped.
        expect(updatedPrompt).toContain('Report contract')
      }
    } finally {
      _realisticProjectMapOverride = false
    }
  })

  it('does not corrupt tool input fields other than prompt', async () => {
    const toolInput = {
      prompt: 'Investigate the issue.',
      description: 'Debug agent',
      subagent_type: 'researcher',
      model: 'claude-opus',
    }
    const payload = {
      tool_name: 'Agent',
      tool_input: toolInput,
      session_id: sessionId,
    }
    const result = await runHook(buildEvent('pre_tool_use', payload))
    expect(result.hookType).toBe('rewriteInput')
    if (result.hookType === 'rewriteInput') {
      // Verify other fields are preserved
      expect(result.updatedInput['description']).toBe('Debug agent')
      expect(result.updatedInput['subagent_type']).toBe('researcher')
      expect(result.updatedInput['model']).toBe('claude-opus')
      // Prompt is modified but still present
      const updatedPrompt = result.updatedInput['prompt']
      expect(typeof updatedPrompt).toBe('string')
      expect(updatedPrompt).toContain('Investigate the issue.')
    }
  })

  it('handles Agent calls without throwing, even when briefing fails', async () => {
    // This test ensures that the hook never throws, even if internal
    // briefing construction fails. The handler catches all errors internally.
    const prompt = 'Proceed despite any errors.'
    const payload = {
      tool_name: 'Agent',
      tool_input: { prompt },
      session_id: sessionId,
    }

    // The hook either passes (if briefing failed) or rewrites (if briefing succeeded).
    // Both are acceptable outcomes — the important thing is no exception is thrown.
    const result = await runHook(buildEvent('pre_tool_use', payload))
    expect(result.hookType === 'pass' || result.hookType === 'rewriteInput').toBe(true)
  })

  // Regression: buildSubagentBriefing's over-budget truncation used to slice the assembled
  // string from the end regardless of section order, contradicting its own "keep map + reminder,
  // sacrifice cache ids if needed" comment -- since the reminder was appended LAST (after the
  // cache-ids section), a tail-slice cut the reminder first, not the cache ids. The cache-ids
  // block must now be dropped first, and the surgical-read reminder must survive whenever the
  // map + reminder alone still fit the budget.
  it('keeps the surgical-read reminder (and drops the cache-ids block first) when the briefing as a whole exceeds budget', async () => {
    _hugeProjectMapOverride = true
    try {
      const outputId = await storeBashOutput('echo test', 'test output', 0)
      recordBashOutput('hash1', outputId, Buffer.byteLength('test output', 'utf-8'))

      const prompt = 'Investigate the large refactor.'
      const payload = {
        tool_name: 'Agent',
        tool_input: { prompt },
        session_id: sessionId,
      }
      const result = await runHook(buildEvent('pre_tool_use', payload))
      expect(result.hookType).toBe('rewriteInput')
      if (result.hookType === 'rewriteInput') {
        const updatedPrompt = result.updatedInput['prompt'] as string
        expect(typeof updatedPrompt).toBe('string')
        expect(updatedPrompt).toContain(prompt)
        // The load-bearing gate reminder and report contract must survive even though the
        // briefing overall had to be trimmed to fit budget: they sit in the same tail unit, one
        // priority tier above the cache-ids block.
        expect(updatedPrompt).toContain('Before your first read of any file')
        expect(updatedPrompt).toContain('Report contract')
        // The nice-to-have cache-ids hint is the sacrificial section, so it's the one dropped.
        expect(updatedPrompt).not.toContain('Cached outputs this session')
      }
    } finally {
      _hugeProjectMapOverride = false
    }
  })
})

describe('postAgentHandler — outlier-large subagent report caching (real runHook dispatch)', () => {
  const toolInput = { prompt: 'Investigate the issue.', description: 'Test agent' }

  function postPayload(toolResponse: unknown): Record<string, unknown> {
    return { tool_name: 'Agent', tool_input: toolInput, session_id: sessionId, tool_response: toolResponse }
  }

  it('passes through an Agent report under the cache threshold untouched (regression: the average real report is ~2,220 chars, well under the 8000-char floor -- this must never fire on a typical report)', async () => {
    const smallReport = 'Found and fixed the bug.'.repeat(50) // well under 8000 chars
    const result = await runHook(buildEvent('post_tool_use', postPayload(smallReport)))
    expect(result.hookType).toBe('pass')
  })

  it('caches an outlier-large all-prose Agent report and appends a recall pointer without altering it (regression: prose is never truncated or hidden -- with no fenced block to collapse this path stays contextOutput-only, exactly as before envelope compaction existed)', async () => {
    const largeReport = 'Detailed finding line.\n'.repeat(400) // > 8000 chars
    const result = await runHook(buildEvent('post_tool_use', postPayload(largeReport)))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      const m = /token-goat mcp-output (mcp_[0-9a-f]{16})/.exec(result.context)
      expect(m).not.toBeNull()
      // The recalled id resolves to the exact original report -- lossless recall is the
      // whole point of the conservative design (never truncate what the parent sees now).
      const entry = getBashOutput(m![1] as string)
      expect(entry?.output).toBe(largeReport)
    }
  })

  it('collapses the middle of an over-long fenced block, keeps both ends, and leaves every prose line byte-identical', async () => {
    const caveat = 'Not verified: I did not re-run the full suite after the falsify cycle.'
    const report = [
      'Here is what I changed.',
      '```',
      ...Array.from({ length: 60 }, (_, i) => `gate output line ${i}`),
      '```',
      caveat,
      'x'.repeat(8000),
    ].join('\n')
    const result = await runHook(buildEvent('post_tool_use', postPayload(report)))
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType === 'rewriteOutput') {
      const out = result.updatedOutput
      // The caveat sentence is the whole reason prose is off-limits: it is what catches a subagent that shipped something it never checked.
      expect(out).toContain(caveat)
      expect(out).toContain('Here is what I changed.')
      // Both ends of the fence survive; only the middle goes.
      expect(out).toContain('gate output line 0')
      expect(out).toContain('gate output line 59')
      expect(out).not.toContain('gate output line 30')
      // The `--full` suffix is load-bearing and nearly shipped missing: a bare `mcp-output <id>` render elides its own middle past the default head 30 / tail 80, so without it the marker points at a command that drops the very lines it just promised. Assert the flag, not just the id.
      expect(out).toMatch(/\d+ lines elided -- full report via token-goat mcp-output mcp_[0-9a-f]{16} --full/)
      // The full text stays recoverable, so nothing is actually lost.
      const m = /token-goat mcp-output (mcp_[0-9a-f]{16})/.exec(out)
      expect(getBashOutput(m![1] as string)?.output).toBe(report)
    }
  })

  it('leaves a short fenced block intact (a diff --stat table is worth more whole than elided)', async () => {
    const report = ['Summary.', '```', ...Array.from({ length: 5 }, (_, i) => `file${i}.ts | 2 +-`), '```', 'y'.repeat(9000)].join('\n')
    const result = await runHook(buildEvent('post_tool_use', postPayload(report)))
    expect(result.hookType).toBe('context')
  })

  it('treats an inner ``` inside a 4-backtick fence as content, not as a closer (a naive ```-toggle closes at the inner line and mis-slices the surrounding prose)', async () => {
    const tail = 'TRAILING PROSE SENTINEL'
    const report = [
      'Intro.',
      '````',
      ...Array.from({ length: 30 }, (_, i) => `outer ${i}`),
      '```',
      'inner fenced example',
      '```',
      ...Array.from({ length: 30 }, (_, i) => `outer tail ${i}`),
      '````',
      tail,
      'p'.repeat(8000),
    ].join('\n')
    const result = await runHook(buildEvent('post_tool_use', postPayload(report)))
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType === 'rewriteOutput') {
      const out = result.updatedOutput
      // One block spanning both 4-backtick markers: its ends survive, its middle (including the whole inner fence) goes, and the prose after the real closer is untouched.
      expect(out).toContain('outer 0')
      expect(out).toContain('outer tail 29')
      expect(out).toContain(tail)
      expect(out).not.toContain('inner fenced example')
      expect(out.match(/lines elided/g)).toHaveLength(1)
    }
  })

  it('collapses a ~~~ fence and does not let a ``` line close it', async () => {
    const report = [
      'Intro.',
      '~~~',
      ...Array.from({ length: 25 }, (_, i) => `tilde body ${i}`),
      '```',
      ...Array.from({ length: 25 }, (_, i) => `still inside ${i}`),
      '~~~',
      'AFTER TILDE FENCE',
      'q'.repeat(8000),
    ].join('\n')
    const result = await runHook(buildEvent('post_tool_use', postPayload(report)))
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType === 'rewriteOutput') {
      expect(result.updatedOutput).toContain('AFTER TILDE FENCE')
      expect(result.updatedOutput).toContain('tilde body 0')
      expect(result.updatedOutput).toContain('still inside 24')
      expect(result.updatedOutput.match(/lines elided/g)).toHaveLength(1)
    }
  })

  it('records the real byte saving under agent_report_compact, not a zero-valued event', async () => {
    // recordStat writes through getGlobalDb() -> dataDir(), driven by LOCALAPPDATA/XDG_DATA_HOME and NOT by TOKEN_GOAT_HOME. Without pinning both, this assertion reads a different database than the hook just wrote to -- and worse, the hook writes into the developer's real global index. Pin both to the exact parent dataDirForHome() derives its per-platform layout from, so writer and reader agree on every platform rather than only on win32.
    const dataRoot = dataDirForHome(tmpHome)
    const envRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
    const prevLocal = process.env['LOCALAPPDATA']
    const prevXdg = process.env['XDG_DATA_HOME']
    process.env['LOCALAPPDATA'] = envRoot
    process.env['XDG_DATA_HOME'] = envRoot
    _resetDataDirCacheForTesting()
    try {
      const report = ['Intro.', '```', ...Array.from({ length: 400 }, (_, i) => `gate line ${i} with padding`), '```'].join('\n')
      const result = await runHook(buildEvent('post_tool_use', postPayload(report)))
      expect(result.hookType).toBe('rewriteOutput')
      // The whole point: a rewrite that removes thousands of bytes must not report 0 the way the advisory session_hint sibling correctly does.
      expect(summarize(3650).by_kind['agent_report_compact']?.bytes_saved ?? 0).toBeGreaterThan(1000)
    } finally {
      if (prevLocal === undefined) delete process.env['LOCALAPPDATA']
      else process.env['LOCALAPPDATA'] = prevLocal
      if (prevXdg === undefined) delete process.env['XDG_DATA_HOME']
      else process.env['XDG_DATA_HOME'] = prevXdg
      _resetDataDirCacheForTesting()
    }
  })

  it('records a decline stat (0 bytes) when the fence-collapse gate runs but the net savings do not clear the notice cost (regression: image_shrink_skipped shipped registered/rendered but never recordStat\'d anywhere -- a decline kind needs a shipping-path test that actually drives postAgentHandler, not just a unit test of isRewriteWorthwhile)', async () => {
    const dataRoot = dataDirForHome(tmpHome)
    const envRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
    const prevLocal = process.env['LOCALAPPDATA']
    const prevXdg = process.env['XDG_DATA_HOME']
    process.env['LOCALAPPDATA'] = envRoot
    process.env['XDG_DATA_HOME'] = envRoot
    _resetDataDirCacheForTesting()
    try {
      // A fence body just 1 line over fence_collapse_min_lines (20) elides only 21-6*2=9 single-char
      // lines: real savings are a handful of bytes, dwarfed by the ~100+ byte recall notice, so the
      // shared net-benefit gate declines even though collapseFencedBlocks() DID rewrite the fence.
      const report = ['Intro.', '```', ...Array.from({ length: 21 }, (_, i) => `${i}`), '```', 'z'.repeat(8000)].join('\n')
      const result = await runHook(buildEvent('post_tool_use', postPayload(report)))
      expect(result.hookType).toBe('context')
      const kind = summarize(3650).by_kind['agent_report_compact_declined']
      expect(kind?.events ?? 0).toBeGreaterThanOrEqual(1)
      // A decline must never carry nonzero bytes -- that would inflate the headline savings number
      // with a non-saving, the exact desync class this codebase keeps having to fix.
      expect(kind?.bytes_saved ?? 0).toBe(0)
    } finally {
      if (prevLocal === undefined) delete process.env['LOCALAPPDATA']
      else process.env['LOCALAPPDATA'] = prevLocal
      if (prevXdg === undefined) delete process.env['XDG_DATA_HOME']
      else process.env['XDG_DATA_HOME'] = prevXdg
      _resetDataDirCacheForTesting()
    }
  })

  it('emits an unterminated trailing fence verbatim rather than guessing where it ends', async () => {
    const report = ['Summary.', 'z'.repeat(8100), '```', ...Array.from({ length: 60 }, (_, i) => `dangling ${i}`)].join('\n')
    const result = await runHook(buildEvent('post_tool_use', postPayload(report)))
    expect(result.hookType).toBe('context')
  })

  it('passes through when sessionId is missing, even for an outlier-large report', async () => {
    const largeReport = 'x'.repeat(9000)
    const payload = { tool_name: 'Agent', tool_input: toolInput, tool_response: largeReport }
    const result = await runHook(buildEvent('post_tool_use', payload))
    expect(result.hookType).toBe('pass')
  })

  it('passes through when tool_response is missing or empty', async () => {
    const result = await runHook(buildEvent('post_tool_use', postPayload(undefined)))
    expect(result.hookType).toBe('pass')
  })

  it('passes through non-Agent tool calls unchanged, even with an oversized result', async () => {
    const largeReport = 'x'.repeat(9000)
    const payload = { tool_name: 'Bash', tool_input: { command: 'echo hi' }, session_id: sessionId, tool_response: largeReport }
    const result = await runHook(buildEvent('post_tool_use', payload))
    expect(result.hookType).toBe('pass')
  })
})

// Invariant-based fixture corpus, deliberately NOT a ratio-band suite. A ratio band ("output is
// >=25% smaller") is a wrong-oracle test: it bakes in today's output, so a future correctness fix
// that legitimately lowers the ratio would read as a regression and get "fixed" back into a bug.
// These fixtures instead pin the design rule itself as executable invariants:
//   1. every non-fence (prose) line is byte-identical between input and output;
//   2. an all-prose report produces EXACTLY zero rewrite (equality, not "mostly unchanged");
//   3. the elided-line count printed in every marker equals the real number of dropped lines;
//   4. a report whose only fence is under the min-lines floor collapses to nothing (filtered-to-
//      empty must render as untouched, not as a phantom compaction) -- "empty/filtered store
//      renders as populated" is a documented recurring bug class in this repo.
describe('Fence-collapse invariant corpus (collapseFencedBlocks, direct)', () => {
  const RECALL_HINT = 'token-goat mcp-output mcp_deadbeefdeadbeef --full'
  const MIN_LINES = 20
  const KEEP_LINES = 6

  /** Pull every "PROSE:..." line out of `text`, in order -- these are the non-fence lines a fixture asserts must survive byte-identically. */
  function proseLines(text: string): string[] {
    return text.split('\n').filter((l) => l.startsWith('PROSE:'))
  }

  interface Fixture {
    name: string
    lines: string[]
    /** Expected elided-line count per fenced block, in the order the blocks appear. */
    expectedElided: number[]
  }

  const corpus: Fixture[] = [
    {
      name: 'single long fence between prose',
      lines: [
        'PROSE:intro line one',
        'PROSE:intro line two',
        '```',
        ...Array.from({ length: 50 }, (_, i) => `fence body ${i}`),
        '```',
        'PROSE:not verified: did not re-run the full suite after the falsify cycle',
        'PROSE:trailing note',
      ],
      expectedElided: [50 - KEEP_LINES * 2],
    },
    {
      name: 'two fences with prose before, between, and after',
      lines: [
        'PROSE:a',
        '```',
        ...Array.from({ length: 40 }, (_, i) => `f1-${i}`),
        '```',
        'PROSE:b',
        '```',
        ...Array.from({ length: 45 }, (_, i) => `f2-${i}`),
        '```',
        'PROSE:c',
      ],
      expectedElided: [40 - KEEP_LINES * 2, 45 - KEEP_LINES * 2],
    },
    {
      name: '4-backtick fence containing a nested triple-backtick example, treated as one block',
      lines: [
        'PROSE:x',
        '````',
        ...Array.from({ length: 30 }, (_, i) => `outer-${i}`),
        '```',
        'inner fenced example (content, not prose -- inside the outer fence)',
        '```',
        ...Array.from({ length: 30 }, (_, i) => `outer-tail-${i}`),
        '````',
        'PROSE:y',
      ],
      // Body spans everything between the 4-backtick markers: 30 + 1 + 1 + 1 + 30 = 63 lines.
      expectedElided: [63 - KEEP_LINES * 2],
    },
  ]

  for (const fx of corpus) {
    it(`preserves every prose line byte-identically, in order, with the correct elided count -- ${fx.name}`, () => {
      const input = fx.lines.join('\n')
      const output = collapseFencedBlocks(input, RECALL_HINT, MIN_LINES, KEEP_LINES)
      expect(output).not.toBe(input) // sanity: this fixture must actually trigger a collapse

      // Invariant 1: every non-fence prose line survives byte-identically, in the same order.
      const inputProse = proseLines(input)
      const outputLines = output.split('\n')
      let searchFrom = 0
      for (const line of inputProse) {
        const idx = outputLines.indexOf(line, searchFrom)
        expect(idx).toBeGreaterThanOrEqual(searchFrom) // present, and not out of order
        searchFrom = idx + 1
      }

      // Invariant 3: the elided count in each marker matches the real number of dropped lines.
      const markers = [...output.matchAll(/\[token-goat: (\d+) lines elided/g)].map((m) => Number(m[1]))
      expect(markers).toEqual(fx.expectedElided)
    })
  }

  it('produces EXACTLY zero rewrite for an all-prose report (equality, not a loose "mostly unchanged" band)', () => {
    const allProse = Array.from({ length: 500 }, (_, i) => `PROSE:detailed finding line ${i} with no fenced content at all.`).join('\n')
    const output = collapseFencedBlocks(allProse, RECALL_HINT, MIN_LINES, KEEP_LINES)
    expect(output).toBe(allProse)
  })

  it('collapses to nothing (byte-identical) when the only fence is under the min-lines floor -- a filtered-to-empty result must not render as a phantom compaction', () => {
    const report = ['PROSE:summary.', '```', ...Array.from({ length: 5 }, (_, i) => `file${i}.ts | 2 +-`), '```', 'PROSE:tail note.'].join('\n')
    const output = collapseFencedBlocks(report, RECALL_HINT, MIN_LINES, KEEP_LINES)
    expect(output).toBe(report)
    expect(output).not.toContain('lines elided')
  })

  it('the filtered-to-empty case, driven through the real hook, records neither the compact stat nor the decline stat (nothing was actually rewritten)', async () => {
    const dataRoot = dataDirForHome(tmpHome)
    const envRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
    const prevLocal = process.env['LOCALAPPDATA']
    const prevXdg = process.env['XDG_DATA_HOME']
    process.env['LOCALAPPDATA'] = envRoot
    process.env['XDG_DATA_HOME'] = envRoot
    _resetDataDirCacheForTesting()
    try {
      const toolInput = { prompt: 'Investigate the issue.', description: 'Test agent' }
      const report = ['Summary.', '```', ...Array.from({ length: 5 }, (_, i) => `file${i}.ts | 2 +-`), '```', 'y'.repeat(9000)].join('\n')
      const payload = { tool_name: 'Agent', tool_input: toolInput, session_id: sessionId, tool_response: report }
      const result = await runHook(buildEvent('post_tool_use', payload))
      expect(result.hookType).toBe('context')
      const before = summarize(3650).by_kind
      expect(before['agent_report_compact']?.events ?? 0).toBe(0)
      expect(before['agent_report_compact_declined']?.events ?? 0).toBe(0)
    } finally {
      if (prevLocal === undefined) delete process.env['LOCALAPPDATA']
      else process.env['LOCALAPPDATA'] = prevLocal
      if (prevXdg === undefined) delete process.env['XDG_DATA_HOME']
      else process.env['XDG_DATA_HOME'] = prevXdg
      _resetDataDirCacheForTesting()
    }
  })
})

describe('Intra-report cross-fence dedup (dedupeFencedBlocks, direct)', () => {
  const RECALL_HINT = 'token-goat mcp-output mcp_deadbeefdeadbeef --full'

  it('replaces a LATER byte-identical fenced block with a byte-comparison marker, keeping the first occurrence intact', () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
    const report = ['PROSE:a', '```', body, '```', 'PROSE:b', '```', body, '```', 'PROSE:c'].join('\n')
    const collapsed = collapseFencedBlocks(report, RECALL_HINT, 20, 6) // under min_lines: collapse alone leaves this untouched
    expect(collapsed).toBe(report)
    const deduped = dedupeFencedBlocks(collapsed, report, RECALL_HINT)
    expect(deduped).not.toBe(report)
    // First block survives whole.
    expect(deduped).toContain('line 0')
    expect(deduped).toContain('line 9')
    // Marker is worded as a byte comparison, never as "ran it once" / "same output as before" language, and never addresses "block N" -- mcp-output has no per-block addressing.
    expect(deduped).toContain('[token-goat: identical bytes to an earlier block in this report -- full report via ' + RECALL_HINT + ']')
    expect(deduped).not.toMatch(/block \d/)
    // Only ONE copy of the body text remains (the second was replaced, not merely annotated).
    expect(deduped.split('line 0').length - 1).toBe(1)
    expect(deduped).toContain('PROSE:a')
    expect(deduped).toContain('PROSE:b')
    expect(deduped).toContain('PROSE:c')
  })

  it('does not touch two fenced blocks that differ by even one byte', () => {
    const report = ['```', 'aaa', '```', '```', 'aab', '```'].join('\n')
    const collapsed = collapseFencedBlocks(report, RECALL_HINT, 20, 6)
    const deduped = dedupeFencedBlocks(collapsed, report, RECALL_HINT)
    expect(deduped).toBe(report)
  })

  it('leaves a report with only one fenced block untouched (nothing to dedup against)', () => {
    const report = ['```', 'solo body', '```'].join('\n')
    const deduped = dedupeFencedBlocks(report, report, RECALL_HINT)
    expect(deduped).toBe(report)
  })

  it('dedups a THIRD occurrence against the first as well, not just pairwise-adjacent duplicates', () => {
    const body = 'shared block body\nsecond line'
    const report = ['```', body, '```', 'PROSE', '```', body, '```', 'PROSE', '```', body, '```'].join('\n')
    const deduped = dedupeFencedBlocks(report, report, RECALL_HINT)
    expect(deduped.match(/identical bytes to an earlier block/g)).toHaveLength(2)
    expect(deduped.split('shared block body').length - 1).toBe(1)
  })

  it('runs dedup on the COLLAPSED text but hashes bodies from the ORIGINAL text, so a duplicate whose middle collapseFencedBlocks already elided still gets its marker (proves the mandated ordering: dedup after collapse, hashed pre-collapse)', () => {
    const bigBody = Array.from({ length: 50 }, (_, i) => `dup line ${i}`).join('\n')
    const report = ['PROSE:one', '```', bigBody, '```', 'PROSE:two', '```', bigBody, '```', 'PROSE:three'].join('\n')
    const collapsed = collapseFencedBlocks(report, RECALL_HINT, 20, 6)
    expect(collapsed).not.toBe(report) // collapse DID elide both blocks' middles first
    const deduped = dedupeFencedBlocks(collapsed, report, RECALL_HINT)
    // First (collapsed) block still present with its own elision marker; second block replaced entirely by the dedup marker, not by a second copy of the collapse-elision marker.
    expect(deduped.match(/lines elided --/g)).toHaveLength(1)
    expect(deduped.match(/identical bytes to an earlier block/g)).toHaveLength(1)
  })

  it('is intra-report only: two SEPARATE Agent reports with identical fenced content each get compacted independently, never deduped against each other', async () => {
    const toolInput = { prompt: 'Investigate the issue.', description: 'Test agent' }
    const bigBody = Array.from({ length: 50 }, (_, i) => `shared cross-report line ${i}`).join('\n')
    const report1 = ['Report one.', '```', bigBody, '```', 'x'.repeat(8000)].join('\n')
    const report2 = ['Report two.', '```', bigBody, '```', 'y'.repeat(8000)].join('\n')

    const payload1 = { tool_name: 'Agent', tool_input: toolInput, session_id: sessionId, tool_response: report1 }
    const result1 = await runHook(buildEvent('post_tool_use', payload1))
    expect(result1.hookType).toBe('rewriteOutput')
    if (result1.hookType === 'rewriteOutput') {
      // Report one has no earlier block in ITS OWN report to dedup against -- the fence survives via
      // the ordinary collapse path (elided middle), not the dedup marker.
      expect(result1.updatedOutput).toContain('lines elided --')
      expect(result1.updatedOutput).not.toContain('identical bytes to an earlier block')
    }

    const payload2 = { tool_name: 'Agent', tool_input: toolInput, session_id: sessionId, tool_response: report2 }
    const result2 = await runHook(buildEvent('post_tool_use', payload2))
    expect(result2.hookType).toBe('rewriteOutput')
    if (result2.hookType === 'rewriteOutput') {
      // Report two's identical fence body must ALSO be collapsed on its own merits (elided-middle
      // marker), never silently pointed at report one's cache id -- cross-report dedup is out of scope.
      expect(result2.updatedOutput).toContain('lines elided --')
      expect(result2.updatedOutput).not.toContain('identical bytes to an earlier block')
    }
  })

  it('records exactly one agent_report_compact event (not two) for a report where both collapse and dedup fire, proving the single combined net-benefit gate', async () => {
    const dataRoot = dataDirForHome(tmpHome)
    const envRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
    const prevLocal = process.env['LOCALAPPDATA']
    const prevXdg = process.env['XDG_DATA_HOME']
    process.env['LOCALAPPDATA'] = envRoot
    process.env['XDG_DATA_HOME'] = envRoot
    _resetDataDirCacheForTesting()
    try {
      const bigBody = Array.from({ length: 50 }, (_, i) => `dup line ${i} with some padding to make it worth eliding`).join('\n')
      const toolInput = { prompt: 'Investigate the issue.', description: 'Test agent' }
      const report = ['PROSE one.', '```', bigBody, '```', 'PROSE two.', '```', bigBody, '```', 'PROSE three.', 'z'.repeat(4000)].join('\n')
      const payload = { tool_name: 'Agent', tool_input: toolInput, session_id: sessionId, tool_response: report }
      const before = summarize(3650).by_kind['agent_report_compact']?.events ?? 0
      const result = await runHook(buildEvent('post_tool_use', payload))
      expect(result.hookType).toBe('rewriteOutput')
      if (result.hookType === 'rewriteOutput') {
        expect(result.updatedOutput).toContain('lines elided --')
        expect(result.updatedOutput).toContain('identical bytes to an earlier block')
      }
      const after = summarize(3650).by_kind['agent_report_compact']?.events ?? 0
      expect(after - before).toBe(1)
    } finally {
      if (prevLocal === undefined) delete process.env['LOCALAPPDATA']
      else process.env['LOCALAPPDATA'] = prevLocal
      if (prevXdg === undefined) delete process.env['XDG_DATA_HOME']
      else process.env['XDG_DATA_HOME'] = prevXdg
      _resetDataDirCacheForTesting()
    }
  })

  it('the dedup marker\'s recall pointer resolves to the exact original report bytes, including the deduped block -- lossless recall is the whole point', async () => {
    const bigBody = Array.from({ length: 50 }, (_, i) => `dup line ${i} with some padding to make it worth eliding`).join('\n')
    const toolInput = { prompt: 'Investigate the issue.', description: 'Test agent' }
    const report = ['PROSE one.', '```', bigBody, '```', 'PROSE two.', '```', bigBody, '```', 'PROSE three.', 'z'.repeat(4000)].join('\n')
    const payload = { tool_name: 'Agent', tool_input: toolInput, session_id: sessionId, tool_response: report }
    const result = await runHook(buildEvent('post_tool_use', payload))
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType === 'rewriteOutput') {
      const m = /token-goat mcp-output (mcp_[0-9a-f]{16})/.exec(result.updatedOutput)
      expect(m).not.toBeNull()
      expect(getBashOutput(m![1] as string)?.output).toBe(report)
    }
  })
})

describe('Duplicate-subagent-brief detection (real cross-process load/dispatch/save cycle)', () => {
  it('fires an advisory warning when a near-duplicate prompt is spawned while the original is still outstanding', async () => {
    const original = 'Investigate the failing tests in the payment module and fix the root cause of the failures.'
    const near = 'Investigate the failing tests in the payment module and find the root cause of the failures.'

    const first = await callAgentHook('pre_tool_use', { prompt: original }, sessionId)
    expect(first.hookType).toBe('rewriteInput')

    const second = await callAgentHook('pre_tool_use', { prompt: near }, sessionId)
    expect(second.hookType).toBe('rewriteInput')
    if (second.hookType === 'rewriteInput') {
      const updatedPrompt = second.updatedInput['prompt']
      expect(typeof updatedPrompt).toBe('string')
      expect(updatedPrompt).toContain('already appears to be outstanding')
    }
  })

  it('does not fire the advisory for two genuinely different tasks that merely share some words', async () => {
    const first = 'Fix the login bug in auth.ts where the session token is not refreshed correctly.'
    const second = 'Write documentation for the new API rate limiter feature, including usage examples.'

    const firstResult = await callAgentHook('pre_tool_use', { prompt: first }, sessionId)
    expect(firstResult.hookType).toBe('rewriteInput')

    const secondResult = await callAgentHook('pre_tool_use', { prompt: second }, sessionId)
    expect(secondResult.hookType).toBe('rewriteInput')
    if (secondResult.hookType === 'rewriteInput') {
      const updatedPrompt = secondResult.updatedInput['prompt']
      expect(typeof updatedPrompt).toBe('string')
      expect(updatedPrompt).not.toContain('already appears to be outstanding')
    }
  })

  it('does not fire once the original spawn has completed (post-hook cleared its outstanding entry)', async () => {
    const original = 'Refactor the billing service to use the new retry queue instead of polling.'

    const preResult = await callAgentHook('pre_tool_use', { prompt: original }, sessionId)
    expect(preResult.hookType).toBe('rewriteInput')
    const spawnedInput = preResult.hookType === 'rewriteInput' ? preResult.updatedInput : { prompt: original }

    // Complete the spawn via the real registered post-hook, using the actual (briefing-appended)
    // tool_input Claude Code would have sent, with a small (non-cacheable) report.
    const postResult = await callAgentHook('post_tool_use', spawnedInput, sessionId, 'Done. Small report.')
    expect(postResult.hookType).toBe('pass')

    // A near-duplicate prompt fired again after completion must not be flagged.
    const again = await callAgentHook('pre_tool_use', { prompt: original }, sessionId)
    expect(again.hookType).toBe('rewriteInput')
    if (again.hookType === 'rewriteInput') {
      const updatedPrompt = again.updatedInput['prompt']
      expect(typeof updatedPrompt).toBe('string')
      expect(updatedPrompt).not.toContain('already appears to be outstanding')
    }
  })

  it('is session-scoped: the same prompt under a different sessionId does not cross-flag', async () => {
    const prompt = 'Audit the checkout flow for accessibility issues and report findings.'
    const otherSessionId = `agent-other-${sessionId}`

    const inFirstSession = await callAgentHook('pre_tool_use', { prompt }, sessionId)
    expect(inFirstSession.hookType).toBe('rewriteInput')

    const inOtherSession = await callAgentHook('pre_tool_use', { prompt }, otherSessionId)
    expect(inOtherSession.hookType).toBe('rewriteInput')
    if (inOtherSession.hookType === 'rewriteInput') {
      const updatedPrompt = inOtherSession.updatedInput['prompt']
      expect(typeof updatedPrompt).toBe('string')
      expect(updatedPrompt).not.toContain('already appears to be outstanding')
    }
  })

  it('bounds the tracked outstanding-spawn set: spawning many distinct prompts in one session never exceeds the cap', async () => {
    const extra = 10
    for (let i = 0; i < MAX_OUTSTANDING_AGENT_SPAWNS + extra; i++) {
      const result = await callAgentHook('pre_tool_use', { prompt: `Distinct standalone task number ${i} about topic ${i}.` }, sessionId)
      expect(result.hookType).toBe('rewriteInput')
    }

    loadSessionState(sessionId)
    expect(getOutstandingAgentSpawns().length).toBeLessThanOrEqual(MAX_OUTSTANDING_AGENT_SPAWNS)
  })
})
