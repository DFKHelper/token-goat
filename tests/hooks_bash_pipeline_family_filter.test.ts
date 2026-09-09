// A compound command is never wrapped by the pre-hook -- correctly, since its shell operators would
// break the `compress -c` argument -- so it arrives at the post hook, where the bytes are already
// captured and no shell is involved. Until pipelineShapeFilter existed, every one of those got
// `filterByName('generic')` no matter what produced it. Measured on real commands in this repo, a
// family filter cuts 40-91% more than generic on the same bytes, so the pre-hook's decline was
// landing here as generic-only compression across the largest tool surface there is.
//
// What these tests pin is SELECTION, and specifically that it stays narrow. Handing a family filter
// input it was not written for is the over-collapse failure mode, where dropping the lines you
// needed improves the ratio and so reads as a better result -- which is why the ratio assertions
// below are paired with a must-not-drop line in every case.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { HookEvent } from '../src/hook_registry.js'

vi.mock('../src/stats.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  const real = original['recordStat'] as (...args: unknown[]) => void
  return { ...original, recordStat: vi.fn((...args: unknown[]) => real(...args)) }
})

import { postBashHandler } from '../src/hooks_bash.js'
import { recordStat } from '../src/stats.js'
import { makeHookEvent } from './helpers/hook-event.js'

// PROVENANCE: CAPTURE. The line shape is real `grep -rn "export function" src/util.ts` output run in
// this repository on 2026-09-08 (`29:export function sleepSync(ms: number): void {`, 62 lines). The
// path prefix and the repetition are synthetic so the body clears the compression floor; the FORMAT
// -- `path:lineno:text` with no colour codes -- is the captured part, and it is the part the grep
// filter matches on. Reading that format off the filter's own regex would prove only that the filter
// agrees with itself.
const GREP_LINES = Array.from(
  { length: 400 },
  (_v, i) => `src/util.ts:${i + 1}:export function helper${i}(ms: number): void {`,
).join('\n')

function makePostBashEvent(command: string, output: string): HookEvent {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: `pipeline-filter-${Math.random().toString(36).slice(2)}`,
    agentId: undefined,
    raw: { tool_name: 'Bash', tool_input: { command }, tool_response: output },
  })
}

/** The filter names every `bash_compress:<name>` stat call recorded, in order. */
function compressFilters(): string[] {
  const calls = (recordStat as unknown as { mock: { calls: unknown[][] } }).mock.calls
  return calls
    .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
    .filter((k) => k.startsWith('bash_compress:'))
    .map((k) => k.slice('bash_compress:'.length))
}

async function runAndGetBody(command: string, output: string = GREP_LINES): Promise<string> {
  const result = await postBashHandler(makePostBashEvent(command, output))
  expect(result.hookType, `${command} must be rewritten`).toBe('rewriteOutput')
  return result.hookType === 'rewriteOutput' ? result.updatedOutput : ''
}

let savedHarnessOverride: string | undefined

describe('post-hook filter selection for a piped command', () => {
  beforeEach(() => {
    ;(recordStat as unknown as { mockClear: () => void }).mockClear()
    savedHarnessOverride = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
  })
  afterEach(() => {
    if (savedHarnessOverride === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedHarnessOverride
  })

  it('uses the first stage’s family filter when every downstream stage only passes bytes through', async () => {
    const body = await runAndGetBody('grep -rn "export function" src | head -200')
    expect(compressFilters(), 'a pass-through pipeline must not fall back to generic').toContain('grep')
    expect(compressFilters()).not.toContain('generic')
    // The grep filter summarises matches rather than listing them, which is its shipped behaviour for
    // a bare grep too. So the anchor is not a matched line but the caller's route back to one: the file
    // that matched and how many times. A body that lost those would be a count of nothing.
    expect(body, 'must still name the file that matched').toContain('src/util.ts')
    expect(body, 'must still carry the match count').toContain('400')
  })

  it('selects the family filter through a `2>&1 | tail` pipeline rather than shearing on the redirect', async () => {
    // `2>&1` contains an `&`, which the shared segment splitter treats as an operator, so this
    // spelling split into a bare-digit remnant that read as an unknown stage and fell back to
    // generic. The redirect is stripped before the split now, the same way the line-range
    // extractor already handles it for the same splitter.
    await runAndGetBody('grep -rn "export function" src 2>&1 | tail -200')
    expect(compressFilters(), 'a trailing 2>&1 must not shear the segment walk').toContain('grep')
    expect(compressFilters()).not.toContain('generic')
  })

  // NOT COVERED, deliberately, and measured rather than assumed: a piped TEST or BUILD run (`npx
  // vitest run 2>&1 | tail -40`) never reaches maybeCompressCompoundOutput at all, because
  // postBashHandler routes it by `isBuildCommand` into the cache branch first. Per command the
  // gap looks worth closing -- the vitest filter takes 13,738 bytes to 168, keeping the failure
  // pointer and both verdict lines, where generic leaves 6,685. The pool is what kills it: across
  // 229,200 real Bash calls, piped build commands are 331 calls and 0.15 MB, against 19.24 MB for
  // the pass-through pipelines this file does cover. A ratio that good on a pool that small buys
  // nothing, so the branch boundary stays where it is.

  it('keeps the generic filter when a downstream stage can reshape the bytes', async () => {
    // `sort` is deliberately absent from PIPELINE_PASSTHROUGH_HEADS: it reorders, and `sort -u`
    // removes. The first stage no longer describes what reached the model, so the family filter
    // for it is the wrong answer even though `grep` is right there in the command.
    await runAndGetBody('grep -rn "export function" src | sort')
    expect(compressFilters(), 'a reshaping stage must fall back').toContain('generic')
    expect(compressFilters()).not.toContain('grep')
  })

  it('keeps the generic filter for a chain, whose output is several commands concatenated', async () => {
    await runAndGetBody('grep -rn "export function" src && echo done')
    expect(compressFilters(), 'a && chain must fall back').toContain('generic')
    expect(compressFilters()).not.toContain('grep')
  })

  it('compresses a pass-through pipeline strictly harder than the generic path it replaces', async () => {
    const family = await runAndGetBody('grep -rn "export function" src | head -200')
    ;(recordStat as unknown as { mockClear: () => void }).mockClear()
    const generic = await runAndGetBody('grep -rn "export function" src | sort')
    // A ratio floor on its own is not a guard -- over-collapsing improves it -- so the survival
    // anchor is asserted on the smaller body, which is the one with something to prove.
    expect(family.length, 'the family filter must beat generic on identical bytes').toBeLessThan(generic.length)
    expect(family, 'and must still name where the matches are').toContain('src/util.ts')
  })
})
