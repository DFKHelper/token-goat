/** HAND-DERIVED integration coverage for the installed shared shim: real built hook entry, open stdin, and isolated hook data. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { afterEach, describe, expect, it } from 'vitest'

import { COPILOT_CLI_HOOK_SCRIPT } from '../../src/bridges/copilot_cli.js'
import { closeAllDbs, getDb } from '../../src/db.js'
import { SHIM_SESSION_START_TIMEOUT_MS } from '../../src/bridges/shim_common.js'
import { findGlobalDb } from '../helpers/find_global_db.js'
import { installStartupOwner } from '../helpers/copilot_session_start_tree.js'
import { awaitProcessExit, childExit } from '../helpers/process_exit.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')
const SESSION_START_BUDGET_MS = 3000
// Windows process startup/teardown has added about 1.2 s to full-deadline runs;
// this tolerance covers that observed scheduler overhead, not handler work.
const SCHEDULING_TOLERANCE_MS = 2000
const PROCESS_WAIT_LIMIT_MS = SESSION_START_BUDGET_MS + SCHEDULING_TOLERANCE_MS + 1000
const tempDirs: string[] = []
const children: ChildProcessWithoutNullStreams[] = []
/** Helpers the shim's startup owner ran in a fixture's project directory, by PID, each with the time its pid file was written. */
const helpers = new Map<number, number>()

interface Fixture {
  root: string
  project: string
  home: string
  shimPath: string
  env: NodeJS.ProcessEnv
}

interface ProcessResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  elapsedMs: number
  timedOut: boolean
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'tg-copilot-session-start-'))
  tempDirs.push(root)
  const project = join(root, 'project')
  const home = join(root, 'home')
  mkdirSync(project, { recursive: true })
  mkdirSync(home, { recursive: true })
  const shimPath = join(root, 'token-goat-shim.cjs')
  writeFileSync(shimPath, COPILOT_CLI_HOOK_SCRIPT, 'utf8')
  installStartupOwner(root)
  return {
    root,
    project,
    home,
    shimPath,
    env: {
      ...process.env,
      TOKEN_GOAT_HOME: home,
      TOKEN_GOAT_HOOK_SERVER: '0',
      TOKEN_GOAT_NATIVE_HOOKS: '0',
      LOCALAPPDATA: home,
      XDG_DATA_HOME: home,
    },
  }
}

function startShim(fixture: Fixture, event: string, entryPath = BUNDLE): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [fixture.shimPath, event, entryPath], {
    cwd: fixture.project,
    env: fixture.env,
    stdio: 'pipe',
    windowsHide: true,
  })
  child.stdin.on('error', () => undefined)
  children.push(child)
  return child
}

function observe(child: ChildProcessWithoutNullStreams): {
  done: Promise<ProcessResult>
  stdout: () => string
} {
  const startedAt = performance.now()
  let stdout = ''
  let stderr = ''
  let timedOut = false
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const done = new Promise<ProcessResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, PROCESS_WAIT_LIMIT_MS)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        code,
        signal,
        stdout,
        stderr,
        elapsedMs: performance.now() - startedAt,
        timedOut,
      })
    })
  })
  return { done, stdout: () => stdout }
}

function copilotPayload(project: string): Record<string, unknown> {
  return {
    sessionId: 'copilot-session-start-test',
    workingDirectory: project,
    source: 'startup',
    initialPrompt: 'Quoted braces }{, quote ", and backslash \\\\ stay inside a JSON string.',
  }
}

function vscodePayload(project: string): Record<string, unknown> {
  return {
    hook_event_name: 'SessionStart',
    session_id: 'vscode-session-start-test',
    cwd: project,
    source: 'startup',
  }
}

function parseOneObject(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout)
  expect(parsed).not.toBeNull()
  expect(typeof parsed, 'the shim must emit one JSON object').toBe('object')
  expect(Array.isArray(parsed)).toBe(false)
  expect(stdout.trim()).toBe(JSON.stringify(parsed))
  return parsed as Record<string, unknown>
}

async function sendOpenInput(
  child: ChildProcessWithoutNullStreams,
  input: string,
  chunked = false,
): Promise<void> {
  if (!chunked) {
    child.stdin.write(input)
    return
  }
  const split = Math.max(1, Math.floor(input.length / 2))
  child.stdin.write(input.slice(0, split))
  await new Promise((resolve) => setTimeout(resolve, 20))
  child.stdin.write(input.slice(split))
}

function assertDeadline(result: ProcessResult): void {
  expect(result.timedOut, 'the test harness had to kill the shim').toBe(false)
  expect(result.elapsedMs).toBeLessThan(SESSION_START_BUDGET_MS + SCHEDULING_TOLERANCE_MS)
}

function assertSessionStartContext(stdout: string): void {
  const text = JSON.stringify(parseOneObject(stdout))
  expect(text, 'the existing SessionStart routing reminder must survive the new transport').toContain('prefer surgical reads')
  expect(text).toContain('token-goat index .')
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => {
    const exit = childExit(child)
    if (child.exitCode === null && child.signalCode === null) child.kill()
    return exit
  }))
  const owned = new Map(helpers)
  helpers.clear()
  awaitProcessExit(owned)
  closeAllDbs()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('Copilot shared-shim SessionStart deadline', () => {
  it('keeps the generated shared shim syntactically valid CommonJS', () => {
    const fixture = makeFixture()
    const result = spawnSync(process.execPath, ['--check', fixture.shimPath], {
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(result.status, result.stderr).toBe(0)
  })

  it('returns healthy Copilot CLI context before the caller closes stdin', async () => {
    expect(SHIM_SESSION_START_TIMEOUT_MS).toBe(SESSION_START_BUDGET_MS)
    expect(existsSync(BUNDLE), 'build dist/token-goat.mjs before this integration test').toBe(true)
    const fixture = makeFixture()
    const child = startShim(fixture, 'sessionStart')
    const observation = observe(child)
    const input = ` \r\n${JSON.stringify(copilotPayload(fixture.project))}\r\n`
    await sendOpenInput(child, input, true)

    const result = await observation.done
    assertDeadline(result)
    expect(result.code).toBe(0)
    assertSessionStartContext(result.stdout)
  }, 12_000)

  it('returns healthy VS Code context before the caller closes stdin', async () => {
    const fixture = makeFixture()
    const child = startShim(fixture, 'sessionStart')
    const observation = observe(child)
    await sendOpenInput(child, JSON.stringify(vscodePayload(fixture.project)), true)

    const result = await observation.done
    assertDeadline(result)
    expect(result.code).toBe(0)
    assertSessionStartContext(result.stdout)
  }, 12_000)

  it.each([
    ['empty input', ''],
    ['incomplete object', '{"hook_event_name":"SessionStart"'],
  ])('fails open within the budget for %s while stdin remains open', async (_label, input) => {
    const fixture = makeFixture()
    const child = startShim(fixture, 'sessionStart')
    const observation = observe(child)
    if (input !== '') child.stdin.write(input)

    const result = await observation.done
    assertDeadline(result)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('{}')
    expect(result.stderr).toMatch(/SessionStart failed open/i)
  }, 12_000)

  it('fails open promptly for malformed complete JSON and oversized input', async () => {
    for (const input of ['{"hook_event_name":}', JSON.stringify({ data: 'x'.repeat(1024 * 1024) })]) {
      const fixture = makeFixture()
      const child = startShim(fixture, 'sessionStart')
      const observation = observe(child)
      child.stdin.write(input)
      const result = await observation.done

      expect(result.timedOut).toBe(false)
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('{}')
      expect(result.stderr).toMatch(/SessionStart failed open/i)
    }
  }, 12_000)

  it('fails open with a diagnostic when the baked hook entry is missing', async () => {
    const fixture = makeFixture()
    const child = startShim(fixture, 'sessionStart', join(fixture.root, 'missing-entry.mjs'))
    const observation = observe(child)
    child.stdin.end(JSON.stringify(copilotPayload(fixture.project)))

    const result = await observation.done
    assertDeadline(result)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('{}')
    expect(result.stderr).toMatch(/SessionStart failed open.*exited without a response/i)
  }, 12_000)

  it('does not perform a parent filesystem probe of the baked entry', async () => {
    const fixture = makeFixture()
    const prefix = "for (const name of ['existsSync', 'readFileSync', 'statSync']) require('node:fs')[name] = () => { throw new Error('parent filesystem probe') }\n"
    writeFileSync(fixture.shimPath, COPILOT_CLI_HOOK_SCRIPT.replace('\n', '\n' + prefix))
    const entry = join(fixture.root, 'entry.cjs')
    writeFileSync(entry, "process.stdout.write('{\"probeFree\":true}')")
    const child = startShim(fixture, 'sessionStart', entry)
    const observation = observe(child)
    child.stdin.end(JSON.stringify(copilotPayload(fixture.project)))
    const result = await observation.done
    expect(result.stdout).toBe('{}')
    expect(result.stderr).not.toContain('parent filesystem probe')
    expect(result.stderr).not.toContain('failed open')
    expect(result.code).toBe(0)
    assertDeadline(result)
  }, 12_000)

  it('frames split UTF-8 bytes, quoted braces and escaped quotes without stdin EOF', async () => {
    const fixture = makeFixture()
    const entry = join(fixture.root, 'entry.cjs')
    writeFileSync(entry, `
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  const payload = JSON.parse(input)
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: payload.prompt } }))
})
`)
    const prompt = 'é🙂 quoted }{ [ ] and " plus \\\\'
    const input = Buffer.from(JSON.stringify({ ...copilotPayload(fixture.project), prompt }))
    const split = input.indexOf(Buffer.from('🙂')) + 1
    const child = startShim(fixture, 'sessionStart', entry)
    const observation = observe(child)
    child.stdin.write(input.subarray(0, split))
    await new Promise((resolve) => setTimeout(resolve, 20))
    child.stdin.write(input.subarray(split))
    const result = await observation.done
    expect(parseOneObject(result.stdout)).toMatchObject({ additionalContext: prompt })
    expect(result.code).toBe(0)
    assertDeadline(result)
  }, 12_000)

  it.each([
    ['asynchronous non-completion', (pidFile: string) =>
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write('{"partial":'); new Promise(() => {}); setInterval(() => {}, 1000)`],
    ['synchronous blocking', (pidFile: string) =>
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); while (true) {}`],
  ])('terminates its owned helper on %s', async (_label, makeSource) => {
    const fixture = makeFixture()
    const pidFile = join(fixture.root, 'helper.pid')
    const entryPath = join(fixture.root, 'stalled-entry.cjs')
    writeFileSync(entryPath, makeSource(pidFile), 'utf8')
    const child = startShim(fixture, 'sessionStart', entryPath)
    const observation = observe(child)
    child.stdin.end(JSON.stringify(copilotPayload(fixture.project)))

    const result = await observation.done
    assertDeadline(result)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('{}')
    expect(result.stderr).toMatch(/SessionStart failed open.*timed out/i)
    const helperPid = Number(readFileSync(pidFile, 'utf8'))
    expect(Number.isInteger(helperPid)).toBe(true)
    helpers.set(helperPid, statSync(pidFile).mtimeMs)
    expect(isProcessAlive(helperPid), 'the shim must not leave its helper running').toBe(false)
  }, 12_000)

  it('bounds a real built SessionStart blocked on an exclusive SQLite write lock', async () => {
    const fixture = makeFixture()
    const child = startShim(fixture, 'sessionStart')
    child.stdin.end(JSON.stringify(copilotPayload(fixture.project)))
    const seedResult = await observe(child).done
    expect(seedResult.code).toBe(0)
    assertSessionStartContext(seedResult.stdout)

    const dbPath = findGlobalDb(fixture.home)
    expect(dbPath, 'the real hook must initialize its isolated SQLite database').not.toBeNull()
    const db = getDb(dbPath as string)
    db.exec('PRAGMA journal_mode=DELETE')
    db.exec('BEGIN EXCLUSIVE')
    try {
      const child = startShim(fixture, 'sessionStart')
      const observation = observe(child)
      child.stdin.end(JSON.stringify(copilotPayload(fixture.project)))
      const result = await observation.done

      assertDeadline(result)
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('{}')
      expect(result.stderr).toMatch(/SessionStart failed open.*timed out/i)
    } finally {
      db.exec('ROLLBACK')
      db.exec('PRAGMA journal_mode=WAL')
      closeAllDbs()
    }
  }, 16_000)

  it('keeps non-SessionStart events on their existing EOF-delimited input path', async () => {
    const fixture = makeFixture()
    const entryPath = join(fixture.root, 'fast-entry.cjs')
    writeFileSync(entryPath, "process.stdout.write('{}')\n", 'utf8')
    const child = startShim(fixture, 'preToolUse', entryPath)
    const observation = observe(child)
    child.stdin.write(JSON.stringify({ toolName: 'view', toolArgs: { path: 'sample.txt' } }))
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(child.exitCode).toBeNull()
    expect(observation.stdout()).toBe('')
    child.stdin.end()

    const result = await observation.done
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
    parseOneObject(result.stdout)
  }, 10_000)
})
