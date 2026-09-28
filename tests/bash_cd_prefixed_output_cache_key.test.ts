// A cached Bash result was recorded in the session under the command alone, with the `cd DIR &&` prefix stripped and no directory in the key, and its blob and staleness fingerprints were taken against the event's cwd rather than the directory the cd left the shell in. So `cd pkgA && cargo build` and `cd pkgB && cargo build` were one command: the pre hook offered pkgA's output as the cached result of pkgB's build, and the post hook took pkgB's run for a rerun of pkgA's, reporting pkgA's errors as resolved and marking pkgA's output superseded for the compaction manifest. Both hooks now key on the directory the command runs in.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { getBashOutput } from '../src/bash_output_cache.js'
import { stripUnsafeSuggestions } from '../src/hint_suggestion_guard.js'
import type { HookEvent } from '../src/hook_registry.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { cdPrefixCwd } from '../src/hooks_bash_commands.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { normalizePath, resolveIndexPath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { getSessionBashOutputs, getSessionBashReruns } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import type { HookOutput } from '../src/types.js'

// HAND-DERIVED: rustc's `error[E0425]` diagnostic shape, 30 lines so the body clears the 512-byte recall floor; pkgA's build fails and pkgB's builds clean.
const FAILING = Array.from({ length: 30 }, (_, i) => `error[E0425]: cannot find value \`limit${i}\` in this scope`).join('\n')
const CLEAN = Array.from({ length: 30 }, (_, i) => `   Compiling writer-part${i} v0.1.0`).join('\n') + '\n    Finished dev [unoptimized + debuginfo] target(s) in 4.20s'

const dirs: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** Points the home directory at `dir`: os.homedir() reads HOME on Linux and macOS and USERPROFILE on Windows. */
function homeAt(dir: string): void {
  vi.stubEnv('HOME', dir)
  vi.stubEnv('USERPROFILE', dir)
}

/** A root holding two packages, the directories one command runs in behind two different `cd` prefixes. */
function layout(): { root: string; pkgA: string; pkgB: string } {
  const root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cd-cache-key-')))
  dirs.push(root)
  const pkgA = normalizePath(path.join(root, 'pkgA'))
  const pkgB = normalizePath(path.join(root, 'pkgB'))
  for (const dir of [pkgA, pkgB]) fs.mkdirSync(dir)
  return { root, pkgA, pkgB }
}

function newSession(): string {
  return `s-cd-cache-${process.pid}-${Math.random().toString(36).slice(2)}`
}

/** One load, handle and save per hook call, as relay.ts runs it, so a key the post hook records has to survive the store's merge before the pre hook reads it. */
async function asHook<T>(sid: string, handle: () => T | Promise<T>): Promise<T> {
  loadSessionState(sid)
  try {
    return await handle()
  } finally {
    saveSessionState(sid)
  }
}

/** Which call an event belongs to: one tool_use_id rides on a call's PreToolUse and PostToolUse alike, and an agent_id only inside a subagent. */
interface Call {
  readonly toolUseId?: string
  readonly agentId?: string
}

// CAPTURE: Claude Code 2.1.281 running `cd sub && pwd` on the main thread and inside a subagent, with hooks writing each payload to a file: the main thread's PreToolUse cwd was the directory the call started in and its PostToolUse cwd the one the cd left the shell in, a subagent's cwd was its start directory on both events, and each call carried one tool_use_id on both.
const SUBAGENT: Call = { agentId: 'a3fa4da94f851e86f' }

// CAPTURE: the envelope and the Bash tool_response keys { stdout, stderr, interrupted, isImage, noOutputExpected } are Claude Code's, recorded off real traffic in tests/hooks_real_harness_payload_shape.test.ts; Claude Code reports no exit code there, so none is sent.
function bashEvent(sid: string, cwd: string, command: string, eventName: 'pre_tool_use' | 'post_tool_use', stdout: string, call: Call): HookEvent {
  const raw: Record<string, unknown> = { cwd, tool_name: 'Bash', tool_input: { command } }
  if (call.toolUseId !== undefined) raw['tool_use_id'] = call.toolUseId
  if (call.agentId !== undefined) raw['agent_id'] = call.agentId
  if (eventName === 'post_tool_use') raw['tool_response'] = { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
  return { eventName, toolName: 'Bash', toolInput: { command }, sessionId: sid, agentId: call.agentId, raw }
}

function text(result: HookOutput): string {
  return result.hookType === 'context' ? result.context : ''
}

async function post(sid: string, cwd: string, command: string, stdout: string, call: Call = SUBAGENT): Promise<HookOutput> {
  return asHook(sid, () => postBashHandler(bashEvent(sid, cwd, command, 'post_tool_use', stdout, call)))
}

async function pre(sid: string, cwd: string, command: string, call: Call = SUBAGENT): Promise<string> {
  return text(await asHook(sid, () => preBashHandler(bashEvent(sid, cwd, command, 'pre_tool_use', '', call))))
}

/** The one output id the session has on record, read back the way the manifest and the recall hint read it. */
function onlyCachedId(sid: string): string {
  loadSessionState(sid)
  const pairs = getSessionBashOutputs()
  expect(pairs).toHaveLength(1)
  return pairs[0]![1]
}

describe('a cached Bash result is keyed on the directory the command ran in', () => {
  it('the pre hook does not offer one package build as the cached output of the same build in another', async () => {
    clearModuleCaches()
    const { root, pkgA, pkgB } = layout()
    const sid = newSession()
    await post(sid, root, 'cd pkgA && cargo build', FAILING)
    const idA = onlyCachedId(sid)
    expect(getBashOutput(idA)?.output).toBe(FAILING)

    expect(await pre(sid, root, 'cd pkgB && cargo build')).not.toContain(idA)
    // Positive controls: the build in pkgA is still recalled, whether a cd prefix or the event's own cwd puts the shell there, so a fix that answered the assertion above by dropping recall for cd-prefixed commands fails here.
    expect(await pre(sid, root, 'cd pkgA && cargo build')).toContain('bash-output ' + idA)
    expect(await pre(sid, pkgA, 'cargo build')).toContain('bash-output ' + idA)
    expect(await pre(sid, pkgB, 'cargo build')).not.toContain(idA)
  })

  it('the post hook does not take the same build in another package for a rerun of the first', async () => {
    clearModuleCaches()
    const { root } = layout()
    const sid = newSession()
    await post(sid, root, 'cd pkgA && cargo build', FAILING)
    const second = await post(sid, root, 'cd pkgB && cargo build', CLEAN)

    // pkgB's clean build resolved none of pkgA's errors, so no delta may claim it did, and pkgA's output is not superseded.
    expect(text(second)).not.toContain('[token-goat: delta]')
    loadSessionState(sid)
    expect(getSessionBashReruns()).toEqual([])
    const outputs = getSessionBashOutputs().map(([, id]) => getBashOutput(id)?.output)
    expect(outputs.sort()).toEqual([CLEAN, FAILING].sort())

    // Positive control: a second build in pkgA is the rerun, so the delta and the superseded mark still fire where they are true.
    const rerun = await post(sid, root, 'cd pkgA && cargo build', CLEAN)
    expect(text(rerun)).toContain('[token-goat: delta] 30 of 30 prior issues resolved; remaining: 0')
    loadSessionState(sid)
    expect(getSessionBashReruns()).toHaveLength(1)
  })

  it('a main-thread post, whose cwd is already the directory the cd moved the shell to, does not apply the cd a second time', async () => {
    clearModuleCaches()
    const { root, pkgA } = layout()
    const sid = newSession()
    // Piped, so the pre hook leaves it to the harness's own shell, which the cd then moves: a command wrapped for compression runs its cd in a child shell and leaves the harness's where it was.
    const piped = 'cargo build 2>&1 | tail -n 400'
    const build = { toolUseId: 'toolu_cd_key_1' }
    await pre(sid, root, `cd pkgA && ${piped}`, build)
    await post(sid, pkgA, `cd pkgA && ${piped}`, FAILING, build)
    const idA = onlyCachedId(sid)

    // The shell stayed in pkgA, so the same build there is the same command in the same directory, and the same build from the root is not.
    expect(await pre(sid, pkgA, piped, { toolUseId: 'toolu_cd_key_2' })).toContain('bash-output ' + idA)
    expect(await pre(sid, root, piped, { toolUseId: 'toolu_cd_key_3' })).not.toContain(idA)

    // Rebuilding there is a rerun of pkgA's build, so the delta reports its errors resolved.
    const rerun = { toolUseId: 'toolu_cd_key_4' }
    await pre(sid, pkgA, piped, rerun)
    expect(text(await post(sid, pkgA, piped, CLEAN, rerun))).toContain('[token-goat: delta] 30 of 30 prior issues resolved; remaining: 0')
  })

  it('the large-output hint files its copy under the directory the command ran in, where the delta looks for a prior run', async () => {
    clearModuleCaches()
    const { root } = layout()
    const sid = newSession()
    // HAND-DERIVED: the two shapes above at 100 lines, past the 4 KB floor of the post hook's large-output hint; the pipe is what stops the pre hook wrapping the build for compression, so that hint fires.
    const bigFailing = Array.from({ length: 100 }, (_, i) => `error[E0425]: cannot find value \`limit${i}\` in this scope`).join('\n')
    const bigClean = Array.from({ length: 100 }, (_, i) => `   Compiling writer-part${i} v0.1.0`).join('\n') + '\n    Finished dev [unoptimized + debuginfo] target(s) in 4.20s'
    const piped = 'cargo build 2>&1 | tail -n 400'

    expect(text(await post(sid, root, `cd pkgA && ${piped}`, bigFailing))).toContain('KB uncompressed')
    // The same build run in the root is not a rerun of pkgA's, so no delta may report pkgA's errors resolved.
    expect(text(await post(sid, root, piped, bigClean))).not.toContain('[token-goat: delta]')
    // Positive control: a second build in pkgA is the rerun.
    expect(text(await post(sid, root, `cd pkgA && ${piped}`, bigClean))).toContain('[token-goat: delta]')
  })
})

describe("the large-output hint's compress suggestion runs the command in the directory it ran in", () => {
  // HAND-DERIVED: the failing build above at 100 lines, past the hint's 4 KB floor, piped so the pre hook leaves it unwrapped and the hint fires. The suggestion dropped the `cd pkgA &&` prefix, so run where the call started, as in a subagent or any harness whose shell does not keep a cd, it built the root instead of pkgA; kept as written instead, it names pkgA/pkgA once Claude Code's main thread has left the shell in pkgA.
  const big = Array.from({ length: 100 }, (_, i) => `error[E0425]: cannot find value \`limit${i}\` in this scope`).join('\n')
  const piped = 'cargo build 2>&1 | tail -n 400'

  function suggestion(hint: string): string | null {
    return /`(token-goat compress -c "[^"]*")`/.exec(hint)?.[1] ?? null
  }

  it('a main-thread call is suggested with a cd to the directory it resolved to', async () => {
    clearModuleCaches()
    const { root, pkgA } = layout()
    const sid = newSession()
    const call = { toolUseId: 'toolu_cd_hint_1' }
    await pre(sid, root, `cd pkgA && ${piped}`, call)
    const hint = text(await post(sid, pkgA, `cd pkgA && ${piped}`, big, call))
    expect(suggestion(hint)).toBe(`token-goat compress -c "cd '${pkgA}' && ${piped}"`)
    // The relay's suggestion scrubber lets it through whole.
    expect(stripUnsafeSuggestions(hint)).toBe(hint)
  })

  it('a subagent call, whose shell stays where it started, is suggested with the same directory', async () => {
    clearModuleCaches()
    const { root, pkgA } = layout()
    const hint = text(await post(newSession(), root, `cd pkgA && ${piped}`, big))
    expect(suggestion(hint)).toBe(`token-goat compress -c "cd '${pkgA}' && ${piped}"`)
  })

  it('a command with no cd prefix is suggested as it ran', async () => {
    clearModuleCaches()
    const { pkgA } = layout()
    expect(suggestion(text(await post(newSession(), pkgA, piped, big)))).toBe(`token-goat compress -c "${piped}"`)
  })

  it('a directory holding a single quote, which its quoting cannot hold, gets the recall pointer and no compress suggestion', async () => {
    clearModuleCaches()
    const { root } = layout()
    fs.mkdirSync(path.join(root, "pkg'Q"))
    const hint = text(await post(newSession(), root, `cd "pkg'Q" && ${piped}`, big))
    expect(hint).toMatch(/`token-goat bash-output [0-9a-f]+`/)
    expect(suggestion(hint)).toBeNull()
  })

  it.each([
    ['~/pkgA', 'pkgA'],
    ['~', ''],
  ] as const)('a cd to %s is suggested with the home directory it expands to spelled out', async (dir, under) => {
    clearModuleCaches()
    const { root } = layout()
    homeAt(root)
    const hint = text(await post(newSession(), root, `cd ${dir} && ${piped}`, big))
    expect(suggestion(hint)).toBe(`token-goat compress -c "cd '${normalizePath(path.join(root, under))}' && ${piped}"`)
  })

  // HAND-DERIVED: the hook leaves another account's home and a quoted `~` as written, so each resolves to a directory under the one the call started in, which is not there. A suggestion naming it would fail at its cd before the build runs.
  it.each(['~other/pkgA', '"~/pkgA"'])('a cd to %s, which the hook cannot resolve to a directory that is there, gets the recall pointer and no compress suggestion', async (dir) => {
    clearModuleCaches()
    const { root } = layout()
    homeAt(root)
    const hint = text(await post(newSession(), root, `cd ${dir} && ${piped}`, big))
    expect(hint).toMatch(/`token-goat bash-output [0-9a-f]+`/)
    expect(suggestion(hint)).toBeNull()
  })
})

// FORMAT-DERIVED from bash(1), "Tilde Expansion": an unquoted word that starts with `~` alone or `~/` has the tilde replaced by $HOME, `~name` by that user's home, and a quoted `~` is not expanded; a variable expands to whatever the shell's environment holds when the command runs. The hook resolved every cd target as a path, so the key for a command behind `cd ~/pkgA` named a directory called `~` that never existed.
describe('a cd to a home-relative directory is keyed where the shell lands', () => {
  it('an unquoted `~` and `~/pkgA` resolve under the home directory', () => {
    const { root, pkgA, pkgB } = layout()
    homeAt(root)
    expect(cdPrefixCwd('cd ~/pkgA && cargo build', pkgB)).toBe(pkgA)
    expect(cdPrefixCwd('cd ~ && cargo build', pkgB)).toBe(root)
    expect(cdPrefixCwd('cd ~ && cd pkgA && cargo build', pkgB)).toBe(pkgA)
  })

  it.each([
    ['cd ~other/pkgA', '~other/pkgA'],
    ['cd $HOME/pkgA', '$HOME/pkgA'],
    ['cd "$HOME/pkgA"', '$HOME/pkgA'],
    ["cd '~/pkgA'", '~/pkgA'],
    ['cd "~/pkgA"', '~/pkgA'],
    ['cd ~+/pkgA', '~+/pkgA'],
  ])('%s is left as written', (prefix, written) => {
    const { root, pkgB } = layout()
    homeAt(root)
    expect(cdPrefixCwd(`${prefix} && cargo build`, pkgB)).toBe(resolveIndexPath(written, pkgB))
  })

  it('a build behind `cd ~/pkgA` is recalled as the same build run in pkgA', async () => {
    clearModuleCaches()
    const { root, pkgA, pkgB } = layout()
    homeAt(root)
    const sid = newSession()
    await post(sid, pkgA, 'cargo build', FAILING)
    const idA = onlyCachedId(sid)
    expect(await pre(sid, pkgB, 'cd ~/pkgA && cargo build')).toContain('bash-output ' + idA)
    // Positive control: the same prefix with the home directory elsewhere names another directory, so the recall above is the expansion and not a key that ignores the prefix.
    homeAt(pkgB)
    expect(await pre(sid, pkgB, 'cd ~/pkgA && cargo build')).not.toContain(idA)
  })
})
