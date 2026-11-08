// Every git a test starts runs with `core.fsmonitor=false` in its environment, injected here once for the whole suite instead of at the roughly 270 start sites in 130 files, where the next new test would forget it.
//
// Why: a host with `core.fsmonitor=true` in its global config (this repo's developer machine has it) starts a `git fsmonitor--daemon` for every fixture repository the first time `status`, `add` or `commit` runs in it, and that daemon outlives the test. Each start costs a process create and teardown (about 0.8 s of wall time per git start measured on this Windows host, of which under 0.15 s was git itself), and hundreds of idle daemons pile up. src/util.ts already passes `-c core.fsmonitor=` for the product's own git calls; this is the same for the fixtures.
//
// How: node:child_process is wrapped once per process, in tests/setup/isolate-home.ts, so spawn, spawnSync, execFile and execFileSync all go through one function. The wrapper hands a git start a copy of its environment (the caller's `env` option, else this process's) with GIT_CONFIG_COUNT/KEY/VALUE appended; the arguments are never touched, so a decoy or fake `git` binary a test puts first on PATH sees exactly the argv the test wrote. process.env itself stays clean: GIT_CONFIG_COUNT is a repository-local variable that tests/setup/isolate-home.ts deletes on purpose (tests/guards/test_process_inherits_no_repository_env.test.ts asserts it stays deleted), and fixtures that copy process.env scrub it from the copy. An option on the command line wins over the environment (`git -c core.fsmonitor=true` keeps true, measured with git 2.53.0.windows.1), so the product's runGit, which passes its own `-c core.fsmonitor=`, is unaffected. An environment that already names core.fsmonitor through GIT_CONFIG_KEY_n keeps its value.
//
// Not covered, by construction: git started by a child process the test spawns (the built bundle, a shell script) is covered only through the environment that child inherits; the bundle's own git goes through src/util.ts runGit, which disables fsmonitor itself.
import { createRequire, syncBuiltinESMExports } from 'node:module'
import * as path from 'node:path'

/** The key and value of the one config entry every fixture git start carries. */
export const GIT_FSMONITOR_KEY = 'core.fsmonitor'
export const GIT_FSMONITOR_VALUE = 'false'

const WRAPPED = Symbol.for('token-goat.tests.git-no-fsmonitor')

function isGitCommand(command: unknown): boolean {
  return typeof command === 'string' && path.basename(command).toLowerCase().replace(/[.]exe$/, '') === 'git'
}

/** A copy of `env` with core.fsmonitor=false appended to its GIT_CONFIG_COUNT entries, unless it already names core.fsmonitor or carries a count git would reject. */
export function withNoFsmonitorEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  const countKey = Object.keys(out).find((key) => key.toUpperCase() === 'GIT_CONFIG_COUNT') ?? 'GIT_CONFIG_COUNT'
  const raw = out[countKey]
  if (raw !== undefined && !/^[0-9]+$/.test(raw)) return out
  const count = raw === undefined ? 0 : Number(raw)
  for (let i = 0; i < count; i++) if (out[`GIT_CONFIG_KEY_${i}`]?.toLowerCase() === GIT_FSMONITOR_KEY) return out
  out[`GIT_CONFIG_KEY_${count}`] = GIT_FSMONITOR_KEY
  out[`GIT_CONFIG_VALUE_${count}`] = GIT_FSMONITOR_VALUE
  out[countKey] = String(count + 1)
  return out
}

type StartFn = (...callArgs: unknown[]) => unknown

/** `callArgs` of a (file[, args][, options][, callback]) call with the options' env replaced by `withNoFsmonitorEnv`; options are created when the caller passed none. */
function withNoFsmonitorOptions(callArgs: unknown[]): unknown[] {
  const second = callArgs[1]
  const optionsAt = Array.isArray(second) || (second == null && callArgs.length > 2) ? 2 : 1
  const given = callArgs[optionsAt]
  const next = [...callArgs]
  if (given !== null && typeof given === 'object') {
    const options = given as { env?: NodeJS.ProcessEnv }
    next[optionsAt] = { ...options, env: withNoFsmonitorEnv(options.env ?? process.env) }
  } else {
    next.splice(optionsAt, 0, { env: withNoFsmonitorEnv(process.env) })
  }
  return next
}

function wrap(original: StartFn): StartFn {
  const wrapped: StartFn = function (this: unknown, ...callArgs: unknown[]): unknown {
    return original.apply(this, isGitCommand(callArgs[0]) ? withNoFsmonitorOptions(callArgs) : callArgs)
  }
  // execFile carries a util.promisify.custom implementation that calls the unwrapped function; keep it, wrapped the same way.
  for (const key of Object.getOwnPropertySymbols(original)) {
    const member = (original as unknown as Record<symbol, unknown>)[key]
    Object.defineProperty(wrapped, key, { value: typeof member === 'function' ? wrap(member as StartFn) : member })
  }
  Object.defineProperty(wrapped, WRAPPED, { value: true })
  return wrapped
}

/** Wraps the four process starters once per process; a second call, or a reused fork running another test file, changes nothing. */
export function installGitNoFsmonitor(): void {
  const cp = createRequire(import.meta.url)('node:child_process') as Record<string, unknown>
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync'] as const) {
    const current = cp[name] as StartFn & { [WRAPPED]?: boolean }
    if (current[WRAPPED] === true) continue
    cp[name] = wrap(current)
  }
  syncBuiltinESMExports()
}
