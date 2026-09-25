/** Module-reset registry. Modules with mutable global state register a clear function at load time via {@link registerReset}. Tests call {@link clearModuleCaches} in `beforeEach` to restore clean state without spawning a fresh process. No imports from other local modules. */

type ResetFn = () => void

const _resets: ResetFn[] = []
// The subset that holds state belonging to one caller rather than to the process: which harness is calling, whose session is loaded. A process that serves many callers (hook_server.ts) runs these between requests and keeps the rest, which is exactly the warm state (loaded modules and models, registered hook handlers) it exists to keep. Open databases are not part of it: db.ts closes them per request, so a server never pins a file that `--purge` or a replacement needs.
const _perRequestResets: ResetFn[] = []

/** Register a reset callback to run when {@link clearModuleCaches} is called. Call this at module load time (top level), not inside a function, so the callback is registered exactly once per process. */
export function registerReset(fn: () => void, opts: { perRequest?: boolean } = {}): void {
  _resets.push(fn)
  if (opts.perRequest === true) _perRequestResets.push(fn)
}

/** Run every registered reset callback. Each callback runs in its own try/catch so a throw in one does not block the others. Collected errors are rethrown after all resets complete: a single error is rethrown as-is, multiple errors are wrapped in an AggregateError so the failures are not silently swallowed. */
export function clearModuleCaches(): void {
  runResets(_resets)
}

/** Run only the resets registered with `perRequest`, leaving process-wide warm state in place. Same error handling as {@link clearModuleCaches}. */
export function clearPerRequestCaches(): void {
  runResets(_perRequestResets)
}

function runResets(resets: readonly ResetFn[]): void {
  const errors: unknown[] = []
  for (const fn of resets) {
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
  _perRequestResets.length = 0
}
