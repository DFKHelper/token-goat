import { afterEach, beforeEach } from 'vitest'

import { setHookSelftestRunnerForTesting } from '../../src/hook_selftest.js'

/** Call at a test file's top level: each row runs with an install self-test that always passes, so the ~7 s of real host shells per install is skipped; rows that assert the self-test keep the real runner by resetting it. */
export function useStubbedHookSelftest(): void {
  beforeEach(() => setHookSelftestRunnerForTesting(() => ({ status: 0, stdout: '{}', stderr: '' })))
  afterEach(() => setHookSelftestRunnerForTesting(undefined))
}
