import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { detectHarness } from '../src/bridges/registry.js'
import { genericMcpHarnessEnv, neutralizeMcpHarnessSignals } from './helpers/mcp_test_harness.js'

const testsDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.dirname(testsDir)

afterEach(() => vi.unstubAllEnvs())

function walkTests(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'fixtures' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkTests(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** The env keys the initialize handler reads to decide hooksAvailable, parsed from the source so a new signal added there is seen here. */
function setterEnvKeys(): string[] {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'mcp_jsonrpc.ts'), 'utf8')
  const start = src.indexOf("case 'initialize'")
  const end = src.indexOf('this.hooksAvailable = true', start)
  expect(start, 'initialize case not found in src/mcp_jsonrpc.ts').toBeGreaterThan(-1)
  expect(end, 'hooksAvailable setter not found in src/mcp_jsonrpc.ts').toBeGreaterThan(start)
  const keys = [...src.slice(start, end).matchAll(/process\.env(?:\[['"]([A-Z0-9_]+)['"]\]|\.([A-Z0-9_]+))/g)].map((m) => m[1] ?? m[2] ?? '')
  return [...new Set(keys.filter((key) => key !== ''))]
}

/** Drops full-line comments and each line's trailing // comment, so a note that names a trigger or the helper does not count as a use. */
function codeOf(src: string): string {
  return src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .map(stripTrailingLineComment)
    .join('\n')
}

/** Cuts a line at the first // outside a quoted literal, so a URL inside a string survives; a regex literal holding a quote can keep a trailing comment, which then counts as code. */
function stripTrailingLineComment(line: string): string {
  let quote: string | undefined
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote !== undefined) {
      if (ch === '\\') i++
      else if (ch === quote) quote = undefined
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '/' && line[i + 1] === '/') return line.slice(0, i)
  }
  return line
}

/** A file drives a tool when it sends tools/call or lists tools (tools/list, listTools()), or calls callTool beside a server it creates, spawns or constructs. */
function drivesMcpTool(code: string): boolean {
  if (code.includes('tools/call') || code.includes('tools/list') || code.includes('listTools(')) return true
  return code.includes('callTool') && ['createMcpServer(', 'new McpServer(', 'mcp-serve'].some((trigger) => code.includes(trigger))
}

/** The opt-ins: a call to useGenericMcpHarness() or neutralizeMcpHarnessSignals(), a call to genericMcpHarnessEnv() for a spawned child, or an explicit generic override key. */
const GENERIC_HARNESS_OPT_IN = /\buseGenericMcpHarness\(\)|\bneutralizeMcpHarnessSignals\(\)|\bgenericMcpHarnessEnv\(|TOKEN_GOAT_HARNESS_OVERRIDE['"]?\s*\]?\s*(?::|=(?!=))\s*['"]generic['"]/

/** A file that spawns the mcp-serve bundle, where the child inherits the parent env, so the override key alone leaves the hook signals in place. */
function spawnsMcpServe(code: string): boolean {
  return /spawn(Sync)?\(/.test(code) && code.includes("'mcp-serve'")
}

/** Opted in: the generic opt-in is present, and a spawned mcp-serve child also strips the signals through genericMcpHarnessEnv(). */
function optedIn(code: string): boolean {
  if (!GENERIC_HARNESS_OPT_IN.test(code)) return false
  return !spawnsMcpServe(code) || /\bgenericMcpHarnessEnv\(/.test(code)
}

describe('tests that drive an MCP server run under the generic harness', () => {
  it('the setter reads at least the three signals this guard was written against', () => {
    expect(setterEnvKeys()).toEqual(expect.arrayContaining(['COPILOT_HOME', 'CLAUDE_CODE_SESSION_ID', 'TERM_PROGRAM']))
  })

  it('neutralizeMcpHarnessSignals clears every env signal the hooksAvailable setter reads, and detection lands on generic', () => {
    for (const key of setterEnvKeys()) vi.stubEnv(key, key === 'TERM_PROGRAM' ? 'claude-code' : 'signal-present')
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    neutralizeMcpHarnessSignals()
    for (const key of setterEnvKeys()) {
      const value = process.env[key]
      expect(key === 'TERM_PROGRAM' ? value !== 'claude-code' : value === undefined, `${key} still set to ${String(value)} after neutralizeMcpHarnessSignals`).toBe(true)
    }
    expect(detectHarness()).toBe('generic')
  })

  it('genericMcpHarnessEnv removes every key the hooksAvailable setter reads, so a spawned child cannot see a hook host', () => {
    const base: NodeJS.ProcessEnv = Object.fromEntries(setterEnvKeys().map((key) => [key, 'signal-present']))
    const env = genericMcpHarnessEnv(base)
    expect(env['TOKEN_GOAT_HARNESS_OVERRIDE']).toBe('generic')
    for (const key of setterEnvKeys()) {
      expect(env[key], `${key} survives genericMcpHarnessEnv, so a child that spawns with it reads a hook host`).toBeUndefined()
    }
  })

  it('the opt-in matcher takes a call or the child env key, not an import or a mention', () => {
    const optIn = (text: string): boolean => GENERIC_HARNESS_OPT_IN.test(codeOf(text))
    expect(optIn('beforeAll(x); useGenericMcpHarness();')).toBe(true)
    expect(optIn('beforeEach(() => neutralizeMcpHarnessSignals())')).toBe(true)
    expect(optIn('spawn(p, { env: genericMcpHarnessEnv(env) })')).toBe(true)
    expect(optIn("env: { TOKEN_GOAT_HARNESS_OVERRIDE: 'generic' }")).toBe(true)
    expect(optIn("process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'generic'")).toBe(true)
    expect(optIn("import { useGenericMcpHarness } from './helpers/mcp_test_harness.js'")).toBe(false)
    expect(optIn('beforeEach(neutralizeMcpHarnessSignals)')).toBe(false)
    expect(optIn('// call useGenericMcpHarness() at the top')).toBe(false)
    expect(optIn('spawn(p, { env: env }) // genericMcpHarnessEnv(env)')).toBe(false)
    expect(optIn("const url = 'https://example.test/x'; useGenericMcpHarness();")).toBe(true)
    expect(optIn("env: { TOKEN_GOAT_HARNESS_OVERRIDE: 'claudecode' }")).toBe(false)
    expect(optIn("if (process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] === 'generic') run()")).toBe(false)
  })

  it('a spawned mcp-serve child opts in only through genericMcpHarnessEnv, not the override key alone', () => {
    expect(optedIn(codeOf("spawn(p, [b, 'mcp-serve'], { env: { TOKEN_GOAT_HARNESS_OVERRIDE: 'generic' } })"))).toBe(false)
    expect(optedIn(codeOf("spawn(p, [b, 'mcp-serve'], { env: genericMcpHarnessEnv(env) })"))).toBe(true)
    expect(optedIn(codeOf("run(['mcp-serve']); useGenericMcpHarness();"))).toBe(true)
  })

  it('every test file that drives an MCP tool opts into the generic harness', () => {
    const offenders = walkTests(testsDir, [])
      .filter((file) => file !== fileURLToPath(import.meta.url))
      .filter((file) => {
        const code = codeOf(fs.readFileSync(file, 'utf8'))
        return drivesMcpTool(code) && !optedIn(code)
      })
      .map((file) => path.relative(repoRoot, file).split(path.sep).join('/'))
    expect(offenders, 'these files call MCP tools under tests/setup/isolate-home.ts default harness override (claudecode), so every call answers "disabled"; call useGenericMcpHarness() from tests/helpers/mcp_test_harness.ts').toEqual([])
  })

  it('no file that calls useGenericMcpHarness() also unstubs envs per test, which would clear its beforeAll stub after the first test', () => {
    const offenders = walkTests(testsDir, [])
      .filter((file) => file !== fileURLToPath(import.meta.url))
      .filter((file) => {
        const code = codeOf(fs.readFileSync(file, 'utf8'))
        return /(?<!function )\buseGenericMcpHarness\(\)/.test(code) && /unstubAllEnvs/.test(code)
      })
      .map((file) => path.relative(repoRoot, file).split(path.sep).join('/'))
    expect(offenders, 'these files call useGenericMcpHarness() and also unstub envs; switch them to beforeEach(() => neutralizeMcpHarnessSignals())').toEqual([])
  })
})
