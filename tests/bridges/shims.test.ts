import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CLAUDECODE_HOOK_SCRIPT } from '../../src/bridges/claudecode.js'
import { CODEX_HOOK_SCRIPT } from '../../src/bridges/codex.js'
import { COPILOT_CLI_HOOK_SCRIPT } from '../../src/bridges/copilot_cli.js'
import { GROK_HOOK_SCRIPT } from '../../src/bridges/grok.js'
import { KIMI_HOOK_SCRIPT } from '../../src/bridges/kimi.js'
import { SHIM_TRY_SERVER } from '../../src/bridges/shim_common.js'
import { HOOK_EVENTS, type HookEventName } from '../../src/types.js'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function mkIsolated(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-shim-test-'))
  tempDirs.push(dir)
  return dir
}

/** Extracts the quoted string literals inside a `new Set([...])` / `[...]` array literal that appears in `source` right after `label`, e.g. `VALID_HOOK_EVENTS = new Set([` -> the event name strings inside it. Used to check the shim's hardcoded allowlist against the real HOOK_EVENTS enum without needing a JS parser. */
function extractQuotedList(source: string, label: string): string[] {
  const start = source.indexOf(label)
  expect(start, `expected to find "${label}" in the shim source`).toBeGreaterThanOrEqual(0)
  const openBracket = source.indexOf('[', start)
  const closeBracket = source.indexOf(']', openBracket)
  const body = source.slice(openBracket, closeBracket)
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1])
}

/** Runs a bridge shim's embedded script exactly as the external harness (Claude Code / Codex) would: as a standalone Node process invoked with the event name as argv[2] and the hook payload on stdin. Returns what it printed on stdout. An optional `env` lets a test swap out what the shim's own internal `token-goat hook <event>` call resolves to (see `withFakeTokenGoat` below), instead of hitting the real installed binary. */
function runShim(script: string, eventName: string, cwd: string, env?: NodeJS.ProcessEnv): string {
  const scriptPath = join(cwd, 'shim.js')
  writeFileSync(scriptPath, script, 'utf8')
  const res = spawnSync(process.execPath, [scriptPath, eventName], {
    cwd,
    input: '{}',
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 32 * 1024 * 1024,
    env: env ?? process.env,
  })
  return res.stdout ?? ''
}

/** Writes a fake `token-goat` executable into `cwd` and returns a PATH-prepended env pointing at it, so a shim's internal `spawnSync('token-goat hook ' + eventName, { shell: true })` resolves to `jsonStdout` instead of the real installed binary. Windows/Linux both resolve `shell: true` commands via PATH rather than the child's cwd (verified empirically -- a same-named file placed only in cwd is NOT picked up), so PATH must be prepended, not just the fake binary dropped next to the shim script. */
function withFakeTokenGoat(cwd: string, jsonStdout: string): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    writeFileSync(join(cwd, 'token-goat.cmd'), `@echo off\r\necho ${jsonStdout}\r\n`, 'utf8')
  } else {
    const scriptPath = join(cwd, 'token-goat')
    writeFileSync(scriptPath, `#!/bin/sh\necho '${jsonStdout}'\n`, 'utf8')
    chmodSync(scriptPath, 0o755)
  }
  return { ...process.env, PATH: cwd + delimiter + (process.env['PATH'] ?? '') }
}

describe('bridge hook shims', () => {
  describe.each([
    ['CLAUDECODE_HOOK_SCRIPT', CLAUDECODE_HOOK_SCRIPT],
    ['CODEX_HOOK_SCRIPT', CODEX_HOOK_SCRIPT],
  ])('%s', (_name, script) => {
    it('validates eventName against a closed allowlist before building the shell command', () => {
      const guardIndex = script.indexOf('VALID_HOOK_EVENTS')
      const shellCallIndex = script.indexOf("spawnSync('token-goat hook ' + eventName")
      expect(guardIndex).toBeGreaterThanOrEqual(0)
      expect(shellCallIndex).toBeGreaterThan(guardIndex)
    })

    it('still uses shell: true (needed on Windows to resolve the token-goat .cmd/.bat shim)', () => {
      expect(script).toContain('shell: true')
    })

    it('keeps its hardcoded event allowlist in sync with HOOK_EVENTS', () => {
      const allowlisted = extractQuotedList(script, 'VALID_HOOK_EVENTS')
      expect(allowlisted.sort()).toEqual([...HOOK_EVENTS].sort())
    })

    it('rejects a malicious eventName without ever reaching the shell, so no injected command runs', () => {
      const cwd = mkIsolated()
      const markerPath = join(cwd, 'INJECTED_MARKER.txt')
      const malicious = 'pre_tool_use & echo pwned>' + markerPath
      const stdout = runShim(script, malicious, cwd)
      expect(stdout.trim()).toBe('{}')
      expect(existsSync(markerPath)).toBe(false)
    })

    it('rejects an eventName that is merely a prefix/suffix of a real event', () => {
      const cwd = mkIsolated()
      const stdout = runShim(script, 'pre_tool_use_extra', cwd)
      expect(stdout.trim()).toBe('{}')
    })
  })
})

/** Writes a fake token-goat "entry" -- a plain Node script, not a PATH-resolvable binary -- that records the argv it was invoked with to `captured-argv.json` in `cwd` and exits 0 with an empty JSON response. Used to prove a shim's inner call, when given a third argv (the baked entry path), invokes that path directly via process.execPath rather than shelling out to a PATH-resolved `token-goat` at all. */
function writeFakeEntry(cwd: string): { entryPath: string; capturePath: string } {
  const entryPath = join(cwd, 'fake-entry.js')
  const capturePath = join(cwd, 'captured-argv.json')
  const captureLiteral = JSON.stringify(capturePath)
  writeFileSync(
    entryPath,
    `require('fs').writeFileSync(${captureLiteral}, JSON.stringify(process.argv.slice(2)))\nprocess.stdout.write('{}')\n`,
    'utf8',
  )
  return { entryPath, capturePath }
}

describe('CODEX_HOOK_SCRIPT inner-call PATH hardening', () => {
  it('invokes the baked entry path (argv[3]) directly via process.execPath, bypassing PATH resolution entirely, when the shim receives one', () => {
    const cwd = mkIsolated()
    const { entryPath, capturePath } = writeFakeEntry(cwd)
    const scriptPath = join(cwd, 'shim.js')
    writeFileSync(scriptPath, CODEX_HOOK_SCRIPT, 'utf8')
    // Deliberately no PATH-resolvable `token-goat` anywhere -- if the shim fell back to the old shell:true PATH lookup instead of using entryPath, this would fail to launch and captured-argv.json would never be written.
    const res = spawnSync(process.execPath, [scriptPath, 'pre_tool_use', entryPath], {
      cwd,
      input: '{}',
      encoding: 'utf8',
      timeout: 15000,
      env: process.env,
    })
    expect(res.status).toBe(0)
    expect(existsSync(capturePath)).toBe(true)
    const capturedArgv = JSON.parse(readFileSync(capturePath, 'utf8')) as string[]
    expect(capturedArgv).toEqual(['hook', 'pre_tool_use'])
  })

  it('falls back to the old PATH-based shell invocation when no entry path arg is given (backward compatible with an older cached hook config)', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(cwd, '{"hookSpecificOutput":{"additionalContext":"via PATH"}}')
    const stdout = runShim(CODEX_HOOK_SCRIPT, 'pre_tool_use', cwd, env)
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toBe('via PATH')
  })
})

describe('CODEX_HOOK_SCRIPT hookEventName casing (regression: the shim previously injected the raw snake_case argv event name -- e.g. "pre_tool_use" -- into hookSpecificOutput.hookEventName when the child token-goat process omitted it, instead of the PascalCase spelling ("PreToolUse") that CLAUDE_CODE_EVENT_NAMES in src/hook_registry.ts actually emits on the live/wired token-goat hook <event> path)', () => {
  const EXPECTED_PASCAL_CASE: Record<HookEventName, string> = {
    pre_tool_use: 'PreToolUse',
    post_tool_use: 'PostToolUse',
    notification: 'Notification',
    stop: 'Stop',
    pre_compact: 'PreCompact',
    post_compact: 'PostCompact',
    user_prompt_submit: 'UserPromptSubmit',
    subagent_stop: 'SubagentStop',
    session_start: 'SessionStart',
    post_tool_use_failure: 'PostToolUseFailure',
  }

  it('maps every HOOK_EVENTS entry to its PascalCase spelling when the child process omits hookEventName', () => {
    for (const eventName of HOOK_EVENTS) {
      const cwd = mkIsolated()
      const env = withFakeTokenGoat(cwd, '{"hookSpecificOutput":{"additionalContext":"x"}}')
      const stdout = runShim(CODEX_HOOK_SCRIPT, eventName, cwd, env)
      const parsed = JSON.parse(stdout)
      expect(parsed.hookSpecificOutput.hookEventName).toBe(EXPECTED_PASCAL_CASE[eventName])
      expect(parsed.hookSpecificOutput.hookEventName).not.toBe(eventName)
    }
  })

  it('does not override hookEventName when the child process already set one', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(
      cwd,
      '{"hookSpecificOutput":{"hookEventName":"AlreadySetByHandler","additionalContext":"x"}}',
    )
    const stdout = runShim(CODEX_HOOK_SCRIPT, 'pre_tool_use', cwd, env)
    const parsed = JSON.parse(stdout)
    expect(parsed.hookSpecificOutput.hookEventName).toBe('AlreadySetByHandler')
  })
})

// A PreToolUse hook that crashes, exits non-zero, or prints something unparseable is fail-closed in at least one harness: Copilot denies the whole session on it. So "the hook cannot take the developer's tooling down with it" is an availability guarantee, not a nicety, and nothing exercised the generated Claude Code shim against a crash. These run it as the harness does, with the snake_case event names the shim's own allowlist holds -- a PascalCase name here would return '{}' from the unknown-event branch and every case below would pass without ever reaching the guard it names. The final main().catch is not covered: nothing reachable from outside the process makes main() reject, so it stays as defense in depth rather than a tested path.
describe('the Claude Code shim cannot block a tool call by failing', () => {
  function runShim(args: string[], stdin: string, env: NodeJS.ProcessEnv = {}): { status: number | null; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'tg-shim-fail-'))
    const shim = join(dir, 'token-goat-shim.js')
    writeFileSync(shim, CLAUDECODE_HOOK_SCRIPT)
    const result = spawnSync(process.execPath, [shim, ...args], {
      input: stdin,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    rmSync(dir, { recursive: true, force: true })
    return { status: result.status, out: result.stdout }
  }

  it('prints an empty decision and exits zero when the entry path it was given does not exist', () => {
    const missing = join(tmpdir(), 'tg-does-not-exist', 'token-goat.mjs')

    const { status, out } = runShim(['pre_tool_use', missing], '{"tool_name":"Read","tool_input":{"file_path":"x"}}')

    expect(status).toBe(0)
    expect(out).toBe('{}')
  })

  it('does the same on stdin that is not JSON at all, rather than throwing on the parse', () => {
    const { status, out } = runShim(['pre_tool_use'], 'not json at all')

    expect(status).toBe(0)
    expect(out.trim()).toBe('{}')
  })

  it('does the same for an event name it does not recognise', () => {
    const { status, out } = runShim(['NoSuchEvent'], '{}')

    expect(status).toBe(0)
    expect(out).toBe('{}')
  })

  it('does the same when the token-goat process it spawns exits non-zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-shim-entry-'))
    const entry = join(dir, 'token-goat.mjs')
    // The child prints a decision AND fails. Exiting non-zero with no output would be caught by the empty-stdout guard too, so this is the only shape that isolates the exit-status check: a token-goat that crashed halfway through printing must not have its half-decision honoured.
    const deny = JSON.stringify({ decision: 'deny', reason: 'half-written' })
    writeFileSync(entry, `process.stdout.write(${JSON.stringify(deny)})
process.exit(1)
`)

    const { status, out } = runShim(['pre_tool_use', entry], '{"tool_name":"Read","tool_input":{"file_path":"x"}}')
    rmSync(dir, { recursive: true, force: true })

    expect(status).toBe(0)
    expect(out).toBe('{}')
    expect(out).not.toContain('deny')
  })
})

/** Writes a fake `token-goat` PATH shim that runs a Node script (not a literal `echo` line, which would hit a batch/shell line-length ceiling long before reaching megabyte-scale payloads) and prints `jsonStdout` verbatim. Reuses the shell-fallback resolution rule documented on `withFakeTokenGoat` above: PATH must be prepended, a same-named file in cwd is not picked up. */
function withFakeTokenGoatLarge(cwd: string, jsonStdout: string): NodeJS.ProcessEnv {
  const bodyPath = join(cwd, 'large-body.json')
  writeFileSync(bodyPath, jsonStdout, 'utf8')
  const printerPath = join(cwd, 'print-large-body.js')
  writeFileSync(printerPath, `process.stdout.write(require('fs').readFileSync(${JSON.stringify(bodyPath)}, 'utf8'))\n`, 'utf8')
  if (process.platform === 'win32') {
    writeFileSync(join(cwd, 'token-goat.cmd'), `@echo off\r\n"${process.execPath}" "${printerPath}"\r\n`, 'utf8')
  } else {
    const scriptPath = join(cwd, 'token-goat')
    writeFileSync(scriptPath, `#!/bin/sh\nexec "${process.execPath}" "${printerPath}"\n`, 'utf8')
    chmodSync(scriptPath, 0o755)
  }
  return { ...process.env, PATH: cwd + delimiter + (process.env['PATH'] ?? '') }
}

describe('shim shell fallback does not truncate a large hook response (regression: Node spawnSync defaults maxBuffer to 1 MB, and hooks_mcp.ts unconditionally fences an MCP tool result of any size, so a fenced payload over ~1 MB used to be ENOBUFS-killed and silently fail open to "{}", dropping the fence)', () => {
  describe.each([
    ['CLAUDECODE_HOOK_SCRIPT', CLAUDECODE_HOOK_SCRIPT],
    ['CODEX_HOOK_SCRIPT', CODEX_HOOK_SCRIPT],
  ])('%s', (_name, script) => {
    it('relays a 1.5 MB hookSpecificOutput.additionalContext through the PATH-based shell fallback intact', () => {
      const cwd = mkIsolated()
      const bigContext = 'x'.repeat(1_500_000)
      const payload = JSON.stringify({ hookSpecificOutput: { additionalContext: bigContext } })
      const env = withFakeTokenGoatLarge(cwd, payload)
      const stdout = runShim(script, 'post_tool_use', cwd, env)
      const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } }
      expect(parsed.hookSpecificOutput?.additionalContext?.length).toBe(bigContext.length)
    })
  })
})

// The resident hook server is reached through a sibling dist/token-goat-hook-client.cjs (or its .mjs build on an older install), tried before the in-process hook library (src/bridges/shim_common.ts SHIM_TRY_SERVER / SHIM_TRY_IN_PROCESS). Proven by running each shim against fakes rather than by grepping its text: a shim that carried the fragment but never called it, or called it after the hook library import, would pass a text check and fail these.
describe('bridge hook shims try the resident hook server first', () => {
  // HAND-DERIVED stand-ins for the two sibling modules, exporting the functions and signatures each shim calls: relayViaServer(event, input, harnessWaitMs) (src/hook_client.ts) and relayInProcess(event, payload, harnessWaitMs) (src/hook_lib.ts). Each records its call and answers with a block decision whose reason names it, which every harness translation carries through.
  function fakeModule(fn: string, reason: string, log: string, format: 'esm' | 'cjs' = 'esm'): string {
    const head = format === 'esm' ? `import { appendFileSync } from 'node:fs'\nexport async function ${fn}(event, input) {` : `const { appendFileSync } = require('node:fs')\nexports.${fn} = async function (event, input) {`
    return `${head}
  const payload = typeof input === 'string' ? JSON.parse(input) : input
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ event, payload, harness: process.env.TOKEN_GOAT_HARNESS_OVERRIDE ?? null }) + String.fromCharCode(10))
  if (process.env.FAKE_SERVER_DECLINES === '1' && ${JSON.stringify(fn)} === 'relayViaServer') return undefined
  return JSON.stringify({ decision: 'block', reason: ${JSON.stringify(reason)} })
}
`
  }

  // A current install carries the client twice, as the CommonJS file a shim loads and the ES module the launcher loads (esbuild.config.mjs); an install built before the CommonJS file has only the second, and one older still has neither. Each build's fake names itself in its answer.
  function layout(client: 'none' | 'mjs' | 'both'): { dir: string; entryPath: string; spawnedMarker: string; clientLog: string; hookLibLog: string } {
    const dir = mkIsolated()
    const spawnedMarker = join(dir, 'SPAWNED.txt')
    const clientLog = join(dir, 'client-calls.log')
    const hookLibLog = join(dir, 'hooklib-calls.log')
    const entryPath = join(dir, 'token-goat.cjs')
    writeFileSync(entryPath, `require('fs').writeFileSync(${JSON.stringify(spawnedMarker)}, 'spawned')\nprocess.stdout.write('{}')\n`, 'utf8')
    if (client !== 'none') writeFileSync(join(dir, 'token-goat-hook-client.mjs'), fakeModule('relayViaServer', 'FROM-RESIDENT-SERVER via mjs', clientLog), 'utf8')
    if (client === 'both') writeFileSync(join(dir, 'token-goat-hook-client.cjs'), fakeModule('relayViaServer', 'FROM-RESIDENT-SERVER via cjs', clientLog, 'cjs'), 'utf8')
    writeFileSync(join(dir, 'token-goat-hook.mjs'), fakeModule('relayInProcess', 'FROM-HOOK-LIBRARY', hookLibLog), 'utf8')
    return { dir, entryPath, spawnedMarker, clientLog, hookLibLog }
  }

  function readLog(p: string): Array<{ event: string; payload: Record<string, unknown>; harness: string | null }> {
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event: string; payload: Record<string, unknown>; harness: string | null })
  }

  // Payload shapes are each harness's own: Claude Code/Codex/Grok/Kimi send tool_name/tool_input (the shape tests/bridges/inprocess.test.ts drives these shims with); Copilot CLI sends toolName/toolArgs with its native `view` tool (src/copilot_tool_names.ts maps view -> Read), FORMAT-DERIVED from the payload the Copilot tests in tests/bridges/inprocess.test.ts send.
  const SNAKE_PAYLOAD = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'notes.md' }, session_id: 'shim-server-first' })
  const COPILOT_PAYLOAD = JSON.stringify({ sessionId: 'shim-server-first', workingDirectory: '.', toolName: 'view', toolArgs: { path: 'notes.md' } })
  const SHIMS: Array<[string, string, string, string]> = [
    ['CLAUDECODE_HOOK_SCRIPT', CLAUDECODE_HOOK_SCRIPT, 'pre_tool_use', SNAKE_PAYLOAD],
    ['CODEX_HOOK_SCRIPT', CODEX_HOOK_SCRIPT, 'pre_tool_use', SNAKE_PAYLOAD],
    ['GROK_HOOK_SCRIPT', GROK_HOOK_SCRIPT, 'pre_tool_use', SNAKE_PAYLOAD],
    ['KIMI_HOOK_SCRIPT', KIMI_HOOK_SCRIPT, 'pre_tool_use', SNAKE_PAYLOAD],
    ['COPILOT_CLI_HOOK_SCRIPT', COPILOT_CLI_HOOK_SCRIPT, 'preToolUse', COPILOT_PAYLOAD],
  ]

  function run(script: string, event: string, payload: string, l: { dir: string; entryPath: string }, extraEnv: NodeJS.ProcessEnv = {}): string {
    const scriptPath = join(l.dir, 'shim.cjs')
    writeFileSync(scriptPath, script, 'utf8')
    const res = spawnSync(process.execPath, [scriptPath, event, l.entryPath], { cwd: l.dir, input: payload, encoding: 'utf8', timeout: 15000, env: { ...process.env, ...extraEnv } })
    expect(res.error).toBeUndefined()
    return res.stdout
  }

  describe.each(SHIMS)('%s', (name, script, event, payload) => {
    it('carries the shared tryServer fragment verbatim', () => {
      expect(script).toContain(SHIM_TRY_SERVER)
    })

    it('answers from the resident server when it serves the call, and never loads the hook library or spawns the entry', () => {
      const l = layout('both')
      const stdout = run(script, event, payload, l)
      expect(stdout).toContain('FROM-RESIDENT-SERVER')
      const calls = readLog(l.clientLog)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.event).toBe('pre_tool_use')
      expect(readLog(l.hookLibLog)).toEqual([])
      expect(existsSync(l.spawnedMarker)).toBe(false)
      // Copilot CLI sets its harness before either path, so a server running the call under this process's environment attributes it to Copilot rather than to whatever the suite or the server inherited.
      if (name === 'COPILOT_CLI_HOOK_SCRIPT') {
        expect(calls[0]?.harness).toBe('copilot_cli')
        expect(calls[0]?.payload['tool_name']).toBe('Read')
      }
    })

    it('falls back to the in-process hook library, with the same call, when the server dispatched nothing', () => {
      const l = layout('both')
      const stdout = run(script, event, payload, l, { FAKE_SERVER_DECLINES: '1' })
      expect(stdout).toContain('FROM-HOOK-LIBRARY')
      const server = readLog(l.clientLog)
      const lib = readLog(l.hookLibLog)
      expect(server).toHaveLength(1)
      expect(lib).toHaveLength(1)
      expect(lib[0]?.event).toBe(server[0]?.event)
      expect(lib[0]?.payload).toEqual(server[0]?.payload)
      expect(existsSync(l.spawnedMarker)).toBe(false)
    })

    it('uses the in-process hook library unchanged for an install that predates the client', () => {
      const l = layout('none')
      const stdout = run(script, event, payload, l)
      expect(stdout).toContain('FROM-HOOK-LIBRARY')
      expect(readLog(l.hookLibLog)).toHaveLength(1)
      expect(existsSync(l.spawnedMarker)).toBe(false)
    })

    it('loads the CommonJS client when the install has one, not the ES module build beside it', () => {
      const l = layout('both')
      const stdout = run(script, event, payload, l)
      expect(stdout).toContain('via cjs')
      expect(readLog(l.clientLog)).toHaveLength(1)
    })

    it('still reaches the server through the ES module client on an install built before the CommonJS one', () => {
      const l = layout('mjs')
      const stdout = run(script, event, payload, l)
      expect(stdout).toContain('FROM-RESIDENT-SERVER via mjs')
      expect(readLog(l.hookLibLog)).toEqual([])
    })
  })
})
