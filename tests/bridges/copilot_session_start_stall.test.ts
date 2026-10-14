/** HAND-DERIVED integration coverage for the installed shared shim: real built hook entry, open stdin, and isolated hook data. No row asserts an elapsed time: a start is either delivered at startup or fails open with exactly `{}` and is owed to the first tool call (HAND-DERIVED from the deferral contract; the reminder phrases are read off src/session_reminder.ts). Content and framing are checked in-process against the embedded helper text, and each row that load can push to the other outcome asserts both and records the branch with ctx.annotate. */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'

import { afterEach, describe, expect, it } from 'vitest'

import { COPILOT_SESSION_START_HELPERS } from '../../src/bridges/copilot_session_start.js'
import { closeAllDbs, getDb } from '../../src/db.js'
import { SHIM_SESSION_START_TIMEOUT_MS } from '../../src/bridges/shim_common.js'
import { findGlobalDb } from '../helpers/find_global_db.js'
import {
  assertOwedDeliveredOnce, assertTreeDead, BUNDLE, cleanupTrees, contextText, DEADLINE_FAIL_OPEN, fixtureWatchdog, indexTreeFixture, premiseBranch,
  readOwnedPid, alive, treeFixture,
} from '../helpers/copilot_session_start_tree.js'

type Fixture = ReturnType<typeof treeFixture>
type Harness = 'copilot_cli' | 'vscode'

const SESSION_START_BUDGET_MS = 3000
// A shim that produces no output, no exit and no error for this long is stalled; a slow machine stretches the time to each step, not the quiet between steps the watchdog counts.
const QUIET_LIMIT_MS = 30_000
const COPILOT_SESSION = 'copilot-session-start-test'
const VSCODE_SESSION = 'vscode-session-start-test'
const children: ChildProcessWithoutNullStreams[] = []

interface ProcessResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  stdinEnded: boolean
}

function startShim(fixture: Fixture, event: string, entryPath = BUNDLE, extraArgs: string[] = []): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [fixture.shim, event, entryPath, ...extraArgs], {
    cwd: fixture.project,
    env: fixture.env,
    stdio: 'pipe',
    windowsHide: true,
  })
  child.stdin.on('error', () => undefined)
  children.push(child)
  return child
}

function observe(fixture: Fixture, child: ChildProcessWithoutNullStreams): { done: Promise<ProcessResult>; stdout: () => string } {
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const watchdog = fixtureWatchdog(fixture, QUIET_LIMIT_MS, 'shim')
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { watchdog.progress('stdout'); stdout += chunk })
  child.stderr.on('data', (chunk: string) => { watchdog.progress('stderr'); stderr += chunk })
  const done = new Promise<ProcessResult>((resolve, reject) => {
    watchdog.failed.catch(() => {
      timedOut = true
      child.kill()
    })
    child.once('spawn', () => watchdog.progress('spawned'))
    child.once('error', reject)
    child.once('close', (code, signal) => {
      watchdog.progress('closed')
      resolve({ code, signal, stdout, stderr, timedOut, stdinEnded: child.stdin.writableEnded })
    })
  })
  return { done, stdout: () => stdout }
}

function copilotPayload(project: string): Record<string, unknown> {
  return {
    sessionId: COPILOT_SESSION,
    workingDirectory: project,
    source: 'startup',
    initialPrompt: 'Quoted braces }{, quote ", and backslash \\\\ stay inside a JSON string.',
  }
}

function vscodePayload(project: string): Record<string, unknown> {
  return {
    hook_event_name: 'SessionStart',
    session_id: VSCODE_SESSION,
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

async function sendOpenInput(child: ChildProcessWithoutNullStreams, input: string, chunked = false): Promise<void> {
  if (!chunked) {
    child.stdin.write(input)
    return
  }
  const split = Math.max(1, Math.floor(input.length / 2))
  child.stdin.write(input.slice(0, split))
  await new Promise((resolve) => setTimeout(resolve, 20))
  child.stdin.write(input.slice(split))
}

/** The run ended by itself, cleanly: the harness never had to kill it. */
function assertFinished(result: ProcessResult): void {
  expect(result.timedOut, 'the shim made no progress and the watchdog had to kill it').toBe(false)
  expect(result.code, result.stderr).toBe(0)
}

/** A start that failed open: exactly `{}`, the failed-open line, and then the owed path behaves for this session (one delivery if its payload was read, none otherwise). */
async function assertFailedOpen(fixture: Fixture, result: ProcessResult, harness: Harness, sessionId: string): Promise<string | null> {
  assertFinished(result)
  expect(result.stdout).toBe('{}')
  expect(result.stderr).toMatch(/SessionStart failed open/i)
  return assertOwedDeliveredOnce(fixture, harness, sessionId)
}

function assertSessionStartContext(text: string): void {
  expect(text, 'the existing SessionStart routing reminder must survive the new transport').toContain('prefer surgical reads')
  expect(text).toContain('token-goat index .')
}

/** A healthy start is delivered at startup (A) or fails open and is owed to the first tool call exactly once (B); both carry the reminder, and the shim did not wait for stdin to close. */
async function assertDeliveredOrOwed(
  ctx: { annotate: (message: string) => Promise<unknown> }, fixture: Fixture, result: ProcessResult, harness: Harness, sessionId: string,
): Promise<void> {
  assertFinished(result)
  expect(result.stdinEnded, 'the caller never closed stdin, so the shim must have exited on its own').toBe(false)
  if (result.stdout !== '{}') {
    await ctx.annotate('branch: A (delivered at startup)')
    expect(result.stderr, 'a delivered start must not also report that it failed open').not.toMatch(/SessionStart failed open/i)
    assertSessionStartContext(JSON.stringify(parseOneObject(result.stdout)))
    return
  }
  const owed = await assertFailedOpen(fixture, result, harness, sessionId)
  await ctx.annotate(`branch: B (failed open, payload read=${String(owed !== null)})`)
  if (owed !== null) assertSessionStartContext(contextText(owed))
}

/** The embedded reader, evaluated in-process against a stream the test controls, so framing is judged without a clock or a child. */
function loadReader(stdin: PassThrough): (timeoutMs: number) => Promise<string> {
  const sandbox: Record<string, unknown> = { process: { stdin }, Buffer, Error, setTimeout, clearTimeout, setImmediate }
  runInNewContext(COPILOT_SESSION_START_HELPERS, sandbox)
  return sandbox['readSessionStartInput'] as (timeoutMs: number) => Promise<string>
}

// Far beyond any test's runtime: the reader's own deadline never decides these rows.
const HUGE_TIMEOUT_MS = 2 ** 31 - 1

type Outcome = { state: 'pending' } | { state: 'resolved'; value: string } | { state: 'rejected'; message: string }

async function turns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** What a reader promise did within a bounded number of event-loop turns, never a clock: a reader that settles on the data it was given does so within a few turns however slow the machine is, and one that does not is reported as pending instead of hanging the row. */
async function outcomeOf(promise: Promise<string>): Promise<Outcome> {
  let outcome: Outcome = { state: 'pending' }
  promise.then((value) => { outcome = { state: 'resolved', value } }, (error: Error) => { outcome = { state: 'rejected', message: error.message } })
  for (let turn = 0; turn < 50 && outcome.state === 'pending'; turn += 1) await turns(1)
  return outcome
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  closeAllDbs()
  await cleanupTrees()
}, 0)

describe('Copilot shared-shim SessionStart deadline', { timeout: 0 }, () => {
  it('keeps the generated shared shim syntactically valid CommonJS', () => {
    const fixture = treeFixture()
    const result = spawnSync(process.execPath, ['--check', fixture.shim], {
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(result.status, result.stderr).toBe(0)
  })

  it('returns healthy Copilot CLI context, or owes it once, before the caller closes stdin', { timeout: 0 }, async (ctx) => {
    expect(SHIM_SESSION_START_TIMEOUT_MS).toBe(SESSION_START_BUDGET_MS)
    expect(existsSync(BUNDLE), 'build dist/token-goat.mjs before this integration test').toBe(true)
    const fixture = treeFixture()
    const child = startShim(fixture, 'sessionStart')
    const observation = observe(fixture, child)
    await sendOpenInput(child, ` \r\n${JSON.stringify(copilotPayload(fixture.project))}\r\n`, true)
    await assertDeliveredOrOwed(ctx, fixture, await observation.done, 'copilot_cli', COPILOT_SESSION)
  })

  it('returns healthy VS Code context, or owes it once, before the caller closes stdin', { timeout: 0 }, async (ctx) => {
    const fixture = treeFixture()
    const child = startShim(fixture, 'sessionStart')
    const observation = observe(fixture, child)
    await sendOpenInput(child, JSON.stringify(vscodePayload(fixture.project)), true)
    await assertDeliveredOrOwed(ctx, fixture, await observation.done, 'vscode', VSCODE_SESSION)
  })

  it('owes a healthy start whose deadline had already passed when its payload arrived', { timeout: 0 }, async (ctx) => {
    const fixture = treeFixture()
    const child = startShim(fixture, 'sessionStart', BUNDLE, [`--session-start-deadline=${String(Date.now() - 1000)}`])
    const observation = observe(fixture, child)
    await sendOpenInput(child, JSON.stringify(copilotPayload(fixture.project)))
    await assertDeliveredOrOwed(ctx, fixture, await observation.done, 'copilot_cli', COPILOT_SESSION)
  })

  it.each([
    ['empty input', ''],
    ['incomplete object', '{"hook_event_name":"SessionStart"'],
  ])('fails open for %s while stdin remains open, and nothing is owed', { timeout: 0 }, async (_label, input) => {
    const fixture = treeFixture()
    const child = startShim(fixture, 'sessionStart')
    const observation = observe(fixture, child)
    if (input !== '') child.stdin.write(input)

    const result = await observation.done
    expect(result.stdinEnded).toBe(false)
    expect(await assertFailedOpen(fixture, result, 'copilot_cli', COPILOT_SESSION), 'no payload was framed, so there is no start to owe').toBeNull()
  })

  it('fails open for malformed complete JSON and for oversized input, and nothing is owed', { timeout: 0 }, async () => {
    for (const input of ['{"hook_event_name":}', JSON.stringify({ data: 'x'.repeat(1024 * 1024) })]) {
      const fixture = treeFixture()
      const child = startShim(fixture, 'sessionStart')
      const observation = observe(fixture, child)
      child.stdin.write(input)
      const result = await observation.done
      expect(await assertFailedOpen(fixture, result, 'copilot_cli', COPILOT_SESSION)).toBeNull()
    }
  })

  it('fails open with a diagnostic when the baked hook entry is missing, and owes the start once', { timeout: 0 }, async (ctx) => {
    const fixture = treeFixture()
    const child = startShim(fixture, 'sessionStart', join(fixture.root, 'missing-entry.mjs'))
    const observation = observe(fixture, child)
    child.stdin.end(JSON.stringify(copilotPayload(fixture.project)))

    const result = await observation.done
    // Load can spend the shim's budget before it reaches the missing entry; then the deadline is what it reports.
    if (/exited without a response/i.test(result.stderr)) await ctx.annotate('branch: strong (the missing entry was reported)')
    else {
      await ctx.annotate('branch: weak (the deadline fired first)')
      expect(result.stderr).toMatch(DEADLINE_FAIL_OPEN)
    }
    await assertFailedOpen(fixture, result, 'copilot_cli', COPILOT_SESSION)
  })

  it('does not perform a parent filesystem probe of the baked entry', { timeout: 0 }, async (ctx) => {
    const fixture = treeFixture()
    const prefix = "for (const name of ['existsSync', 'readFileSync', 'statSync']) require('node:fs')[name] = () => { throw new Error('parent filesystem probe') }\n"
    writeFileSync(fixture.shim, readFileSync(fixture.shim, 'utf8').replace('\n', '\n' + prefix))
    const entry = join(fixture.root, 'entry.cjs')
    writeFileSync(entry, "process.stdout.write('{\"probeFree\":true}')")
    const child = startShim(fixture, 'sessionStart', entry)
    const observation = observe(fixture, child)
    child.stdin.end(JSON.stringify(copilotPayload(fixture.project)))
    const result = await observation.done
    assertFinished(result)
    expect(result.stderr).not.toContain('parent filesystem probe')
    expect(result.stdout).toBe('{}')
    if (result.stderr.includes('failed open')) {
      await ctx.annotate('branch: weak (the deadline fired first)')
      expect(result.stderr).toMatch(DEADLINE_FAIL_OPEN)
      await assertOwedDeliveredOnce(fixture, 'copilot_cli', COPILOT_SESSION)
    } else await ctx.annotate('branch: strong (the entry ran probe-free)')
  })

  describe('payload framing, in-process', () => {
    it('frames split UTF-8 bytes, quoted braces and escaped quotes without stdin EOF', async () => {
      const stdin = new PassThrough()
      const pending = loadReader(stdin)(HUGE_TIMEOUT_MS)
      const prompt = 'é🙂 quoted }{ [ ] and " plus \\\\'
      const input = Buffer.from(JSON.stringify({ ...copilotPayload('p'), prompt }))
      const split = input.indexOf(Buffer.from('🙂')) + 1
      try {
        stdin.write(input.subarray(0, split))
        await turns(5)
        stdin.write(input.subarray(split))
        const outcome = await outcomeOf(pending)
        expect(outcome, 'the object must be framed while stdin is still open').toMatchObject({ state: 'resolved', value: input.toString('utf8') })
        expect(JSON.parse((outcome as { value: string }).value)).toMatchObject({ prompt })
      } finally {
        stdin.end()
      }
    })

    it('ignores leading and trailing whitespace around one object', async () => {
      const stdin = new PassThrough()
      const pending = loadReader(stdin)(HUGE_TIMEOUT_MS)
      const object = JSON.stringify(vscodePayload('p'))
      try {
        stdin.write(` \r\n\t${object}\r\n`)
        expect(await outcomeOf(pending)).toEqual({ state: 'resolved', value: object })
      } finally {
        stdin.end()
      }
    })

    it.each([
      ['empty input then EOF', '', 'stdin closed without input', true],
      ['an incomplete object then EOF', '{"a":', 'stdin closed before the JSON object was complete', true],
      ['trailing data after the object', '{"a":1} x', 'input contained trailing data', false],
      ['a non-object', '[1]', 'input was not a JSON object', false],
      ['mismatched closers', '{"a":]', 'input contained malformed JSON', false],
      ['a complete but unparseable object', '{"a":}', 'input contained malformed JSON', false],
      ['more than 1 MiB', `{"a":"${'x'.repeat(1024 * 1024)}"}`, 'input exceeded 1 MiB', false],
    ])('rejects %s', async (_label, input, reason, endInput) => {
      const stdin = new PassThrough()
      const pending = loadReader(stdin)(HUGE_TIMEOUT_MS)
      try {
        stdin.write(input)
        if (endInput) stdin.end()
        expect(await outcomeOf(pending)).toEqual({ state: 'rejected', message: reason })
      } finally {
        stdin.end()
      }
    })

    it('resolves a payload already buffered when its deadline is already past', async () => {
      const stdin = new PassThrough()
      const object = JSON.stringify(copilotPayload('p'))
      stdin.write(object)
      expect(await outcomeOf(loadReader(stdin)(0))).toEqual({ state: 'resolved', value: object })
    })

    it('rejects with the deadline when nothing arrives', async () => {
      const stdin = new PassThrough()
      const promise = loadReader(stdin)(0)
      // The reader's own zero-length timer must fire, so each step waits on a real timer tick; the count of ticks is the bound, never a clock reading.
      let outcome: Outcome = { state: 'pending' }
      promise.then((value) => { outcome = { state: 'resolved', value } }, (error: Error) => { outcome = { state: 'rejected', message: error.message } })
      for (let tick = 0; tick < 50 && outcome.state === 'pending'; tick += 1) await new Promise((resolve) => setTimeout(resolve, 1))
      expect(outcome).toEqual({ state: 'rejected', message: 'input deadline exceeded' })
    })
  })

  it.for([
    ['asynchronous non-completion', (pidFile: string) =>
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write('{"partial":'); new Promise(() => {}); setInterval(() => {}, 1000)`],
    ['synchronous blocking', (pidFile: string) =>
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); while (true) {}`],
  ] as const)('terminates its owned helper on %s', { timeout: 0 }, async ([_label, makeSource], ctx) => {
    const fixture = treeFixture()
    const pidFile = join(fixture.root, 'helper.pid')
    const entryPath = join(fixture.root, 'stalled-entry.cjs')
    writeFileSync(entryPath, makeSource(pidFile), 'utf8')
    const child = startShim(fixture, 'sessionStart', entryPath)
    const observation = observe(fixture, child)
    child.stdin.end(JSON.stringify(copilotPayload(fixture.project)))

    const result = await observation.done
    assertFinished(result)
    if (!await premiseBranch(ctx, fixture, result, [pidFile], COPILOT_SESSION)) return
    expect(result.stdout).toBe('{}')
    expect(result.stderr).toMatch(/SessionStart failed open.*timed out/i)
    expect(alive(readOwnedPid(pidFile)), 'the shim must not leave its helper running').toBe(false)
    assertTreeDead(fixture)
    await assertOwedDeliveredOnce(fixture, 'copilot_cli', COPILOT_SESSION)
  })

  it('bounds a real built SessionStart blocked on an exclusive SQLite write lock, and owes it once', { timeout: 0 }, async () => {
    const fixture = treeFixture()
    indexTreeFixture(fixture)
    const dbPath = findGlobalDb(fixture.env['TOKEN_GOAT_HOME'] as string)
    expect(dbPath, 'indexing must initialize the isolated SQLite database').not.toBeNull()
    const db = getDb(dbPath as string)
    db.exec('PRAGMA journal_mode=DELETE')
    db.exec('BEGIN EXCLUSIVE')
    let result: ProcessResult
    try {
      const child = startShim(fixture, 'sessionStart')
      const observation = observe(fixture, child)
      child.stdin.end(JSON.stringify(copilotPayload(fixture.project)))
      result = await observation.done
    } finally {
      db.exec('ROLLBACK')
      db.exec('PRAGMA journal_mode=WAL')
      closeAllDbs()
    }
    // The owed tool calls open the same database, so they run once the lock is released.
    expect(result.stderr).toMatch(DEADLINE_FAIL_OPEN)
    await assertFailedOpen(fixture, result, 'copilot_cli', COPILOT_SESSION)
  })

  it('keeps non-SessionStart events on their existing EOF-delimited input path', { timeout: 0 }, async () => {
    const fixture = treeFixture()
    const entryPath = join(fixture.root, 'fast-entry.cjs')
    writeFileSync(entryPath, "process.stdout.write('{}')\n", 'utf8')
    const child = startShim(fixture, 'preToolUse', entryPath)
    const observation = observe(fixture, child)
    child.stdin.write(JSON.stringify({ toolName: 'view', toolArgs: { path: 'sample.txt' } }))
    await new Promise((resolve) => setTimeout(resolve, 150))

    // Nothing can make a run that was never given EOF exit sooner, so a stalled machine only makes this check easier to satisfy.
    expect(child.exitCode).toBeNull()
    expect(observation.stdout()).toBe('')
    child.stdin.end()

    const result = await observation.done
    assertFinished(result)
    parseOneObject(result.stdout)
  })
})
