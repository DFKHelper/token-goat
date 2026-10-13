/** HAND-DERIVED adversity: actual built hook -> reconcileProject -> getTrackedFiles -> runGit,
 * with only the Git executable boundary replaced. This is not a healthy-handler substitute. */
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'

import { afterEach, expect, it } from 'vitest'

import { COPILOT_SESSION_START_HELPERS } from '../../src/bridges/copilot_session_start.js'
import { COPILOT_CLI_HOOK_SCRIPT } from '../../src/bridges/copilot_cli.js'
import { buildLegacyStartupOwner } from '../helpers/legacy_startup_owner.js'
import { alive, assertInstalledResidentBypass, BUNDLE, buildWindowsBoundary, cleanupTrees, indexTreeFixture, installStartupOwner, ownedPids, readOwnedPid, runInstalledStartup, runTreeShim, treeFixture } from '../helpers/copilot_session_start_tree.js'

afterEach(cleanupTrees)

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
    const result = await runInstalledStartup({
      fixture, entry, shell: surface === 'powershell' ? 'powershell' : 'cmd', alias: surface === 'alias',
      payload: vscode
        ? { hook_event_name: 'SessionStart', session_id: 'installed-vscode', cwd: fixture.project }
        : { sessionId: 'installed-cli', workingDirectory: fixture.project },
    }).done
    expect(result.stdout).toBe(vscode
      ? '{"hookSpecificOutput":{"additionalContext":"installed-owned"}}'
      : '{"additionalContext":"installed-owned"}')
    expect(result.stderr).toBe('')
    expect(alive(readOwnedPid(entered)), 'installed canonical helper survived before teardown').toBe(false)
    expect(JSON.parse(readFileSync(payloadFile, 'utf8'))).toMatchObject({
      session_id: vscode ? 'installed-vscode' : 'installed-cli', cwd: fixture.project,
    })
    expect(result.elapsed).toBeLessThan(5000)
  }, 20_000,
)

it.runIf(process.platform === 'win32').each(['', '{"sessionId":'])('bounds installed native incomplete input %j', async (input) => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'entry.cjs')
  const entered = join(fixture.root, 'helper.pid')
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(entered)}, String(process.pid)); process.stdout.write('{}')`)
  const result = await runInstalledStartup({ fixture, entry, input }).done
  expect(result.stdout).toBe('{}')
  expect(result.stderr).toContain('startup input deadline exceeded')
  expect(existsSync(entered)).toBe(false)
  expect(result.elapsed).toBeLessThan(5000)
}, 12_000)

it.runIf(process.platform === 'win32')('bypasses an available real resident for installed startup with and without EOF', async () => {
  const fixture = treeFixture()
  indexTreeFixture(fixture)
  await assertInstalledResidentBypass(fixture)
}, 40_000)

it.runIf(process.platform === 'win32')('allows bounded owner metadata around a near-limit installed response', async () => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'entry.cjs')
  writeFileSync(entry, "process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:'x'.repeat(1024 * 1024 - 100)}}))")
  const result = await runInstalledStartup({ fixture, entry }).done
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe(JSON.stringify({ additionalContext: 'x'.repeat(1024 * 1024 - 100) }))
}, 12_000)

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

it.each(['direct', ...(process.platform === 'win32' ? ['installed'] : [])])('terminates the real indexed SessionStart helper and its blocked Git descendant (%s)', async (surface) => {
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
  const result = await (surface === 'installed' ? runInstalledStartup({ fixture, entry }) : runTreeShim({ fixture, entry })).done
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
  expect(result.elapsed).toBeLessThan(5000)
}, 40_000)

it.runIf(process.platform === 'win32')('contains an independent native breakaway attempt across nested jobs', async () => {
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
  const result = await runTreeShim({ fixture, entry }).done
  // Check before teardown: a passing outer harness job must not clean up for us.
  const attempt = readFileSync(attempted, 'utf8')
  if (attempt.startsWith('created:')) {
    // Windows may break away from libuv's inner permissive job, but not the
    // owner's strict ancestor job. Successful creation is not proof of escape.
    const pid = Number(attempt.slice('created:'.length))
    ownedPids.push(pid)
    expect(Number.isInteger(pid) && pid > 0).toBe(true)
    expect(alive(pid), 'native breakaway descendant survived before teardown').toBe(false)
  } else {
    expect(attempt).toBe('denied:5')
    expect(existsSync(descendant)).toBe(false)
  }
  expect(result.stdout).toBe('{"additionalContext":"breakaway-denied"}')
  expect(result.stderr).toBe('')
}, 40_000)

it.runIf(process.platform === 'win32')('rejects breakaway from the strict job without an intervening libuv job', async () => {
  const fixture = treeFixture()
  const boundary = buildWindowsBoundary(fixture.root)
  const descendant = join(fixture.root, 'descendant.pid')
  const attempted = join(fixture.root, 'breakaway.result')
  const result = spawnSync(installStartupOwner(fixture.root), [
    '--session-start-owner-v1', String(Date.now() + 3000), boundary, 'direct-breakaway', descendant, attempted,
  ], { input: '{}', env: fixture.env, encoding: 'utf8', windowsHide: true, timeout: 5000 })
  expect(result.status, result.stderr).toBe(0)
  const attempt = readFileSync(attempted, 'utf8')
  if (attempt.startsWith('created:')) ownedPids.push(Number(attempt.slice('created:'.length)))
  expect(attempt).toBe('denied:5')
  expect(existsSync(descendant)).toBe(false)
  expect(JSON.parse(result.stdout)).toMatchObject({
    protocol: 'tg-session-start-owner-v1', capability: 'atomic-job-list',
    activeProcesses: 0, rootExited: true, pipesDrained: true, candidate: {},
  })
}, 40_000)

it.runIf(process.platform === 'win32').each(['before-input', 'at-creation', 'with-live-descendant'])('closes the owned job after abrupt native owner death %s', async (phase) => {
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
  owner.stderr.resume()
  const closed = new Promise<void>((resolve, reject) => {
    owner.once('close', () => resolve())
    owner.once('error', reject)
  })
  const waitUntil = async (condition: () => boolean): Promise<void> => {
    const until = performance.now() + 1500
    while (!condition()) {
      expect(performance.now()).toBeLessThan(until)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  if (phase === 'with-live-descendant') {
    owner.stdin.end('{}')
    await waitUntil(() => existsSync(descendantFile))
    expect(alive(readOwnedPid(rootPidFile))).toBe(true)
    expect(alive(readOwnedPid(descendantFile))).toBe(true)
  } else if (phase === 'at-creation') {
    // Race owner termination against canonical process creation, without a
    // spawn-then-assign seam or a test-only pause in the production owner.
    owner.stdin.end('{}')
    await new Promise((resolve) => setTimeout(resolve, 5))
  } else {
    await new Promise<void>((resolve) => owner.once('spawn', resolve))
  }
  owner.kill('SIGKILL')
  await closed
  expect(stdout).toBe('')
  if (phase === 'with-live-descendant') {
    await waitUntil(() => !alive(readOwnedPid(rootPidFile)) && !alive(readOwnedPid(descendantFile)))
  } else if (phase === 'at-creation') {
    await waitUntil(() =>
      (!existsSync(rootPidFile) || !alive(readOwnedPid(rootPidFile)))
      && (!existsSync(descendantFile) || !alive(readOwnedPid(descendantFile))))
  } else {
    expect(existsSync(rootPidFile), 'canonical work ran before complete input').toBe(false)
  }
}, 40_000)

it.runIf(process.platform === 'win32')('rejects an incompatible built native protocol before canonical execution', async () => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'entry.cjs')
  const entered = join(fixture.root, 'entered')
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(entered)}, 'yes'); process.stdout.write('{}')`)
  const shim = readFileSync(fixture.shim, 'utf8')
  writeFileSync(fixture.shim, shim.replace("['--session-start-owner-v1', String(deadline), process.execPath, ...args]", "['--selftest']"))
  const result = await runTreeShim({ fixture, entry }).done
  expect(result.stdout).toBe('{}')
  expect(result.stderr).toContain('incompatible protocol or unverified cleanup')
  expect(existsSync(entered)).toBe(false)
})

it.runIf(process.platform === 'win32')('rejects the actual owner argv in a built legacy binary, with a separator negative control', async () => {
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
  expect(readFileSync(fixture.shim, 'utf8')).toBe(COPILOT_CLI_HOOK_SCRIPT)
  const result = await runTreeShim({ fixture, entry }).done
  assertNoCanonical()
  expect(result.stdout).toBe('{}')
  expect(result.stderr).toContain('native startup owner failed')

  const argv = "['--session-start-owner-v1', String(deadline), process.execPath, ...args]"
  expect(COPILOT_CLI_HOOK_SCRIPT).toContain(argv)
  writeFileSync(fixture.shim, COPILOT_CLI_HOOK_SCRIPT.replace(argv,
    "['--session-start-owner-v1', String(deadline), '--', process.execPath, ...args]"))
  const unsafe = await runTreeShim({ fixture, entry }).done
  expect(unsafe.stdout).toBe('{}')
  expect(unsafe.stderr).toContain('incompatible protocol or unverified cleanup')
  expect(() => assertNoCanonical()).toThrow(/canonical marker must be absent/)
  expect(existsSync(pidFile)).toBe(true)
  expect(alive(readOwnedPid(pidFile))).toBe(false)
}, 120_000)

it.runIf(process.platform === 'win32')('fails open on native atomic process-creation failure without canonical execution', async () => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'entry.cjs')
  const entered = join(fixture.root, 'entered')
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(entered)}, 'yes'); process.stdout.write('{}')`)
  const shim = readFileSync(fixture.shim, 'utf8')
  writeFileSync(fixture.shim, shim.replace('\n', "\nObject.defineProperty(process, 'execPath', { value: 'C:\\\\missing-startup-node\\\\node.exe' });\n"))
  const result = await runTreeShim({ fixture, entry }).done
  expect(result.stdout).toBe('{}')
  expect(result.stderr).toContain('startup job association/process creation failed')
  expect(existsSync(entered)).toBe(false)
})

it.each([
  ['blocks', false], ['exits', false],
  ...(process.platform === 'win32' ? [['blocks', true], ['exits', true], ['crashes', true]] as const : []),
] as const)('cleans descendants retaining stdout when the helper %s (installed=%s)', async (behavior, installed) => {
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
  const result = await (installed ? runInstalledStartup({ fixture, entry }) : runTreeShim({ fixture, entry })).done
  const helperPid = readOwnedPid(helperFile)
  const descendantPid = readOwnedPid(descendantFile)
  expect(result.elapsed).toBeLessThan(5000)
  if (behavior === 'exits') expect(result.stderr).toBe('')
  else expect(result.stderr).not.toContain('cleanup failed')
  expect(result.stdout).toBe(behavior === 'exits' ? '{"additionalContext":"completed-owned-lifecycle"}' : '{}')
  expect(alive(helperPid)).toBe(false)
  expect(alive(descendantPid), 'pipe-inheriting descendant survived').toBe(false)
}, 12_000)

it('uses one input-plus-handler deadline, discarding complete stdout from a hung child', async () => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'entry.cjs')
  const entered = join(fixture.root, 'entry.started')
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(entered)}, 'yes'); process.stdout.write('{"complete":true}'); setInterval(() => {}, 1000)`)
  const result = await runTreeShim({ fixture, entry, delayMs: 1500 }).done
  expect(existsSync(entered)).toBe(true)
  expect(result.stdout).toBe('{}')
  expect(result.stderr).toMatch(/timed out/)
  expect(result.elapsed).toBeLessThan(5000)
}, 12_000)

it.runIf(process.platform === 'win32')('inherits the earliest installed native deadline across delayed input and helper work', async () => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'entry.cjs')
  const entered = join(fixture.root, 'helper.pid')
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(entered)}, String(process.pid)); process.stdout.write('{"complete":true}'); setInterval(() => {}, 1000)`)
  const result = await runInstalledStartup({ fixture, entry, delayMs: 1500 }).done
  // The installed relay reads the whole input before it creates the owner, shim and helper, so after a 1500 ms delay those launches share the few hundred milliseconds left before its cleanup reserve: whether the helper got to start is a race the run does not decide, but no helper it did start may outlive it.
  if (existsSync(entered)) expect(alive(readOwnedPid(entered))).toBe(false)
  expect(result.stdout).toBe('{}')
  expect(result.stderr).toMatch(/timed out/)
  expect(result.elapsed).toBeLessThan(3500)
}, 12_000)

it.runIf(process.platform === 'win32')('hands the installed native deadline to the shim\'s own owner instead of restarting it at shim start', async () => {
  const fixture = treeFixture()
  const entry = join(fixture.root, 'entry.cjs')
  const entered = join(fixture.root, 'helper.pid')
  const handoff = join(fixture.root, 'handoff.json')
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(entered)}, String(process.pid)); process.stdout.write('{"complete":true}'); setInterval(() => {}, 1000)`)
  // The relay ends the run at its own deadline even when the shim restarts the clock, so the outcome cannot show inheritance; the shim records what it hands its owner, checked against its own process start, which the native entry's deadline precedes by construction.
  const ownerSpawn = "const root = spawn(binary, ['--session-start-owner-v1', String(deadline), process.execPath, ...args], {"
  const shim = readFileSync(fixture.shim, 'utf8')
  expect(shim).toContain(ownerSpawn)
  writeFileSync(fixture.shim, shim.replace(ownerSpawn, `require('node:fs').writeFileSync(${JSON.stringify(handoff)}, JSON.stringify({ inherited: process.argv[4], deadline, started: Math.floor(require('node:perf_hooks').performance.timeOrigin) })); ${ownerSpawn}`))
  const result = await runInstalledStartup({ fixture, entry }).done
  const record = JSON.parse(readFileSync(handoff, 'utf8')) as { inherited: string; deadline: number; started: number }
  expect(record.inherited).toMatch(/^--session-start-deadline=\d+$/)
  expect(record.deadline).toBe(Number(record.inherited.slice('--session-start-deadline='.length)))
  expect(record.deadline).toBeLessThan(record.started + 3000)
  expect(alive(readOwnedPid(entered))).toBe(false)
  expect(result.stdout).toBe('{}')
  expect(result.stderr).toMatch(/timed out/)
}, 12_000)

it('does not spawn the supervisor when input arrives inside the cleanup reserve', async () => {
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

  const result = await runTreeShim({ fixture, entry }).done
  expect(result.stdout).toBe('{}')
  expect(
    existsSync(spawnAttempt),
    existsSync(spawnAttempt) ? `supervisor started with ${readFileSync(spawnAttempt, 'utf8')} ms remaining` : 'supervisor was not spawned',
  ).toBe(false)
  expect(result.stderr).toContain('insufficient time for process-tree cleanup')
  expect(result.elapsed).toBeLessThan(5000)
}, 12_000)

it.each(['stdout', 'stderr'])('bounds %s overflow and terminates the owned helper', async (stream) => {
  const fixture = treeFixture()
  const pidFile = join(fixture.root, 'helper.pid')
  const entry = join(fixture.root, 'entry.cjs')
  writeFileSync(entry, `
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
const chunk = Buffer.alloc(1024 * 1024, 120)
function flood() { while (process.${stream}.write(chunk)) {} }
process.${stream}.on('drain', flood); flood(); setInterval(() => {}, 1000)
`)
  const result = await runTreeShim({ fixture, entry }).done
  expect(result.stdout).toBe('{}')
  expect(result.stderr).toMatch(/exceeded 1 MiB/)
  expect(result.elapsed).toBeLessThan(5000)
  expect(alive(readOwnedPid(pidFile))).toBe(false)
}, 12_000)

it('refuses unavailable ownership without a Windows canonical fallback', async () => {
  const fixture = treeFixture()
  const shim = readFileSync(fixture.shim, 'utf8')
  writeFileSync(fixture.shim, process.platform === 'win32'
    ? shim.replace("const root = spawn(binary,", "const root = spawn(binary + '.missing',")
    : shim.replace("process.kill(-root.pid, 'SIGKILL')", "(() => { const e = new Error('deliberate'); e.code = 'EPERM'; throw e })()"))
  const pidFile = join(fixture.root, 'helper.pid')
  const entry = join(fixture.root, 'entry.cjs')
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
  const result = await runTreeShim({ fixture, entry }).done
  expect(result.stdout).toBe('{}')
  if (process.platform === 'win32') {
    expect(result.stderr).toContain('native startup owner unavailable')
    expect(existsSync(pidFile), 'canonical work ran without ownership').toBe(false)
  } else {
    expect(result.stderr).toContain('process-tree cleanup failed')
    expect(result.stderr).toContain('remaining owned PIDs before fallback:')
    expect(result.stderr).toContain('descendant termination not verified')
    expect(alive(readOwnedPid(pidFile))).toBe(false)
  }
  expect(result.elapsed).toBeLessThan(5000)
}, 12_000)

it.each(['copilot_cli', 'vscode'])('preserves real indexed reminder, notes and drift context for %s', async (harness) => {
  const fixture = treeFixture()
  indexTreeFixture(fixture)
  const note = spawnSync(process.execPath, [BUNDLE, 'note', 'set', 'startup-contract', 'keep-owned-tree-bounded'], {
    cwd: fixture.project, env: fixture.env, encoding: 'utf8', windowsHide: true, timeout: 10_000,
  })
  expect(note.status, note.stderr).toBe(0)
  writeFileSync(join(fixture.project, 'example.ts'), 'export function ownedExample() { return 2 }\n')
  const payload = harness === 'vscode'
    ? { hook_event_name: 'SessionStart', session_id: 'notes-vscode', cwd: fixture.project }
    : { sessionId: 'notes-cli', workingDirectory: fixture.project }
  const result = await runTreeShim({ fixture, entry: BUNDLE, payload }).done
  const parsed = JSON.parse(result.stdout) as { additionalContext?: string; hookSpecificOutput?: { additionalContext?: string } }
  const context = harness === 'vscode' ? parsed.hookSpecificOutput?.additionalContext : parsed.additionalContext
  expect(context).toContain('token-goat: this project is indexed.')
  expect(context).toContain('read "file::symbol"')
  expect(context).toContain('startup-contract')
  expect(context).toContain('keep-owned-tree-bounded')
  expect(context).toContain('changed outside this session')
  expect(result.elapsed).toBeLessThan(5000)
}, 40_000)
