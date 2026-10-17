import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { installCopilotHooksFile, HOOKS_SCRIPT_FILE } from '../src/bridges/copilot_cli_install.js'
import { copilotCapture } from './fixtures/copilot_cli_1_0_88.js'
import { BUNDLE } from './helpers/bundle.js'

/** A long subagent report reaches the parent in full on Copilot CLI unless it is rewritten where Copilot honors a rewrite. Copilot's subagentStop hook carries the subagent's answer as `response` and takes `modifiedResponse` in reply, and that replaces the answer in the parent's task result and in the model request built from it. token-goat forwarded neither: the shim dropped `response`, so the subagent_stop handlers saw an empty report, and it answered every subagentStop with `{"decision":"allow"}`. PROVENANCE: CAPTURE. The payloads are tests/fixtures/copilot_cli_1_0_88/C4a-013-subagentStop.json, C4c-011-subagentStop.json and C4a-014-postToolUse-task.json (from %TEMP%/tg-captures/C4a/raw/013-subagentStop.json, C4c/raw/011-subagentStop.json and C4a/raw/014-postToolUse-task.json, Copilot CLI 1.0.88). C4a's marker hook answered subagentStop with `{"modifiedResponse": "TGCAP-C4-SSTOP-MR-7a3b#N ..."}` (C4a/responses/subagentStop.json), and C4a-014 shows the parent's task toolResult holding exactly that text, not the subagent's answer. C4c returned nothing and its task result (C4c-012) is the answer unchanged. The long report that replaces the captured `response` in the compaction cases is HAND-DERIVED: a fenced block long enough to collapse plus prose above the min_bytes floor, the shape the post-tool report tests in tests/hooks_agent_spawn.test.ts use. */

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

function mkTemp(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

/** Runs the shim the real installer wrote, the way Copilot runs it: `node <shim> <event> <token-goat entry>`, payload on stdin, pointed at the built bundle. */
function runInstalledShim(event: string, payload: unknown, cwd: string, env: Record<string, string> = {}): Record<string, unknown> {
  const dir = mkTemp('tg-subagent-stop-hooks-')
  installCopilotHooksFile(dir, 'copilot')
  const res = spawnSync(process.execPath, [path.join(dir, HOOKS_SCRIPT_FILE), event, BUNDLE], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, ...env },
  })
  expect(res.status, res.stderr).toBe(0)
  return JSON.parse(res.stdout) as Record<string, unknown>
}

function runBundle(args: string[], cwd: string): string {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env } })
  expect(res.status, res.stderr).toBe(0)
  return res.stdout
}

const CAVEAT = 'Not verified: I did not re-run the suite after the last edit.'

/** HAND-DERIVED long report: a 60-line fenced block (collapsible) and prose past the 8000-byte floor. */
function longReport(): string {
  return ['Here is what I found.', '```', ...Array.from({ length: 60 }, (_, i) => `gate output line ${i}`), '```', CAVEAT, 'x'.repeat(8000)].join('\n')
}

/** C4a-013 with a fresh session id (so no other case's cache or ledger is shared) and, when given, a different `response`. */
function stopPayload(proj: string, response?: string): Record<string, unknown> {
  const payload = copilotCapture('C4a-013-subagentStop', { proj })
  payload['sessionId'] = `subagent-stop-${Math.random().toString(36).slice(2)}`
  if (response !== undefined) payload['response'] = response
  return payload
}

describe('Copilot CLI subagentStop modifiedResponse (CAPTURE C4a, C4c)', () => {
  it('replaces a long report with the compacted one through modifiedResponse, and the cached copy is the full report', () => {
    const proj = mkTemp('tg-subagent-stop-ws-')
    const report = longReport()
    const out = runInstalledShim('subagentStop', stopPayload(proj, report), proj)
    expect(Object.keys(out)).toEqual(['modifiedResponse'])
    const text = out['modifiedResponse'] as string
    expect(text).toContain('Here is what I found.')
    expect(text).toContain(CAVEAT)
    expect(text).toContain('gate output line 0')
    expect(text).toContain('gate output line 59')
    expect(text).not.toContain('gate output line 30')
    const m = /\n\n\[token-goat\] This subagent report \([0-9.]+KB\) is cached for later recall: token-goat mcp-output (mcp_[0-9a-f]{16}) --full$/.exec(text)
    expect(m, text.slice(-300)).not.toBeNull()
    expect(runBundle(['mcp-output', m![1] as string, '--full'], proj)).toContain('gate output line 30')
  })

  it('lets the captured short answer through unchanged (C4c-011)', () => {
    const proj = mkTemp('tg-subagent-stop-ws-')
    const payload = copilotCapture('C4c-011-subagentStop', { proj })
    expect(runInstalledShim('subagentStop', payload, proj)).toEqual({ decision: 'allow' })
  })

  it('lets a long report that does not pay for the notice through unchanged, for the post-tool pass to annotate', () => {
    const proj = mkTemp('tg-subagent-stop-ws-')
    const prose = 'Detailed finding line.\n'.repeat(400)
    expect(runInstalledShim('subagentStop', stopPayload(proj, prose), proj)).toEqual({ decision: 'allow' })
  })

  it('leaves the parent task result alone when it already holds the subagentStop rewrite (C4a-014 shape), so the report is not cached and annotated twice', () => {
    const proj = mkTemp('tg-subagent-stop-ws-')
    const stop = stopPayload(proj, longReport())
    const rewritten = runInstalledShim('subagentStop', stop, proj)['modifiedResponse'] as string
    expect(typeof rewritten).toBe('string')
    const post = copilotCapture('C4a-014-postToolUse-task', { proj })
    post['sessionId'] = stop['sessionId']
    post['toolResult'] = { resultType: 'success', textResultForLlm: rewritten }
    expect(runInstalledShim('postToolUse', post, proj)).toEqual({})
  })
})

describe('Copilot CLI evidence receipt through the installed shim and the built bundle (CAPTURE C4a-013, C4a-014)', () => {
  /** A project that is a clean git repository, so a report that claims a change has no tree change behind it. */
  function cleanRepo(): string {
    const proj = mkTemp('tg-subagent-receipt-ws-')
    for (const args of [['init', '-q'], ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'base']]) {
      const res = spawnSync('git', args, { cwd: proj, encoding: 'utf8' })
      expect(res.status, res.stderr).toBe(0)
    }
    return proj
  }

  it('maps agentId and response, so the rewrite carries the receipt for a claimed change on a clean tree, and the parent task result is then left alone', () => {
    const proj = cleanRepo()
    const stop = stopPayload(proj, 'I fixed the parser bug in widget.ts.')
    const out = runInstalledShim('subagentStop', stop, proj)
    expect(Object.keys(out)).toEqual(['modifiedResponse'])
    const text = out['modifiedResponse'] as string
    expect(text.startsWith('I fixed the parser bug in widget.ts.\n\n')).toBe(true)
    expect(text).toContain('the report claims a change, but this subagent recorded no edit and the working tree is clean')
    const post = copilotCapture('C4a-014-postToolUse-task', { proj })
    post['sessionId'] = stop['sessionId']
    post['toolResult'] = { resultType: 'success', textResultForLlm: text }
    expect(runInstalledShim('postToolUse', post, proj)).toEqual({})
  })

  it('keeps both the compaction and the clean-tree verdict when a long report claims a change, and still answers with nothing but the rewrite', () => {
    const proj = cleanRepo()
    const claim = 'I fixed the parser bug in widget.ts.'
    const out = runInstalledShim('subagentStop', stopPayload(proj, `${claim}\n${longReport()}`), proj)
    expect(Object.keys(out)).toEqual(['modifiedResponse'])
    const text = out['modifiedResponse'] as string
    expect(text).toContain('mcp-output')
    expect(text).toContain('the report claims a change, but this subagent recorded no edit and the working tree is clean')
    expect(text).toContain(CAVEAT)
  })

  it('leaves a short report that claims a change alone when the receipt is switched off, and does not block the stop', () => {
    const proj = cleanRepo()
    expect(runInstalledShim('subagentStop', stopPayload(proj, 'I fixed the parser bug in widget.ts.'), proj, { TOKEN_GOAT_AGENT_RECEIPT: '0' })).toEqual({ decision: 'allow' })
  })

  it('parks nothing, so a post-tool result with the unrewritten report adds no receipt of its own', () => {
    const proj = cleanRepo()
    const stop = stopPayload(proj, 'I fixed the parser bug in widget.ts.')
    runInstalledShim('subagentStop', stop, proj)
    const post = copilotCapture('C4a-014-postToolUse-task', { proj })
    post['sessionId'] = stop['sessionId']
    post['toolResult'] = { resultType: 'success', textResultForLlm: 'I fixed the parser bug in widget.ts.' }
    expect(JSON.stringify(runInstalledShim('postToolUse', post, proj))).not.toContain('recorded no edit')
  })

  it('lets a report that claims nothing through without a receipt', () => {
    const proj = cleanRepo()
    expect(runInstalledShim('subagentStop', stopPayload(proj, 'The parser reads the file once.'), proj)).toEqual({ decision: 'allow' })
  })
})
