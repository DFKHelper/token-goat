/**
 * Schema-aware compression packs for two specific MCP servers, layered on top
 * of {@link mcp_compress.ts}'s generic structural pass.
 *
 * The generic pass in `mcp_compress.ts` is deliberately blind: it table-ifies
 * any homogeneous JSON array without knowing anything about what produced it.
 * That is the right default for an unbounded set of MCP servers, but real
 * GitHub API JSON and real browser-automation payloads both carry large,
 * well-known sets of boilerplate fields (`_links`, `node_id`, `avatar_url`,
 * `requestHeaders`, `stackTrace`, ...) that are almost never useful to a model
 * driving an MCP tool, and stripping them first exposes far more
 * constant-across-rows columns for the generic pass's header-hoisting to
 * catch. These packs strip that known boilerplate, then hand the smaller,
 * schema-cleaned JSON back to {@link compressMcpResult} for the actual
 * table-ification -- reusing its logic rather than re-implementing it.
 *
 * Fails closed per pack: a tool name that does not match a pack's server
 * prefix, or a body that is not JSON / does not match the pack's expected
 * shape, returns `null` immediately so {@link hooks_mcp.ts}'s `postMcpHandler`
 * falls through to the plain generic pass exactly as it does today for every
 * other MCP server.
 */

import { compressMcpResult } from './mcp_compress.js'

/**
 * Mirrors `mcp_compress.ts`'s private `MIN_SAVINGS_RATIO` (0.15). Kept as a
 * separate constant rather than importing it: that file is shipped and
 * intentionally left untouched by this feature, and the two thresholds are
 * meant to move together only by convention, not by a shared binding.
 */
const PACK_MIN_SAVINGS_RATIO = 0.15

/** Recursively strip keys matched by `shouldStrip` from every object in `value`, leaving arrays and primitives otherwise intact. */
function deepStrip(value: unknown, shouldStrip: (key: string) => boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => deepStrip(v, shouldStrip))
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (shouldStrip(key)) continue
    out[key] = deepStrip(val, shouldStrip)
  }
  return out
}

/**
 * Runs a stripped JSON value back through the generic table-ifying pass, and
 * falls back to the stripped-but-untabled JSON when the pass declines (e.g.
 * the top-level shape is a single object, not a homogeneous array) but the
 * stripping alone still clears the savings bar. Returns `null` when neither
 * step saves enough to be worth showing.
 */
function finishWithGenericPass(originalText: string, stripped: unknown): string | null {
  const strippedText = JSON.stringify(stripped)
  const tabled = compressMcpResult(strippedText)
  if (tabled !== null) return tabled
  if (strippedText.length <= originalText.length * (1 - PACK_MIN_SAVINGS_RATIO)) return strippedText
  return null
}

// --- GitHub pack -----------------------------------------------------------

/**
 * Matches `mcp__plugin_github_github__*` (the GitHub MCP server's tool naming
 * convention used throughout this codebase's own tests, e.g.
 * `mcp__plugin_github_github__search_issues`) as well as any other MCP
 * bridge whose server segment contains "github", so a differently-prefixed
 * install of the same server (e.g. a raw `mcp__github__*`) is still covered.
 */
const GITHUB_TOOL_RE = /^mcp__[a-z0-9_-]*github[a-z0-9_-]*__/i

/**
 * Exact-match boilerplate keys found throughout GitHub REST/GraphQL JSON
 * that carry no information a model would act on: `_links` (a whole subtree
 * of self/git/html hyperlink objects), `node_id` (GraphQL global ID, never
 * referenced by the REST-shaped MCP tools), `gravatar_id` (long-deprecated,
 * always empty in practice), and `site_admin` (GitHub-staff flag on user
 * objects, irrelevant outside GitHub's own admin tooling).
 */
const GITHUB_STRIP_EXACT_KEYS = new Set(['_links', 'node_id', 'gravatar_id', 'site_admin'])

/**
 * GitHub's API attaches a `*_url` field for nearly every relation a resource
 * has (`followers_url`, `events_url`, `gists_url`, `avatar_url`, `html_url`,
 * `comments_url`, `commits_url`, `statuses_url`, `issue_url`, `labels_url`,
 * ...) -- dozens of predictable hyperlink fields per user/repo/issue/PR
 * object, none of which an MCP-calling model can act on (it cannot browse to
 * `html_url`; it calls another tool instead). Stripping by suffix, rather
 * than enumerating every one of GitHub's known `*_url` fields by hand,
 * generalizes to fields GitHub adds later. `download_url`, `git_url`,
 * `clone_url`, and `ssh_url` are exempted: those are the actual resource
 * pointers a coding agent needs (raw file content location, clone
 * endpoints), not decorative hyperlinks.
 */
const GITHUB_URL_SUFFIX_EXCEPTIONS = new Set(['download_url', 'git_url', 'clone_url', 'ssh_url'])

function githubShouldStrip(key: string): boolean {
  if (GITHUB_STRIP_EXACT_KEYS.has(key)) return true
  return key.endsWith('_url') && !GITHUB_URL_SUFFIX_EXCEPTIONS.has(key)
}

/**
 * Compress a GitHub MCP tool result. Returns `null` when *toolName* is not a
 * GitHub-server tool, *resultText* is not JSON, or the stripped result still
 * does not clear the savings bar -- in every such case the caller falls
 * through to the generic pass unchanged.
 */
export function compressGithubMcpResult(toolName: string, resultText: string): string | null {
  if (!GITHUB_TOOL_RE.test(toolName)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(resultText)
  } catch {
    return null
  }
  const stripped = deepStrip(parsed, githubShouldStrip)
  return finishWithGenericPass(resultText, stripped)
}

// --- Browser automation pack -------------------------------------------------

/**
 * Matches the browser-automation MCP server naming conventions actually
 * referenced elsewhere in this codebase (`src/hooks_screenshot.ts`,
 * `src/mcp_cache.ts`, and this repo's own test fixtures): Anthropic's
 * `claude-in-chrome` extension (`mcp__claude-in-chrome__*`), Google's
 * `chrome-devtools-mcp` (`mcp__chrome-devtools-mcp_chrome-devtools__*` /
 * `mcp__plugin_chrome-devtools-mcp_chrome-devtools__*`), and Microsoft's
 * `@playwright/mcp` (`mcp__plugin_playwright_playwright__*`).
 */
const BROWSER_TOOL_RE = /^mcp__.*(?:chrome-devtools|claude-in-chrome|playwright).*__/i

/** Matches the method segment for both servers' console-message list tools: `read_console_messages` (claude-in-chrome) and `list_console_messages` (chrome-devtools-mcp). */
const BROWSER_CONSOLE_METHOD_RE = /(?:^|_)(?:read|list)_console_messages$/i

/** Matches the method segment for both servers' network-request list tools: `read_network_requests` (claude-in-chrome) and `list_network_requests` (chrome-devtools-mcp). */
const BROWSER_NETWORK_METHOD_RE = /(?:^|_)(?:read|list)_network_requests$/i

/**
 * Console-message entries (Chrome DevTools Protocol `Runtime.consoleAPICalled`
 * / `Log.entryAdded` shape, which both servers surface close to verbatim)
 * carry a `stackTrace` -- an array of call frames each with its own
 * `functionName`/`scriptId`/`url`/`lineNumber`/`columnNumber` -- that exists
 * for source-mapping a browser DevTools UI, not for an agent reading a
 * one-line log message. Everything else (`type`/`level`, `text`, `url`,
 * `lineNumber`, `timestamp`, `source`, `args`) is the actual message content
 * and is kept.
 */
const BROWSER_CONSOLE_STRIP_KEYS = new Set(['stackTrace'])

/**
 * Network-request entries carry several large, high-entropy-but-low-signal
 * blocks: `requestHeaders`/`responseHeaders`/`headers` (dozens of standard
 * HTTP headers per request, rarely inspected), `timing` (a dozen+ numeric
 * sub-phase timestamps), `initiator` (a full JS call-stack for what fired
 * the request), and `securityDetails`/`securityState`/`remoteAddress`/
 * `serverIPAddress`/`connectionId` (TLS/connection plumbing). `url`,
 * `method`, `status`, `statusText`, `resourceType`/`type`, `mimeType`,
 * `size`/`encodedDataLength`, `failed`, `fromCache`, and the request's own id
 * (`reqid`/`requestId`, needed for a follow-up `get_network_request` call)
 * are the fields an agent actually reasons about and are kept.
 */
const BROWSER_NETWORK_STRIP_KEYS = new Set([
  'requestHeaders',
  'responseHeaders',
  'headers',
  'timing',
  'initiator',
  'securityDetails',
  'securityState',
  'remoteAddress',
  'serverIPAddress',
  'connectionId',
  'requestCookies',
  'responseCookies',
  'cookies',
])

/**
 * Compress a browser-automation MCP tool result (console-message or
 * network-request list). Returns `null` when *toolName* is not a recognized
 * browser-automation server tool, its method is neither a console-message
 * nor network-request list tool, *resultText* is not JSON, or the stripped
 * result still does not clear the savings bar -- in every such case the
 * caller falls through to the generic pass unchanged.
 */
export function compressBrowserMcpResult(toolName: string, resultText: string): string | null {
  if (!BROWSER_TOOL_RE.test(toolName)) return null
  const method = toolName.split('__').pop() || ''
  let shouldStrip: ((key: string) => boolean) | null = null
  if (BROWSER_CONSOLE_METHOD_RE.test(method)) shouldStrip = (key) => BROWSER_CONSOLE_STRIP_KEYS.has(key)
  else if (BROWSER_NETWORK_METHOD_RE.test(method)) shouldStrip = (key) => BROWSER_NETWORK_STRIP_KEYS.has(key)
  if (!shouldStrip) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(resultText)
  } catch {
    return null
  }
  const stripped = deepStrip(parsed, shouldStrip)
  return finishWithGenericPass(resultText, stripped)
}

// --- Dispatch ----------------------------------------------------------------

/**
 * Try each per-server pack in turn, returning the first non-null result.
 * {@link hooks_mcp.ts}'s `postMcpHandler` calls this before the generic
 * pass; a `null` here means neither pack matched or paid off, and the caller
 * should fall through to {@link compressMcpResult} on the untransformed text.
 */
export function compressMcpResultWithPacks(toolName: string, resultText: string): string | null {
  return compressGithubMcpResult(toolName, resultText) ?? compressBrowserMcpResult(toolName, resultText)
}
