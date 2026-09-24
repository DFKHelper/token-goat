/** A Bash result the harness persisted to disk is not "served" (hooks_bash.ts `maybeCollapseIdenticalRead`, `maybeElideServedGenericOutput`). Past 20,000 bytes Claude Code writes the output to `tool-results/` and shows the model a 2 KB `<persisted-output>` preview. Both served-output stores recorded that output as delivered anyway, so the next overlapping read came back as `[token-goat] N lines here were already served verbatim in this session; withheld here`, pointing at lines the model never saw. The pointer it offered, `bash-output <id> --full`, returns a body over the same threshold, which the harness persists and previews again. Seen in a real session: a 20 KB `awk` read of a skill file came back as a preview, the next `awk` read of lines inside it came back withheld, and the agent had to change its print format to get the lines through. Fixture provenance: - The PostToolUse payload with `persistedOutputPath`/`persistedOutputSize` and a 20,000-char `stdout` head is FORMAT-DERIVED from the capture recorded in `src/delivery_cap.ts` and memory project_persisted_bash_output_hook_sees_20k_head_model_sees_2kb.md (Claude Code 2.1.276, 41-43 KB outputs). - The line bodies are HAND-DERIVED: distinguishable lines sized so 400 of them cross the 20,000-byte persistence threshold and 43 of them do not. - The file-read commands name a real repo file because the read extractors exempt temp paths, the same constraint bash_served_line_elision.test.ts records. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { postBashHandler, preBashHandler } from '../src/hooks_bash.js'
import { clearModuleCaches } from '../src/reset.js'
import { getFileLineRanges, wasFileReadThisSession } from '../src/session.js'
import { projectTranscriptsDir } from '../src/waste.js'
import { makeHookEvent } from './helpers/hook-event.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SESSION_ID = 'persisted-served-session'

function row(prefix: string, n: number): string {
  return `${prefix} ${n}: ${'x'.repeat(60)}`
}

function rows(prefix: string, lo: number, hi: number): string {
  const out: string[] = []
  for (let n = lo; n <= hi; n++) out.push(row(prefix, n))
  return out.join('\n')
}

let fakeHome: string
let toolResultsDir: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  clearModuleCaches()
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-persisted-served-'))
  for (const key of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR']) saved[key] = process.env[key]
  process.env['HOME'] = fakeHome
  process.env['USERPROFILE'] = fakeHome
  process.env['CLAUDE_CONFIG_DIR'] = path.join(fakeHome, '.claude')
  toolResultsDir = path.join(projectTranscriptsDir(REPO), SESSION_ID, 'tool-results')
  fs.mkdirSync(toolResultsDir, { recursive: true })
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(fakeHome, { recursive: true, force: true })
})

/** What the harness sends for a result it persisted: the full text on disk, a 20,000-char head inline. */
function persistedEvent(command: string, output: string) {
  const file = path.join(toolResultsDir, `b${Math.abs(command.length * 7919 + output.length)}.txt`)
  fs.writeFileSync(file, output)
  const toolResponse = { stdout: output.slice(0, 20_000), exitCode: 0, persistedOutputPath: file, persistedOutputSize: Buffer.byteLength(output, 'utf-8') }
  return makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId: SESSION_ID, raw: { cwd: REPO, tool_name: 'Bash', tool_input: { command }, tool_response: toolResponse } })
}

function inlineEvent(command: string, output: string) {
  return makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId: SESSION_ID, raw: { cwd: REPO, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: output, exitCode: 0 } } })
}

describe('a persisted Bash result is not recorded as served', () => {
  it('ships a later file read in full when the read containing it was persisted', async () => {
    const wide = rows('line', 1, 400)
    expect(Buffer.byteLength(wide, 'utf-8')).toBeGreaterThan(20_000)
    await postBashHandler(persistedEvent("sed -n '1,400p' LICENSE", wide))

    const narrow = rows('line', 208, 250)
    const out = await postBashHandler(inlineEvent("sed -n '208,250p' LICENSE", narrow))
    expect(out.hookType).not.toBe('rewriteOutput')
  })

  it('ships a later overlapping command in full when the earlier output was persisted', async () => {
    await postBashHandler(persistedEvent('some-report-tool --stage build', rows('record', 1, 400)))

    const out = await postBashHandler(inlineEvent('some-report-tool --stage deploy', rows('record', 200, 260)))
    expect(out.hookType).not.toBe('rewriteOutput')
  })

  it('still withholds against an earlier read the model received whole', async () => {
    // Control: the same pair with the first read under the threshold, so a pass above is the persisted flag's doing and not a read this path never withholds.
    await postBashHandler(inlineEvent("sed -n '180,260p' LICENSE", rows('line', 180, 260)))

    const out = await postBashHandler(inlineEvent("sed -n '208,250p' LICENSE", rows('line', 208, 250)))
    expect(out.hookType).toBe('rewriteOutput')
  })
})

function preEvent(command: string) {
  return makeHookEvent({ toolName: 'Bash', toolInput: { command }, sessionId: SESSION_ID, raw: { cwd: REPO, tool_name: 'Bash', tool_input: { command } } })
}

const LICENSE = path.join(REPO, 'LICENSE')

// What these assert is the session record a later Read consults: the recorded line ranges back its "Lines A..B was already read this session" refusal, and a recorded whole-file read backs its "already read" ones.
describe('a persisted Bash read does not count as a read of the lines in it', () => {
  // The pre-hook records a line-range read before the output exists, so the post-hook is the first place that knows the model got a preview.
  it('takes back the line range the pre-hook recorded when the read was persisted', async () => {
    preBashHandler(preEvent("sed -n '1,400p' LICENSE"))
    await postBashHandler(persistedEvent("sed -n '1,400p' LICENSE", rows('line', 1, 400)))
    expect(getFileLineRanges(LICENSE)).toEqual([])
  })

  it('keeps the line range of a read delivered whole', async () => {
    // Control: the same pair inline, so an empty list above is the persisted flag's doing and not a range the pre-hook never recorded.
    preBashHandler(preEvent("sed -n '180,260p' LICENSE"))
    await postBashHandler(inlineEvent("sed -n '180,260p' LICENSE", rows('line', 180, 260)))
    expect(getFileLineRanges(LICENSE)).toEqual([[180, 260]])
  })

  it('records no whole-file read for a persisted cat, and does for an inline one', async () => {
    // A source file, since the whole-file extractor recognises a file by its extension and LICENSE has none.
    const source = path.join(REPO, 'src', 'env.ts')
    await postBashHandler(persistedEvent('cat src/env.ts', rows('line', 1, 400)))
    expect(wasFileReadThisSession(source)).toBe(false)
    await postBashHandler(inlineEvent('cat src/env.ts', rows('line', 1, 60)))
    expect(wasFileReadThisSession(source)).toBe(true)
  })
})
