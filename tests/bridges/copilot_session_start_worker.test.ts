/** Real shipped SessionStart -> dirty queue -> default detached worker -> SQLite. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import Database from '../../src/sqlite_driver.js'
import { readProcessCommandLine } from '../../src/resident_process.js'
import { alive, aliveAs, assertOwedDeliveredOnce, BUNDLE, cleanupTrees, fixtureWatchdog, indexTreeFixture, ownedPids, ownedRoots, runInstalledStartup, runOwedToolCall, runTreeShim, startBegan, treeFixture } from '../helpers/copilot_session_start_tree.js'

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
  // Each worker is asked about as the process it was before the kill: the number is free for reuse the moment it dies, and a stranger that took it is not a survivor.
  const lines = new Map(workers.map(pid => [pid, readProcessCommandLine(pid)]))
  cleanupTrees()
  for (const pid of workers) expect(aliveAs(pid, lines.get(pid) ?? null), `owned worker ${pid} survived teardown`).toBe(false)
  console.log(`owned startup workers cleaned: ${workers.join(',')}`)
})

// A condition wait: it ends when `check` holds and fails only after the fixture's watchdog saw no progress for its whole quiet limit, so a slow machine lengthens the wait and a stuck worker still fails.
async function until(fixture: ReturnType<typeof treeFixture>, label: string, check: () => boolean): Promise<void> {
  const watchdog = fixtureWatchdog(fixture, 40_000, 'startup worker')
  while (!check()) await Promise.race([new Promise(resolve => setTimeout(resolve, 50)), watchdog.failed])
  watchdog.progress(label)
}

it.runIf(process.platform === 'win32').for(['installed', 'direct'] as const)(
  'keeps the default index worker alive after the %s startup tree exits',
  { timeout: 0 },
  async (surface, ctx) => {
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
      expect(db.prepare('SELECT name FROM symbols WHERE name = ?').get('startupWorkerRecoveredSymbol')).toBeUndefined()
      const run = surface === 'installed'
        ? runInstalledStartup({ fixture, entry: BUNDLE, quietLimitMs: 40_000 })
        : runTreeShim({ fixture, entry: BUNDLE, endInput: false, quietLimitMs: 40_000 })
      const result = await run.done
      // The shim answers `{}` when the host's startup deadline passes first, which a slow machine makes likely. Only a delivered start is held to the worker checks below; a missed one is held to the failed-open invariants.
      const missed = result.stdout === '{}'
      await ctx.annotate(`first start printed ${missed ? '{}' : 'context'} after ${String(Math.round(result.elapsed))} ms`)
      if (missed) {
        expect(result.stderr, 'a start that is not delivered must say it failed open').toMatch(/SessionStart failed open/)
        // A start that failed open cuts the helper off wherever it was, so no worker is guaranteed to exist: the invariants left are a dead tree and a reminder owed exactly when the payload was read.
        await ctx.annotate('branch: weak (the start failed open before delivering)')
        expect(alive(run.child.pid ?? 0), 'startup root still alive').toBe(false)
        await assertOwedDeliveredOnce(fixture, 'copilot_cli', surface === 'installed' ? 'installed-startup' : 'owned-tree')
        return
      } else {
        expect(result.stderr).toBe('')
        expect(result.stdout).toContain('reindexing')
      }
      await ctx.annotate('branch: strong (the start delivered)')
      expect(alive(run.child.pid ?? 0), 'startup root still alive before worker observation').toBe(false)
      const canonical = Number(readFileSync(canonicalPid, 'utf8'))
      expect(Number.isSafeInteger(canonical) && canonical > 0).toBe(true)
      ownedPids.push(canonical)
      expect(alive(canonical), 'canonical helper survived strict cleanup').toBe(false)
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
      writeFileSync(source, 'export function startupWorkerSecondSymbol() { return 43 }\n')
      const second = surface === 'installed'
        ? runInstalledStartup({ fixture, entry: BUNDLE, quietLimitMs: 40_000 })
        : runTreeShim({ fixture, entry: BUNDLE, endInput: false, quietLimitMs: 40_000 })
      const secondResult = await second.done
      if (secondResult.stdout === '{}') {
        // Missed deadline: the reconcile that queues the edit is owed to the session's first tool call, which delivers it. A start cut off before its payload was read owes nothing and leaves nothing to queue.
        expect(secondResult.stderr).toMatch(/SessionStart failed open/)
        expect(startBegan(fixture, surface === 'installed' ? 'installed-startup' : 'owned-tree'), 'the shim must have read the payload').toBe(true)
        const owed = await runOwedToolCall(fixture, 'copilot_cli', surface === 'installed' ? 'installed-startup' : 'owned-tree')
        expect(owed).toContain('reindexing')
      } else {
        expect(secondResult.stderr).toBe('')
        expect(secondResult.stdout).toContain('reindexing')
      }
      await until(fixture, 'worker indexed the second edit', () => db.prepare('SELECT name FROM symbols WHERE name = ?').get('startupWorkerSecondSymbol') !== undefined)
      expect(db.prepare('SELECT name FROM symbols WHERE name = ?').get('startupWorkerSecondSymbol')).toBeDefined()
      expect(Number(readFileSync(pidPath, 'utf8')), 'existing worker was replaced').toBe(pid)
      expect(alive(pid), 'existing worker was terminated').toBe(true)
      expect(alive(second.child.pid ?? 0)).toBe(false)
      const secondCanonical = Number(readFileSync(canonicalPid, 'utf8'))
      ownedPids.push(secondCanonical)
      expect(alive(secondCanonical)).toBe(false)
      expect(readdirSync(fixture.root).filter(name => name.startsWith('daemon-') && name.endsWith('.pid')))
        .toEqual([`daemon-${pid}.pid`])
      console.log(`startup worker ${surface}: roots=${run.child.pid},${second.child.pid} and canonicals=${canonical},${secondCanonical} exited; worker=${pid} alive; two real default drains verified`)
    } finally {
      db.close()
    }
  },
)
