/** Real shipped SessionStart -> dirty queue -> default detached worker -> SQLite. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import Database from '../../src/sqlite_driver.js'
import { alive, BUNDLE, cleanupTrees, indexTreeFixture, ownedPids, ownedRoots, runInstalledStartup, runTreeShim, treeFixture } from '../helpers/copilot_session_start_tree.js'

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
  cleanupTrees()
  for (const pid of workers) expect(alive(pid), `owned worker ${pid} survived teardown`).toBe(false)
  console.log(`owned startup workers cleaned: ${workers.join(',')}`)
})

it.runIf(process.platform === 'win32').each(['installed', 'direct'] as const)(
  'keeps the default index worker alive after the %s startup tree exits',
  async (surface) => {
    // OS-temp projects are intentionally never queued. This owned ignored tree
    // has its own Git root and data directory, outside that exclusion.
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
        ? runInstalledStartup({ fixture, entry: BUNDLE })
        : runTreeShim({ fixture, entry: BUNDLE, endInput: false })
      const result = await run.done
      expect(result.elapsed).toBeLessThan(5000)
      expect(alive(run.child.pid ?? 0), 'startup root still alive before worker observation').toBe(false)
      const canonical = Number(readFileSync(canonicalPid, 'utf8'))
      expect(Number.isSafeInteger(canonical) && canonical > 0).toBe(true)
      ownedPids.push(canonical)
      expect(alive(canonical), 'canonical helper survived strict cleanup').toBe(false)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('reindexing')
      const until = Date.now() + 10_000
      let pid = 0
      let indexed = false
      while (Date.now() < until) {
        if (existsSync(pidPath)) {
          pid = Number(readFileSync(pidPath, 'utf8'))
          if (Number.isSafeInteger(pid) && pid > 0 && !ownedPids.includes(pid)) ownedPids.push(pid)
        }
        indexed = db.prepare('SELECT name FROM symbols WHERE name = ?').get('startupWorkerRecoveredSymbol') !== undefined
        if (indexed && pid > 0 && alive(pid)) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      const queue = join(dir, 'queue', 'dirty.txt')
      const queued = existsSync(queue) ? readFileSync(queue, 'utf8') : ''
      expect({ indexed, workerAlive: pid > 0 && alive(pid), queued }, `worker PID ${pid} after startup exit; ${result.stdout}`)
        .toEqual({ indexed: true, workerAlive: true, queued: '' })
      // A worker already outside the jobs keeps its lease. The next startup
      // must queue and drain its edit without killing or replacing that daemon.
      writeFileSync(source, 'export function startupWorkerSecondSymbol() { return 43 }\n')
      const second = surface === 'installed'
        ? runInstalledStartup({ fixture, entry: BUNDLE })
        : runTreeShim({ fixture, entry: BUNDLE, endInput: false })
      const secondResult = await second.done
      expect(secondResult.elapsed).toBeLessThan(5000)
      expect(secondResult.stderr).toBe('')
      expect(secondResult.stdout).toContain('reindexing')
      const secondUntil = Date.now() + 10_000
      while (Date.now() < secondUntil && db.prepare('SELECT name FROM symbols WHERE name = ?').get('startupWorkerSecondSymbol') === undefined) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
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
  }, 40_000,
)
