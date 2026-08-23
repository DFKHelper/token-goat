/**
 * post_compact measurement handler (src/hooks_compact.ts postCompactHandler).
 *
 * Compaction summaries were the one large thing token-goat could not see: every other number in
 * `stats` came from a tool call a hook intercepted, and a summary arrives through none of them.
 * Claude Code's PostCompact event hands the finished summary to a hook verbatim -- confirmed by
 * reading the installed binary, whose hook-input schema declares
 * `{hook_event_name: "PostCompact", trigger, compact_summary}` -- so this handler counts it.
 *
 * It also doubles as the canary for the undocumented channel preCompactHandler depends on. The
 * manifest reaches the summarizing model as a PreCompact hook's raw stdout, which Claude Code's
 * own hooks reference describes as going to a debug log. If that stops working it stops silently:
 * the hook still succeeds, the manifest is still built, nothing fails. Counting how many manifest
 * paths survive into the summary is what makes the failure visible.
 *
 * The assertions below therefore pin three separate things, because each has its own way of going
 * quietly wrong: that a row is recorded at all, that it is recorded at ZERO savings (a measurement
 * credited as a saving is this project's most-repeated accounting bug), and that the survival
 * count actually discriminates -- a counter that always reports 0/0, or always reports every path
 * as surviving, would pass a test that only checked the row exists.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { dataDir } from '../src/constants.js'
import { getDb } from '../src/db.js'
import type { HookEvent } from '../src/hook_registry.js'
import { buildManifest, postCompactHandler } from '../src/hooks_compact.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordFileEdit, recordFileRead } from '../src/session.js'
import { isCaseInsensitiveFs } from '../src/util.js'

const tmpDirs: string[] = []

function makeTmpFile(name: string, content = 'data'): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-postcompact-'))
  tmpDirs.push(dir)
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
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
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()
    if (d === undefined) continue
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

describe('postCompactHandler', () => {
  it('returns pass, because a PostCompact hook has no context channel to write to', () => {
    // Claude Code's PostCompact runner (read from claude.exe 2.1.240) builds its return value from
    // `userDisplayMessage` alone -- a line echoed to the user's terminal. Anything emitted here
    // would be noise in front of a person, never context for a model.
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
    // The summary was written whether or not token-goat was watching. Crediting its size as a
    // saving would add roughly 21 KB per compaction to a total that is supposed to mean "tokens
    // that did not reach the model because of token-goat".
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

    // Take the path spelling out of the real manifest rather than re-deriving it here. The two
    // must agree on normalization (case folding, separators, the folded ~ form) or the survival
    // count silently reads zero forever: the summary would quote what the manifest printed while
    // the handler looked for something else. Re-implementing foldPath in the test would assert
    // the handler agrees with the test, not that it agrees with the manifest.
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
    // The first version of this handler folded the needle but not the haystack, so on Windows it
    // compared a lowercased path against the manifest's real spelling and matched nothing --
    // reporting "channel dead" on every single compaction, which is exactly the false alarm a
    // canary must not raise. Both sides are folded now, and only where the filesystem says case
    // does not distinguish two files.
    recordFileRead(makeTmpFile('MixedCaseName.ts'))
    // Uppercase the manifest's own spelling rather than the raw temp path: session state stores
    // paths with forward slashes, so uppercasing the raw path would change the separators too and
    // this would end up testing separator handling under a case-drift name.
    const asPrinted = buildManifest()
      .split('\n')
      .map((line) => /^- (\S+)/.exec(line)?.[1])
      .find((v) => v !== undefined && v.endsWith('MixedCaseName.ts'))
    expect(asPrinted).toBeDefined()
    postCompactHandler(postCompactEvent(`The session read ${(asPrinted ?? '').toUpperCase()} at some point.`))
    const detail = latestCompactSummaryRow()?.detail ?? ''
    expect(detail).toContain(isCaseInsensitiveFs() ? 'manifest_paths=1/1' : 'manifest_paths=0/1')
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
    // A harness that fires post_compact without the field, or with a null, must not break the
    // hook -- the relay would swallow the throw and the row would simply never appear, which is
    // the invisible-failure shape this handler exists to prevent elsewhere.
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
    for (let i = 0; i < 40; i++) {
      recordFileRead(makeTmpFile(`sampled-${i}.ts`))
    }
    postCompactHandler(postCompactEvent('a summary naming nothing in particular'))
    const detail = latestCompactSummaryRow()?.detail ?? ''
    const total = Number(/manifest_paths=\d+\/(\d+)/.exec(detail)?.[1])
    expect(total).toBe(12)
  })
})
