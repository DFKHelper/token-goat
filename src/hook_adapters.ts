/** What each harness's hook shim decides around a token-goat hook call, in TypeScript, for the resident hook server's harness-aware protocol (HARNESS_PROTOCOL_VERSION in hook_ipc.ts). A client speaking it carries no harness logic: it names the harness and the event argument it was run with, and the server answers with exactly the stdout bytes and exit code that harness's installed Node shim would have produced. The shims (src/bridges/claudecode.ts, codex.ts, grok.ts, kimi.ts, copilot_cli.ts) keep their own embedded copies, because an installed shim reaches the server through the v1 client, which returns the relay's raw output and leaves the translation to the shim; translating twice is not harmless (a Grok deny answered twice becomes an allow). Nothing but tests/native_hook_adapter_equivalence.test.ts holds the two copies together: it runs every installed shim and this module on the same payloads and requires identical bytes, so a change to either side belongs in both. */
import * as crypto from 'node:crypto'

import { materializeShrunkImageFile } from './bridges/vscode_hooks.js'
import { COPILOT_CLI_TOOL_NAME_MAP } from './copilot_tool_names.js'
import { ownGet } from './own_lookup.js'
import { foldToolName } from './tool_name_fold.js'
import { HOOK_EVENTS } from './types.js'

/** The harnesses that run a token-goat Node shim. The others call `token-goat hook <event>` directly (Gemini, Qwen), ride Claude Code's wiring (Cursor), or host token-goat in-process (opencode, pi, OpenClaw). */
export const ADAPTER_HARNESSES = ['claudecode', 'codex', 'grok', 'kimi', 'copilot_cli'] as const
export type AdapterHarness = (typeof ADAPTER_HARNESSES)[number]

export function isAdapterHarness(name: unknown): name is AdapterHarness {
  return typeof name === 'string' && (ADAPTER_HARNESSES as readonly string[]).includes(name)
}

/** What the server supplies: `early` sends bytes the harness must see before the handler runs and returns the harness's wait at that instant, in the caller's clock; `relay` runs one token-goat hook event in this process with the current environment (relay.ts relayInProcess). */
export interface AdapterIo {
  early(data: string): number
  relay(event: string, payload: unknown, harnessWaitMs?: number): Promise<string>
}

export interface AdapterRequest {
  event: string
  input: string
  harnessWaitMs?: number
  scriptDir?: string
}

export interface AdapterResult {
  stdout: string
  exit: number
}

interface Adapter {
  /** What the shim prints for an event argument it does not know. */
  unknown: string
  /** The event arguments the shim accepts. */
  events: readonly string[]
  run(req: AdapterRequest, io: AdapterIo): Promise<AdapterResult>
  /** What the shim prints when its request reached a server that never answered: the v1 client reports that as a relay output of `{}`, which the shim then translates. */
  lost(event: string): string
}

const HOOK_EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENTS)

const done = (stdout: string, exit = 0): AdapterResult => ({ stdout, exit })

/** `v[k]` by JavaScript's own lookup, which is how every shim reads its payload, except that a null or undefined `v` gives `undefined` where the shim's lookup would throw. Every such throw in a shim lands in a branch that treats the value as absent, so the two agree on output. */
function get(v: unknown, k: string): unknown {
  return v === null || v === undefined ? undefined : (v as Record<string, unknown>)[k]
}

/** The relay call every shim but Copilot CLI's makes, with the shim's two paths: a payload that parses is relayed as is; one that does not makes the shim fall back to spawning `token-goat hook <event>`, which reads stdin the way relay.ts readStdinJson does (trimmed, and `{}` for empty or invalid input) and whose empty stdout the shim treats as a failure. `undefined` means that failure. */
async function relayAsShim(event: string, input: string, io: AdapterIo, harnessWaitMs: number | undefined): Promise<string | undefined> {
  let payload: unknown
  try {
    payload = JSON.parse(input)
  } catch {
    const text = input.trim()
    let lenient: unknown = {}
    if (text !== '') {
      try {
        lenient = JSON.parse(text)
      } catch {
        lenient = {}
      }
    }
    const out = await io.relay(event, lenient)
    return out === '' ? undefined : out
  }
  return io.relay(event, payload, harnessWaitMs)
}

// Claude Code: SHIM_ASYNC_DETACH and SHIM_OWN_COMMAND_BYPASS in src/bridges/shim_common.ts, and main() in CLAUDECODE_HOOK_SCRIPT.

const ASYNC_DETACH_TOOLS: ReadonlySet<unknown> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const ASYNC_DETACH_SKIP_EXT_RE = /\.(md|mdx|markdown|rst)$/i
const ASYNC_DETACH_BASH_MAX_BYTES = 200
const ASYNC_DETACH_BASH_TEXT_KEYS = ['output', 'content', 'text', 'body', 'stdout', 'stderr']
export const ASYNC_DETACH_LINE = '{"async":true}\n'

function bashResultByteLength(resp: unknown): number {
  if (typeof resp === 'string') return Buffer.byteLength(resp, 'utf8')
  if (resp && typeof resp === 'object') {
    const persisted = get(resp, 'persistedOutputSize')
    if (typeof persisted === 'number') return persisted
    for (const key of ASYNC_DETACH_BASH_TEXT_KEYS) {
      const text = get(resp, key)
      if (typeof text === 'string' && text !== '') return Buffer.byteLength(text, 'utf8')
    }
    return Buffer.byteLength(JSON.stringify(resp), 'utf8')
  }
  return 0
}

export function isAsyncDetachEligible(event: string, input: string): boolean {
  if (event === 'subagent_stop') return true
  if (event !== 'post_tool_use') return false
  try {
    const payload: unknown = JSON.parse(input)
    const toolName = get(payload, 'tool_name')
    if (ASYNC_DETACH_TOOLS.has(toolName)) {
      const toolInput = get(payload, 'tool_input') || {}
      const filePath = get(toolInput, 'file_path')
      const notebookPath = get(toolInput, 'notebook_path')
      return !ASYNC_DETACH_SKIP_EXT_RE.test(typeof filePath === 'string' ? filePath : typeof notebookPath === 'string' ? notebookPath : '')
    }
    if (toolName === 'Bash') return bashResultByteLength(get(payload, 'tool_response')) < ASYNC_DETACH_BASH_MAX_BYTES
    return false
  } catch {
    return false
  }
}

const TG_CD_PREFIX_RE = /^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)[ \t]*(?:&&|;|\r?\n)\s*)+/
const TG_OWN_COMMAND_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:token-goat\b|node(?:\.exe)?\s+["']?(?:\S*[\\/])?token-goat(?:\.mjs)?["']?\b)/i

export function isOwnTokenGoatCommand(cmd: unknown): boolean {
  if (typeof cmd !== 'string' || cmd.trim() === '') return false
  const body = (cmd.replace(TG_CD_PREFIX_RE, '') || cmd).trim()
  if (/[;&|`]|\$\(/.test(body)) return false
  return TG_OWN_COMMAND_RE.test(body)
}

const claudecode: Adapter = {
  unknown: '{}',
  events: HOOK_EVENTS,
  lost: () => '{}',
  async run(req, io) {
    const { event, input } = req
    if (!HOOK_EVENT_SET.has(event)) return done('{}')
    if (event === 'pre_tool_use') {
      try {
        const payload: unknown = JSON.parse(input)
        if (get(payload, 'tool_name') === 'Bash' && isOwnTokenGoatCommand(get(get(payload, 'tool_input'), 'command'))) return done('{}')
      } catch {
        // unparseable stdin falls through to normal handling, as in the shim
      }
    }
    let harnessWaitMs = req.harnessWaitMs
    if (isAsyncDetachEligible(event, input)) harnessWaitMs = io.early(ASYNC_DETACH_LINE)
    return done((await relayAsShim(event, input, io, harnessWaitMs)) ?? '{}')
  },
}

// Codex: CODEX_HOOK_SCRIPT in src/bridges/codex.ts.

function stripTg(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTg)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('_tg_')) continue
      out[k] = stripTg(v)
    }
    return out
  }
  return value
}

function codexTranslate(stdout: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return '{}'
  }
  // The shim also fills a missing hookSpecificOutput.hookEventName. Nothing here does: every hookSpecificOutput a relay can return comes from serializeOutput (src/hook_registry.ts), which always names the event, and the equivalence test's serializer case pins that.
  return JSON.stringify(stripTg(parsed))
}

const codex: Adapter = {
  unknown: '{}',
  events: HOOK_EVENTS,
  lost: () => '{}',
  async run(req, io) {
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'codex'
    if (!HOOK_EVENT_SET.has(req.event)) return done('{}')
    const stdout = await relayAsShim(req.event, req.input, io, req.harnessWaitMs)
    return done(stdout === undefined ? '{}' : codexTranslate(stdout))
  },
}

// Grok: GROK_HOOK_SCRIPT in src/bridges/grok.ts. Exit 2 with a deny is how Grok is told to block a tool call.

const GROK_EVENTS = ['pre_tool_use', 'post_tool_use', 'notification', 'stop', 'pre_compact', 'user_prompt_submit', 'subagent_stop'] as const
const GROK_EVENT_SET: ReadonlySet<string> = new Set(GROK_EVENTS)

function grokAllow(event: string): string {
  return event === 'pre_tool_use' ? '{"decision":"allow"}' : '{}'
}

function grokTranslate(event: string, stdout: string): AdapterResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return done(grokAllow(event))
  }
  if (event !== 'pre_tool_use') return done(JSON.stringify(parsed))
  if (parsed && get(parsed, 'decision') === 'block') {
    return done(JSON.stringify({ decision: 'deny', reason: get(parsed, 'reason') || 'blocked by token-goat' }), 2)
  }
  return done('{"decision":"allow"}')
}

const grok: Adapter = {
  unknown: '{}',
  events: GROK_EVENTS,
  lost: (event) => grokTranslate(event, '{}').stdout,
  async run(req, io) {
    if (!GROK_EVENT_SET.has(req.event)) return done('{}')
    try {
      const stdout = await relayAsShim(req.event, req.input, io, req.harnessWaitMs)
      return stdout === undefined ? done(grokAllow(req.event)) : grokTranslate(req.event, stdout)
    } catch {
      return done(grokAllow(req.event))
    }
  },
}

// Kimi: KIMI_HOOK_SCRIPT in src/bridges/kimi.ts. Kimi reads empty stdout as "nothing to say", so every no-op is empty.

function kimiHintText(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return ''
  const hso = get(parsed, 'hookSpecificOutput')
  const context = get(hso, 'additionalContext')
  if (hso && typeof hso === 'object' && typeof context === 'string') return context
  const systemMessage = get(parsed, 'systemMessage')
  if (typeof systemMessage === 'string') return systemMessage
  return ''
}

function kimiTranslate(stdout: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return ''
  }
  if (!parsed || typeof parsed !== 'object') return ''
  const reason = get(parsed, 'reason')
  if (get(parsed, 'decision') === 'block' && typeof reason === 'string' && reason) {
    return JSON.stringify({ message: reason, hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: reason } })
  }
  const hint = kimiHintText(parsed)
  if (hint) return JSON.stringify({ message: hint })
  return ''
}

const kimi: Adapter = {
  unknown: '',
  events: HOOK_EVENTS,
  lost: () => kimiTranslate('{}'),
  async run(req, io) {
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'kimi'
    if (!HOOK_EVENT_SET.has(req.event)) return done('')
    try {
      const stdout = await relayAsShim(req.event, req.input, io, req.harnessWaitMs)
      return done(stdout === undefined ? '' : kimiTranslate(stdout))
    } catch {
      return done('')
    }
  },
}

// Copilot CLI: COPILOT_CLI_HOOK_SCRIPT in src/bridges/copilot_cli.ts, including its branch for VS Code, which runs the same hooks file with its own payload shape.

const COPILOT_TO_TG_EVENT: Readonly<Record<string, string>> = {
  sessionStart: 'session_start',
  preToolUse: 'pre_tool_use',
  postToolUse: 'post_tool_use',
  preCompact: 'pre_compact',
  agentStop: 'stop',
  subagentStop: 'subagent_stop',
  userPromptSubmitted: 'user_prompt_submit',
  postToolUseFailure: 'post_tool_use_failure',
  subagentStart: 'subagent_start',
}

/** Hooks-file keys only VS Code reads (the shim's VSCODE_ONLY_TO_TG_EVENT); a Copilot CLI payload on one is answered with nothing. */
const VSCODE_ONLY_TO_TG_EVENT: Readonly<Record<string, string>> = {
  SubagentStart: 'subagent_start',
}

const FOLDED_COPILOT_TOOL_TO_TG: Record<string, string> = {}
for (const [k, v] of Object.entries(COPILOT_CLI_TOOL_NAME_MAP)) FOLDED_COPILOT_TOOL_TO_TG[foldToolName(k)] = v
for (const v of Object.values(COPILOT_CLI_TOOL_NAME_MAP)) FOLDED_COPILOT_TOOL_TO_TG[foldToolName(v)] = v

/** `ownGet` for a key that may not be a string, which the shim's own `ownGet` answers `undefined`. */
function ownLookup(map: Readonly<Record<string, string>>, key: unknown): string | undefined {
  return typeof key === 'string' ? ownGet(map, key) : undefined
}

/** The part of a possibly `server:`-qualified tool name after its last colon. */
function unqualified(name: unknown): unknown {
  return typeof name === 'string' && name.includes(':') ? name.split(':').pop() : name
}

function copilotCanonicalToolName(name: unknown): unknown {
  if (!name || typeof name !== 'string') return name
  const direct = ownGet(COPILOT_CLI_TOOL_NAME_MAP, name)
  if (direct !== undefined) return direct
  const stripped = unqualified(name)
  const strippedDirect = ownLookup(COPILOT_CLI_TOOL_NAME_MAP, stripped)
  if (strippedDirect !== undefined) return strippedDirect
  return ownGet(FOLDED_COPILOT_TOOL_TO_TG, foldToolName(name)) || ownGet(FOLDED_COPILOT_TOOL_TO_TG, foldToolName(stripped)) || name
}

function parseMaybeJsonObject(value: unknown): object {
  if (value && typeof value === 'object') return value
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // not JSON: forwarded as no arguments, as in the shim
    }
  }
  return {}
}

function stableFallbackSessionId(cwd: unknown): string {
  const key = typeof cwd === 'string' && cwd ? cwd : process.cwd()
  return 'copilot-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
}

function copilotContext(resp: unknown): string | undefined {
  const hso = resp && get(resp, 'hookSpecificOutput')
  const context = get(hso, 'additionalContext')
  if (hso && typeof context === 'string') return context
  const systemMessage = get(resp, 'systemMessage')
  if (resp && typeof systemMessage === 'string') return systemMessage
  return undefined
}

function copilotTranslate(copilotEvent: string, resp: unknown, toolName: unknown, originalToolArgs: object): Record<string, unknown> {
  if (copilotEvent === 'preToolUse') {
    const hso = resp && get(resp, 'hookSpecificOutput')
    const denied = resp && (get(resp, 'decision') === 'block' || (hso && get(hso, 'permissionDecision') === 'deny'))
    if (denied) {
      const reason = (resp && get(resp, 'reason')) || (hso && get(hso, 'permissionDecisionReason')) || 'blocked by token-goat'
      return { permissionDecision: 'deny', permissionDecisionReason: reason }
    }
    const context = copilotContext(resp)
    const shrinkPayload = typeof context === 'string' && context.includes('data:image/')
    const out: Record<string, unknown> = {}
    const updated = hso && get(hso, 'updatedInput')
    if (updated && typeof updated === 'object') {
      out['modifiedArgs'] = updated
    } else if (shrinkPayload && (toolName === 'view' || foldToolName(toolName) === 'view')) {
      const shrunkPath = materializeShrunkImageFile(context)
      if (shrunkPath) out['modifiedArgs'] = Object.assign({}, originalToolArgs, { path: shrunkPath })
    }
    if (context && !shrinkPayload) out['additionalContext'] = context
    return out
  }
  if (copilotEvent === 'postToolUse') {
    const hso = resp && get(resp, 'hookSpecificOutput')
    const updatedToolOutput = hso && get(hso, 'updatedToolOutput')
    const context = copilotContext(resp)
    const out: Record<string, unknown> = {}
    if (typeof updatedToolOutput === 'string') out['modifiedResult'] = { resultType: 'success', textResultForLlm: updatedToolOutput }
    if (context) out['additionalContext'] = context
    return out
  }
  if (copilotEvent === 'postToolUseFailure' || copilotEvent === 'sessionStart' || copilotEvent === 'subagentStart' || copilotEvent === 'userPromptSubmitted') {
    const context = copilotContext(resp)
    return context ? { additionalContext: context } : {}
  }
  if (copilotEvent === 'agentStop' || copilotEvent === 'subagentStop') {
    if (resp && get(resp, 'decision') === 'block') return { decision: 'block', reason: (resp && get(resp, 'reason')) || 'blocked by token-goat' }
    return { decision: 'allow' }
  }
  return {}
}

/** The shim hands the server the canonical payload through the v1 client, which serializes it, so the server relays what survives JSON. */
function viaJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

async function copilotRelayVscode(tgEvent: string, payload: object, scriptDir: string | undefined, io: AdapterIo): Promise<string> {
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'vscode'
  if (scriptDir !== undefined) process.env['TOKEN_GOAT_VSCODE_HOOKS_DIR'] = scriptDir
  const sessionId = get(payload, 'session_id')
  const input = typeof sessionId === 'string' && sessionId !== '' ? payload : Object.assign({}, payload, { session_id: stableFallbackSessionId(process.cwd()) })
  const stdout = await io.relay(tgEvent, viaJson(input))
  try {
    const parsed: unknown = JSON.parse(stdout)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? JSON.stringify(parsed) : '{}'
  } catch {
    return '{}'
  }
}

async function copilotRun(req: AdapterRequest, io: AdapterIo): Promise<string> {
  const copilotEvent = req.event
  const vscodeOnly = ownGet(VSCODE_ONLY_TO_TG_EVENT, copilotEvent)
  const tgEvent = ownGet(COPILOT_TO_TG_EVENT, copilotEvent) ?? vscodeOnly
  if (!tgEvent) return '{}'
  let payload: unknown
  try {
    payload = JSON.parse(req.input)
  } catch {
    return '{}'
  }
  if (payload !== null && typeof payload === 'object' && typeof get(payload, 'hook_event_name') === 'string' && get(payload, 'toolName') === undefined) {
    return copilotRelayVscode(tgEvent, payload, req.scriptDir, io)
  }
  if (vscodeOnly !== undefined) return '{}'
  const toolName = payload && get(payload, 'toolName')
  const workingDirectory = payload && (get(payload, 'workingDirectory') || get(payload, 'cwd'))
  const canonical: Record<string, unknown> = {
    session_id: (payload && get(payload, 'sessionId')) || stableFallbackSessionId(workingDirectory),
    cwd: workingDirectory,
  }
  const agentId = payload && (get(payload, 'agent_id') || get(payload, 'agentId'))
  if (typeof agentId === 'string' && agentId !== '') canonical['agent_id'] = agentId
  const traceparent = payload && (get(payload, 'traceparent') || get(payload, 'traceParent'))
  if (typeof traceparent === 'string' && traceparent !== '') canonical['traceparent'] = traceparent
  const tracestate = payload && (get(payload, 'tracestate') || get(payload, 'traceState'))
  if (typeof tracestate === 'string' && tracestate !== '') canonical['tracestate'] = tracestate
  const prompt = get(payload, 'prompt')
  if (typeof prompt === 'string' && prompt !== '') canonical['prompt'] = prompt
  let originalToolArgs: object = {}
  if (toolName) {
    originalToolArgs = parseMaybeJsonObject(get(payload, 'toolArgs'))
    canonical['tool_name'] = copilotCanonicalToolName(toolName)
    // The shim's remapToolInput (path to file_path, shellId to bash_id, old_str/new_str, view_range to offset/limit) is not repeated: normalizePayload's COPILOT_CLI_INPUT_KEY_MAP (src/hooks_cli.ts) renames the same keys on pre/post_tool_use, readRequestedSliceWindow reads view_range itself, and diagnoseEditFailure reads path and old_str on post_tool_use_failure, so the relay answers the same without it (the equivalence test's view and edit-failure cases).
    canonical['tool_input'] = originalToolArgs
  }
  const error = get(payload, 'error')
  if (typeof error === 'string' && error !== '') canonical['error'] = error
  const rawResult = get(payload, 'toolResult')
  if (rawResult && typeof rawResult === 'object') {
    const camel = get(rawResult, 'textResultForLlm')
    const text = typeof camel === 'string' ? camel : get(rawResult, 'text_result_for_llm')
    if (typeof text === 'string') canonical['tool_response'] = text
  }
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'copilot_cli'
  if (req.scriptDir !== undefined) process.env['TOKEN_GOAT_COPILOT_HOOKS_DIR'] = req.scriptDir
  else delete process.env['TOKEN_GOAT_COPILOT_HOOKS_DIR']
  const stdout = await io.relay(tgEvent, viaJson(canonical))
  let resp: unknown
  try {
    resp = JSON.parse(stdout)
  } catch {
    return '{}'
  }
  return JSON.stringify(copilotTranslate(copilotEvent, resp, toolName, originalToolArgs))
}

const copilotCli: Adapter = {
  unknown: '{}',
  events: [...Object.keys(COPILOT_TO_TG_EVENT), ...Object.keys(VSCODE_ONLY_TO_TG_EVENT)],
  lost: (event) => JSON.stringify(copilotTranslate(event, {}, undefined, {})),
  async run(req, io) {
    try {
      return done(await copilotRun(req, io))
    } catch {
      return done('{}')
    }
  },
}

const ADAPTERS: Readonly<Record<AdapterHarness, Adapter>> = { claudecode, codex, grok, kimi, copilot_cli: copilotCli }

/** Run one hook call the way `harness`'s installed shim would. Never throws: a failure answers what that shim prints on failure. */
export async function runAdapter(harness: AdapterHarness, req: AdapterRequest, io: AdapterIo): Promise<AdapterResult> {
  try {
    return await ADAPTERS[harness].run(req, io)
  } catch {
    return done(harness === 'grok' ? grokAllow(req.event) : ADAPTERS[harness].unknown)
  }
}

/** What a client prints for `harness` when a dispatched request is never answered: `noop` for any event not listed in `noops`, which holds `[event, stdout]` pairs sorted by event. */
export function noopOutputs(harness: AdapterHarness): { noop: string; noops: Array<[string, string]> } {
  const adapter = ADAPTERS[harness]
  const noops: Array<[string, string]> = []
  for (const event of [...adapter.events].sort()) {
    const out = adapter.lost(event)
    if (out !== adapter.unknown) noops.push([event, out])
  }
  return { noop: adapter.unknown, noops }
}

/** The no-op for one event, as {@link noopOutputs} tells the client. */
export function noopFor(harness: AdapterHarness, event: string): string {
  const { noop, noops } = noopOutputs(harness)
  return noops.find(([e]) => e === event)?.[1] ?? noop
}
