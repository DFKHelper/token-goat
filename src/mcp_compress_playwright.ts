/** Section pass for `@playwright/mcp` browser-tool results. They arrive as markdown `### ` sections (`Result`, `Ran Playwright code`, `Open tabs`, `Page`, `Snapshot`, `Events`, `Error`) rather than JSON, so neither {@link mcp_compress.ts}'s generic pass nor a key-stripping pack in {@link mcp_compress_packs.ts} can touch them. Only the two sections that repeat what the model already holds are rewritten. `Ran Playwright code` on `browser_evaluate`/`browser_run_code`/`browser_run_code_unsafe` echoes the model's own `function`/`code` argument back, re-escaped into a JS string and so longer than what was sent (34% of all measured `browser_evaluate` bytes). `Open tabs` repeats the list an earlier Playwright result already showed (83 of 212 measured sections). Every other section, and the code block of every action tool (the only record of the locator Playwright resolved a ref to), passes through byte-identical. {@link hooks_mcp.ts}'s `postMcpHandler` runs this below `MCP_COMPRESS_MIN_BYTES`, because that is where most Playwright results are: 903 of 1,160 measured fell under it. */

import { PLAYWRIGHT_TOOL_RE } from './mcp_tool_pattern.js'
import { lastTabContextMatches, setLastTabContext } from './session.js'

const SECTION_HEADING_PREFIX = '### '
const CODE_HEADING = '### Ran Playwright code'
const TABS_HEADING = '### Open tabs'

/** One `Open tabs` entry, `- {index}: [{title}]({url})`, with `(current) ` before the link on the selected tab. */
const TAB_LINE_RE = /^- \d+: /
const CURRENT_TAB_LINE_RE = /^- \d+: \(current\) /

/** `text` the way `@playwright/mcp` quotes an argument into the code it prints: `JSON.stringify`'s escaping with the double quotes left bare and the single quotes escaped, inside single quotes (playwright-core's `escapeWithQuotes(text, "'")`). Reproducing it exactly is what proves an echo is nothing but the model's own argument: on the measured corpus all 499 `browser_evaluate` code blocks were byte-equal to this. */
function quoteLikePlaywright(text: string): string {
  const escaped = JSON.stringify(text).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")
  return `'${escaped}'`
}

/** The tools whose `Ran Playwright code` block is built from a single argument the model sent: that argument's input key, and the code Playwright prints around it. A tool missing here keeps its block, since the block is then Playwright's own account of what ran. */
const ECHOED_ARGUMENT = new Map<string, { readonly key: string; readonly code: (arg: string) => string }>([
  ['browser_evaluate', { key: 'function', code: (fn) => `await page.evaluate(${quoteLikePlaywright(fn)});` }],
  ['browser_run_code', { key: 'code', code: (code) => `await (${code})(page);` }],
  ['browser_run_code_unsafe', { key: 'code', code: (code) => `await (${code})(page);` }],
])

/** Index just past the last non-blank line of `lines`, so a section's trailing blank lines can be carried over unchanged after a rewrite. */
function contentEnd(lines: readonly string[]): number {
  let end = lines.length
  while (end > 0 && lines[end - 1] === '') end--
  return end
}

/** The one-line replacement for a `Ran Playwright code` block that is exactly the echo of the call's own argument, or `null` when it is anything else. */
function rewriteEchoedCode(method: string, toolInput: Record<string, unknown>, body: readonly string[]): string[] | null {
  const echoed = ECHOED_ARGUMENT.get(method)
  if (echoed === undefined) return null
  const arg = toolInput[echoed.key]
  if (typeof arg !== 'string') return null
  const end = contentEnd(body)
  if (end < 2 || body[0] !== '```js' || body[end - 1] !== '```') return null
  const code = body.slice(1, end - 1).join('\n')
  if (code !== echoed.code(arg)) return null
  return [`${CODE_HEADING}: omitted, a ${Buffer.byteLength(code, 'utf-8')}-byte echo of this call's own \`${echoed.key}\` argument`, ...body.slice(end)]
}

/** Record this `Open tabs` list as the last one shown this session, and return its collapsed form when it is the same list the previous one showed: a one-line note with the tab count, then the `(current)` tab. The record goes through session.ts's tab-list fingerprint, the slot claude-in-chrome's `Tab Context:` dedup uses, so only a digest of the titles and URLs is ever persisted. */
function rewriteRepeatedTabs(body: readonly string[]): string[] | null {
  const end = contentEnd(body)
  const list = body.slice(0, end).join('\n')
  const repeat = lastTabContextMatches(list)
  setLastTabContext(list)
  if (!repeat) return null
  const tabs = body.slice(0, end).filter((line) => TAB_LINE_RE.test(line))
  const current = tabs.find((line) => CURRENT_TAB_LINE_RE.test(line))
  const count = `${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}`
  // Worded short on purpose. Over 71 measured repeats the commonest one saved 145 bytes against the longer "unchanged since the previous result" note, short of what isRewriteWorthwhile needs once the 67-byte compressed notice is paid, and 171 against this one, which clears it: 65 of the 71 ship, against 9.
  const replacement = [
    `${TABS_HEADING}: unchanged (${count})${current === undefined ? '' : ', current:'}`,
    ...(current === undefined ? [] : [current]),
  ]
  if (replacement.join('\n').length >= [TABS_HEADING, list].join('\n').length) return null
  return [...replacement, ...body.slice(end)]
}

/** Rewrite the repeated sections of a `@playwright/mcp` result (see the module comment), or return `null` when *toolName* is not a Playwright browser tool or no section changed. *resultText* must already be redacted: every comparison and every record here is taken on the text the model will be shown. */
export function compressPlaywrightResult(toolName: string, toolInput: Record<string, unknown>, resultText: string): string | null {
  if (!PLAYWRIGHT_TOOL_RE.test(toolName)) return null
  const method = toolName.split('__').pop() ?? ''
  const lines = resultText.split('\n')
  const out: string[] = []
  let changed = false
  let i = 0
  while (i < lines.length && !(lines[i] ?? '').startsWith(SECTION_HEADING_PREFIX)) out.push(lines[i++] ?? '')
  while (i < lines.length) {
    const heading = lines[i] ?? ''
    let next = i + 1
    while (next < lines.length && !(lines[next] ?? '').startsWith(SECTION_HEADING_PREFIX)) next++
    const body = lines.slice(i + 1, next)
    const rewritten =
      heading === CODE_HEADING ? rewriteEchoedCode(method, toolInput, body) : heading === TABS_HEADING ? rewriteRepeatedTabs(body) : null
    if (rewritten === null) out.push(heading, ...body)
    else {
      out.push(...rewritten)
      changed = true
    }
    i = next
  }
  return changed ? out.join('\n') : null
}
