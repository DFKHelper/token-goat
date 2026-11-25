/** The generated opencode plugin loads on opencode v2 (default export { id, setup }) and still loads on v1 (default export's server(), plus the named TokenGoatPlugin). Provenance, all FORMAT-DERIVED from opencode source at tag v2.4.1 (commit 6f0514052a3c859894ad01bb14cc14dda1e44b96, github.com/anomalyco/opencode): - the v2 loader's accepted default export: packages/core/src/plugin/module.ts, `const Module` (id: string plus a function `effect` or `setup`), the error text in loadServer. - the v2 hook event shapes: packages/plugin/src/promise/tool.ts (ToolHooks "execute.before"/"execute.after"), packages/plugin/src/promise/session.ts (SessionHooks "compaction", SessionContext.system). - the v2 tool names and argument keys: packages/core/src/tool/plugin/{read,shell,grep,edit,write,webfetch,websearch,skill,subagent,patch,glob}.ts (`export const name`, the Input schema). - the exit code: packages/core/src/tool/plugin/shell.ts, output field `exitCode`. - the v1 loader: packages/opencode/src/plugin/shared.ts readV1Plugin (identical at v1.4.0, v1.15.0, v1.18.0, v1.18.16, v1.18.28, v1.18.35). The real-binary check (opencode v2.4.1 refusing the old file with "Plugin must export a default definition with an id and an effect or setup function.") was run by hand and is not repeated here. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { transformSync } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'

import { OPENCODE_PLUGIN_SCRIPT } from '../../src/bridges/opencode.js'
import { expandShortPath } from '../../src/paths.js'

type Handler<E> = (event: E) => Promise<void> | void
type V2Event = Record<string, unknown>
interface V2Context {
  location: { directory: string }
  tool: { hook: (name: string, cb: Handler<V2Event>) => Promise<unknown> }
  session: { hook: (name: string, cb: Handler<V2Event>) => Promise<unknown> }
}
interface DefaultExport {
  id?: unknown
  setup?: unknown
  server?: unknown
  tui?: unknown
}
interface PluginModule {
  default?: DefaultExport
  TokenGoatPlugin: (ctx: { directory: string }) => Promise<Record<string, (input: unknown, output: unknown) => Promise<void>>>
}
interface RelayCall {
  event: string
  payload: Record<string, unknown>
}

const SPAWN_SLOT = '__tgOpencodeV2Spawn'
const slot = globalThis as Record<string, unknown>
const tempDirs: string[] = []
afterEach(() => {
  delete slot[SPAWN_SLOT]
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/** Loads the generated plugin as a module. Every hook relay goes to a fake entry that records the event and payload and prints answers[event] (or nothing). */
async function loadPlugin(answers: Record<string, unknown> = {}): Promise<{ mod: PluginModule; dir: string; calls: RelayCall[] }> {
  const dir = expandShortPath(mkdtempSync(join(tmpdir(), 'tg-opencode-v2-')).replace(/\\/g, '/'))
  tempDirs.push(dir)
  const entry = join(dir, 'entry.cjs')
  writeFileSync(entry, '', 'utf8')
  writeFileSync(join(dir, 'token-goat-entry.json'), JSON.stringify({ entryPath: entry }), 'utf8')
  const calls: RelayCall[] = []
  slot[SPAWN_SLOT] = (command: string, args: string[], options?: { input?: string }) => {
    if (command !== process.execPath) return { status: 1, stdout: '' }
    const event = args[2] ?? ''
    calls.push({ event, payload: JSON.parse(options?.input ?? '{}') as Record<string, unknown> })
    const answer = answers[event]
    return { status: 0, stdout: answer === undefined ? '' : JSON.stringify(answer) }
  }
  const { code } = transformSync(OPENCODE_PLUGIN_SCRIPT, { loader: 'js', format: 'esm' })
  const importLine = /import \{ spawnSync \} from "node:child_process";?/
  const patched = code.replace(importLine, `const spawnSync = (...a) => globalThis.${SPAWN_SLOT}(...a);`)
  expect(patched, 'the spawnSync import was replaced').not.toBe(code)
  const file = join(dir, 'plugin.mjs')
  writeFileSync(file, patched, 'utf8')
  const mod = (await import(pathToFileURL(file).href)) as PluginModule
  return { mod, dir, calls }
}

/** A hand-written restatement of opencode v2's loader check, not opencode's own code (FORMAT-DERIVED, no opencode dependency): the Module schema in packages/core/src/plugin/module.ts at v2.4.1. Returns the error text it would raise, or undefined when the module loads. */
function v2LoaderRefusal(mod: PluginModule): string | undefined {
  const value = mod.default
  const loads =
    typeof value === 'object' && value !== null && typeof value.id === 'string' && (typeof (value as { effect?: unknown }).effect === 'function' || typeof value.setup === 'function')
  return loads ? undefined : 'Plugin must export a default definition with an id and an effect or setup function.'
}

/** A hand-written restatement of opencode v1's loader check, not opencode's own code (FORMAT-DERIVED, no opencode dependency): readV1Plugin(mod, spec, "server", "detect") in packages/opencode/src/plugin/shared.ts, then resolvePluginId for a path plugin (it must export an id). */
function v1LoaderRefusal(mod: PluginModule): string | undefined {
  const value = mod.default
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'v1 reads its hooks from the named exports instead'
  if (typeof value.id !== 'string' || value.id.trim() === '') return 'Path plugin must export id'
  if (value.server !== undefined && typeof value.server !== 'function') return 'invalid server export'
  if (value.tui !== undefined) return 'must default export either server() or tui(), not both'
  if (value.server === undefined) return 'must default export an object with server()'
  return undefined
}

/** Runs the v2 setup() against a fake context and returns the hooks it registered, keyed "tool.execute.before" and so on. */
async function setupV2(mod: PluginModule, directory: string): Promise<Record<string, Handler<V2Event>>> {
  const hooks: Record<string, Handler<V2Event>> = {}
  const ctx: V2Context = {
    location: { directory },
    tool: { hook: async (name, cb) => (hooks[`tool.${name}`] = cb) },
    session: { hook: async (name, cb) => (hooks[`session.${name}`] = cb) },
  }
  await (mod.default!.setup as (c: V2Context) => Promise<void>)(ctx)
  return hooks
}

// A v2 execute.before event, shaped as ToolHooks["execute.before"] (tool.ts): tool, sessionID, input, plus the fields the plugin never reads.
const beforeEvent = (tool: string, input: unknown): V2Event => ({ tool, codemode: false, sessionID: 'ses_test', agent: 'build', messageID: 'msg_test', id: 'call_test', input })
// A completed v2 execute.after event, shaped as ToolHooks["execute.after"] (tool.ts) with status "completed" and result: Tool.Result (schema/src/tool.ts).
const afterEventDone = (tool: string, input: unknown, result: Record<string, unknown>): V2Event => ({ ...beforeEvent(tool, input), status: 'completed', result })

describe('opencode plugin default export: loads on v2 and on v1', () => {
  it('matches the v2.4.1 module.ts schema as restated here (FORMAT-DERIVED): a default export with a string id and a setup function', async () => {
    const { mod } = await loadPlugin()
    expect(v2LoaderRefusal(mod), 'opencode v2 refuses the generated file').toBeUndefined()
  })

  it('matches the v1 readV1Plugin check as restated here (FORMAT-DERIVED, shared.ts v1.18.35): the same default export carries id and server, and the named export stays', async () => {
    const { mod } = await loadPlugin()
    expect(v1LoaderRefusal(mod), 'opencode v1 refuses the generated file').toBeUndefined()
    expect(mod.default?.server, 'the default export reuses the v1 plugin function').toBe(mod.TokenGoatPlugin)
    expect(typeof mod.TokenGoatPlugin).toBe('function')
  })

  it('the v1 server() still returns the three v1 hooks', async () => {
    const { mod, dir } = await loadPlugin()
    const hooks = await (mod.default!.server as (c: { directory: string }) => Promise<Record<string, unknown>>)({ directory: dir })
    expect(Object.keys(hooks).sort()).toEqual(['experimental.session.compacting', 'tool.execute.after', 'tool.execute.before'])
  })

  it('registers exactly the three v2 hooks', async () => {
    const { mod, dir } = await loadPlugin()
    const hooks = await setupV2(mod, dir)
    expect(Object.keys(hooks).sort()).toEqual(['session.compaction', 'tool.execute.after', 'tool.execute.before'])
  })
})

describe('opencode v2 hooks relay to the same hook events as v1', () => {
  it('execute.before on a read relays pre_tool_use with the v1 payload, translating path to file_path', async () => {
    const { mod, dir, calls } = await loadPlugin()
    const hooks = await setupV2(mod, dir)
    await hooks['tool.execute.before']!(beforeEvent('read', { path: '/tmp/a.txt', offset: 3, limit: 9 }))
    expect(calls).toEqual([
      { event: 'pre_tool_use', payload: { session_id: 'ses_test', tool_name: 'Read', tool_input: { file_path: '/tmp/a.txt', offset: 3, limit: 9 }, cwd: dir } },
    ])
  })

  it('execute.before relays the same pre_tool_use payload a v1 tool.execute.before sends for the same read', async () => {
    const v1 = await loadPlugin()
    const v1Hooks = await v1.mod.TokenGoatPlugin({ directory: v1.dir })
    await v1Hooks['tool.execute.before']!({ tool: 'read', sessionID: 'ses_test' }, { args: { filePath: '/tmp/a.txt' } })
    const v2 = await loadPlugin()
    const v2Hooks = await setupV2(v2.mod, v2.dir)
    await v2Hooks['tool.execute.before']!(beforeEvent('read', { path: '/tmp/a.txt' }))
    expect({ ...v2.calls[0]!.payload, cwd: '' }).toEqual({ ...v1.calls[0]!.payload, cwd: '' })
  })

  it.each([
    ['shell', { command: 'ls' }, 'Bash', { command: 'ls' }],
    ['grep', { pattern: 'x', path: 'src' }, 'Grep', { pattern: 'x', path: 'src' }],
    ['webfetch', { url: 'https://example.com' }, 'WebFetch', { url: 'https://example.com' }],
    ['websearch', { query: 'q' }, 'WebSearch', { query: 'q' }],
    ['skill', { id: 'deploy' }, 'Skill', { skill: 'deploy' }],
    ['subagent', { agent: 'general', description: 'd', prompt: 'p' }, 'task', { subagent_type: 'general', description: 'd', prompt: 'p' }],
  ])('execute.before on a %s call relays it as %s with the v1 argument keys', async (tool, input, tgName, tgInput) => {
    const { mod, dir, calls } = await loadPlugin()
    const hooks = await setupV2(mod, dir)
    await hooks['tool.execute.before']!(beforeEvent(tool, input))
    expect(calls.map((c) => [c.event, c.payload['tool_name'], c.payload['tool_input']])).toEqual([['pre_tool_use', tgName, tgInput]])
  })

  it('execute.before on tools with no pre-hook or no token-goat equivalent relays nothing', async () => {
    const { mod, dir, calls } = await loadPlugin()
    const hooks = await setupV2(mod, dir)
    for (const tool of ['glob', 'edit', 'write', 'patch', 'todo', 'question', 'opencode.tool.read']) await hooks['tool.execute.before']!(beforeEvent(tool, { path: 'x' }))
    expect(calls).toEqual([])
  })

  // FORMAT-DERIVED: a throw in execute.before becomes the tool's error (Tool.Error message) in packages/plugin/src/promise/adapter.ts at v2.4.1, and the tool does not run.
  it('a deny surfaces its reason verbatim as the thrown Error message', async () => {
    const { mod, dir } = await loadPlugin({ pre_tool_use: { decision: 'block', reason: 'already read this file' } })
    const hooks = await setupV2(mod, dir)
    let thrown: unknown
    try {
      await hooks['tool.execute.before']!(beforeEvent('read', { path: '/tmp/a.txt' }))
    } catch (e) {
      thrown = e
    }
    expect(thrown, 'the hook threw an Error').toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('already read this file')
  })

  // FORMAT-DERIVED: v2 execute.before event.input is the tool's argument object, mutable (packages/plugin/src/promise/tool.ts at v2.4.1); the write tool's arguments are path and content (core/src/tool/plugin/write.ts).
  it('execute.before keeps a string content argument through an input rewrite', async () => {
    const answer = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'ls -la' } } }
    const { mod, dir, calls } = await loadPlugin({ pre_tool_use: answer })
    const hooks = await setupV2(mod, dir)
    const event = beforeEvent('shell', { command: 'ls', content: 'plain string body' })
    await hooks['tool.execute.before']!(event)
    expect(calls.map((c) => c.event), 'the call was relayed').toEqual(['pre_tool_use'])
    expect(event['input']).toEqual({ command: 'ls -la', content: 'plain string body' })
  })

  it('execute.before throws the block reason, which fails the call', async () => {
    const { mod, dir } = await loadPlugin({ pre_tool_use: { decision: 'block', reason: 'already read this file' } })
    const hooks = await setupV2(mod, dir)
    await expect(hooks['tool.execute.before']!(beforeEvent('read', { path: '/tmp/a.txt' }))).rejects.toThrow('already read this file')
  })

  it('execute.before applies an updatedInput rewrite to the v2 argument keys and keeps the other arguments', async () => {
    const answer = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { file_path: '/tmp/shrunk.png', prompt: 'ignored' } } }
    const { mod, dir } = await loadPlugin({ pre_tool_use: answer })
    const hooks = await setupV2(mod, dir)
    const event = beforeEvent('read', { path: '/tmp/a.png', offset: 2 })
    await hooks['tool.execute.before']!(event)
    expect(event['input']).toEqual({ path: '/tmp/shrunk.png', offset: 2, prompt: 'ignored' })
  })

  it('execute.before rewrites a subagent prompt through the task mapping', async () => {
    const answer = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { prompt: 'briefed p', subagent_type: 'explore' } } }
    const { mod, dir } = await loadPlugin({ pre_tool_use: answer })
    const hooks = await setupV2(mod, dir)
    const event = beforeEvent('subagent', { agent: 'general', description: 'd', prompt: 'p' })
    await hooks['tool.execute.before']!(event)
    expect(event['input']).toEqual({ agent: 'explore', description: 'd', prompt: 'briefed p' })
  })

  it('execute.after relays post_tool_use with the result text and the shell exit code', async () => {
    const { mod, dir, calls } = await loadPlugin()
    const hooks = await setupV2(mod, dir)
    await hooks['tool.execute.after']!(afterEventDone('shell', { command: 'ls' }, { content: 'a.txt', output: { exitCode: 2 } }))
    expect(calls).toEqual([
      { event: 'post_tool_use', payload: { session_id: 'ses_test', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { output: 'a.txt', exit_code: 2 }, cwd: dir } },
    ])
  })

  it('execute.after reads the text out of a list of content parts', async () => {
    const { mod, dir, calls } = await loadPlugin()
    const hooks = await setupV2(mod, dir)
    const content = [{ type: 'text', text: 'one' }, { type: 'file', uri: 'file:///x', mime: 'image/png' }, { type: 'text', text: 'two' }]
    await hooks['tool.execute.after']!(afterEventDone('read', { path: '/tmp/a' }, { content }))
    expect((calls[0]!.payload['tool_response'] as { output: string }).output).toBe('one\ntwo')
  })

  it('execute.after replaces the result text with updatedToolOutput and leaves the rest of the result alone', async () => {
    const answer = { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'fenced output' } }
    const { mod, dir } = await loadPlugin({ post_tool_use: answer })
    const hooks = await setupV2(mod, dir)
    const event = afterEventDone('webfetch', { url: 'https://example.com' }, { content: 'raw', metadata: { status: 200 } })
    await hooks['tool.execute.after']!(event)
    expect(event['result']).toEqual({ content: 'fenced output', metadata: { status: 200 } })
  })

  it('execute.after appends additionalContext to a string result', async () => {
    const answer = { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'hint' } }
    const { mod, dir } = await loadPlugin({ post_tool_use: answer })
    const hooks = await setupV2(mod, dir)
    const event = afterEventDone('grep', { pattern: 'x' }, { content: 'out' })
    await hooks['tool.execute.after']!(event)
    expect((event['result'] as { content: string }).content).toBe('out\n\n[token-goat] hint')
  })

  it('execute.after does nothing for a failed call or an unmapped tool', async () => {
    const answer = { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'changed' } }
    const { mod, dir, calls } = await loadPlugin({ post_tool_use: answer })
    const hooks = await setupV2(mod, dir)
    const failed = { ...beforeEvent('shell', { command: 'x' }), status: 'error', error: { message: 'boom' } }
    await hooks['tool.execute.after']!(failed)
    const unmapped = afterEventDone('todo', {}, { content: 'kept' })
    await hooks['tool.execute.after']!(unmapped)
    expect(calls, 'no relay call').toEqual([])
    expect(unmapped['result']).toEqual({ content: 'kept' })
  })

  it('compaction relays pre_compact and adds the manifest to the compaction request system parts', async () => {
    const { mod, dir, calls } = await loadPlugin({ pre_compact: { systemMessage: 'manifest text' } })
    const hooks = await setupV2(mod, dir)
    const event = { sessionID: 'ses_test', agent: 'build', system: [{ type: 'text', text: 'existing' }], messages: [], options: {}, tools: {} } as V2Event
    await hooks['session.compaction']!(event)
    expect(calls).toEqual([{ event: 'pre_compact', payload: { session_id: 'ses_test' } }])
    expect(event['system']).toEqual([{ type: 'text', text: 'existing' }, { type: 'text', text: 'manifest text' }])
  })

  it('compaction leaves the request alone when token-goat has no manifest', async () => {
    const { mod, dir } = await loadPlugin({ pre_compact: {} })
    const hooks = await setupV2(mod, dir)
    const event = { sessionID: 'ses_test', system: [{ type: 'text', text: 'existing' }] } as V2Event
    await hooks['session.compaction']!(event)
    expect(event['system']).toEqual([{ type: 'text', text: 'existing' }])
  })
})
