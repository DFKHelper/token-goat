import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const hooksWrite = fs.readFileSync(path.join(repo, 'src', 'hooks_write.ts'), 'utf8')
const hooksBash = fs.readFileSync(path.join(repo, 'src', 'hooks_bash.ts'), 'utf8')
const deadlineRs = fs.readFileSync(path.join(repo, 'native', 'tg-hook', 'src', 'deadline.rs'), 'utf8')
const srcDir = path.join(repo, 'src')
const srcFiles = pinnedPopulation({
  what: 'src/**/*.ts files',
  items: fs
    .readdirSync(srcDir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.split(path.sep).join('/')),
  floor: 400,
  mustInclude: ['hooks_bash.ts', 'hooks_write.ts'],
})
const srcSources = new Map(srcFiles.map((f) => [f, fs.readFileSync(path.join(srcDir, f), 'utf8')] as const))

// The tool names that pre_tool_use registrations of one handler name, e.g. Write, Edit and MultiEdit for preWriteRewriteHandler.
function registeredTools(source: string, handler: string): string[] {
  const re = new RegExp(`registerHook\\('pre_tool_use', ${handler}, \\{ toolName: '([^']+)' \\}\\)`, 'g')
  return [...source.matchAll(re)].map((m) => m[1])
}

// The folded tool names listed in deadline.rs tool_of under one class arm, e.g. Write.
function nativeArm(arm: string): string[] {
  const re = /^\s*((?:"[a-z]+"\s*\|\s*)*"[a-z]+")\s*=> Tool::(\w+),/gm
  const names: string[] = []
  for (const m of deadlineRs.matchAll(re)) {
    if (m[2] === arm) names.push(...[...m[1].matchAll(/"([a-z]+)"/g)].map((n) => n[1]))
  }
  return names
}

function fold(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '')
}

function folded(names: string[]): string[] {
  return names.map(fold).sort()
}

interface Registration {
  file: string
  event: string
  handler: string
  toolName: string
}

interface PatternRegistration {
  file: string
  event: string
  handler: string
  pattern: string
}

// The top-level arguments of the call whose opening parenthesis is at open; throws when it never closes, so no call is dropped.
function callArgs(code: string, open: number): string[] {
  const args: string[] = []
  let depth = 0
  let quote = ''
  let start = open + 1
  for (let i = open + 1; i < code.length; i++) {
    const ch = code.charAt(i)
    if (quote !== '') {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth++
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        args.push(code.slice(start, i))
        return args.map((a) => a.trim()).filter((a) => a !== '')
      }
      depth--
    } else if (ch === ',' && depth === 0) {
      args.push(code.slice(start, i))
      start = i + 1
    }
  }
  throw new Error(`registerHook call at offset ${String(open)} never closes`)
}

function literalOf(text: string | undefined): string | undefined {
  return /^\s*['"]([^'"]*)['"]\s*$/.exec(text ?? '')?.[1]
}

// Every registerHook call in the sources (comments removed); a call the scanner cannot resolve is a problem, never a skip.
function scanRegistrations(sources: ReadonlyMap<string, string>): { registrations: Registration[]; patterns: PatternRegistration[]; problems: string[] } {
  const registrations: Registration[] = []
  const patterns: PatternRegistration[] = []
  const problems: string[] = []
  for (const [name, text] of sources) {
    const file = `src/${name}`
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const call of code.matchAll(/(?<!function\s)\bregisterHook\(/g)) {
      const args = callArgs(code, (call.index ?? 0) + 'registerHook'.length)
      const event = literalOf(args[0])
      const handler = args[1] ?? ''
      const opts = args[2] ?? ''
      if (event === undefined) {
        problems.push(`${file}: registerHook event is not a string literal (${args[0] ?? 'none'})`)
        continue
      }
      const hasPattern = /\btoolPattern\b/.test(opts)
      const pattern = hasPattern ? /\btoolPattern:\s*([^,}]+)/.exec(opts)?.[1]?.trim() : undefined
      if (hasPattern && pattern === undefined) problems.push(`${file}: ${handler} on ${event} has a toolPattern that is not a key: value pair`)
      if (pattern !== undefined) patterns.push({ file, event, handler, pattern })
      if (event === 'pre_tool_use' && /\btoolName\b/.test(opts)) {
        const toolName = literalOf(/\btoolName:\s*(['"][^'"]*['"])/.exec(opts)?.[1])
        if (toolName === undefined) problems.push(`${file}: ${handler} on pre_tool_use has a toolName that is not a string literal`)
        else registrations.push({ file, event, handler, toolName })
      } else if (event === 'pre_tool_use' && pattern === undefined) {
        problems.push(`${file}: ${handler} on pre_tool_use names neither a toolName nor a toolPattern`)
      }
    }
  }
  return { registrations, patterns, problems }
}

// The tools native answers as allowed at the deadline: neither a write nor a shell call, so the native busy set does not name them.
const ALLOW_AT_DEADLINE: readonly (readonly [string, string])[] = [
  ['Agent', 'subagent spawn, not a write or shell tool (src/hooks_agent_spawn_register.ts)'],
  ['task', 'subagent spawn, not a write or shell tool (src/hooks_agent_spawn_register.ts)'],
  ['Task', 'subagent spawn, not a write or shell tool (src/hooks_agent_spawn_register.ts)'],
  ['spawn_agent', 'subagent spawn, not a write or shell tool (src/hooks_agent_spawn_register.ts)'],
  ['WebFetch', 'fetch, not a write or shell tool (src/hooks_fetch.ts)'],
  ['Glob', 'search, not a write or shell tool (src/hooks_glob.ts)'],
  ['Grep', 'search, not a write or shell tool (src/hooks_grep.ts, src/hooks_read.ts)'],
  ['Read', 'read, not a write or shell tool (src/hooks_read.ts, src/image_shrink.ts)'],
  ['Skill', 'skill load, not a write or shell tool (src/hooks_skill.ts)'],
  ['WebSearch', 'web search, not a write or shell tool (src/hooks_websearch.ts)'],
]

// The toolPattern registrations, each named with its reason; an mcp__ name is neither a write nor a shell call.
const ALLOW_PATTERNS: readonly (PatternRegistration & { reason: string })[] = [
  { file: 'src/hooks_mcp.ts', event: 'pre_tool_use', handler: 'preMcpHandler', pattern: 'MCP_TOOL_PATTERN', reason: 'mcp__ tools, not a write or shell tool' },
  { file: 'src/hooks_mcp.ts', event: 'post_tool_use', handler: 'postMcpHandler', pattern: 'MCP_TOOL_PATTERN', reason: 'mcp__ tools, not a write or shell tool' },
  { file: 'src/hooks_screenshot.ts', event: 'pre_tool_use', handler: 'preScreenshotHandler', pattern: "'^mcp__'", reason: 'mcp__ tools, not a write or shell tool' },
  { file: 'src/hooks_browser_image.ts', event: 'post_tool_use', handler: 'postBrowserImageHandler', pattern: "'^mcp__'", reason: 'mcp__ tools, not a write or shell tool' },
]

describe('native deadline busy set mirrors node', () => {
  // FORMAT-DERIVED: src/hooks_write.ts and src/hooks_bash.ts pre_tool_use registrations, against deadline.rs tool_of.
  it('answers busy for exactly the tools node PreToolUse write and shell guards register', () => {
    const nodeWrite = registeredTools(hooksWrite, 'preWriteRewriteHandler')
    const nodeShell = registeredTools(hooksBash, 'preShell')
    expect(nodeWrite.length, 'src/hooks_write.ts no longer registers its write guard on pre_tool_use').toBeGreaterThan(0)
    expect(nodeShell.length, 'src/hooks_bash.ts no longer registers its shell guard on pre_tool_use').toBeGreaterThan(0)
    expect(folded(nativeArm('Write')), 'deadline.rs Write arm differs from the write guard names in src/hooks_write.ts').toEqual(folded(nodeWrite))
    expect(folded(nativeArm('Shell')), 'deadline.rs Shell arm differs from the shell guard names in src/hooks_bash.ts').toEqual(folded(nodeShell))
  })
})

describe('every src/ pre_tool_use registration is in the native busy set or the allow list', () => {
  // FORMAT-DERIVED: registerHook calls in every src/**/*.ts (the registerHook signature in src/hook_registry.ts) and deadline.rs tool_of, read this run.
  const scan = scanRegistrations(srcSources)

  it('resolves every registration to a string-literal event, toolName or toolPattern', () => {
    expect(scan.registrations.length, 'the scan found no pre_tool_use registrations in src/').toBeGreaterThan(0)
    expect(scan.problems, 'a registration the scanner cannot resolve statically must fail closed').toEqual([])
  })

  it('puts each pre_tool_use toolName in exactly one of the native busy set and the allow list', () => {
    const busy = new Set(folded([...nativeArm('Write'), ...nativeArm('Shell')]))
    const allow = new Set(ALLOW_AT_DEADLINE.map(([tool]) => fold(tool)))
    const violations = scan.registrations
      .filter((r) => busy.has(fold(r.toolName)) === allow.has(fold(r.toolName)))
      .map((r) => `${r.file} registers pre_tool_use tool "${r.toolName}" (handler ${r.handler}), which is in ${busy.has(fold(r.toolName)) ? 'both' : 'neither'} of the native busy set (deadline.rs tool_of Write/Shell arms) and the allow-at-deadline list (this test)`)
    expect(violations, 'each folded pre_tool_use tool name must appear in exactly one of the two lists').toEqual([])
  })

  it('names every toolPattern registration with its reason', () => {
    const found = scan.patterns.map((p) => `${p.file} ${p.event} ${p.handler} ${p.pattern}`).sort()
    const named = ALLOW_PATTERNS.map((p) => `${p.file} ${p.event} ${p.handler} ${p.pattern}`).sort()
    expect(found, 'a toolPattern registration is not named in ALLOW_PATTERNS with its reason').toEqual(named)
  })
})
