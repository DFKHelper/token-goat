/** A credential coloured part-way through is split by an escape sequence, so the redactor read past it, and the tool-output fence then stripped the escape and joined it again after redaction had run. `rg --color=always` prints exactly that shape when it highlights the match inside `GITHUB_TOKEN=ghp_...`. The fence shipped the token whole on the MCP path, the curl HTML fold, a `bash-output` recall and the recall index, while the raw result had shown it split. Redaction now reads the escape-stripped view as well, and the recall index redacts after its own strip. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { withoutFenceNonces } from './helpers/fence_nonce.js'
import { tempConfigPath } from './helpers/temp-config.js'

const mockDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-redact-escape-view-'))
const _testConfigPath = tempConfigPath('tg-redact-escape-view-config.toml')
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath, globalDbPath: () => path.join(mockDbDir, 'global.db') }
})

import { _applyFiltersAndPrint } from '../src/cli_cached_output.js'
import { invalidateConfigCache } from '../src/config.js'
import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { runHook } from '../src/hook_registry.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { UNTRUSTED_TOOL_TAG, withoutEscapes } from '../src/injection_scan.js'
import { indexRecallEntry, searchRecall } from '../src/recall_index.js'
import { buildEvent } from '../src/relay.js'
import { stripAnsiEscapes } from '../src/render/ansi.js'
import { clearModuleCaches } from '../src/reset.js'
import { hasPreciseSecret, redactSecrets, redactSerializedJson } from '../src/secret_redact.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ESC = '\x1b'
// HAND-DERIVED: a GitHub personal access token shape, `ghp_` and 36 alphanumerics, written here rather than generated.
const TOKEN = 'ghp_' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7c'

/** True when `text`, or any view a strip leaves of it, holds a whole GitHub token. */
function leaks(text: string): boolean {
  const token = /gh[oprsu]_[A-Za-z0-9]{36,}/
  return [text, stripAnsiEscapes(text), withoutEscapes(text)].some((view) => token.test(view))
}

// PROVENANCE: the audit's `rg --color=always` line, a reset, a bold red match on the token's prefix, and a reset before the rest of it.
const RG_LINE = `.env:3:GITHUB_TOKEN=${ESC}[0m${ESC}[1;31m${TOKEN.slice(0, 4)}${ESC}[0m${TOKEN.slice(4)}`
// PROVENANCE: the audit's recall payload, the token split by an escape nested one layer deep, which a single strip leaves split and a second joins.
const NESTED = `token ${TOKEN.slice(0, 10)}${ESC}${ESC}[0m[0m${TOKEN.slice(10)} end`

let stdout: string[]
let spies: WriteSpy[]
let isTty: boolean | undefined
let home: string
let savedHome: string | undefined

// Not clearModuleCaches between cases: it drops the hook registry the MCP case dispatches through.
beforeEach(() => {
  try {
    fs.unlinkSync(_testConfigPath)
  } catch {
    // no config file -> defaults
  }
  invalidateConfigCache()
  stdout = []
  spies = [spyOnWrite(process.stdout, stdout), spyOnWrite(process.stderr, [])]
  isTty = process.stdout.isTTY
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })
  savedHome = process.env['TOKEN_GOAT_HOME']
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-redact-escape-home-'))
  process.env['TOKEN_GOAT_HOME'] = home
})

afterEach(() => {
  for (const spy of spies) spy.mockRestore()
  Object.defineProperty(process.stdout, 'isTTY', { value: isTty, configurable: true })
  if (savedHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = savedHome
  fs.rmSync(home, { recursive: true, force: true })
})

afterAll(() => {
  clearModuleCaches()
  fs.rmSync(mockDbDir, { recursive: true, force: true })
})

describe('redaction reads a credential an escape sequence split', () => {
  it('the fixtures hide the token from a plain redaction and show it once stripped', () => {
    expect(RG_LINE).not.toContain(TOKEN)
    expect(withoutEscapes(RG_LINE)).toContain(TOKEN)
    expect(NESTED).not.toContain(TOKEN)
    expect(stripAnsiEscapes(NESTED)).not.toContain(TOKEN)
    expect(withoutEscapes(NESTED)).toContain(TOKEN)
  })

  it('redactSecrets counts it and returns the stripped text redacted', () => {
    for (const text of [RG_LINE, NESTED]) {
      const redacted = redactSecrets(text)
      expect(redacted.count, JSON.stringify(text)).toBe(1)
      expect(leaks(redacted.text), JSON.stringify(text)).toBe(false)
      expect(redacted.text).toContain('[REDACTED:')
    }
  })

  it('hasPreciseSecret sees it too, so a Read fold declines on it as on the plain token', () => {
    expect(hasPreciseSecret(`token ${TOKEN}`)).toBe(true)
    for (const text of [RG_LINE, NESTED]) expect(hasPreciseSecret(text), JSON.stringify(text)).toBe(true)
    expect(hasPreciseSecret(`${ESC}[31merror${ESC}[0m: build failed`)).toBe(false)
  })

  it('keeps the colour of text with no credential in it', () => {
    const coloured = `${ESC}[31merror${ESC}[0m: ${ESC}[1mbuild failed${ESC}[0m`
    expect(redactSecrets(coloured)).toEqual({ text: coloured, count: 0 })
  })

  it('leaves a serialized blob parseable, since the strip would cut its quotes', () => {
    const json = JSON.stringify({ output: `${ESC}]0;a title with no terminator ${RG_LINE}`, exitCode: 0 })
    const redacted = redactSerializedJson(json)
    expect(() => JSON.parse(redacted.text) as unknown).not.toThrow()
  })
})

describe('no surface fences a credential back together', () => {
  it('an MCP result', async () => {
    const payload = {
      tool_name: 'mcp__plugin_github_github__get_file_contents',
      tool_input: { owner: 'o', repo: 'r', path: '.env' },
      session_id: `redact-escape-${path.basename(home)}`,
      tool_response: [{ type: 'text', text: `${RG_LINE}\nother line` }],
    }
    const post = await runHook(buildEvent('post_tool_use', payload))
    expect(post.hookType, 'the fixture must reach the MCP fence').toBe('rewriteOutput')
    if (post.hookType !== 'rewriteOutput') throw new Error('unreachable')
    expect(post.updatedOutput).toContain(UNTRUSTED_TOOL_TAG)
    expect(post.updatedOutput).toContain('[REDACTED:')
    expect(leaks(post.updatedOutput)).toBe(false)
  })

  it('the curl HTML fold of a page that splits a token with an entity-encoded escape', async () => {
    // HAND-DERIVED: html-to-text decodes `&#27;` to ESC, so the cleaned text holds the token split by `ESC[0m`; the head padding makes the fold pay for itself.
    const page =
      `<!DOCTYPE html><html><head><title>Deploy</title>${'<style>.filler{color:#000;}</style>\n'.repeat(700)}</head>` +
      `<body><article><p>Set ${TOKEN.slice(0, 10)}&#27;[0m${TOKEN.slice(10)} before deploying.</p></article></body></html>`
    const command = 'curl -s https://example.com/deploy'
    const out = await postBashHandler(
      makeHookEvent({
        eventName: 'post_tool_use',
        toolName: 'Bash',
        toolInput: { command },
        sessionId: 's',
        raw: { cwd: REPO, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: page, exitCode: 0 } },
      }),
    )
    expect(out.hookType, 'the fixture must reach the curl HTML fold').toBe('rewriteOutput')
    if (out.hookType !== 'rewriteOutput') throw new Error('unreachable')
    expect(out.updatedOutput).toContain('curl HTML body cleaned')
    expect(out.updatedOutput).toContain('before deploying')
    expect(leaks(out.updatedOutput)).toBe(false)
  })

  it('a bash-output recall of cached output', () => {
    _applyFiltersAndPrint(`make: ok\n${NESTED}\ndone`, {}, true, UNTRUSTED_TOOL_TAG)
    const printed = stdout.join('')
    expect(printed).toContain('make: ok')
    expect(withoutFenceNonces(printed)).toContain(`</${UNTRUSTED_TOOL_TAG}>`)
    expect(leaks(printed)).toBe(false)
  })

  it('the recall index row', () => {
    for (const [label, content] of [
      ['rg colour', `${RG_LINE}\nother line`],
      ['nested', NESTED],
    ] as const) {
      const id = `redact-escape-${label.replace(' ', '-')}-${Date.now().toString(36)}`
      indexRecallEntry('bash', id, 'cat .env', content, Date.now())
      const row = getDb(globalDbPath()).prepare('SELECT content FROM cache_recall WHERE entry_id = ?').get(id) as { content: string } | undefined
      expect(row, label).toBeDefined()
      expect(row?.content, label).toContain('[REDACTED:')
      expect(leaks(row?.content ?? ''), label).toBe(false)
    }
  })
  it('the recall row and the snippet recall shows, for shapes one whole-text strip joins and a line-by-line one does not', () => {
    // PROVENANCE: the audit's crafted shapes. An OSC opened inside the key and closed by a BEL on the next line, behind a nested escape; the same key between a nested escape and a BEL on one line; and an OSC ended by the 8-bit string terminator. The index stripped once, which left the first open, and the snippet stripped again, across the line break, and showed the key whole.
    const shapes = [
      `${TOKEN.slice(0, 14)}${ESC}${ESC}[0m]x\n\x07${TOKEN.slice(14)}`,
      `${ESC}${ESC}[0m]x${TOKEN.slice(0, 14)}${ESC}[0m${TOKEN.slice(14)}\x07`,
      `${TOKEN.slice(0, 14)}${ESC}]p\u{9C}-\x07${TOKEN.slice(14)}`,
    ]
    for (const [i, shape] of shapes.entries()) {
      const marker = `recallshape${i}x${Date.now().toString(36)}`
      const id = `${marker}-id`
      // Redacted first, as every caller of indexRecallEntry redacts what it stores.
      indexRecallEntry('bash', id, 'cat build.log', redactSecrets(`${marker} ${shape} end`).text, Date.now())
      const row = getDb(globalDbPath()).prepare('SELECT content FROM cache_recall WHERE entry_id = ?').get(id) as { content: string } | undefined
      expect(row, marker).toBeDefined()
      expect(leaks(row?.content ?? ''), `row ${i}`).toBe(false)
      const hits = searchRecall(marker)
      expect(hits.map((h) => h.id), `search ${i}`).toContain(id)
      for (const hit of hits) expect(leaks(hit.snippet), `snippet ${i}`).toBe(false)
    }
  })
})
