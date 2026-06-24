/**
 * Module-reset registry.
 *
 * Modules with mutable global state register a clear function at load time via
 * {@link registerReset}. Tests call {@link clearModuleCaches} in `beforeEach`
 * to restore clean state without spawning a fresh process. No imports from
 * other local modules.
 */

type ResetFn = () => void

const _resets: ResetFn[] = []

/**
 * Register a reset callback to run when {@link clearModuleCaches} is called.
 *
 * Call this at module load time (top level), not inside a function, so the
 * callback is registered exactly once per process.
 */
export function registerReset(fn: () => void): void {
  _resets.push(fn)
}

/**
 * Run every registered reset callback.
 *
 * Each callback runs in its own try/catch so a throw in one does not block the
 * others. Collected errors are rethrown after all resets complete: a single
 * error is rethrown as-is, multiple errors are wrapped in an AggregateError so
 * the failures are not silently swallowed.
 */
export function clearModuleCaches(): void {
  const errors: unknown[] = []
  for (const fn of _resets) {
    try {
      fn()
    } catch (err) {
      errors.push(err)
    }
  }
  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'clearModuleCaches: one or more resets failed')
  }
}

/** For use in tests only — clears all registered reset callbacks. */
export function _clearResetRegistryForTesting(): void {
  _resets.length = 0
}
