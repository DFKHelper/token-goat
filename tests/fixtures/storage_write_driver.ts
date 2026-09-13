/**
 * Drive exactly ONE real write through one storage subsystem, in a fresh process, and print where
 * it landed.
 *
 * Used by `tests/storage_root_rehardened_on_upgrade.test.ts`. A fresh process is required rather
 * than convenient: both storage roots memoize their hardening (`dataDirHardened`, `hardenedHomes`),
 * so a root already hardened by an earlier test in the same worker would make the check pass
 * without the subsystem under test doing anything at all -- the exact vacuous-pass shape the static
 * guard next door already fell into once.
 *
 * Deliberately calls the subsystem's real public entry point (`snapshots.store`,
 * `saveSessionState`, `storeBlob`) rather than `ensureDirSync` directly. The whole finding is that
 * three of these guard their `ensureDirSync` behind `if (!fs.existsSync(dir))`, so on an upgraded
 * install where the directory already exists that call never runs and the hardening rides entirely
 * on `atomicWriteCore` calling `ensureDirSync` unconditionally. Calling the helper would assert the
 * helper; calling the subsystem asserts the path a user is actually on.
 *
 * Usage: `node --import tsx storage_write_driver.ts <snapshots|session|cache>`
 * Prints one line: `OK <absolute path written>` or `FAIL <reason>`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { storeBlob } from '../../src/disk_cache.js'
import { saveSessionState } from '../../src/session_store.js'
import { store } from '../../src/snapshots.js'

const which = process.argv[2] ?? ''

function report(p: string | null | undefined): void {
  if (typeof p === 'string' && p.length > 0 && fs.existsSync(p)) {
    process.stdout.write(`OK ${p}\n`)
    return
  }
  process.stdout.write(`FAIL ${which} produced no file (${String(p)})\n`)
  process.exitCode = 1
}

if (which === 'snapshots') {
  const r = store('drv-session', path.join(process.cwd(), 'driver-file.ts'), Buffer.from('snapshot body\n'))
  report(r === null ? null : r.path)
} else if (which === 'session') {
  saveSessionState('drv-session')
  const dir = path.join(process.env['TOKEN_GOAT_HOME'] ?? '', 'sessions')
  const hit = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.endsWith('.json')) : undefined
  report(hit === undefined ? null : path.join(dir, hit))
} else if (which === 'cache') {
  const ok = storeBlob('web', 'driver-blob', { body: 'cached' })
  const dir = path.join(process.env['TOKEN_GOAT_HOME'] ?? '', 'web')
  const hit = ok && fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.endsWith('.json')) : undefined
  report(hit === undefined ? null : path.join(dir, hit))
} else {
  process.stdout.write(`FAIL unknown subsystem ${JSON.stringify(which)}\n`)
  process.exitCode = 1
}
