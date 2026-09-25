/** Text fragments shared by the generated harness hook shims. Four bridges ship a Node shim that does the same three things before any harness-specific translation: require the same modules, reject an event name outside the closed `HOOK_EVENTS` set, and reach `token-goat hook <event>` through the same three-step ladder (in-process hook lib, then the baked entry via `process.execPath`, then a PATH-based `shell: true` call). Those parts were byte-identical copies in {@link ../claudecode.ts}, {@link ../codex.ts}, {@link ../grok.ts} and {@link ../kimi.ts}, so a fix to the spawn ladder or the event allowlist had to be applied four times or silently diverge. They live here once and are interpolated into each shim template. What is deliberately NOT here: everything downstream of `stdout`. Each harness has its own response contract and its own fail-open shape (`{}` for Claude Code and Codex, `{"decision":"allow"}` for Grok on `pre_tool_use`, empty stdout for Kimi), and forcing those through one template would be worse than the duplication it removed. Grok also keeps its own `VALID_HOOK_EVENTS`: it genuinely has no `session_start` event. These are fragments of generated JavaScript, not TypeScript. They must stay free of backticks and `${` so they interpolate verbatim. */

/** File name the Claude Code, Codex, Grok and Kimi shims are installed under. `.cjs` rather than `.js` because Node picks a `.js` file's module system from the nearest package.json above it: a `{"type":"module"}` anywhere over the harness config, a home directory set up for ES modules being enough, made the shim an ES module where the `require` it opens with is undefined, and every hook failed before it could print `{}`. */
export const SHIM_FILE = 'token-goat-shim.cjs'

/** The name earlier installs wired. It stays on disk as a {@link legacyShimForwarder} because a harness session started before the upgrade keeps running the hook commands it read at startup. */
export const LEGACY_SHIM_FILE = 'token-goat-shim.js'

/** Written to {@link LEGACY_SHIM_FILE}. A dynamic `import()` loads the `.cjs` shim from either module system, and when even that fails the catch answers `noOp`, whatever the shim itself prints for "no change" on that harness: `{}` for most, nothing at all for Kimi, which reads a bare `{}` on a prompt hook as text to add to the context. */
export function legacyShimForwarder(noOp: '{}' | ''): string {
  const answer = noOp === '' ? '' : `
  try { process.stdout.write('${noOp}') } catch {}`
  return `#!/usr/bin/env node
// Forwards to token-goat-shim.cjs for hook commands wired before the shim was renamed.
import('./token-goat-shim.cjs').catch(() => {${answer}
  process.exitCode = 0
});
`
}

/** The three `require`s every shim opens with. */
export const SHIM_REQUIRES = `const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { pathToFileURL } = require('node:url')`

/** The closed hook-event allowlist, kept in sync with `HOOK_EVENTS` in ../types.ts. */
export const SHIM_VALID_HOOK_EVENTS = `// Keep in sync with HOOK_EVENTS in src/types.ts. eventName is validated against this closed
// set before being concatenated into a shell command string, so a hostile argv (e.g.
// 'pre_tool_use & calc.exe') can never reach the shell parser.
const VALID_HOOK_EVENTS = new Set([
  'pre_tool_use',
  'post_tool_use',
  'notification',
  'stop',
  'pre_compact',
  'post_compact',
  'user_prompt_submit',
  'subagent_stop',
  'session_start',
  'post_tool_use_failure',
])`

export { SHIM_TRY_SERVER } from './shim_try_server.js'

/** `tryInProcess()`: the resident server, then the in-process `dist/token-goat-hook.mjs` fast path. Requires {@link SHIM_TRY_SERVER} alongside it. */
export const SHIM_TRY_IN_PROCESS = `// Attempts the in-process hook call: import()s dist/token-goat-hook.mjs (a sibling of
// the baked token-goat entry path, built with zero load-time side effects -- unlike
// the CLI entry, which runs the full argv-parsing CLI as a side effect of being
// loaded) and calls its exported relayInProcess() directly, avoiding a second node
// process spawn entirely. Returns undefined (triggering the spawnSync fallback below)
// when entryPath is absent, the sibling file doesn't exist (an older install predating
// this file), or anything else goes wrong -- this must never throw. harnessWaitMs, when
// the caller has one (Claude Code's async-detach marker time -- see SHIM_ASYNC_DETACH),
// is forwarded straight through: this runs in the same process as the caller, so its
// performance.now() reading shares the same origin and needs no conversion.
async function tryInProcess(entryPath, eventName, input, harnessWaitMs) {
  if (!entryPath) return undefined
  try {
    const payload = JSON.parse(input)
    const served = await tryServer(entryPath, eventName, input, harnessWaitMs)
    if (served !== undefined) return served
    const hookLibPath = path.join(path.dirname(entryPath), 'token-goat-hook.mjs')
    if (!require('node:fs').existsSync(hookLibPath)) return undefined
    const mod = await import(pathToFileURL(hookLibPath).href)
    return await mod.relayInProcess(eventName, payload, harnessWaitMs)
  } catch {
    return undefined
  }
}`

/** The `spawnSync` fallback ladder, indented for use inside `main()`'s `if (stdout === undefined)`. Node's `spawnSync` defaults `maxBuffer` to 1 MB; a fenced MCP tool result (see hooks_mcp.ts's unconditional `passOrFence`) has no upper size bound of its own, so without an explicit override a large one gets ENOBUFS-killed, the shim fails open to `{}`, and the fence protecting that untrusted payload never reaches the model. `SHIM_MAX_BUFFER_BYTES` below matches this codebase's existing largest capture ceiling (`MAX_CAPTURE_BYTES` in bash_runner.ts) so this path is bounded by the same number rather than an arbitrary new one. */
export const SHIM_SPAWN_LADDER = `    const res = entryPath
      ? spawnSync(process.execPath, [entryPath, 'hook', eventName], {
          input,
          encoding: 'utf8',
          timeout: 3000,
          killSignal: 'SIGKILL',
          maxBuffer: SHIM_MAX_BUFFER_BYTES,
        })`

/** 32 MiB, matching `MAX_CAPTURE_BYTES` in bash_runner.ts: the largest payload a hook response is allowed to reach without Node's `spawnSync` truncating it via its 1 MB default. */
export const SHIM_MAX_BUFFER_CONST = `const SHIM_MAX_BUFFER_BYTES = 32 * 1024 * 1024`

/** Claude Code only: classifies a hook call the harness can safely background before the in-process/spawn round trip runs, because the handler it would reach either always answers pass or, for a tiny Bash result, answers something almost never. `subagent_stop` always qualifies (subagentStopHandler in hooks_session.ts returns passOutput() on every branch); `post_tool_use` qualifies for Edit/Write/MultiEdit/NotebookEdit outside the markdown family (postEditHandler in hooks_edit.ts answers with real context only for md/mdx/markdown/rst), and for a Bash result under 200 bytes (postBashHandler in hooks_bash.ts emitted on 19 of 10,602 such calls measured -- 0.18%). The Bash branch backgrounds rather than skips: resolvePendingHintsForEvent (hint_stats.ts) is registered on every post_tool_use call and must still run to keep hint-efficacy accounting correct. Printing `{"async":true}` as the first stdout line lets the harness move on immediately instead of waiting out a response it was almost always going to get as `{}`. */
export const SHIM_ASYNC_DETACH = `const ASYNC_DETACH_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const ASYNC_DETACH_SKIP_EXT_RE = /\\.(md|mdx|markdown|rst)$/i
const ASYNC_DETACH_BASH_MAX_BYTES = 200
// Same key order as OUTPUT_FIRST_TOOL_RESPONSE_KEYS in hooks_common.ts.
const ASYNC_DETACH_BASH_TEXT_KEYS = ['output', 'content', 'text', 'body', 'stdout', 'stderr']
function bashResultByteLength(resp) {
  if (typeof resp === 'string') return Buffer.byteLength(resp, 'utf8')
  if (resp && typeof resp === 'object') {
    if (typeof resp['persistedOutputSize'] === 'number') return resp['persistedOutputSize']
    for (const key of ASYNC_DETACH_BASH_TEXT_KEYS) {
      if (typeof resp[key] === 'string' && resp[key] !== '') return Buffer.byteLength(resp[key], 'utf8')
    }
    return Buffer.byteLength(JSON.stringify(resp), 'utf8')
  }
  return 0
}
function isAsyncDetachEligible(eventName, input) {
  if (eventName === 'subagent_stop') return true
  if (eventName !== 'post_tool_use') return false
  try {
    const payload = JSON.parse(input)
    const toolName = payload['tool_name']
    if (ASYNC_DETACH_TOOLS.has(toolName)) {
      const toolInput = payload['tool_input'] || {}
      const filePath =
        typeof toolInput['file_path'] === 'string'
          ? toolInput['file_path']
          : typeof toolInput['notebook_path'] === 'string'
            ? toolInput['notebook_path']
            : ''
      return !ASYNC_DETACH_SKIP_EXT_RE.test(filePath)
    }
    if (toolName === 'Bash') return bashResultByteLength(payload['tool_response']) < ASYNC_DETACH_BASH_MAX_BYTES
    return false
  } catch {
    return false
  }
}`

/** Claude Code only: a `pre_tool_use` Bash call that is token-goat's own CLI has nothing for the pre-hook pipeline to say -- none of preBashHandlerInner's file-read/build/search extractors match a `token-goat` invocation, so it always falls through to `passOutput()` (measured: 2,899 such calls since Sep 6, 16 emitted anything -- 0.55%, mostly the generic unbalanced-quoting warning, which this bypass forfeits on the rare malformed one in exchange for skipping the bundle import on the other 99.45%). `CD_PREFIX_RE` mirrors `stripCdPrefix` in hooks_bash_commands.ts so a leading `cd ... &&` is stripped the same way before classifying. The chain-operator check is deliberately coarse -- reject on any of `; & | \`` or `$(` appearing anywhere, not just unquoted, the way `detectFromCommand`'s `hasUnquotedOperator` does -- because a false negative here only costs a missed bypass, while a false positive would skip real handling for a compound command that merely contains a token-goat call among others. */
export const SHIM_OWN_COMMAND_BYPASS = `const TG_CD_PREFIX_RE = /^(?:cd\\s+(?:"[^"]*"|'[^']*'|\\S+)[ \\t]*(?:&&|;|\\r?\\n)\\s*)+/
const TG_OWN_COMMAND_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*(?:token-goat\\b|node(?:\\.exe)?\\s+["']?(?:\\S*[\\\\/])?token-goat(?:\\.mjs)?["']?\\b)/i
function isOwnTokenGoatCommand(cmd) {
  if (typeof cmd !== 'string' || cmd.trim() === '') return false
  const body = (cmd.replace(TG_CD_PREFIX_RE, '') || cmd).trim()
  if (/[;&|\`]|\\$\\(/.test(body)) return false
  return TG_OWN_COMMAND_RE.test(body)
}`
