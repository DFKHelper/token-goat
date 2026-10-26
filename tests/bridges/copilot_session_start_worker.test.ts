/** Real shipped SessionStart -> dirty queue -> default detached worker -> SQLite. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import Database from '../../src/sqlite_driver.js'
import { commandLineOf, queryProcessCommandLine } from '../../src/resident_process.js'
import { alive, aliveAs, assertOwedDeliveredOnce, BUNDLE, cleanupTrees, DEFERRED_DRIFT_NOTICE, expectDriftNotice, fixtureWatchdog, indexTreeFixture, ownedPids, ownedRoots, runInstalledStartup, runOwedToolCall, runTreeShim, startBegan, treeFixture } from '../helpers/copilot_session_start_tree.js'

afterEach(() => {
  const workers: number[] = []
  for (const root of ownedRoots) {
    const path = join(root, 'home', 'dfk-helper', 'token-goat', 'worker.pid')
    if (!existsSync(path)) continue
    const pid = Number(readFileSync(path, 'utf8'))
    if (Number.isSafeInteger(pid) && pid > 0) {
      workers.push(pid)
      if (!ownedPids.includes(pid)) ownedPids.push(pid)
    }
  }
  // Each worker is asked about as the process it was before the kill: the number is free for reuse the moment it dies, and a stranger that took it is not a survivor. Only a worker seen alive here can survive: a line the query could not read still counts it as ours, and a number already free is not a survivor.
  const lines = new Map(workers.filter(alive).map(pid => [pid, commandLineOf(queryProcessCommandLine(pid))]))
  cleanupTrees()
  for (const [pid, line] of lines) expect(aliveAs(pid, line), `owned worker ${pid} survived teardown`).toBe(false)
  console.log(`owned startup workers cleaned: ${workers.join(',')}`)
})

// A condition wait: it ends when `check` holds and fails only after the fixture's watchdog saw no progress for its whole quiet limit, so a slow machine lengthens the wait and a stuck worker still fails.
async function until(fixture: ReturnType<typeof treeFixture>, label: string, check: () => boolean): Promise<void> {
  const watchdog = fixtureWatchdog(fixture, 40_000, 'startup worker')
  // The watchdog's rejection names the fixture's last progress, not the condition: re-raised as a named assertion so a worker that never finishes fails on the line that says what it did not do.
  try {
    while (!check()) await Promise.race([new Promise(resolve => setTimeout(resolve, 50)), watchdog.failed])
  } catch (error) {
    expect.fail(`never reached: ${label} (${error instanceof Error ? error.message : String(error)})`)
  }
  watchdog.progress(label)
}

// The branch a slow-listing second start must take: its own listing times out (the memory is 0 here, so it lists again), new files cannot be found, and the worker is handed the check (reconcileNote's total-zero notice, with the budget clause when the sweep also ran out of time).
const DEFERRED_NEW_FILE_NOTICE = /token-goat: index drift check (?:\(sweep stopped[^\n]*?\) )?\(git did not answer in time listing the project files, so new files could not be found; the background worker is finishing the check\) found nothing/


// A worker start must name a queued reindex or the deferred check: an unqueued drift line means the edit never reached the worker, so it fails here as before.
function expectQueuedDriftNotice(stdout: string): ReturnType<typeof expectDriftNotice> {
  const kind = expectDriftNotice(stdout)
  expect(kind, 'the start must name a reindex, the deferred background drift check, or the partial sweep that queued nothing').not.toBe('unqueued')
  return kind
}

// A silent start claims the index already matches disk, so the edit it was started for must already resolve (the sweep ran before this check, and the index only grows); a partial one queued nothing, so the edit still has to reach the worker.
function followUp(fixture: ReturnType<typeof treeFixture>, kind: ReturnType<typeof expectDriftNotice>, resolves: boolean): void {
  if (kind === 'silent') expect(resolves, 'a start that stayed silent says the index matches disk, yet the edit does not resolve').toBe(true)
  if (kind === 'partial') sweepAndWake(fixture)
}

// The product's own way to get a drifted file queued and a dead worker woken, for a start that queued nothing (it failed open, or its sweep ran out of budget). The 60 s is this CLI sweep's own budget, so load cannot cut it short; it is not the start's budget.
function sweepAndWake(fixture: ReturnType<typeof treeFixture>): void {
  const swept = spawnSync(process.execPath, [BUNDLE, 'reconcile', '--budget-ms', '60000'], { cwd: fixture.project, env: fixture.env, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  expect(swept.status, `reconcile CLI failed: ${swept.stderr}`).toBe(0)
  // A start killed after src/worker_lifecycle.ts::ensureWorkerAlive stamped worker-healthcheck.marker leaves a five-minute throttle with no worker behind it, so every later hook and the reconcile above only no-op: the explicit start is the one path that is not throttled, and the one a user has.
  const started = spawnSync(process.execPath, [BUNDLE, 'worker', 'start'], { cwd: fixture.project, env: fixture.env, encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  expect(started.status, `worker start failed: ${started.stdout}${started.stderr}`).toBe(0)
}

it.runIf(process.platform === 'win32').for([
  { surface: 'installed', listing: 'normal' },
  { surface: 'direct', listing: 'normal' },
  { surface: 'installed', listing: 'slow' },
] as const)(
  'keeps the default index worker alive after the $surface startup tree exits ($listing listing)',
  { timeout: 0 },
  async ({ surface, listing }, ctx) => {
    // OS-temp projects are intentionally never queued. This owned ignored tree has its own Git root and data directory, outside that exclusion.
    const parent = join(process.cwd(), 'artifacts', 'session-start-worker-fixtures')
    mkdirSync(parent, { recursive: true })
    const fixture = treeFixture(parent)
    const dir = join(fixture.root, 'home', 'dfk-helper', 'token-goat')
    const pidPath = join(dir, 'worker.pid')
    fixture.env['TOKEN_GOAT_NO_WORKER_SPAWN'] = '1'
    indexTreeFixture(fixture)
    expect(existsSync(pidPath), 'index setup unexpectedly spawned a worker').toBe(false)
    delete fixture.env['TOKEN_GOAT_NO_WORKER_SPAWN']
    expect(fixture.env['TOKEN_GOAT_NO_WORKER_SPAWN']).toBeUndefined()
    // Forces git's listing past a 1 ms deadline on every start of this row, so the deferred drift check is the one delivered.
    if (listing === 'slow') fixture.env['TOKEN_GOAT_RECONCILE_LISTING_DEADLINE_MS'] = '1'
    const canonicalPid = join(fixture.root, 'canonical.pid')
    const preload = join(fixture.root, 'canonical-probe.cjs')
    writeFileSync(preload, `
const fs = require('node:fs')
if (process.argv[2] === 'hook') fs.writeFileSync(${JSON.stringify(canonicalPid)}, String(process.pid))
if (process.argv[2] === '--worker-daemon') fs.writeFileSync(require('node:path').join(${JSON.stringify(fixture.root)}, 'daemon-' + process.pid + '.pid'), String(process.pid))
`)
    fixture.env['NODE_OPTIONS'] = `${fixture.env['NODE_OPTIONS'] ?? ''} --require ${JSON.stringify(preload)}`
    const source = join(fixture.project, 'example.ts')
    writeFileSync(source, 'export function startupWorkerRecoveredSymbol() { return 42 }\n')
    const db = new Database(join(dir, 'global.db'), { readonly: true, fileMustExist: true, timeout: 100 })
    try {
      const hasSymbol = (name: string): boolean => db.prepare('SELECT name FROM symbols WHERE name = ?').get(name) !== undefined
      expect(hasSymbol('startupWorkerRecoveredSymbol')).toBe(false)
      const run = surface === 'installed'
        ? runInstalledStartup({ fixture, entry: BUNDLE, quietLimitMs: 40_000 })
        : runTreeShim({ fixture, entry: BUNDLE, endInput: false, quietLimitMs: 40_000 })
      const result = await run.done
      // The shim answers `{}` when the host's startup deadline passes first, which a slow machine makes likely. Only a delivered start is held to the worker checks below; a missed one is held to the failed-open invariants.
      const missed = result.stdout === '{}'
      await ctx.annotate(`first start printed ${missed ? '{}' : 'context'} after ${String(Math.round(result.elapsed))} ms`)
      if (missed) {
        expect(result.stderr, 'a start that is not delivered must say it failed open').toMatch(/SessionStart failed open/)
        // A start that failed open cuts the helper off wherever it was, so no worker is guaranteed to exist: the invariants are a dead tree and a reminder owed exactly when the payload was read. The worker path below is held to the product's own wake-up instead.
        await ctx.annotate('branch: weak (the start failed open before delivering)')
        expect(alive(run.child.pid ?? 0), 'startup root still alive').toBe(false)
        await assertOwedDeliveredOnce(fixture, 'copilot_cli', surface === 'installed' ? 'installed-startup' : 'owned-tree')
      } else {
        expect(result.stderr).toBe('')
        const kind = expectQueuedDriftNotice(result.stdout)
        await ctx.annotate(`first start drift notice: ${kind}`)
        await ctx.annotate('branch: strong (the start delivered)')
        expect(alive(run.child.pid ?? 0), 'startup root still alive before worker observation').toBe(false)
        followUp(fixture, kind, hasSymbol('startupWorkerRecoveredSymbol'))
      }
      // The canonical helper stamps its pid when the hook ran; a start cut off earlier never ran it.
      if (existsSync(canonicalPid)) {
        const canonical = Number(readFileSync(canonicalPid, 'utf8'))
        expect(Number.isSafeInteger(canonical) && canonical > 0).toBe(true)
        ownedPids.push(canonical)
        expect(alive(canonical), 'canonical helper survived strict cleanup').toBe(false)
      } else {
        expect(missed, 'a delivered start ran the hook, which stamps the canonical pid').toBe(true)
      }
      if (missed) sweepAndWake(fixture)
      let pid = 0
      let indexed = false
      await until(fixture, 'worker indexed the first edit', () => {
        if (existsSync(pidPath)) {
          pid = Number(readFileSync(pidPath, 'utf8'))
          if (Number.isSafeInteger(pid) && pid > 0 && !ownedPids.includes(pid)) ownedPids.push(pid)
        }
        indexed = db.prepare('SELECT name FROM symbols WHERE name = ?').get('startupWorkerRecoveredSymbol') !== undefined
        return indexed && pid > 0 && alive(pid)
      })
      const queue = join(dir, 'queue', 'dirty.txt')
      const queued = existsSync(queue) ? readFileSync(queue, 'utf8') : ''
      expect({ indexed, workerAlive: pid > 0 && alive(pid), queued }, `worker PID ${pid} after startup exit; ${result.stdout}`)
        .toEqual({ indexed: true, workerAlive: true, queued: '' })
      // A worker already outside the jobs keeps its lease. The next startup must queue and drain its edit without killing or replacing that daemon.
      const secondSource = listing === 'slow' ? join(fixture.project, 'second.ts') : source
      // A slow-listing row's second edit is a new file staged in git: `git ls-files` lists it for the worker's drain, but the hook's own 1 ms listing cannot reach it. An untracked file is listed by neither, so it cannot test the drain.
      writeFileSync(secondSource, 'export function startupWorkerSecondSymbol() { return 43 }\n')
      if (listing === 'slow') execFileSync('git', ['-C', fixture.project, 'add', '--', 'second.ts'], { env: fixture.env })
      // The first start (or the worker it woke) stamped a complete sweep, which stands in for the next start's own for minutes; this start must sweep to find the second edit, whenever the stamp landed.
      fixture.env['TOKEN_GOAT_RECONCILE_MEMORY_MS'] = '0'
      const second = surface === 'installed'
        ? runInstalledStartup({ fixture, entry: BUNDLE, quietLimitMs: 40_000 })
        : runTreeShim({ fixture, entry: BUNDLE, endInput: false, quietLimitMs: 40_000 })
      const secondResult = await second.done
      if (secondResult.stdout === '{}') {
        // Missed deadline: the reconcile that queues the edit is owed to the session's first tool call, which delivers it. A start cut off before its payload was read owes nothing and leaves nothing to queue.
        expect(secondResult.stderr).toMatch(/SessionStart failed open/)
        if (startBegan(fixture, surface === 'installed' ? 'installed-startup' : 'owned-tree')) {
          const owed = await runOwedToolCall(fixture, 'copilot_cli', surface === 'installed' ? 'installed-startup' : 'owned-tree')
          // A slow listing cannot reindex the new file in the start: the owed call, like the start, defers it to the worker.
          if (listing === 'slow') expect(owed, 'the owed call must hand the slow-listing check to the worker').toMatch(DEFERRED_DRIFT_NOTICE)
          else followUp(fixture, expectQueuedDriftNotice(owed),hasSymbol('startupWorkerSecondSymbol'))
        } else {
          // Cut off before the payload was read: nothing is owed and no hook ran, so the product's own sweep is the only way the edit reaches the worker.
          await ctx.annotate('second start: cut off before reading its payload (worker path via the reconcile CLI)')
          sweepAndWake(fixture)
        }
      } else {
        expect(secondResult.stderr).toBe('')
        if (listing === 'slow') {
          expect(secondResult.stdout, 'the slow-listing second start must print the deferred new-file notice').toMatch(DEFERRED_NEW_FILE_NOTICE)
          await ctx.annotate('second start drift notice: deferred (new files left to the worker)')
        } else {
          const kind = expectQueuedDriftNotice(secondResult.stdout)
          await ctx.annotate(`second start drift notice: ${kind}`)
          followUp(fixture, kind, hasSymbol('startupWorkerSecondSymbol'))
        }
      }
      await until(fixture, 'worker indexed the second edit', () => db.prepare('SELECT name FROM symbols WHERE name = ?').get('startupWorkerSecondSymbol') !== undefined)
      expect(db.prepare('SELECT name FROM symbols WHERE name = ?').get('startupWorkerSecondSymbol')).toBeDefined()
      expect(Number(readFileSync(pidPath, 'utf8')), 'existing worker was replaced').toBe(pid)
      expect(alive(pid), 'existing worker was terminated').toBe(true)
      expect(alive(second.child.pid ?? 0)).toBe(false)
      const secondCanonical = existsSync(canonicalPid) ? Number(readFileSync(canonicalPid, 'utf8')) : 0
      if (secondCanonical > 0) {
        ownedPids.push(secondCanonical)
        expect(alive(secondCanonical)).toBe(false)
      }
      // Every daemon that booted wrote its pid; the one worker holds the lease and any other candidate that booted lost the claim and is gone.
      const daemonPids = readdirSync(fixture.root).flatMap(name => /^daemon-(\d+)\.pid$/.exec(name)?.[1] ?? [])
      expect(daemonPids, 'the worker that holds the lease booted through the preload').toContain(String(pid))
      for (const other of daemonPids.filter(p => p !== String(pid))) {
        ownedPids.push(Number(other))
        await until(fixture, `daemon ${other} lost the claim and exited`, () => !alive(Number(other)))
      }
      console.log(`startup worker ${surface}: roots=${run.child.pid},${second.child.pid} exited; worker=${pid} alive; two real default drains verified`)
    } finally {
      db.close()
    }
  },
)
