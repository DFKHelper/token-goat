/** HAND-DERIVED adversity: actual built hook -> reconcileProject -> getTrackedFiles -> runGit, with only the Git executable boundary replaced. This is not a healthy-handler substitute. No row asserts elapsed time: a healthy start is delivered at startup OR is owed and delivered by the first post_tool_use, exactly once (HAND-DERIVED from the deferral contract, FORMAT-DERIVED from src/hooks_session.ts::deliverOwedSessionStart; the reminder phrase is read off src/session_reminder.ts NOTE_REMINDER). A hung-helper row holds the invariant that every pid file names a dead process and asserts two branches, recorded with ctx.annotate: the premise was reached (full assertions), or it was not and the start failed open with exactly `{}` on a deadline, every pid is dead and the owed path behaves. No row skips. */
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'

import { afterEach, expect, it } from 'vitest'

import { COPILOT_SESSION_START_HELPERS } from '../../src/bridges/copilot_session_start.js'
import { COPILOT_CLI_HOOK_SCRIPT } from '../../src/bridges/copilot_cli.js'
import { startBudgetAtShimStart } from '../helpers/shim_deadline.js'
import { buildLegacyStartupOwner } from '../helpers/legacy_startup_owner.js'
import { alive, startBegan, assertInstalledResidentBypass, assertOwedDeliveredOnce, assertTreeDead, BUNDLE, buildWindowsBoundary, cleanupTrees, contextText, fileAppears, fixtureWatchdog, indexTreeFixture, installStartupOwner, ownedPids, readOwnedPid, runInstalledStartup, runTreeShim, premiseBranch, DEADLINE_FAIL_OPEN, HANG_BACKSTOP_MS, treeFixture } from '../helpers/copilot_session_start_tree.js'

// Cleanup is synchronous process-table work, so no fixed hook wall-clock bound applies: a loaded machine makes it slow, never wrong.
afterEach(cleanupTrees, 0)

it.runIf(process.platform === 'win32').each(['cmd', 'powershell', 'vscode', 'alias'] as const)(
  'runs the installed native %s startup before stdin EOF',
  async (surface) => {
    const fixture = treeFixture()
    const entry = join(fixture.root, 'entry 日本 with spaces.cjs')
    const entered = join(fixture.root, 'helper.pid')
    const payloadFile = join(fixture.root, 'payload.json')
    writeFileSync(entry, `
require('node:fs').writeFileSync(${JSON.stringify(entered)}, String(process.pid))
require('node:fs').writeFileSync(${JSON.stringify(payloadFile)}, require('node:fs').readFileSync(0, 'utf8'))
process.stdout.write('{"hookSpecificOutput":{"additionalContext":"installed-owned"}}')
`)
    const vscode = surface === 'vscode' || surface === 'alias'
    const sessionId = vscode ? 'installed-vscode' : 'installed-cli'
    const run = runInstalledStartup({
      fixture, entry, shell: surface === 'powershell' ? 'powershell' : 'cmd', alias: surface === 'alias', quietLimitMs: HANG_BACKSTOP_MS,
      payload: vscode
        ? { hook_event_name: 'SessionStart', session_id: sessionId, cwd: fixture.project }
        : { sessionId, workingDirectory: fixture.project },
    })
    // Framing without EOF: the entry reads its stdin to the end, so the payload file appearing while this test still holds the outer stdin open proves a framed payload reached it.
    const watch = fileAppears(payloadFile, fixtureWatchdog(fixture, HANG_BACKSTOP_MS, 'installed startup'))
    await Promise.race([watch.appeared, run.done.catch(() => undefined)])
    watch.stop()
    const result = await run.done
    assertTreeDead(fixture)
    if (result.stdout === '{}') {
      await assertOwedDeliveredOnce(fixture, vscode ? 'vscode' : 'copilot_cli', sessionId)
    } else {
      expect(result.stdout).toBe(vscode
        ? '{"hookSpecificOutput":{"additionalContext":"installed-owned"}}'
        : '{"additionalContext":"installed-owned"}')
      expect(result.stderr).toBe('')
      expect(alive(readOwnedPid(entered)), 'installed canonical helper survived before teardown').toBe(false)
      expect(JSON.parse(readFileSync(payloadFile, 'utf8'))).toMatchObject({ session_id: sessionId, cwd: fixture.project })
    }
  }, 0,
)

it.runIf(process.platform === 'win32').each(['', '{"sessionId":'])('bounds installed native incomplete input %j', async (input) => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'entry.cjs')
  const entered = join(fixture.root, 'helper.pid')
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(entered)}, String(process.pid)); process.stdout.write('{}')`)
  const result = await runInstalledStartup({ fixture, entry, input, quietLimitMs: HANG_BACKSTOP_MS }).done
  expect(result.stdout).toBe('{}')
  expect(result.stderr).toContain('startup input deadline exceeded')
  expect(existsSync(entered)).toBe(false)
}, 0)

it.runIf(process.platform === 'win32')('bypasses an available real resident for installed startup with and without EOF', async () => {
  const fixture = treeFixture()
  indexTreeFixture(fixture)
  await assertInstalledResidentBypass(fixture, HANG_BACKSTOP_MS)
}, 0)

it.runIf(process.platform === 'win32')('allows bounded owner metadata around a near-limit installed response', async () => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'entry.cjs')
  writeFileSync(entry, "process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:'x'.repeat(1024 * 1024 - 100)}}))")
  const result = await runInstalledStartup({ fixture, entry, quietLimitMs: HANG_BACKSTOP_MS }).done
  assertTreeDead(fixture)
  if (result.stdout === '{}') {
    await assertOwedDeliveredOnce(fixture, 'copilot_cli', 'installed-startup')
  } else {
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(JSON.stringify({ additionalContext: 'x'.repeat(1024 * 1024 - 100) }))
  }
}, 0)

it('keeps the exact cleanup-reserve boundary before starting the supervisor', () => {
  const observeSupervisorSpawn = (remainingMs: number): unknown[][] => {
    const attempts: unknown[][] = []
    const spawn = (...args: unknown[]): void => {
      attempts.push(args)
      throw new Error('spawn observed')
    }
    runInNewContext(`
${COPILOT_SESSION_START_HELPERS}
runBoundedSessionStart('entry.cjs', 'sessionStart', {}, 'copilot_cli', remainingMs).catch(() => {})
`, {
      Date: { now: () => 0 },
      process: { env: {}, execPath: process.execPath, platform: 'win32', arch: process.arch },
      __dirname: 'C:\\fixture',
      require: (specifier: string) => {
        if (specifier === 'node:child_process') return { spawn }
        if (specifier === 'node:path') return createRequire(import.meta.url)(specifier)
        throw new Error(`unexpected require: ${specifier}`)
      },
      remainingMs,
      spawn,
      attempts,
    })
    return attempts
  }

  expect(observeSupervisorSpawn(1000)).toHaveLength(0)
  expect(observeSupervisorSpawn(1001)).toHaveLength(1)
})

it.for(['direct', ...(process.platform === 'win32' ? ['installed'] : [])])('terminates the real indexed SessionStart helper and its blocked Git descendant (%s)', { timeout: 0 }, async (surface, ctx) => {
  const fixture = treeFixture()
  indexTreeFixture(fixture)
  const helperFile = join(fixture.root, 'helper.pid')
  const gitFile = join(fixture.root, 'git.pid')
  const invocation = join(fixture.root, 'git.json')
  const blocker = join(fixture.root, 'blocking-git.cjs')
  writeFileSync(blocker, `require('node:fs').writeFileSync(${JSON.stringify(gitFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
  const nativeBoundary = process.platform === 'win32' ? buildWindowsBoundary(fixture.root) : undefined
  const entry = join(fixture.root, 'entry.cjs')
  writeFileSync(entry, `
const fs = require('node:fs')
const cp = require('node:child_process')
fs.writeFileSync(${JSON.stringify(helperFile)}, String(process.pid))
const original = cp.spawnSync
cp.spawnSync = function(command, args, options) {
  if (command === 'git' && args.includes('ls-files')) {
    fs.writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({ args, stack: new Error().stack }))
    ${nativeBoundary ? `return original(${JSON.stringify(nativeBoundary)}, ['hold', ${JSON.stringify(gitFile)}], { ...options, detached: true })` : ''}
    // Windows' libuv job may close ordinary descendants when Node dies. A detached
    // executable exercises the process-tree ownership gap independently of that job.
    const descendant = cp.spawn(process.execPath, [${JSON.stringify(blocker)}], {
      ...options, stdio: 'inherit', detached: process.platform === 'win32',
    })
    descendant.unref()
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
  return original(command, args, options)
}
require('node:module').syncBuiltinESMExports()
process.argv[1] = ${JSON.stringify(BUNDLE)}
import(${JSON.stringify(pathToFileURL(BUNDLE).href)})
`)
  const result = await (surface === 'installed' ? runInstalledStartup({ fixture, entry, quietLimitMs: HANG_BACKSTOP_MS }) : runTreeShim({ fixture, entry, quietLimitMs: HANG_BACKSTOP_MS })).done
  assertTreeDead(fixture)
  if (!await premiseBranch(ctx, fixture, result, [helperFile, gitFile, invocation], surface === 'installed' ? 'installed-startup' : 'owned-tree')) return
  const helperPid = readOwnedPid(helperFile)
  const gitPid = readOwnedPid(gitFile)
  const reached: unknown = JSON.parse(readFileSync(invocation, 'utf8'))
  expect(reached).toMatchObject({ args: expect.arrayContaining(['ls-files']) })
  expect(readFileSync(invocation, 'utf8')).toContain('reconcile')
  expect(alive(helperPid), 'owned canonical helper survived').toBe(false)
  expect(alive(gitPid), 'owned Git descendant survived').toBe(false)
  expect(result.stdout).toBe('{}')
  expect(result.stderr).toMatch(/timed out/)
  expect(result.stderr).not.toContain('cleanup failed')
})

it.runIf(process.platform === 'win32')('contains an independent native breakaway attempt across nested jobs', async (ctx) => {
  const fixture = treeFixture()
  const boundary = buildWindowsBoundary(fixture.root)
  const descendant = join(fixture.root, 'escaped.pid')
  const attempted = join(fixture.root, 'breakaway.result')
  const entry = join(fixture.root, 'entry 日本 with spaces.cjs')
  writeFileSync(entry, `
const result = require('node:child_process').spawnSync(${JSON.stringify(boundary)}, ['breakaway', ${JSON.stringify(descendant)}, ${JSON.stringify(attempted)}], { stdio: 'inherit' })
if (result.status !== 0) process.exit(1)
process.stdout.write('{"hookSpecificOutput":{"additionalContext":"breakaway-denied"}}')
`)
  const result = await runTreeShim({ fixture, entry, quietLimitMs: HANG_BACKSTOP_MS }).done
  assertTreeDead(fixture)
  if (!await premiseBranch(ctx, fixture, result, [attempted], 'owned-tree')) return
  // Check before teardown: a passing outer harness job must not clean up for us.
  const attempt = readFileSync(attempted, 'utf8')
  if (attempt.startsWith('created:')) {
    // Windows may break away from libuv's inner permissive job, but not the owner's strict ancestor job. Successful creation is not proof of escape.
    const pid = Number(attempt.slice('created:'.length))
    ownedPids.push(pid)
    expect(Number.isInteger(pid) && pid > 0).toBe(true)
    expect(alive(pid), 'native breakaway descendant survived before teardown').toBe(false)
  } else {
    expect(attempt).toBe('denied:5')
    expect(existsSync(descendant)).toBe(false)
  }
  if (result.stdout === '{}') {
    await assertOwedDeliveredOnce(fixture, 'copilot_cli', 'owned-tree')
  } else {
    expect(result.stdout).toBe('{"additionalContext":"breakaway-denied"}')
    expect(result.stderr).toBe('')
  }
}, 0)

it.runIf(process.platform === 'win32')('rejects breakaway from the strict job without an intervening libuv job', async (ctx) => {
  const fixture = treeFixture()
  const boundary = buildWindowsBoundary(fixture.root)
  const descendant = join(fixture.root, 'descendant.pid')
  const attempted = join(fixture.root, 'breakaway.result')
  const result = spawnSync(installStartupOwner(fixture.root), [
    '--session-start-owner-v1', String(Date.now() + 3000), boundary, 'direct-breakaway', descendant, attempted,
  ], { input: '{}', env: fixture.env, encoding: 'utf8', windowsHide: true, timeout: HANG_BACKSTOP_MS })
  // The spawn timeout is the hang backstop, not a measurement: the owner bounds itself at 3000 ms. The owner refuses a deadline with 1000 ms or less left, and the 3000 ms budget it was given can run out under the helper; machine load turns either into a fail-open exit 1 with no acknowledgement, which is the premise missing, not the containment broken.
  if (result.status === 1 && /insufficient time for process-tree cleanup|hook helper timed out/.test(result.stderr)) {
    expect(result.stdout).toBe('')
    await ctx.annotate('branch: weak (the owner failed open on its own deadline)')
    if (existsSync(attempted) && readFileSync(attempted, 'utf8').startsWith('created:')) {
      const created = Number(readFileSync(attempted, 'utf8').slice('created:'.length))
      ownedPids.push(created)
      expect(alive(created), 'a breakaway descendant survived the failed-open owner').toBe(false)
    }
    return
  }
  await ctx.annotate('branch: strong (owner acknowledged)')
  expect(result.status, result.stderr).toBe(0)
  const attempt = readFileSync(attempted, 'utf8')
  if (attempt.startsWith('created:')) ownedPids.push(Number(attempt.slice('created:'.length)))
  expect(attempt).toBe('denied:5')
  expect(existsSync(descendant)).toBe(false)
  expect(JSON.parse(result.stdout)).toMatchObject({
    protocol: 'tg-session-start-owner-v1', capability: 'atomic-job-list',
    activeProcesses: 0, rootExited: true, pipesDrained: true, candidate: {},
  })
}, 0)

it.runIf(process.platform === 'win32').for(['before-input', 'at-creation', 'with-live-descendant'])('closes the owned job after abrupt native owner death %s', { timeout: 0 }, async (phase, ctx) => {
  const fixture = treeFixture()
  const native = installStartupOwner(fixture.root)
  const entry = join(fixture.root, 'entry.cjs')
  const rootPidFile = join(fixture.root, 'root.pid')
  const descendantFile = join(fixture.root, 'descendant.pid')
  const boundary = buildWindowsBoundary(fixture.root)
  writeFileSync(entry, `
require('node:fs').writeFileSync(${JSON.stringify(rootPidFile)}, String(process.pid))
require('node:child_process').spawnSync(${JSON.stringify(boundary)}, ['hold', ${JSON.stringify(descendantFile)}], { stdio: 'inherit', detached: true })
`)
  const owner = spawn(native, ['--session-start-owner-v1', String(Date.now() + 3000), process.execPath, entry, 'hook', 'session_start'], {
    env: fixture.env, stdio: 'pipe', windowsHide: true,
  })
  if (owner.pid !== undefined) ownedPids.push(owner.pid)
  owner.stdin.on('error', () => undefined)
  let stdout = ''
  owner.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  const watchdog = fixtureWatchdog(fixture, HANG_BACKSTOP_MS, 'abrupt native owner death')
  owner.stdout.on('data', () => watchdog.progress('owner stdout'))
  owner.stderr.on('data', () => watchdog.progress('owner stderr'))
  const closed = Promise.race([new Promise<void>((resolve, reject) => {
    owner.once('close', () => { watchdog.progress('owner closed'); resolve() })
    owner.once('error', reject)
  }), watchdog.failed])
  const waitUntil = async (condition: () => boolean, state?: () => string): Promise<void> => {
    let seen = state?.()
    while (!condition()) {
      const now = state?.()
      if (now !== seen) { seen = now; watchdog.progress(`state changed: ${String(now)}`) }
      await Promise.race([new Promise((resolve) => setTimeout(resolve, 5)), watchdog.failed])
    }
    watchdog.progress('awaited condition held')
  }
  if (phase === 'with-live-descendant') {
    owner.stdin.end('{}')
    let ownerGone = false
    owner.once('close', () => { ownerGone = true })
    await waitUntil(() => existsSync(descendantFile) || ownerGone)
    if (!existsSync(descendantFile)) {
      // Machine load let the owner reach its own deadline before the helper ran: it closed the job itself, so the invariant left is that nothing it started survives.
      await ctx.annotate('branch: weak (the owner reached its own deadline before the descendant existed)')
      await closed
      expect(stdout).toBe('')
      await waitUntil(() => !existsSync(rootPidFile) || !alive(readOwnedPid(rootPidFile)))
      return
    }
    await ctx.annotate('branch: strong (descendant live when the owner was killed)')
    expect(alive(readOwnedPid(rootPidFile))).toBe(true)
    expect(alive(readOwnedPid(descendantFile))).toBe(true)
  } else if (phase === 'at-creation') {
    // Race owner termination against canonical process creation, without a spawn-then-assign seam or a test-only pause in the production owner.
    owner.stdin.end('{}')
    await new Promise((resolve) => setTimeout(resolve, 5))
  } else {
    await new Promise<void>((resolve) => owner.once('spawn', resolve))
  }
  owner.kill('SIGKILL')
  await closed
  expect(stdout).toBe('')
  if (phase === 'with-live-descendant') {
    await waitUntil(() => !alive(readOwnedPid(rootPidFile)) && !alive(readOwnedPid(descendantFile)), () => `${String(alive(readOwnedPid(rootPidFile)))}/${String(alive(readOwnedPid(descendantFile)))}`)
  } else if (phase === 'at-creation') {
    await waitUntil(() =>
      (!existsSync(rootPidFile) || !alive(readOwnedPid(rootPidFile)))
      && (!existsSync(descendantFile) || !alive(readOwnedPid(descendantFile))))
  } else {
    expect(existsSync(rootPidFile), 'canonical work ran before complete input').toBe(false)
  }
})

it.runIf(process.platform === 'win32')('rejects an incompatible built native protocol before canonical execution', async (ctx) => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'entry.cjs')
  const entered = join(fixture.root, 'entered')
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(entered)}, 'yes'); process.stdout.write('{}')`)
  const shim = readFileSync(fixture.shim, 'utf8')
  writeFileSync(fixture.shim, shim.replace("['--session-start-owner-v1', String(deadline), process.execPath, ...args]", "['--selftest']"))
  const result = await runTreeShim({ fixture, entry, quietLimitMs: HANG_BACKSTOP_MS }).done
  expect(result.stdout).toBe('{}')
  expect(existsSync(entered)).toBe(false)
  assertTreeDead(fixture)
  if (!result.stderr.includes('incompatible protocol or unverified cleanup')) {
    expect(result.stderr).toMatch(DEADLINE_FAIL_OPEN)
    await ctx.annotate('branch: weak (the deadline fired before the protocol check)')
    await assertOwedDeliveredOnce(fixture, 'copilot_cli', 'owned-tree')
    return
  }
  await ctx.annotate('branch: strong (protocol refused)')
}, 0)

it.runIf(process.platform === 'win32')('rejects the actual owner argv in a built legacy binary, with a separator negative control', async (ctx) => {
  const fixture = treeFixture()
  const legacy = buildLegacyStartupOwner(fixture.root)
  copyFileSync(legacy, installStartupOwner(fixture.root))
  const entry = join(fixture.root, 'entry 日本 with spaces.cjs')
  const entered = join(fixture.root, 'canonical-entered')
  const pidFile = join(fixture.root, 'canonical.pid')
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(entered)}, 'yes'); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write('{}')`)
  const assertNoCanonical = (): void => {
    expect(existsSync(entered), 'canonical marker must be absent').toBe(false)
    expect(existsSync(pidFile), 'canonical PID must be absent').toBe(false)
  }
  expect(readFileSync(fixture.shim, 'utf8')).toBe(startBudgetAtShimStart(COPILOT_CLI_HOOK_SCRIPT))
  const result = await runTreeShim({ fixture, entry, quietLimitMs: HANG_BACKSTOP_MS }).done
  assertNoCanonical()
  expect(result.stdout).toBe('{}')
  assertTreeDead(fixture)
  if (!result.stderr.includes('native startup owner failed')) {
    expect(result.stderr).toMatch(DEADLINE_FAIL_OPEN)
    await ctx.annotate('branch: weak (the deadline fired before the legacy owner was refused)')
    await assertOwedDeliveredOnce(fixture, 'copilot_cli', 'owned-tree')
    return
  }
  await ctx.annotate('branch: strong (legacy owner refused)')

  const argv = "['--session-start-owner-v1', String(deadline), process.execPath, ...args]"
  expect(COPILOT_CLI_HOOK_SCRIPT).toContain(argv)
  writeFileSync(fixture.shim, startBudgetAtShimStart(COPILOT_CLI_HOOK_SCRIPT).replace(argv,
    "['--session-start-owner-v1', String(deadline), '--', process.execPath, ...args]"))
  const unsafe = await runTreeShim({ fixture, entry, quietLimitMs: HANG_BACKSTOP_MS }).done
  expect(unsafe.stdout).toBe('{}')
  assertTreeDead(fixture)
  if (!unsafe.stderr.includes('incompatible protocol or unverified cleanup')) {
    expect(unsafe.stderr).toMatch(DEADLINE_FAIL_OPEN)
    await ctx.annotate('branch: weak (the deadline fired before the separator control ran)')
    await assertOwedDeliveredOnce(fixture, 'copilot_cli', 'owned-tree')
    return
  }
  if (!await premiseBranch(ctx, fixture, unsafe, [entered, pidFile], 'owned-tree')) return
  expect(() => assertNoCanonical()).toThrow(/canonical marker must be absent/)
  expect(existsSync(pidFile)).toBe(true)
  expect(alive(readOwnedPid(pidFile))).toBe(false)
}, 0)

it.runIf(process.platform === 'win32')('fails open on native atomic process-creation failure without canonical execution', async (ctx) => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'entry.cjs')
  const entered = join(fixture.root, 'entered')
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(entered)}, 'yes'); process.stdout.write('{}')`)
  const shim = readFileSync(fixture.shim, 'utf8')
  writeFileSync(fixture.shim, shim.replace('\n', "\nObject.defineProperty(process, 'execPath', { value: 'C:\\\\missing-startup-node\\\\node.exe' });\n"))
  const result = await runTreeShim({ fixture, entry, quietLimitMs: HANG_BACKSTOP_MS }).done
  expect(result.stdout).toBe('{}')
  expect(existsSync(entered)).toBe(false)
  assertTreeDead(fixture)
  if (!result.stderr.includes('startup job association/process creation failed')) {
    expect(result.stderr).toMatch(DEADLINE_FAIL_OPEN)
    await ctx.annotate('branch: weak (the deadline fired before process creation was attempted)')
    await assertOwedDeliveredOnce(fixture, 'copilot_cli', 'owned-tree')
    return
  }
  await ctx.annotate('branch: strong (process creation failed open)')
}, 0)

it.for([
  ['blocks', false], ['exits', false],
  ...(process.platform === 'win32' ? [['blocks', true], ['exits', true], ['crashes', true]] as const : []),
] as const)('cleans descendants retaining stdout when the helper %s (installed=%s)', { timeout: 0 }, async ([behavior, installed], ctx) => {
  const fixture = treeFixture()
  const helperFile = join(fixture.root, 'helper.pid')
  const descendantFile = join(fixture.root, 'descendant.pid')
  const entry = join(fixture.root, 'entry.cjs')
  const boundary = process.platform === 'win32' ? buildWindowsBoundary(fixture.root) : undefined
  writeFileSync(entry, `
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(helperFile)}, String(process.pid))
const child = require('node:child_process').spawn(${boundary ? JSON.stringify(boundary) : 'process.execPath'},
  ${boundary ? JSON.stringify(['hold', descendantFile]) : "['-e', 'setInterval(() => {}, 1000)']"},
  { stdio: ['ignore', 1, 2], detached: process.platform === 'win32', windowsHide: true })
fs.writeFileSync(${JSON.stringify(descendantFile)}, String(child.pid))
process.stdout.write('{"hookSpecificOutput":{"additionalContext":"completed-owned-lifecycle"}}')
${behavior === 'exits' ? 'process.exit(0)' : behavior === 'crashes' ? 'process.exit(1)' : 'setInterval(() => {}, 1000)'}
`)
  const result = await (installed ? runInstalledStartup({ fixture, entry, quietLimitMs: HANG_BACKSTOP_MS }) : runTreeShim({ fixture, entry, quietLimitMs: HANG_BACKSTOP_MS })).done
  assertTreeDead(fixture)
  const sessionId = installed ? 'installed-startup' : 'owned-tree'
  if (!await premiseBranch(ctx, fixture, result, [helperFile, descendantFile], sessionId)) return
  const helperPid = readOwnedPid(helperFile)
  const descendantPid = readOwnedPid(descendantFile)
  if (behavior === 'exits' && result.stdout === '{}') {
    await assertOwedDeliveredOnce(fixture, 'copilot_cli', sessionId)
  } else {
    if (behavior === 'exits') expect(result.stderr).toBe('')
    else expect(result.stderr).not.toContain('cleanup failed')
    expect(result.stdout).toBe(behavior === 'exits' ? '{"additionalContext":"completed-owned-lifecycle"}' : '{}')
  }
  expect(alive(helperPid)).toBe(false)
  expect(alive(descendantPid), 'pipe-inheriting descendant survived').toBe(false)
})

it('uses one input-plus-handler deadline, discarding complete stdout from a hung child', async (ctx) => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'entry.cjs')
  const entered = join(fixture.root, 'entry.started')
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(entered)}, 'yes'); process.stdout.write('{"complete":true}'); setInterval(() => {}, 1000)`)
  const result = await runTreeShim({ fixture, entry, delayMs: 1500, quietLimitMs: HANG_BACKSTOP_MS }).done
  assertTreeDead(fixture)
  if (!await premiseBranch(ctx, fixture, result, [entered], 'owned-tree')) return
  expect(result.stdout).toBe('{}')
  expect(result.stderr).toMatch(/timed out/)
}, 0)

it.runIf(process.platform === 'win32')('inherits the earliest installed native deadline across delayed input and helper work', async (ctx) => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'entry.cjs')
  const entered = join(fixture.root, 'helper.pid')
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(entered)}, String(process.pid)); process.stdout.write('{"complete":true}'); setInterval(() => {}, 1000)`)
  const result = await runInstalledStartup({ fixture, entry, delayMs: 1500, quietLimitMs: HANG_BACKSTOP_MS }).done
  assertTreeDead(fixture)
  if (!await premiseBranch(ctx, fixture, result, [entered], 'installed-startup')) return
  expect(alive(readOwnedPid(entered))).toBe(false)
  expect(result.stdout).toBe('{}')
  expect(result.stderr).toMatch(/timed out/)
}, 0)

it('does not spawn the supervisor when input arrives inside the cleanup reserve', async (ctx) => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'entry.cjs')
  const spawnAttempt = join(fixture.root, 'supervisor-spawned')
  writeFileSync(entry, `process.stdout.write('{"complete":true}')`)

  let shim = readFileSync(fixture.shim, 'utf8')
  const dataRegistration = 'process.stdin.on(\'data\', onData)'
  expect(shim).toContain(dataRegistration)
  shim = shim.replace(
    dataRegistration,
    "let clockAdvanced = false; process.stdin.on('data', (...args) => { if (!clockAdvanced) { const now = Date.now; Date.now = () => now() + 2000; clockAdvanced = true } onData(...args) })",
  )
  const supervisorSpawn = process.platform === 'win32'
    ? "const root = spawn(binary, ['--session-start-owner-v1', String(deadline), process.execPath, ...args], {"
    : "const root = spawn(process.execPath, ['-e', supervisor, ...args], {"
  expect(shim).toContain(supervisorSpawn)
  shim = shim.replace(
    supervisorSpawn,
    `require('node:fs').writeFileSync(${JSON.stringify(spawnAttempt)}, String(deadline - Date.now())); ${supervisorSpawn}`,
  )
  writeFileSync(fixture.shim, shim)

  const result = await runTreeShim({ fixture, entry, quietLimitMs: HANG_BACKSTOP_MS }).done
  expect(result.stdout).toBe('{}')
  expect(
    existsSync(spawnAttempt),
    existsSync(spawnAttempt) ? `supervisor started with ${readFileSync(spawnAttempt, 'utf8')} ms remaining` : 'supervisor was not spawned',
  ).toBe(false)
  // Machine load can carry the start past its whole deadline before the payload is read, which prints the deadline refusal instead; no supervisor is spawned either way, and only the reserve branch proves the reserve rule.
  if (!result.stderr.includes('insufficient time for process-tree cleanup')) {
    expect(result.stderr).toMatch(DEADLINE_FAIL_OPEN)
    await ctx.annotate('branch: weak (the whole deadline passed before the payload was read)')
    return
  }
  await ctx.annotate('branch: strong (input inside the cleanup reserve)')
}, 0)

it.for(['stdout', 'stderr'])('bounds %s overflow and terminates the owned helper', { timeout: 0 }, async (stream, ctx) => {
  const fixture = treeFixture()
  const pidFile = join(fixture.root, 'helper.pid')
  const entry = join(fixture.root, 'entry.cjs')
  writeFileSync(entry, `
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
const chunk = Buffer.alloc(1024 * 1024, 120)
function flood() { while (process.${stream}.write(chunk)) {} }
process.${stream}.on('drain', flood); flood(); setInterval(() => {}, 1000)
`)
  const result = await runTreeShim({ fixture, entry, quietLimitMs: HANG_BACKSTOP_MS }).done
  assertTreeDead(fixture)
  if (!await premiseBranch(ctx, fixture, result, [pidFile], 'owned-tree')) return
  expect(result.stdout).toBe('{}')
  expect(result.stderr).toMatch(/exceeded 1 MiB/)
  expect(alive(readOwnedPid(pidFile))).toBe(false)
})

it('refuses unavailable ownership without a Windows canonical fallback', async (ctx) => {
  const fixture = treeFixture()
  const shim = readFileSync(fixture.shim, 'utf8')
  writeFileSync(fixture.shim, process.platform === 'win32'
    ? shim.replace("const root = spawn(binary,", "const root = spawn(binary + '.missing',")
    : shim.replace("process.kill(-root.pid, 'SIGKILL')", "(() => { const e = new Error('deliberate'); e.code = 'EPERM'; throw e })()"))
  const pidFile = join(fixture.root, 'helper.pid')
  const entry = join(fixture.root, 'entry.cjs')
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
  const result = await runTreeShim({ fixture, entry, quietLimitMs: HANG_BACKSTOP_MS }).done
  expect(result.stdout).toBe('{}')
  if (process.platform === 'win32') {
    // Load can pass the whole deadline before the owner is looked up; the invariant, no canonical work without ownership, holds on both branches.
    expect(result.stderr).toMatch(/native startup owner unavailable|overall deadline exceeded|insufficient time for process-tree cleanup/)
    expect(existsSync(pidFile), 'canonical work ran without ownership').toBe(false)
  } else {
    assertTreeDead(fixture)
    if (!await premiseBranch(ctx, fixture, result, [pidFile], 'owned-tree')) return
    expect(result.stderr).toContain('process-tree cleanup failed')
    expect(result.stderr).toContain('remaining owned PIDs before fallback:')
    expect(result.stderr).toContain('descendant termination not verified')
    expect(alive(readOwnedPid(pidFile))).toBe(false)
  }
}, 0)

it.for(['copilot_cli', 'vscode'])('preserves real indexed reminder, notes and drift context for %s', { timeout: 0 }, async (harness) => {
  const fixture = treeFixture()
  indexTreeFixture(fixture)
  // Prints nothing until it exits, so no limit is set here: the test's own timeout is the hang backstop.
  const note = spawnSync(process.execPath, [BUNDLE, 'note', 'set', 'startup-contract', 'keep-owned-tree-bounded'], {
    cwd: fixture.project, env: fixture.env, encoding: 'utf8', windowsHide: true,
  })
  expect(note.status, note.stderr).toBe(0)
  writeFileSync(join(fixture.project, 'example.ts'), 'export function ownedExample() { return 2 }\n')
  const payload = harness === 'vscode'
    ? { hook_event_name: 'SessionStart', session_id: 'notes-vscode', cwd: fixture.project }
    : { sessionId: 'notes-cli', workingDirectory: fixture.project }
  const result = await runTreeShim({ fixture, entry: BUNDLE, payload, quietLimitMs: HANG_BACKSTOP_MS }).done
  assertTreeDead(fixture)
  const sessionId = harness === 'vscode' ? 'notes-vscode' : 'notes-cli'
  // Delivered at startup, or the start failed open with `{}` and the first tool call carries the same context once.
  const delivered = result.stdout === '{}' ? await assertOwedDeliveredOnce(fixture, harness as 'copilot_cli' | 'vscode', sessionId) : result.stdout
  const context = contextText(delivered as string)
  expect(context).toContain('token-goat: this project is indexed.')
  expect(context).toContain('read "file::symbol"')
  expect(context).toContain('startup-contract')
  expect(context).toContain('keep-owned-tree-bounded')
  expect(context).toContain('changed outside this session')
})

it('an expired startup deadline fails open with {} and no helper, and the first tool call delivers the owed reminder once', async () => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'entry.cjs')
  const entered = join(fixture.root, 'entry.started')
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(entered)}, 'yes'); process.stdout.write('{"additionalContext":"never"}')`)
  // The deadline is measured from the shim process's birth, so on a slow machine it can pass before stdin is read, and then no session is known to owe anything. The clock is therefore taken from the shim's first line and moved past the deadline only once the payload has been read, which is the case this row is about.
  let shim = readFileSync(fixture.shim, 'utf8')
  const dataRegistration = "process.stdin.on('data', onData)"
  expect(shim).toContain(dataRegistration)
  shim = shim.replace(dataRegistration, "let clockAdvanced = false; process.stdin.on('data', (...args) => { if (!clockAdvanced) { const now = Date.now; Date.now = () => now() + 60000; clockAdvanced = true } onData(...args) })")
  writeFileSync(fixture.shim, shim)
  const result = await runTreeShim({ fixture, entry, quietLimitMs: HANG_BACKSTOP_MS }).done
  expect(result.stdout).toBe('{}')
  expect(result.stderr).toContain('overall deadline exceeded')
  expect(existsSync(entered), 'no helper may start past the deadline').toBe(false)
  assertTreeDead(fixture)
  expect(startBegan(fixture, 'owned-tree'), 'the payload was read, so the start began').toBe(true)
  expect(await assertOwedDeliveredOnce(fixture, 'copilot_cli', 'owned-tree')).not.toBeNull()
}, 0)

it('a deadline that is already past never starts the helper, prints {}, and owes the reminder exactly when the payload was read', async (ctx) => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'entry.cjs')
  const entered = join(fixture.root, 'entry.started')
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(entered)}, 'yes'); process.stdout.write('{"additionalContext":"never"}')`)
  const result = await runTreeShim({ fixture, entry, quietLimitMs: HANG_BACKSTOP_MS, deadline: Date.now() - 1000 }).done
  expect(result.stdout).toBe('{}')
  expect(existsSync(entered), 'no helper may start past the deadline').toBe(false)
  assertTreeDead(fixture)
  await ctx.annotate(`branch: payload read before the deferred deadline=${String(startBegan(fixture, 'owned-tree'))}`)
  await assertOwedDeliveredOnce(fixture, 'copilot_cli', 'owned-tree')
})
