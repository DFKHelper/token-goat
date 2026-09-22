/**
 * post_compact measurement handler (src/hooks_compact.ts postCompactHandler).
 *
 * Compaction summaries were the one large thing token-goat could not see: every other number in `stats` came from a tool call a hook intercepted, and a summary arrives through none of them. Claude Code's PostCompact event hands the finished summary to a hook verbatim -- confirmed by reading the installed binary, whose hook-input schema declares `{hook_event_name: "PostCompact", trigger, compact_summary}` -- so this handler counts it.
 *
 * It also doubles as the canary for the undocumented channel preCompactHandler depends on. The manifest reaches the summarizing model as a PreCompact hook's raw stdout, which Claude Code's own hooks reference describes as going to a debug log. If that stops working it stops silently: the hook still succeeds, the manifest is still built, nothing fails. Counting how many manifest paths survive into the summary is what makes the failure visible.
 *
 * The assertions below therefore pin three separate things, because each has its own way of going quietly wrong: that a row is recorded at all, that it is recorded at ZERO savings (a measurement credited as a saving is this project's most-repeated accounting bug), and that the survival count actually discriminates -- a counter that always reports 0/0, or always reports every path as surviving, would pass a test that only checked the row exists.
 */
import { join, parse, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { dataDir } from '../src/constants.js'
import { getDb } from '../src/db.js'
import type { HookEvent } from '../src/hook_registry.js'
import { postCompactHandler } from '../src/hooks_compact.js'
import { buildManifest, manifestPrintedPaths } from '../src/manifest.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordFileEdit, recordFileRead } from '../src/session.js'
import { isCaseInsensitiveFs } from '../src/util.js'

// A project-shaped absolute path, not a real file under the OS temp directory. The manifest drops noise paths before its row cap and every OS temp root is on that list, so a fixture written there is filtered out of the very rows the survival canary samples. Nothing here reads the bytes: the row renderer stats the path for a size and floors it at 1kb, so an absent file renders exactly as a small real one would.
const FIXTURE_ROOT = `${parse(tmpdir()).root.split(sep).join('/')}tg-postcompact-project`
let fixtureSeq = 0

function makeTmpFile(name: string): string {
  fixtureSeq += 1
  return `${FIXTURE_ROOT}/run-${fixtureSeq}/${name}`
}

function postCompactEvent(summary: string, trigger = 'auto', sessionId = 'postcompact-test'): HookEvent {
  return {
    eventName: 'post_compact',
    toolName: undefined,
    toolInput: {},
    sessionId,
    agentId: undefined,
    raw: { session_id: sessionId, trigger, compact_summary: summary },
  }
}

/** Newest `compact_summary` row straight out of the isolated global stats DB, detail included -- summarize() aggregates and drops `detail`, which is where every number this handler records lives. */
function latestCompactSummaryRow(): { bytes_saved: number; tokens_saved: number; detail: string } | undefined {
  const db = getDb(join(dataDir(), 'global.db'))
  const rows = db
    .prepare("SELECT bytes_saved, tokens_saved, detail FROM stats WHERE kind = 'compact_summary' ORDER BY rowid DESC LIMIT 1")
    .all() as Array<{ bytes_saved: number; tokens_saved: number; detail: string }>
  return rows[0]
}

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  clearModuleCaches()
})

// HAND-DERIVED: 64 read files is computed from the two caps that disagreed, not read off either -- the survival sample asks for 64 paths while buildManifest prints at most 40 rows per section, so a session at or above the sample size exhausts the walk inside the read-files list. The assertion is the invariant rather than a count: every sampled path must be one the manifest actually printed, because a path the model was never shown cannot be judged to have survived. Checked against buildManifest's real output rather than against the cap constant, so the two cannot drift apart again silently.
describe('manifestPrintedPaths', () => {
  it('samples only paths the manifest actually prints, including from the sections after the first', () => {
    for (let i = 0; i < 45; i++) recordFileRead(`${FIXTURE_ROOT}/printed/read-${i}.ts`)
    recordFileEdit(`${FIXTURE_ROOT}/printed/edited-one.ts`)
    const manifest = buildManifest(undefined)
    const sampled = manifestPrintedPaths(undefined, 64)
    expect(sampled.length).toBeGreaterThan(0)
    const unprinted = sampled.filter((p) => !manifest.includes(parse(p).base))
    expect(unprinted, 'the canary must not sample rows the manifest never printed').toEqual([])
    // 45 read files is past both the section's own 40-row cap and the manifest's 1600-char budget, which is the case that used to lose the edited row entirely. Asserted against the manifest text rather than assumed, so this cannot start passing vacuously if the edited section stops being emitted.
    expect(manifest, 'an edited file must survive a read list that overflows the char budget').toContain('edited-one.ts')
    expect(sampled.some((p) => p.endsWith('edited-one.ts')), 'an edited file must be reachable past a full read section').toBe(true)
  })
})

describe('postCompactHandler', () => {
  it('returns pass, because a PostCompact hook has no context channel to write to', () => {
    // Claude Code's PostCompact runner (read from claude.exe 2.1.240) builds its return value from `userDisplayMessage` alone -- a line echoed to the user's terminal. Anything emitted here would be noise in front of a person, never context for a model.
    expect(postCompactHandler(postCompactEvent('a summary'))).toEqual({ hookType: 'pass' })
  })

  it('records the summary size and its token estimate', () => {
    const summary = 'x'.repeat(4000)
    postCompactHandler(postCompactEvent(summary))
    const row = latestCompactSummaryRow()
    expect(row).toBeDefined()
    expect(row?.detail).toContain('bytes=4000')
    expect(row?.detail).toMatch(/est_tokens=\d+/)
    const estimated = Number(/est_tokens=(\d+)/.exec(row?.detail ?? '')?.[1])
    expect(estimated).toBeGreaterThan(0)
    expect(estimated).toBeLessThan(4000)
  })

  it('records the trigger, so an auto compaction can be told from a manual one', () => {
    postCompactHandler(postCompactEvent('summary text', 'manual'))
    expect(latestCompactSummaryRow()?.detail).toContain('trigger=manual')
  })

  it('records zero bytes and zero tokens saved, because measuring a summary saves nothing', () => {
    // The summary was written whether or not token-goat was watching. Crediting its size as a saving would add roughly 21 KB per compaction to a total that is supposed to mean "tokens that did not reach the model because of token-goat".
    postCompactHandler(postCompactEvent('y'.repeat(9000)))
    const row = latestCompactSummaryRow()
    expect(row?.bytes_saved).toBe(0)
    expect(row?.tokens_saved).toBe(0)
  })

  it('counts the manifest paths that survived into the summary, matching the exact spelling the manifest used', () => {
    const kept = makeTmpFile('kept-by-the-summary.ts')
    const dropped = makeTmpFile('dropped-by-the-summary.ts')
    recordFileRead(kept)
    recordFileEdit(dropped)

    // Take the path spelling out of the real manifest rather than re-deriving it here. The two must agree on normalization (case folding, separators, the folded ~ form) or the survival count silently reads zero forever: the summary would quote what the manifest printed while the handler looked for something else. Re-implementing foldPath in the test would assert the handler agrees with the test, not that it agrees with the manifest.
    const manifest = buildManifest()
    const keptAsPrinted = manifest
      .split('\n')
      .map((line) => /^- (\S+)/.exec(line)?.[1])
      .find((p) => p !== undefined && p.endsWith('kept-by-the-summary.ts'))
    expect(keptAsPrinted, `no kept row in manifest:\n${manifest}`).toBeDefined()

    // A summary that quotes one of the two paths verbatim and paraphrases the other away.
    postCompactHandler(postCompactEvent(`The session worked on ${keptAsPrinted} and some other file.`))

    expect(latestCompactSummaryRow()?.detail).toContain('manifest_paths=1/2')
  })

  it('still counts a path the summary reproduced with different capitalization, on a filesystem where that is the same file', () => {
    // The first version of this handler folded the needle but not the haystack, so on Windows it compared a lowercased path against the manifest's real spelling and matched nothing -- reporting "channel dead" on every single compaction, which is exactly the false alarm a canary must not raise. Both sides are folded now, and only where the filesystem says case does not distinguish two files.
    recordFileRead(makeTmpFile('MixedCaseName.ts'))
    // Uppercase the manifest's own spelling rather than the raw temp path: session state stores paths with forward slashes, so uppercasing the raw path would change the separators too and this would end up testing separator handling under a case-drift name.
    const asPrinted = buildManifest()
      .split('\n')
      .map((line) => /^- (\S+)/.exec(line)?.[1])
      .find((v) => v !== undefined && v.endsWith('MixedCaseName.ts'))
    expect(asPrinted).toBeDefined()
    postCompactHandler(postCompactEvent(`The session read ${(asPrinted ?? '').toUpperCase()} at some point.`))
    const detail = latestCompactSummaryRow()?.detail ?? ''
    expect(detail).toContain(isCaseInsensitiveFs() ? 'manifest_paths=1/1' : 'manifest_paths=0/1')
  })

  it('counts a path the summary rewrote relative to the project root, which is how real summaries name files', () => {
    // CAPTURE: 322 recorded compaction summaries of one project named its files as `src/...` and `tests/...` and never by the absolute path the manifest printed; matching the absolute form alone recorded 0/64 on every one of them.
    const root = `${FIXTURE_ROOT}/relative-root`
    recordFileRead(`${root}/src/relative-in-summary.ts`)
    const event = postCompactEvent('Edited `src/relative-in-summary.ts` and moved on.')

    postCompactHandler({ ...event, raw: { ...event.raw, cwd: root } })
    expect(latestCompactSummaryRow()?.detail).toContain('manifest_paths=1/1')

    // Control: from a directory the file is not under, the relative spelling is not this file, so nothing survives.
    postCompactHandler({ ...event, raw: { ...event.raw, cwd: `${FIXTURE_ROOT}/elsewhere` } })
    expect(latestCompactSummaryRow()?.detail).toContain('manifest_paths=0/1')
  })

  it('reports zero survivors when the summary paraphrases every path away, which is the signal the channel died', () => {
    recordFileRead(makeTmpFile('alpha.ts'))
    recordFileRead(makeTmpFile('beta.ts'))
    postCompactHandler(postCompactEvent('The user asked about some source files and we discussed them.'))
    expect(latestCompactSummaryRow()?.detail).toContain('manifest_paths=0/2')
  })

  it('reports 0/0 rather than crashing when the session touched no files at all', () => {
    postCompactHandler(postCompactEvent('a summary of a session that read nothing'))
    expect(latestCompactSummaryRow()?.detail).toContain('manifest_paths=0/0')
  })

  it('treats a missing or non-string compact_summary as empty instead of throwing', () => {
    // A harness that fires post_compact without the field, or with a null, must not break the hook -- the relay would swallow the throw and the row would simply never appear, which is the invisible-failure shape this handler exists to prevent elsewhere.
    const event: HookEvent = {
      eventName: 'post_compact',
      toolName: undefined,
      toolInput: {},
      sessionId: 'postcompact-missing-field',
      agentId: undefined,
      raw: { session_id: 'postcompact-missing-field', trigger: 'auto' },
    }
    expect(postCompactHandler(event)).toEqual({ hookType: 'pass' })
    expect(latestCompactSummaryRow()?.detail).toContain('bytes=0')
  })

  it('caps how many paths it samples, so a session with hundreds of files does not scan the summary hundreds of times', () => {
    // Deliberately more files than any cap in the path. This used to assert the total was exactly MANIFEST_SURVIVAL_SAMPLE (64), a number read off the constant rather than off the output -- so it passed while the sample included 24 rows the manifest never printed, and the denominator of a survival ratio counted content the model was never given. The bound that matters is the printed one: the total must not exceed the sample cap, and every path in it must be a row buildManifest really emitted.
    for (let i = 0; i < 96; i++) {
      recordFileRead(makeTmpFile(`sampled-${i}.ts`))
    }
    const printedRows = buildManifest().split('\n').filter((l) => /^- \S/.test(l)).length
    postCompactHandler(postCompactEvent('a summary naming nothing in particular'))
    const detail = latestCompactSummaryRow()?.detail ?? ''
    const total = Number(/manifest_paths=\d+\/(\d+)/.exec(detail)?.[1])
    expect(total, 'the sample must stay bounded, or a large session rescans the summary hundreds of times').toBeLessThanOrEqual(64)
    expect(total, 'and must not exceed what the manifest actually printed').toBeLessThanOrEqual(printedRows)
    expect(total, 'while still sampling enough to discriminate').toBeGreaterThan(10)
  })
})
