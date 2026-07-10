/**
 * Cross-process session-persistence smoke test against the BUILT bundle.
 *
 * The hooks run as a fresh `token-goat hook <event>` OS process per tool call,
 * so session state (re-read dedup, bash-output recall index) only works if it is
 * persisted to disk between processes. Before this layer existed, a second
 * `pre_tool_use` for the same file in a separate process saw a cold session and
 * emitted nothing. These tests drive the real bundle via separate `spawnSync`
 * invocations sharing one TOKEN_GOAT_HOME and session id, asserting state
 * survives the process boundary. They fail on a port without disk persistence.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

let tgHome: string
let repo: string

/** Run the built bundle in a fresh process with the shared isolated home. */
function runHook(event: string, payload: unknown): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync(process.execPath, [BUNDLE, 'hook', event], {
    cwd: repo,
    env: { ...process.env, TOKEN_GOAT_HOME: tgHome },
    input: JSON.stringify(payload),
    encoding: 'utf8',
  })
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status }
}

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: repo,
    env: { ...process.env, TOKEN_GOAT_HOME: tgHome },
    encoding: 'utf8',
  })
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status }
}

beforeAll(() => {
  tgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-persist-home-'))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-persist-repo-'))
  fs.writeFileSync(path.join(repo, 'tsconfig.json'), '{\n  "compilerOptions": { "strict": true }\n}\n')
}, 120_000)

afterAll(() => {
  for (const d of [tgHome, repo]) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

describe('re-read dedup survives the process boundary', () => {
  it('a second pre_read of the same file in a new process emits the re-read hint', () => {
    const tsconfig = path.join(repo, 'tsconfig.json')
    const payload = { session_id: 'e2e-read', tool_name: 'Read', tool_input: { file_path: tsconfig } }

    // First read (process 1): records the read, no hint yet.
    const first = runHook('pre_tool_use', payload)
    expect(first.status).toBe(0)
    expect(first.stdout).not.toMatch(/[Aa]lready read/)

    // The session state must have been written to disk for the next process.
    expect(fs.existsSync(path.join(tgHome, 'sessions', 'e2e-read.json'))).toBe(true)

    // Second read (process 2, cold memory): must see the prior read via disk.
    const second = runHook('pre_tool_use', payload)
    expect(second.status).toBe(0)
    expect(second.stdout).toMatch(/[Aa]lready read/)
    expect(second.stdout).toContain('tsconfig.json')
  })
})

describe('bash-output recall survives the process boundary', () => {
  it('stores in post, then recalls the cached output by id from separate processes', () => {
    const command = 'npm run build'
    const output = 'BUILD OK ' + 'x'.repeat(700) + '\n' // exceed MIN_CACHE_BYTES (512)

    // Process 1: post_tool_use caches the build output + session recall index.
    const post = runHook('post_tool_use', {
      session_id: 'e2e-bash',
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { output },
      cwd: repo,
    })
    expect(post.status).toBe(0)
    expect(fs.existsSync(path.join(tgHome, 'bash_outputs'))).toBe(true)

    // Process 2: pre_tool_use for the same build command emits a recall hint naming the cached id — only possible if the session index persisted.
    const pre = runHook('pre_tool_use', {
      session_id: 'e2e-bash',
      tool_name: 'Bash',
      tool_input: { command },
      cwd: repo,
    })
    expect(pre.status).toBe(0)
    expect(pre.stdout).toContain('token-goat bash-output ')

    const idMatch = pre.stdout.match(/bash-output ([a-f0-9]{16})/)
    expect(idMatch).not.toBeNull()
    const id = idMatch![1]!

    // Process 3: the session-less CLI recalls the full content by id from disk.
    const recall = runCli(['bash-output', id])
    expect(recall.status).toBe(0)
    expect(recall.stdout).toContain('BUILD OK')
  })
})

describe('markdown hard re-read deny survives an intervening unrelated tool call', () => {
  it('Read -> PostToolUse -> unrelated Bash -> identical Read is hard-denied (regression for the aa4018c9 markdown deny, mirroring a live-session transcript)', () => {
    const mdFile = path.join(repo, 'notes.md')
    fs.writeFileSync(
      mdFile,
      '# Notes\n\n## Heading One\nfoo bar baz\n\n## Heading Two\nqux qux qux\n\n## Heading Three\nzzz zzz zzz\n',
    )
    const sessionId = 'e2e-md-reread'
    const readPayload = { session_id: sessionId, tool_name: 'Read', tool_input: { file_path: mdFile, offset: 1, limit: 90 } }

    // Process 1: Read #1 (PreToolUse) -- first read, recorded, not denied.
    const pre1 = runHook('pre_tool_use', readPayload)
    expect(pre1.status).toBe(0)
    expect(pre1.stdout).not.toMatch(/"decision":"block"/)

    // Process 2: Read #1 (PostToolUse) -- captures the snapshot used for the diff/unchanged check.
    const post1 = runHook('post_tool_use', {
      ...readPayload,
      tool_response: { content: fs.readFileSync(mdFile, 'utf8') },
    })
    expect(post1.status).toBe(0)

    // Process 3 + 4: one intervening, unrelated Bash tool call (Pre + Post), same session id.
    const preBash = runHook('pre_tool_use', { session_id: sessionId, tool_name: 'Bash', tool_input: { command: 'echo hello' } })
    expect(preBash.status).toBe(0)
    const postBash = runHook('post_tool_use', {
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      tool_response: { output: 'hello\n' },
    })
    expect(postBash.status).toBe(0)

    // Process 5: Read #2 -- identical offset/limit, same file, same session. Must be a
    // hard deny (decision: block), never a silent pass-through of the full content again.
    const pre2 = runHook('pre_tool_use', readPayload)
    expect(pre2.status).toBe(0)
    const parsed = JSON.parse(pre2.stdout) as { decision?: string; reason?: string }
    expect(parsed.decision).toBe('block')
    expect(parsed.reason).toMatch(/already read|unchanged since last read/i)
  })
})

describe('sibling subagents get independent re-read dedup ledgers (regression: agent_id salting)', () => {
  it('a sibling subagent\'s genuinely-first read of a file already read by another subagent in the same session is not denied', () => {
    const mdFile = path.join(repo, 'shared-notes.md')
    fs.writeFileSync(
      mdFile,
      '# Shared\n\n## Heading One\nfoo\n\n## Heading Two\nbar\n\n## Heading Three\nbaz\n',
    )
    const sessionId = 'e2e-subagent-session'
    const readPayload = (agentId: string): unknown => ({
      session_id: sessionId,
      agent_id: agentId,
      tool_name: 'Read',
      tool_input: { file_path: mdFile, offset: 1, limit: 90 },
    })

    // Agent A (subagent) reads the file for its own first time -- not denied.
    const preA1 = runHook('pre_tool_use', readPayload('agent-A'))
    expect(preA1.status).toBe(0)
    expect(preA1.stdout).not.toMatch(/"decision":"block"/)

    // Agent B (a sibling subagent -- SAME session_id, different agent_id) reads the
    // SAME file for its own genuinely-first time. Before salting the persisted
    // session-state key by agent_id, this was denied purely because Agent A had
    // already read it: a false positive across sibling agents sharing one session_id.
    const preB1 = runHook('pre_tool_use', readPayload('agent-B'))
    expect(preB1.status).toBe(0)
    expect(preB1.stdout).not.toMatch(/"decision":"block"/)

    // Sanity: Agent A reading the SAME file a second time is still correctly
    // hard-denied -- dedup must still work within one agent's own lineage.
    const preA2 = runHook('pre_tool_use', readPayload('agent-A'))
    expect(preA2.status).toBe(0)
    expect(preA2.stdout).toMatch(/"decision":"block"/)

    // Sanity: the main thread (no agent_id, same session_id) is its own independent
    // lineage too -- its first read of the file is not denied by either subagent's reads.
    const preMain = runHook('pre_tool_use', {
      session_id: sessionId,
      tool_name: 'Read',
      tool_input: { file_path: mdFile, offset: 1, limit: 90 },
    })
    expect(preMain.status).toBe(0)
    expect(preMain.stdout).not.toMatch(/"decision":"block"/)
  })
})

describe('WebFetch recall survives the process boundary', () => {
  it('a pre_fetch of a previously fetched URL in a new process emits the web-output recall hint', () => {
    const url = 'https://example.com/doc'
    const body = 'web body line\n'.repeat(120) // > 1KB, above the post-fetch cache threshold

    // Process 1: cache the response body to disk and record the URL in the session.
    const first = runHook('post_tool_use', {
      session_id: 'e2e-web',
      tool_name: 'WebFetch',
      tool_input: { url },
      tool_response: { output: body },
    })
    expect(first.status).toBe(0)
    expect(fs.existsSync(path.join(tgHome, 'web_outputs'))).toBe(true)
    expect(fs.readdirSync(path.join(tgHome, 'web_outputs')).length).toBeGreaterThan(0)

    // Process 2 (cold memory): the recall hint must cross the process boundary via the
    // persisted session state plus the on-disk web_outputs blob.
    const second = runHook('pre_tool_use', {
      session_id: 'e2e-web',
      tool_name: 'WebFetch',
      tool_input: { url },
    })
    expect(second.status).toBe(0)
    expect(second.stdout).toMatch(/web-output/)
  })
})
