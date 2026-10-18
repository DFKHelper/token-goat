import { TEST_WORKER_IDLE_EXIT_MS } from '../setup/resident-backstop.js'
import { tgIsolatedEnv } from './bundle.js'

/** The per-test timeout of the stray-resident e2e tests that start the most daemons (tests/worker_stray_retire_e2e.test.ts); vitest ends a test at this bound whatever the machine's speed. */
export const STRAY_TEST_TIMEOUT_MS = 180_000

/** The environment of a daemon the stray-resident e2e starts: isolated data home, a long poll, the run's idle exit stated again so it holds without the setup file, embeddings off, and the real spawn path left open (the suite pins TOKEN_GOAT_NO_WORKER_SPAWN=1, which would turn the shim's spawn into a no-op). */
export function strayWorkerEnv(base: string, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = tgIsolatedEnv(base, { TG_WORKER_POLL_MS: '600000', TG_WORKER_IDLE_EXIT_MS: String(TEST_WORKER_IDLE_EXIT_MS), TOKEN_GOAT_EMBEDDINGS_ENABLED: '0', ...extra })
  delete env['TOKEN_GOAT_NO_WORKER_SPAWN']
  return env
}
