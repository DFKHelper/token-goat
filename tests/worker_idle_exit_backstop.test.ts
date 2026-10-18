/** Every worker daemon a test starts inherits an idle exit from the run's environment, so one outliving a hard-killed run leaves on its own. Test hygiene, not product behaviour. */
import { describe, expect, it } from 'vitest'

import { resolveIdleExitMs } from '../src/worker.js'
import { tgIsolatedEnv } from './helpers/bundle.js'
import { TEST_WORKER_IDLE_EXIT_MS } from './setup/resident-backstop.js'

// HAND-DERIVED: the idle rule is read off src/worker.ts::resolveIdleExitMs (a positive integer in TG_WORKER_IDLE_EXIT_MS, else six hours) and runWorkerLoop; tests/setup/isolate-home.ts is the setupFiles entry every test file runs. No wire format is involved.
describe('the idle exit of a test-started worker daemon', () => {
  it('is set for the whole run by the setup file, below the product default', () => {
    expect(process.env['TG_WORKER_IDLE_EXIT_MS'], 'the run gives a spawned daemon no idle exit').toBe(String(TEST_WORKER_IDLE_EXIT_MS))
    expect(resolveIdleExitMs()).toBe(TEST_WORKER_IDLE_EXIT_MS)
    expect(TEST_WORKER_IDLE_EXIT_MS).toBeLessThan(6 * 60 * 60 * 1000)
  })

  it('rides along in the environment the shared bundle helper hands a spawn', () => {
    expect(tgIsolatedEnv('base', {})['TG_WORKER_IDLE_EXIT_MS']).toBe(String(TEST_WORKER_IDLE_EXIT_MS))
  })

  it('yields to a test that sets its own', () => {
    expect(tgIsolatedEnv('base', { TG_WORKER_IDLE_EXIT_MS: '1500' })['TG_WORKER_IDLE_EXIT_MS']).toBe('1500')
  })
})
