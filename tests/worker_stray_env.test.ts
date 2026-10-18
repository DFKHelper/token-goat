/** What ends a worker daemon the stray-resident e2e started when its test run is killed before any afterEach runs: those daemons run from copies of dist/, so the run-root sweep (tests/setup/build-bundle.ts::killDaemonsUnder) does not recognise them, and only the daemon's own idle exit is left. Test hygiene, not product behaviour. */
import { describe, expect, it } from 'vitest'

import { resolveIdleExitMs } from '../src/worker.js'
import { STRAY_TEST_TIMEOUT_MS, strayWorkerEnv } from './helpers/worker_stray_env.js'

// HAND-DERIVED: the idle rule is read off src/worker.ts::runWorkerLoop, which leaves once `Date.now() - lastBusyMs >= idleExitMs` and counts lastBusyMs from the loop's start or its last drained batch; the timeout is the one vitest enforces on the stray e2e tests. No wire format is involved.
describe('the environment of a stray-resident e2e daemon', () => {
  it('sets an idle exit, so a daemon outliving a killed run leaves on its own', () => {
    const env = strayWorkerEnv('base', {})
    expect(env['TG_WORKER_IDLE_EXIT_MS'], 'no idle exit in the daemon environment').toBeDefined()
    expect(Number.isInteger(Number(env['TG_WORKER_IDLE_EXIT_MS'])) && Number(env['TG_WORKER_IDLE_EXIT_MS']) > 0).toBe(true)
  })

  it('is longer than any test that needs the daemon, which the runner ends first, and shorter than the default', () => {
    const saved = process.env['TG_WORKER_IDLE_EXIT_MS']
    try {
      delete process.env['TG_WORKER_IDLE_EXIT_MS']
      const defaultMs = resolveIdleExitMs()
      const chosen = Number(strayWorkerEnv('base', {})['TG_WORKER_IDLE_EXIT_MS'])
      process.env['TG_WORKER_IDLE_EXIT_MS'] = String(chosen)
      expect(resolveIdleExitMs(), 'the product does not read the value as given').toBe(chosen)
      expect(chosen).toBeGreaterThan(STRAY_TEST_TIMEOUT_MS)
      expect(chosen).toBeLessThan(defaultMs)
    } finally {
      if (saved === undefined) delete process.env['TG_WORKER_IDLE_EXIT_MS']
      else process.env['TG_WORKER_IDLE_EXIT_MS'] = saved
    }
  })

  it('keeps the real spawn path open', () => {
    expect(strayWorkerEnv('base', {})).not.toHaveProperty('TOKEN_GOAT_NO_WORKER_SPAWN')
  })
})
