import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// Importing relay registers every hook module (including hooks_mcp) for its side effects, so runHook dispatches through the real production registry, same pattern as tests/hooks_mcp.test.ts. Do NOT call clearModuleCaches() here: it drops every registered handler. The Open tabs record lives in session.ts's process-wide state, so every test below builds tab lists that carry its own session id and can never match another test's.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { getBashOutput } from '../src/bash_output_cache.js'
import { MCP_COMPRESS_MIN_BYTES } from '../src/mcp_compress.js'
import type { HookOutput } from '../src/types.js'
import { unfence } from './helpers/unfence.js'

const COMPRESSED_NOTICE_RE = /^\[token-goat: compressed, full via mcp-output (mcp_[0-9a-f]{16})\]\n/

/** The recall id and the unfenced body of a compressed rewrite. */
function compressedBody(post: HookOutput): { id: string; body: string } {
  expect(post.hookType).toBe('rewriteOutput')
  if (post.hookType !== 'rewriteOutput') throw new Error('unreachable')
  const m = COMPRESSED_NOTICE_RE.exec(post.updatedOutput)
  if (m === null) throw new Error(`not a compressed rewrite: ${post.updatedOutput.slice(0, 200)}`)
  return { id: m[1] as string, body: unfence(post.updatedOutput.slice(m[0].length)) }
}

/** The unfenced body of a rewrite that only fenced the result. */
function fencedOnlyBody(post: HookOutput): string {
  expect(post.hookType).toBe('rewriteOutput')
  if (post.hookType !== 'rewriteOutput') throw new Error('unreachable')
  expect(post.updatedOutput).not.toMatch(COMPRESSED_NOTICE_RE)
  return unfence(post.updatedOutput)
}

/** The `function` argument a model sent to `browser_evaluate`, in the shape of the measured 506-char input (8f04f74c): a fetch with a quoted header object, double quotes, and newlines. */
const EVALUATE_FUNCTION = [
  'async () => {',
  "  const r = await fetch('/api/user', {headers: {'x-app': 'web'}});",
  '  const u = await r.json();',
  '  return {status: r.status, url: location.href, type: u.type || "unknown", keys: Object.keys(u).slice(0, 25)};',
  '}',
].join('\n')

/** The echo @playwright/mcp prints under `### Ran Playwright code` for EVALUATE_FUNCTION, written out by hand from the measured transcripts rather than computed: the function re-quoted as one single-quoted JS string, newlines as `\n`, single quotes as `\'`, double quotes left bare. */
const EVALUATE_ECHO = String.raw`await page.evaluate('async () => {\n  const r = await fetch(\'/api/user\', {headers: {\'x-app\': \'web\'}});\n  const u = await r.json();\n  return {status: r.status, url: location.href, type: u.type || "unknown", keys: Object.keys(u).slice(0, 25)};\n}');`

const EVALUATE_RESULT_SECTION = [
  '### Result',
  '{',
  '  "status": 200,',
  '  "url": "https://shop.example.com/orders",',
  '  "type": "USER",',
  '  "keys": [',
  '    "token",',
  '    "first_name",',
  '    "last_name",',
  '    "email_address"',
  '  ]',
  '}',
].join('\n')

const PAGE_SECTION = ['### Page', '- Page URL: https://shop.example.com/orders', '- Page Title: Orders - Example Shop', '- Console: 0 errors, 1 warnings'].join('\n')

const EVENTS_SECTION = ['### Events', String.raw`- New console entries: .playwright-mcp\console-2026-08-08T12-48-01-979Z.log#L15-L19`].join('\n')

function evaluateResult(echo: string): string {
  return [EVALUATE_RESULT_SECTION, '### Ran Playwright code', '```js', echo, '```', PAGE_SECTION, EVENTS_SECTION].join('\n')
}

/** An `### Open tabs` section in @playwright/mcp's shape, with sign-in-redirect URLs as long as the measured ones. `tag` keeps one test's tab list from ever matching another's. */
function openTabsSection(tag: string, count: number, current: number): string {
  const lines = ['### Open tabs']
  for (let i = 0; i < count; i++) {
    const url = `https://accounts.example.com/v3/signin/identifier?continue=https://app.example.com/analytics/web/%23tab${i}&followup=https://app.example.com/analytics/web/&passive=1209600&service=analytics&flowName=GlifWebSignIn&flowEntry=ServiceLogin&t=${tag}`
    lines.push(`- ${i}: ${i === current ? '(current) ' : ''}[Example App tab ${i}](${url})`)
  }
  return lines.join('\n')
}

function navigateResult(target: string, tabs: string): string {
  return [
    '### Ran Playwright code',
    '```js',
    `await page.goto('${target}');`,
    '```',
    tabs,
    '### Page',
    `- Page URL: ${target}`,
    '- Page Title: Example App',
    '### Snapshot',
    String.raw`- [Snapshot](.playwright-mcp\page-2026-09-22T23-05-03-646Z.yml)`,
  ].join('\n')
}

function clickResult(tabs: string): string {
  return [
    '### Ran Playwright code',
    '```js',
    "await page.getByRole('button', { name: 'Continue' }).click();",
    '```',
    tabs,
    '### Page',
    '- Page URL: https://app.example.com/analytics/web/',
    '- Page Title: Example App',
  ].join('\n')
}

let tmpHome: string
let prevHome: string | undefined
let prevCompressFlag: string | undefined
let sessionId: string

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-playwright-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  sessionId = `mcp-pw-${path.basename(tmpHome)}`
  prevCompressFlag = process.env['TOKEN_GOAT_MCP_COMPRESS']
  delete process.env['TOKEN_GOAT_MCP_COMPRESS']
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  if (prevCompressFlag === undefined) delete process.env['TOKEN_GOAT_MCP_COMPRESS']
  else process.env['TOKEN_GOAT_MCP_COMPRESS'] = prevCompressFlag
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

function post(toolName: string, toolInput: Record<string, unknown>, text: string): Promise<HookOutput> {
  return runHook(buildEvent('post_tool_use', { tool_name: toolName, tool_input: toolInput, session_id: sessionId, tool_response: text }))
}

describe('Playwright Ran Playwright code echo', () => {
  it('drops a browser_evaluate echo of its own function argument from a result under the 2,000-byte floor and keeps every other section verbatim', async () => {
    const raw = evaluateResult(EVALUATE_ECHO)
    expect(raw.length).toBeGreaterThan(500)
    expect(raw.length).toBeLessThan(MCP_COMPRESS_MIN_BYTES)

    const { id, body } = compressedBody(await post('mcp__playwright__browser_evaluate', { function: EVALUATE_FUNCTION }, raw))
    const note = `### Ran Playwright code: omitted, a ${Buffer.byteLength(EVALUATE_ECHO, 'utf-8')}-byte echo of this call's own \`function\` argument`
    expect(body).toBe([EVALUATE_RESULT_SECTION, note, PAGE_SECTION, EVENTS_SECTION].join('\n'))
    expect(getBashOutput(id)?.output).toBe(raw)
  })

  it('drops a browser_run_code_unsafe echo of its own code argument under the plugin server key', async () => {
    const code = [
      'async (page) => {',
      '  const log = []; let cells = 0;',
      '  for (const [row, sku] of [[238, "CB-STI-3"], [240, "OT-STENCIL-11"], [241, "OT-STENCIL-12"], [833, "WAX-WARMER"]]) {',
      "    await page.click('#t-name-box');",
      "    await page.keyboard.press('Control+A');",
      "    await page.keyboard.type('B' + row);",
      "    await page.keyboard.press('Enter');",
      '    await page.keyboard.type(sku, { delay: 12 });',
      '    cells++; log.push(`B${row}`);',
      '  }',
      "  return { runs: log.length, cells, ranges: log.join(' ') };",
      '}',
    ].join('\n')
    const resultSection = ['### Result', '{"runs":4,"cells":4,"ranges":"B238 B240 B241 B833"}'].join('\n')
    const echo = `await (${code})(page);`
    const raw = [resultSection, '### Ran Playwright code', '```js', echo, '```'].join('\n')

    const { body } = compressedBody(await post('mcp__plugin_playwright_playwright__browser_run_code_unsafe', { code }, raw))
    expect(body).toBe([resultSection, `### Ran Playwright code: omitted, a ${Buffer.byteLength(echo, 'utf-8')}-byte echo of this call's own \`code\` argument`].join('\n'))
  })

  it('keeps a code block that is not an exact echo of the input, since then it is not only what the model sent', async () => {
    const otherFunction = EVALUATE_FUNCTION.replace('/api/user', '/api/account')
    const raw = evaluateResult(EVALUATE_ECHO)
    expect(fencedOnlyBody(await post('mcp__playwright__browser_evaluate', { function: otherFunction }, raw))).toBe(raw)
  })

  it('keeps the code block of an action tool, where it is the only record of the locator that ran', async () => {
    const raw = clickResult('')
    expect(fencedOnlyBody(await post('mcp__playwright__browser_click', { target: 'e25', element: 'Continue button' }, raw))).toBe(raw)
  })

  it('is switched off by TOKEN_GOAT_MCP_COMPRESS=0 like every other MCP compression pass', async () => {
    process.env['TOKEN_GOAT_MCP_COMPRESS'] = '0'
    const raw = evaluateResult(EVALUATE_ECHO)
    expect(fencedOnlyBody(await post('mcp__playwright__browser_evaluate', { function: EVALUATE_FUNCTION }, raw))).toBe(raw)
  })

  it('leaves a non-Playwright server with the same tool and section names alone', async () => {
    const raw = evaluateResult(EVALUATE_ECHO)
    expect(fencedOnlyBody(await post('mcp__puppeteer__browser_evaluate', { function: EVALUATE_FUNCTION }, raw))).toBe(raw)
  })
})

describe('Playwright Open tabs', () => {
  it('collapses an Open tabs list unchanged since the previous Playwright result to a note and the current tab, and keeps a changed one', async () => {
    const tabs = openTabsSection(sessionId, 4, 1)
    const first = navigateResult('https://app.example.com/analytics/web/', tabs)
    expect(fencedOnlyBody(await post('mcp__playwright__browser_navigate', { url: 'https://app.example.com/analytics/web/' }, first))).toBe(first)

    const second = clickResult(tabs)
    const { body } = compressedBody(await post('mcp__playwright__browser_click', { target: 'e25', element: 'Continue button' }, second))
    const currentLine = tabs.split('\n').find((l) => l.includes('(current)')) as string
    expect(body).toBe(clickResult(['### Open tabs: unchanged (4 tabs), current:', currentLine].join('\n')))

    const changedTabs = openTabsSection(sessionId, 5, 4)
    const third = navigateResult('https://app.example.com/help', changedTabs)
    expect(fencedOnlyBody(await post('mcp__playwright__browser_navigate', { url: 'https://app.example.com/help' }, third))).toBe(third)
  })

  it('ships the collapse of the commonest measured repeat, three tabs of 96, 103 and 143 chars, when it is the only change', async () => {
    const pad = (line: string, length: number): string => line.replace('PAD', 'p'.repeat(length - line.length + 3))
    const tabs = [
      '### Open tabs',
      pad(`- 0: [Orders](https://shop.example.com/orders?t=${sessionId}&PAD)`, 96),
      pad(`- 1: [Help](https://help.example.com/a?t=${sessionId}&PAD)`, 103),
      pad(`- 2: (current) [Cart](https://shop.example.com/cart?t=${sessionId}&PAD)`, 143),
    ].join('\n')
    expect(tabs.split('\n').map((l) => l.length)).toEqual([13, 96, 103, 143])
    await post('mcp__playwright__browser_navigate', { url: 'https://shop.example.com/cart' }, navigateResult('https://shop.example.com/cart', tabs))
    const { body } = compressedBody(await post('mcp__playwright__browser_click', { target: 'e25', element: 'Continue button' }, clickResult(tabs)))
    expect(body).toContain(['### Open tabs: unchanged (3 tabs), current:', tabs.split('\n')[3]].join('\n'))
  })

  it('counts a list shown in full on an error-flagged result as the last one seen, so an older list coming back is not called unchanged', async () => {
    const tabsA = openTabsSection(`${sessionId}-a`, 4, 1)
    const tabsB = openTabsSection(`${sessionId}-b`, 4, 2)
    const first = navigateResult('https://app.example.com/a', tabsA)
    expect(fencedOnlyBody(await post('mcp__playwright__browser_navigate', { url: 'https://app.example.com/a' }, first))).toBe(first)

    const failed = ['### Error', 'Error: locator.click: Timeout 5000ms exceeded.', tabsB].join('\n')
    const errorEvent = buildEvent('post_tool_use', {
      tool_name: 'mcp__playwright__browser_click',
      tool_input: { target: 'e9', element: 'Next' },
      session_id: sessionId,
      tool_response: { isError: true, content: [{ type: 'text', text: failed }] },
    })
    expect(fencedOnlyBody(await runHook(errorEvent))).toBe(failed)

    const back = clickResult(tabsA)
    expect(fencedOnlyBody(await post('mcp__playwright__browser_click', { target: 'e25', element: 'Continue button' }, back))).toBe(back)
  })
})

describe('Playwright pass redaction runs before any cut', () => {
  it('never leaves a raw sk-ant- fragment when a Playwright YAML snapshot text straddles the 200-char truncation cut', async () => {
    const key = 'sk-ant-' + 'A1b2C3d4E5f6G7h8I9J0K1L2M3N4O5P6Q7R8S9T0'
    const straddling = 'x'.repeat(180) + key + 'y'.repeat(400)
    const filler = 'z'.repeat(400)
    const raw = [
      '### Page',
      '- Page URL: https://shop.example.com/about',
      '- Page Title: About',
      '### Snapshot',
      '```yaml',
      '- generic [ref=e2]:',
      `  - paragraph [ref=e3]: ${straddling}`,
      ...Array.from({ length: 19 }, (_, i) => `  - paragraph [ref=e${i + 4}]: ${filler}`),
      '```',
    ].join('\n')

    const { body } = compressedBody(await post('mcp__playwright__browser_snapshot', {}, raw))
    expect(body).toContain('chars elided')
    expect(body).not.toMatch(/sk-ant-[A-Za-z0-9]{6,}/)
  })

  it('never leaves a raw ghp_ fragment when a browser_network_requests URL query straddles the cut', async () => {
    const token = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2'
    const prefix = 'https://api.example.com/v1/collect?'
    const lines = ['### Result']
    lines.push(`1. [GET] ${prefix}${'p'.repeat(170 - prefix.length)}&t=${token}&${'q'.repeat(300)} => [200] OK`)
    for (let i = 2; i <= 12; i++) lines.push(`${i}. [POST] ${prefix}v=2&tid=G-3FHCRNP43E&${'r'.repeat(400)} => [204] `)
    lines.push('', 'Note: 12 static requests not shown, run with "static" option to see them.')
    const raw = lines.join('\n')

    const { body } = compressedBody(await post('mcp__playwright__browser_network_requests', { static: false }, raw))
    expect(body).toContain('chars elided')
    expect(body).not.toMatch(/ghp_[A-Za-z0-9]{6,}/)
  })

  it('keeps, redacted, an evaluate echo carrying a credential, since the redacted echo no longer equals what the model sent', async () => {
    const token = 'ghp_' + 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8'
    // Long enough that dropping the echo would clear the net-savings floor, so the block surviving is the comparison refusing a redacted echo rather than the gate declining a small rewrite.
    const pad = 'x'.repeat(400)
    const fn = `async () => (await fetch('/api/me?pad=${pad}', {headers: {Authorization: 'token ${token}'}})).status`
    const echo = String.raw`await page.evaluate('async () => (await fetch(\'/api/me?pad=` + pad + String.raw`\', {headers: {Authorization: \'token ` + token + String.raw`\'}})).status');`
    const raw = evaluateResult(echo)

    const out = await post('mcp__playwright__browser_evaluate', { function: fn }, raw)
    expect(out.hookType).toBe('rewriteOutput')
    if (out.hookType !== 'rewriteOutput') return
    expect(out.updatedOutput).not.toContain(token)
    expect(out.updatedOutput).toContain('[REDACTED:github_token]')
    expect(out.updatedOutput).toContain('### Ran Playwright code\n```js\n')
  })
})
