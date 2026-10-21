import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ServerStatus } from '../src/hook_ipc.js'
import { BUNDLE, bundleTg, makeBundleProject, runBundle } from './helpers/bundle.js'
import { isHookServerCommandLine, killAllIfCommandLine } from './helpers/kill_if_command_line.js'

// The inlined-symbol Grep deny through the resident hook server against the built bundle: the same payload goes once through the cold CLI hook (TOKEN_GOAT_HOOK_SERVER=0) and once through the real hook client to a real `hook-server run` process, and the two outputs must be byte for byte the same. No handler is injected on either side. The server handles one hook at a time in a long-lived process, so state a cold process builds fresh (the config cache, the module caches, the once-per-session marker) is the thing this compares.

// HAND-DERIVED: a synthetic Python module with one function that is the only definition of its name.
const SOURCE = 'def parity_loader(path):\n    """Load one thing."""\n    return open(path).read()\n\ndef other():\n    return 2\n'
const PATTERN = String.raw`def parity_loader\b`

// FORMAT-DERIVED: the Claude Code PreToolUse payload keys (hook_event_name, session_id, cwd, tool_name, tool_input), as src/hook_registry.ts reads them; the same shape tests/inline_symbol_answer_bundle.test.ts sends.
function grepPayload(project: string, file: string, sessionId: string): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sessionId, cwd: project, tool_name: 'Grep', tool_input: { pattern: PATTERN, path: file, output_mode: 'content' } })
}

let root: string
let project: string
let file: string
let env: NodeJS.ProcessEnv
let server: ChildProcess | undefined
const serverPids = new Set<number>()

beforeEach(() => {
  ;({ root, project, env } = makeBundleProject('tg-inline-hs-'))
  env = { ...env, TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_INLINE_SYMBOL_BODY: '1', TOKEN_GOAT_HOOK_SERVER: '1' }
  file = path.join(project, 'mod.py')
  fs.writeFileSync(file, SOURCE, 'utf8')
  const idx = bundleTg(project, env, ['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
})

afterEach(() => {
  try {
    bundleTg(project, env, ['hook-server', 'stop'])
  } catch {
    // the kill below by pid still runs
  }
  if (server !== undefined && server.exitCode === null && server.signalCode === null) server.kill()
  server = undefined
  killAllIfCommandLine(serverPids, isHookServerCommandLine, { signal: 'SIGTERM' })
  serverPids.clear()
  fs.rmSync(root, { recursive: true, force: true })
})

function status(): ServerStatus[] {
  const res = bundleTg(project, env, ['hook-server', 'status', '--json'])
  expect(res.status, res.stderr).toBe(0)
  const list = JSON.parse(res.stdout) as ServerStatus[]
  for (const s of list) serverPids.add(s.pid)
  return list
}

describe('inline symbol body: CLI hook and hook server', () => {
  it('answers the same Grep payload with the same deny text from the cold CLI and from a resident server', async () => {
    const cold = runBundle(['hook', 'pre_tool_use'], { cwd: project, env: { ...env, TOKEN_GOAT_HOOK_SERVER: '0' }, input: grepPayload(project, file, 'inline-hs-cold'), timeout: 60000 })
    expect(cold.status, cold.stderr).toBe(0)
    const coldReply = JSON.parse(cold.stdout) as { decision?: string; reason?: string }
    expect(coldReply.decision, cold.stdout).toBe('block')
    expect(coldReply.reason ?? '').toMatch(/symbol body \(\d+ bytes\) is inlined below/)

    const child = spawn(process.execPath, [BUNDLE, 'hook-server', 'run', '--slot', '0'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    server = child
    if (child.pid !== undefined) serverPids.add(child.pid)
    child.stdout?.resume()
    child.stderr?.resume()
    const exited = new Promise<'exited'>((resolve) => child.once('exit', () => resolve('exited')))
    // Ready when status lists slot 0; a server that died instead is a failure at once. Bounded by the test's own timeout, not by a clock here.
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('the hook server exited before it listened: ' + String(await exited))
      if (status().some((s) => s.slot === 0)) break
    }

    const driver = path.join(root, 'relay-driver.mjs')
    fs.writeFileSync(driver, ["import { readFileSync } from 'node:fs'", "import { pathToFileURL } from 'node:url'", 'const [clientPath, event] = process.argv.slice(2)', 'const { relayViaServer } = await import(pathToFileURL(clientPath).href)', "const out = await relayViaServer(event, readFileSync(0, 'utf8'))", 'process.stdout.write(JSON.stringify({ out: out ?? null }))', ''].join('\n'))
    const warm = spawnSync(process.execPath, [driver, path.join(path.dirname(BUNDLE), 'token-goat-hook-client.mjs'), 'pre_tool_use'], { cwd: project, env, input: grepPayload(project, file, 'inline-hs-warm'), encoding: 'utf8', timeout: 60000 })
    expect(warm.status, warm.stderr).toBe(0)
    const served = (JSON.parse(warm.stdout) as { out: string | null }).out
    expect(served, 'the client handed the call back instead of dispatching it to the server').not.toBeNull()
    expect(served).toBe(cold.stdout)
    expect(status().find((s) => s.slot === 0)?.served).toBeGreaterThanOrEqual(1)
  })
})
