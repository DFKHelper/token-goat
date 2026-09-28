// `token-goat waste` lists the Bash commands a session ran more than once without a bash-output cache hit, and it looked each call up under the command as the transcript recorded it and the directory on the transcript line. The post hook stores a call's output under the command past its cd prefix, leading assignments and subshell group, unwrapped from a `token-goat compress` wrapper, and keyed on the directory the command ran in. So every repeated `cd <dir> && cargo build` whose output was stored, the usual spelling of a build in a real transcript, was reported as a missed recall. The report now resolves each call through the function the post hook stores under.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import { buildWasteReport } from '../src/waste.js'

// HAND-DERIVED: rustc's `error[E0425]` diagnostic shape, 30 lines so the body clears the 512-byte cache floor the post hook stores above.
const FAILING = Array.from({ length: 30 }, (_, i) => `error[E0425]: cannot find value \`limit${i}\` in this scope`).join('\n')

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function layout(): { root: string; pkgA: string } {
  const root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-waste-recall-key-')))
  dirs.push(root)
  const pkgA = normalizePath(path.join(root, 'pkgA'))
  fs.mkdirSync(pkgA)
  return { root, pkgA }
}

// CAPTURE: a subagent's Bash payload from Claude Code 2.1.281, whose cwd is the directory the call started in on every event, with the tool_response keys recorded off real traffic in tests/hooks_real_harness_payload_shape.test.ts; Claude Code reports no exit code there.
async function storeRun(root: string, command: string): Promise<void> {
  const sid = `s-waste-key-${process.pid}-${Math.random().toString(36).slice(2)}`
  const raw = { cwd: root, tool_name: 'Bash', tool_input: { command }, agent_id: 'a3fa4da94f851e86f', tool_response: { stdout: FAILING, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }
  const event: HookEvent = { eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId: sid, agentId: 'a3fa4da94f851e86f', raw }
  loadSessionState(sid)
  try {
    await postBashHandler(event)
  } finally {
    saveSessionState(sid)
  }
}

// CAPTURE: the line shapes Claude Code 2.1.281 writes to a session transcript, read off this machine's transcripts on 2026-09-27: an assistant line with a top-level `cwd` and a `{ type: 'tool_use', id, name: 'Bash', input: { command, description } }` block, answered by a user line holding `{ type: 'tool_result', tool_use_id, content }` with a string content.
function transcriptRunning(root: string, command: string, times: number): string {
  const lines: unknown[] = []
  for (let i = 0; i < times; i++) {
    const id = `toolu_waste_key_${i}`
    lines.push({ type: 'assistant', cwd: root, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'Build' } }] } })
    lines.push({ type: 'user', cwd: root, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: FAILING }] } })
  }
  const file = path.join(root, 'session.jsonl')
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')
  return file
}

describe('the waste report looks a repeated Bash call up under the key its output was stored under', () => {
  const spellings: Array<[string, (pkgA: string) => string]> = [
    ['an absolute cd prefix', (pkgA) => `cd ${pkgA} && cargo build`],
    ['a relative cd prefix', () => 'cd pkgA && cargo build'],
    ['a leading assignment', () => 'RUST_BACKTRACE=1 cargo build'],
    ['a subshell group', () => '(cd pkgA && cargo build)'],
    ['a compress wrapper', () => "token-goat compress -f cargo --timeout 600 -c 'cd pkgA && cargo build'"],
  ]

  for (const [label, spell] of spellings) {
    it(`a stored repeat behind ${label} is not reported as a missed recall`, async () => {
      clearModuleCaches()
      const { root, pkgA } = layout()
      const command = spell(pkgA)
      await storeRun(root, command)
      const report = await buildWasteReport(transcriptRunning(root, command, 2))
      expect(report.repeatedUncompressedBash).toEqual([])
    })
  }

  it('a repeat nothing stored is still reported', async () => {
    clearModuleCaches()
    const { root } = layout()
    const report = await buildWasteReport(transcriptRunning(root, 'cd pkgA && cargo build', 2))
    expect(report.repeatedUncompressedBash).toMatchObject([{ normalized: 'cd pkgA && cargo build', count: 2 }])
  })
})
