import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted -- wrap homedir (delegating to the real implementation by
// default) so the installCodex/installGrok cross-check tests below can point
// `~` at an isolated temp dir instead of touching the real `~/.codex/` /
// `~/.grok/` (mirrors the pattern in install_codex.test.ts / install_grok.test.ts).
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import { parse } from 'smol-toml'

import { installCodex, codexConfigPath } from '../src/bridges/codex_install.js'
import { installGrok, grokConfigPath } from '../src/bridges/grok_install.js'
import { HOOK_EVENTS, type HookEventName } from '../src/types.js'
import {
  BRIDGE_CAPABILITY_MATRIX,
  bridgesStatusToJson,
  formatBridgesStatus,
  type BridgeCapabilityRow,
} from '../src/bridges_status.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..')

function rowFor(harness: string): BridgeCapabilityRow {
  const row = BRIDGE_CAPABILITY_MATRIX.find((r) => r.harness === harness)
  if (row === undefined) throw new Error(`no matrix row for ${harness}`)
  return row
}

describe('BRIDGE_CAPABILITY_MATRIX (static data)', () => {
  it('covers exactly the real bridge modules -- excludes hermes (no install-writer) and generic (fallback, not a harness)', () => {
    const harnesses = BRIDGE_CAPABILITY_MATRIX.map((r) => r.harness).sort()
    expect(harnesses).toEqual(
      ['claudecode', 'codex', 'copilot_cli', 'gemini', 'grok', 'openclaw', 'opencode', 'pi'].sort(),
    )
    expect(harnesses).not.toContain('hermes')
    expect(harnesses).not.toContain('generic')
  })

  it('every row is internally consistent: implemented is a subset of HOOK_EVENTS, and every reasons entry only cites events NOT in implemented', () => {
    for (const row of BRIDGE_CAPABILITY_MATRIX) {
      for (const event of row.implemented) {
        expect(HOOK_EVENTS as readonly string[]).toContain(event)
      }
      const reasonEvents = row.reasons.flatMap((r) => r.events)
      // No duplicate reason coverage for the same event within one row.
      expect(new Set(reasonEvents).size).toBe(reasonEvents.length)
      for (const event of reasonEvents) {
        expect(row.implemented.has(event)).toBe(false)
      }
    }
  })

  it('every event NOT implemented by a row has a documented reason (no silent unexplained gap)', () => {
    for (const row of BRIDGE_CAPABILITY_MATRIX) {
      const explained = new Set(row.reasons.flatMap((r) => r.events))
      for (const event of HOOK_EVENTS) {
        if (row.implemented.has(event)) continue
        expect(explained.has(event), `${row.harness} is missing ${event} with no documented reason`).toBe(true)
      }
    }
  })

  it('claudecode and codex wire the identical event set (regression: codex used to be missing pre_compact/user_prompt_submit/subagent_stop -- feature-queue #307 Part B fix)', () => {
    const claudecode = rowFor('claudecode')
    const codex = rowFor('codex')
    expect([...codex.implemented].sort()).toEqual([...claudecode.implemented].sort())
    expect(codex.implemented.has('pre_compact')).toBe(true)
    expect(codex.implemented.has('user_prompt_submit')).toBe(true)
    expect(codex.implemented.has('subagent_stop')).toBe(true)
  })

  it("notification is implemented by zero rows, matching the codebase-wide absence of any registerHook('notification', ...) call site", () => {
    for (const row of BRIDGE_CAPABILITY_MATRIX) {
      expect(row.implemented.has('notification')).toBe(false)
    }
    // Exclude bridges_status.ts itself -- its own docstring describes this
    // absence using the same `registerHook('notification'|'stop', ...)` text,
    // which would otherwise false-positive as a real call site.
    const src = fs.readdirSync(path.join(REPO_ROOT, 'src')).filter((f) => f.endsWith('.ts') && f !== 'bridges_status.ts')
    let hits = 0
    for (const file of src) {
      const text = fs.readFileSync(path.join(REPO_ROOT, 'src', file), 'utf8')
      if (/registerHook\(\s*'notification'/.test(text)) hits++
    }
    expect(hits).toBe(0)
  })

  it("stop has no registered server-side handler either, but copilot_cli still wires it client-side (via its agentStop mapping) -- documented in this row's own reasons text for every other bridge", () => {
    // Exclude bridges_status.ts itself -- its own docstring describes this
    // absence using the same `registerHook('notification'|'stop', ...)` text,
    // which would otherwise false-positive as a real call site.
    const src = fs.readdirSync(path.join(REPO_ROOT, 'src')).filter((f) => f.endsWith('.ts') && f !== 'bridges_status.ts')
    let hits = 0
    for (const file of src) {
      const text = fs.readFileSync(path.join(REPO_ROOT, 'src', file), 'utf8')
      if (/registerHook\(\s*'stop'/.test(text)) hits++
    }
    expect(hits).toBe(0)
    for (const row of BRIDGE_CAPABILITY_MATRIX) {
      if (row.harness === 'copilot_cli') continue
      expect(row.implemented.has('stop')).toBe(false)
    }
  })

  it('copilot_cli is the only bridge implementing stop (via its agentStop mapping)', () => {
    const implementers = BRIDGE_CAPABILITY_MATRIX.filter((r) => r.implemented.has('stop')).map((r) => r.harness)
    expect(implementers).toEqual(['copilot_cli'])
  })
})

describe('bridgesStatusToJson', () => {
  it('produces one entry per row with a boolean per HOOK_EVENTS and reasons keyed by event name', () => {
    const json = bridgesStatusToJson(BRIDGE_CAPABILITY_MATRIX)
    expect(json).toHaveLength(BRIDGE_CAPABILITY_MATRIX.length)

    const claudecode = json.find((r) => r.harness === 'claudecode')
    expect(claudecode).toBeDefined()
    expect(claudecode?.events.pre_tool_use).toBe(true)
    expect(claudecode?.events.notification).toBe(false)
    expect(claudecode?.reasons['notification']).toMatch(/no registered server-side handler/)
    // Every HOOK_EVENTS key present, none extra.
    expect(Object.keys(claudecode?.events ?? {}).sort()).toEqual([...HOOK_EVENTS].sort())

    const gemini = json.find((r) => r.harness === 'gemini')
    expect(gemini?.events.pre_compact).toBe(true)
    expect(gemini?.events.subagent_stop).toBe(false)
    expect(gemini?.reasons['subagent_stop']).toMatch(/BeforeTool\/AfterTool\/PreCompress/)
  })

  it('round-trips through JSON.stringify/parse without losing any event or reason', () => {
    const json = JSON.parse(JSON.stringify(bridgesStatusToJson(BRIDGE_CAPABILITY_MATRIX))) as Array<{
      harness: string
      events: Record<HookEventName, boolean>
      reasons: Record<string, string>
    }>
    expect(json.length).toBe(BRIDGE_CAPABILITY_MATRIX.length)
    for (const row of json) {
      expect(Object.keys(row.events).sort()).toEqual([...HOOK_EVENTS].sort())
    }
  })
})

describe('formatBridgesStatus', () => {
  it('renders a header, one row per bridge with its harness name, and a documented-gaps legend', () => {
    const text = formatBridgesStatus(BRIDGE_CAPABILITY_MATRIX)
    expect(text).toContain('parity matrix')
    for (const event of HOOK_EVENTS) {
      expect(text).toContain(event)
    }
    for (const row of BRIDGE_CAPABILITY_MATRIX) {
      expect(text).toContain(row.harness)
    }
    expect(text).toContain('## Documented gaps')
    expect(text).toContain('opencode')
    expect(text).toMatch(/opencode:.*tool\.execute\.before/)
  })

  it('shows a 5/7 score for claudecode and codex, 3/7 for opencode/gemini/openclaw/pi, 6/7 for copilot_cli', () => {
    const text = formatBridgesStatus(BRIDGE_CAPABILITY_MATRIX)
    expect(text).toMatch(/claudecode\s+.*\s5\/7/)
    expect(text).toMatch(/codex\s+.*\s5\/7/)
    expect(text).toMatch(/copilot_cli\s+.*\s6\/7/)
    for (const harness of ['opencode', 'gemini', 'openclaw', 'pi']) {
      expect(text).toMatch(new RegExp(`${harness}\\s+.*\\s3\\/7`))
    }
  })
})

describe('drift guard: matrix reasons stay grounded in the real bridge source', () => {
  it("gemini's documented gap phrase still appears in gemini_install.ts", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'src', 'bridges', 'gemini_install.ts'), 'utf8')
    expect(text).toContain("['BeforeTool', 'AfterTool', 'PreCompress']")
  })

  it("opencode's documented gap phrase still appears in opencode.ts", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'src', 'bridges', 'opencode.ts'), 'utf8')
    expect(text).toContain('tool.execute.before')
    expect(text).toContain('tool.execute.after')
    expect(text).toContain('experimental.session.compacting')
  })

  it("openclaw's documented gap phrase still appears in openclaw.ts", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'src', 'bridges', 'openclaw.ts'), 'utf8')
    expect(text).toContain('before_tool_call')
    expect(text).toContain('after_tool_call')
    expect(text).toContain('before_compaction')
  })

  it("pi's documented gap phrase still appears in pi.ts", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'src', 'bridges', 'pi.ts'), 'utf8')
    expect(text).toContain('session_start')
    expect(text).toContain('tool_call')
    expect(text).toContain('session_before_compact')
  })

  it("copilot_cli's documented unimplemented-notification note still appears in copilot_cli.ts", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'src', 'bridges', 'copilot_cli.ts'), 'utf8')
    expect(text).toContain('notification')
    expect(text).toContain('is left unimplemented')
    expect(text).toContain('rather than guessed at')
  })
})

describe('drift guard: real installer output matches the matrix (codex, grok)', () => {
  let TMP: string

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bridges-status-drift-'))
    const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
    homedirMock.mockReturnValue(path.join(TMP, 'home'))
  })

  afterEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true })
  })

  it('installCodex wires exactly the events the codex matrix row claims', () => {
    installCodex()
    const config = parse(fs.readFileSync(codexConfigPath(), 'utf8')) as { hooks?: Record<string, unknown[]> }
    const wiredEvents = new Set(Object.keys(config.hooks ?? {}).filter((k) => (config.hooks?.[k]?.length ?? 0) > 0))

    // Codex's config.toml uses PascalCase event keys; translate to the internal
    // snake_case names the matrix keys on (mirrors CODEX_EVENT_ARG/CODEX_GLOBAL_EVENT_ARG).
    const PASCAL_TO_SNAKE: Record<string, HookEventName> = {
      PreToolUse: 'pre_tool_use',
      PostToolUse: 'post_tool_use',
      PreCompact: 'pre_compact',
      UserPromptSubmit: 'user_prompt_submit',
      SubagentStop: 'subagent_stop',
    }
    const actual = new Set([...wiredEvents].map((k) => PASCAL_TO_SNAKE[k]).filter((v): v is HookEventName => v !== undefined))
    expect(actual).toEqual(rowFor('codex').implemented)
  })

  it('installGrok wires exactly the events the grok matrix row claims', () => {
    installGrok()
    const config = JSON.parse(fs.readFileSync(grokConfigPath(), 'utf8')) as { hooks?: Record<string, unknown[]> }
    const wiredEvents = new Set(Object.keys(config.hooks ?? {}).filter((k) => (config.hooks?.[k]?.length ?? 0) > 0))

    const PASCAL_TO_SNAKE: Record<string, HookEventName> = {
      PreToolUse: 'pre_tool_use',
      PostToolUse: 'post_tool_use',
      PreCompact: 'pre_compact',
      UserPromptSubmit: 'user_prompt_submit',
      SubagentStop: 'subagent_stop',
    }
    const actual = new Set([...wiredEvents].map((k) => PASCAL_TO_SNAKE[k]).filter((v): v is HookEventName => v !== undefined))
    expect(actual).toEqual(rowFor('grok').implemented)
  })
})
