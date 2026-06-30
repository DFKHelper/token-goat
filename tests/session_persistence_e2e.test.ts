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

import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const BUNDLE = path.join(ROOT, 'dist', 'token-goat.mjs')

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
  execFileSync(process.execPath, ['esbuild.config.mjs'], { cwd: ROOT, stdio: 'ignore' })
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
