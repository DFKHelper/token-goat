/** `token-goat doctor`'s Hook server line (src/cli_doctor.ts checkHookServer / runDoctorChecks). A server that is not running is the normal state between sessions, so only a recorded start failure may warn; the failure text is the one place a background start's error ever surfaces. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { checkHookServer, runDoctorChecks } from '../src/cli_doctor.js'
import { dataDir } from '../src/constants.js'
import { markerPath, removeMarker, touchMarker, type ServerStatus } from '../src/hook_ipc.js'

// HAND-DERIVED: the fields src/hook_ipc.ts ServerStatus declares, with values chosen so each one is distinguishable in the rendered line.
function status(slot: number, pid: number, served: number): ServerStatus {
  return { pid, slot, version: '9.9.9', startedAt: 1_000, lastUsedAt: 2_000, served, errors: 0 }
}

describe('checkHookServer', () => {
  it('reports ok and says every call starts its own process when the server is turned off, even with a recorded failure', () => {
    const r = checkHookServer({ enabled: false, statuses: [status(0, 11, 3)], failure: 'slot 0: boom' })
    expect(r).toEqual({ name: 'Hook server', status: 'ok', message: 'off (hooks.server or TOKEN_GOAT_HOOK_SERVER); every hook call starts its own process' })
  })

  it('lists every running server with its slot, pid and served count', () => {
    const r = checkHookServer({ enabled: true, statuses: [status(0, 4242, 17), status(2, 5151, 0)] })
    expect(r).toEqual({ name: 'Hook server', status: 'ok', message: '2 running (slot 0, pid 4242, 17 served; slot 2, pid 5151, 0 served)' })
  })

  it('prefers the running servers over a stale failure marker', () => {
    const r = checkHookServer({ enabled: true, statuses: [status(1, 7, 1)], failure: 'slot 0: old failure' })
    expect(r.status).toBe('ok')
    expect(r.message).toBe('1 running (slot 1, pid 7, 1 served)')
  })

  it('warns with the failure text and the foreground command when none is running and the last start failed', () => {
    const r = checkHookServer({ enabled: true, statuses: [], failure: 'slot 0: EACCES: permission denied' })
    expect(r.status).toBe('warn')
    expect(r.message).toContain('slot 0: EACCES: permission denied')
    expect(r.message).toContain("Run 'token-goat hook-server run' to see it in the foreground")
  })

  it('reports ok when none is running and nothing failed, since the next hook call starts one', () => {
    expect(checkHookServer({ enabled: true, statuses: [] })).toEqual({ name: 'Hook server', status: 'ok', message: 'not running; the next hook call starts one' })
    expect(checkHookServer({ enabled: true, statuses: [], failure: undefined }).status).toBe('ok')
  })
})

describe('runDoctorChecks', () => {
  let savedServerEnv: string | undefined

  beforeEach(() => {
    savedServerEnv = process.env['TOKEN_GOAT_HOOK_SERVER']
  })

  afterEach(() => {
    if (savedServerEnv === undefined) delete process.env['TOKEN_GOAT_HOOK_SERVER']
    else process.env['TOKEN_GOAT_HOOK_SERVER'] = savedServerEnv
    removeMarker('failed')
  })

  function hookServerLine(results: Awaited<ReturnType<typeof runDoctorChecks>>): { status: string; message: string } {
    const lines = results.filter((r) => r.name === 'Hook server')
    expect(lines).toHaveLength(1)
    return lines[0] as { status: string; message: string }
  }

  it('reads the failed marker from the data directory and turns it into a warning', async () => {
    process.env['TOKEN_GOAT_HOOK_SERVER'] = '1'
    // No hook-server.key in this file's isolated data dir, so serverStatuses() answers [] without touching any endpoint.
    expect(fs.existsSync(path.join(dataDir(), 'hook-server.key'))).toBe(false)
    touchMarker('failed', 'slot 1: --slot must be an integer from 0 to 2')
    expect(fs.existsSync(markerPath('failed'))).toBe(true)
    const line = hookServerLine(await runDoctorChecks(undefined, undefined, undefined, []))
    expect(line.status).toBe('warn')
    expect(line.message).toContain('slot 1: --slot must be an integer from 0 to 2')
  })

  it('reports off when TOKEN_GOAT_HOOK_SERVER=0, and ignores the failed marker then', async () => {
    process.env['TOKEN_GOAT_HOOK_SERVER'] = '0'
    touchMarker('failed', 'slot 0: boom')
    const line = hookServerLine(await runDoctorChecks(undefined, undefined, undefined, []))
    expect(line.status).toBe('ok')
    expect(line.message).toMatch(/^off /)
  })
})
