/** Token-goat's own notes worded for whichever client asked. The read handlers are shared verbatim with the CLI, so their notes are written for a shell caller: literal `token-goat <cmd> "..."` retry commands and `--flag` switches. An MCP client has no shell and no CLI flags, only a tool's own JSON params, so under an MCP tool call those affordances become guidance to re-call the tool. The rewrite applies to text token-goat wrote and never to a result body: a file whose own text says `token-goat read "x"` or `--json` reaches an MCP client byte for byte. So mcp_server.ts rewrites a failure, which is token-goat's words alone, and a note appended to a success passes through {@link forClient} where it is built. A leaf: node:async_hooks and nothing of token-goat's. */
import { AsyncLocalStorage } from 'node:async_hooks'

/** Set for the duration of one MCP tools/call, async continuations included; `listed` is the server's effective tool list when the caller knows it. */
const mcpToolCall = new AsyncLocalStorage<{ readonly listed: ReadonlySet<string> | undefined }>()

/** A literal retry command token-goat suggests, its argument in whichever quote mark quotedArg chose. */
const TOKEN_GOAT_RETRY_RE = /token-goat (\w[\w-]*) (?:"([^"]+)"|'([^']+)')/g

/** cmd -> the MCP tool param name that literal retry command's quoted argument maps to. */
const RETRY_PARAM_BY_COMMAND: Record<string, string> = {
  read: 'spec',
  section: 'spec',
  symbol: 'name',
  skeleton: 'file',
  outline: 'file',
  semantic: 'query',
}

/** Runs `fn` as the answer to an MCP tool call, so every {@link forClient} note built inside it is worded for an MCP client. `listed` is the tools the server registered: a note must not send the model to a tool outside it. */
export function answeringMcpToolCall<T>(fn: () => T, listed?: ReadonlySet<string>): T {
  return mcpToolCall.run({ listed }, fn)
}

/** Whether a note may tell the caller to use the MCP tool `name`: always outside an MCP call (the CLI has every command), and inside one only when the server lists it. */
export function mcpToolListed(name: string): boolean {
  const store = mcpToolCall.getStore()
  return store?.listed === undefined || store.listed.has(name)
}

/** `note` as the client asking should read it: unchanged for the CLI and hooks, {@link mcpFriendlyText} inside an MCP tool call. Only for text token-goat wrote; a result body never goes through it. */
export function forClient(note: string): string {
  return mcpToolCall.getStore() !== undefined ? mcpFriendlyText(note) : note
}

/** Rewrites CLI-only affordances (shell retry commands, `--flag` switches) in token-goat's own `text` into MCP tool-call guidance. No-op on text that contains neither. */
export function mcpFriendlyText(text: string): string {
  // quotedArg single-quotes an argument holding `$`, a backtick or `"`, so the argument is in whichever group matched.
  let out = text.replace(TOKEN_GOAT_RETRY_RE, (_match, cmd: string, doubleQuoted: string | undefined, singleQuoted: string | undefined) => {
    // A command whose tool this server does not list cannot be retried as a tool, so the note asks for a narrower request instead of naming a tool the model cannot call.
    if (!mcpToolListed(cmd)) return 'a narrower request'
    const param = RETRY_PARAM_BY_COMMAND[cmd] ?? 'parameter'
    const value = doubleQuoted ?? singleQuoted ?? ''
    // The example sits in double quotes, often inside the backtick fence the command had, so a value holding either mark is left out rather than closing one of them early.
    const example = /["`]/.test(value) ? '' : ` (e.g. "${value}")`
    return `the "${cmd}" tool again with a more specific ${param}${example}`
  })
  out = out.replace(/--json\b/g, 'the json parameter')
  out = out.replace(/--limit\b/g, 'the limit parameter')
  out = out.replace(/--top\b/g, 'the top parameter')
  out = out.replace(/--grep PATTERN, --section HEADING, or --tail N/g, 'a narrower query')
  return out
}
