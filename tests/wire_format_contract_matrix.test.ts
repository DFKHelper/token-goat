/**
 * Wire-format contract matrix -- context/systemMessage boundary (real bundle,
 * real default handlers, real shims).
 *
 * tests/hook_event_harness_matrix.test.ts already covers the harness x event
 * cross product for two concerns: "does the real bundle crash" (every pair)
 * and "does the real bundle/shim reshape a `deny` into the harness's wire
 * shape" (pre_tool_use only). Neither exercises the OTHER branch
 * serializeOutput() (src/hook_registry.ts) forks on: a `context` output,
 * which serializes to `hookSpecificOutput.additionalContext` for most events
 * but to a top-level `systemMessage` for events in
 * EVENTS_WITHOUT_ADDITIONAL_CONTEXT (`notification`, `pre_compact`) --
 * documented as a real, previously-shipped wire-format bug (see
 * hook_registry.ts's own comment: "2026-07-02").
 *
 * That branch's only existing coverage is:
 *  - tests/hook_registry.test.ts, which calls serializeOutput() directly with
 *    hand-constructed HookOutput values (internal-consistency only, never
 *    touches the real hook CLI entrypoint or a real handler).
 *  - tests/relay.test.ts, which spawns relay()/relayInProcess() from source
 *    but only ever against hand-registered fixture handlers
 *    (registerHook(...) inline in the test) rather than the real
 *    hooks_read.ts/hooks_edit.ts/hooks_compact.ts handlers relay.ts actually
 *    wires up in production -- the exact injected-seam shape this repo's
 *    CLAUDE.md warns about.
 *  - tests/bridges/shims.test.ts's CODEX_HOOK_SCRIPT hookEventName-casing
 *    tests, which spawn the real shim script but feed it a FAKE child
 *    process's canned JSON (withFakeTokenGoat) instead of the real bundle, so
 *    they prove the shim reshapes correctly-shaped input, never that the real
 *    bundle actually produces that shape for a real triggering scenario.
 *
 * This file closes that gap: it spawns the real built bundle (dist/token-goat.mjs)
 * -- and, for codex/copilot_cli, the real embedded shim scripts pointed at that
 * same real bundle -- against realistic tool-call sequences that trigger a real
 * default handler's `context` output (preReadHandler's re-read hint,
 * postEditHandler's markdown section hint, preCompactHandler's manifest), then
 * asserts the raw stdout bytes match each harness's actual wire contract.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CODEX_HOOK_SCRIPT } from '../src/bridges/codex.js'
import { COPILOT_CLI_HOOK_SCRIPT } from '../src/bridges/copilot_cli.js'
import type { HarnessName } from '../src/bridges/types.js'

import { BUNDLE, ROOT } from './helpers/bundle.js'

// --- Spawning helpers (mirrors tests/hook_event_harness_matrix.test.ts's own local helpers) ---

const tempDirs: string[] = []

function mkIsolated(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function tgEnv(harness: HarnessName, dataBase: string, homeBase: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOCALAPPDATA: dataBase,
    XDG_DATA_HOME: dataBase,
    HOME: homeBase,
    USERPROFILE: homeBase,
    TOKEN_GOAT_HARNESS_OVERRIDE: harness,
    ...extra,
  }
}

function run(args: string[], env: NodeJS.ProcessEnv, input: string): RunResult {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 15000,
    input,
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** Runs a bridge shim's embedded script exactly as the external harness would, pointed at the real bundle via entryPath -- mirrors runShim() in tests/hook_event_harness_matrix.test.ts. */
function runShim(script: string, cwd: string, eventArg: string, payload: unknown, env: NodeJS.ProcessEnv): RunResult {
  const scriptPath = path.join(cwd, 'shim.js')
  fs.writeFileSync(scriptPath, script, 'utf8')
  const res = spawnSync(process.execPath, [scriptPath, eventArg, BUNDLE], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
    env,
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort; a lingering detached worker can briefly hold a temp dir on Windows
    }
  }
})

/**
 * Harnesses whose default install path wires `token-goat hook <event>` straight
 * into their own settings file with no reshaping shim, so the raw bundle
 * response IS their wire contract -- same set tests/hook_event_harness_matrix.test.ts
 * uses for its RAW_PASSTHROUGH_HARNESSES deny-shape assertions.
 */
const RAW_PASSTHROUGH_HARNESSES: HarnessName[] = ['claudecode', 'grok', 'hermes', 'gemini', 'qwen', 'generic']

describe('wire-format contract matrix: pre_tool_use `context` hint -> hookSpecificOutput.additionalContext (real bundle, real preReadHandler)', () => {
  let dataBase: string
  let homeBase: string

  beforeAll(() => {
    dataBase = mkIsolated('tg-wireformat-ptu-data-')
    homeBase = mkIsolated('tg-wireformat-ptu-home-')
  })

  for (const harness of RAW_PASSTHROUGH_HARNESSES) {
    it(`${harness}: re-reading a small already-read file emits hookSpecificOutput.additionalContext with hookEventName "PreToolUse"`, () => {
      const sessionId = `wireformat-ptu-${harness}`
      const filePath = path.join(dataBase, `${sessionId}.txt`)
      fs.writeFileSync(filePath, 'hello from the wire-format contract matrix\n')
      const env = tgEnv(harness, dataBase, homeBase)
      const payload = { tool_name: 'Read', tool_input: { file_path: filePath }, session_id: sessionId }
      const first = run(['hook', 'pre_tool_use'], env, JSON.stringify(payload))
      expect(first.status, `first read, stderr: ${first.stderr}`).toBe(0)

      const second = run(['hook', 'pre_tool_use'], env, JSON.stringify(payload))
      expect(second.status, `second read, stderr: ${second.stderr}`).toBe(0)
      const parsed = JSON.parse(second.stdout) as {
        hookSpecificOutput?: { hookEventName?: string; additionalContext?: string }
        systemMessage?: string
      }
      expect(parsed.systemMessage).toBeUndefined()
      expect(parsed.hookSpecificOutput?.hookEventName).toBe('PreToolUse')
      expect(typeof parsed.hookSpecificOutput?.additionalContext).toBe('string')
      expect(parsed.hookSpecificOutput?.additionalContext ?? '').toContain('already read this session')
    })
  }

  it('codex: the real CODEX_HOOK_SCRIPT shim forwards a bundle context hint and injects hookSpecificOutput.hookEventName "PreToolUse"', () => {
    const cwd = mkIsolated('tg-wireformat-ptu-codexshim-')
    const sessionId = 'wireformat-ptu-codex-shim'
    const filePath = path.join(cwd, 'small.txt')
    fs.writeFileSync(filePath, 'hello from the codex shim wire-format test\n')
    // CODEX_TOOL_NAME_MAP (src/hooks_cli.ts) has no 'Read' entry, so tool_name
    // 'Read' passes through normalizePayload's codex branch unmapped -- reaches
    // the canonical Read handler exactly as claudecode's own payload would.
    // Same real fixture pattern as the shim's deny-shape test in
    // tests/hook_event_harness_matrix.test.ts.
    const payload = { tool_name: 'Read', tool_input: { file_path: filePath }, session_id: sessionId }
    const env = tgEnv('codex', cwd, cwd)
    const first = runShim(CODEX_HOOK_SCRIPT, cwd, 'pre_tool_use', payload, env)
    expect(first.status, `first read, stderr: ${first.stderr}`).toBe(0)
    const second = runShim(CODEX_HOOK_SCRIPT, cwd, 'pre_tool_use', payload, env)
    expect(second.status, `second read, stderr: ${second.stderr}`).toBe(0)
    const parsed = JSON.parse(second.stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string }
    }
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('PreToolUse')
    expect(typeof parsed.hookSpecificOutput?.additionalContext).toBe('string')
    expect(parsed.hookSpecificOutput?.additionalContext ?? '').toContain('already read this session')
  })
})

describe('wire-format contract matrix: post_tool_use `context` hint -> hookSpecificOutput.additionalContext (real bundle, real postEditHandler)', () => {
  let dataBase: string
  let homeBase: string

  beforeAll(() => {
    dataBase = mkIsolated('tg-wireformat-ptu2-data-')
    homeBase = mkIsolated('tg-wireformat-ptu2-home-')
  })

  // postEditHandler (src/hooks_edit.ts) only emits the section-hint context for
  // markdown/rst files whose size clears hints.min_session_hint_savings_bytes
  // (default 512 bytes) -- see meetsSavingsFloor.
  const MD_BODY = '# heading\n\n' + 'lorem ipsum dolor sit amet, '.repeat(40) + '\n'

  for (const harness of RAW_PASSTHROUGH_HARNESSES) {
    it(`${harness}: editing a markdown file emits hookSpecificOutput.additionalContext with hookEventName "PostToolUse"`, () => {
      const sessionId = `wireformat-post-${harness}`
      const filePath = path.join(dataBase, `${sessionId}.md`)
      fs.writeFileSync(filePath, MD_BODY)
      const env = tgEnv(harness, dataBase, homeBase)
      const payload = { tool_name: 'Edit', tool_input: { file_path: filePath }, session_id: sessionId }
      const r = run(['hook', 'post_tool_use'], env, JSON.stringify(payload))
      expect(r.status, `stderr: ${r.stderr}`).toBe(0)
      const parsed = JSON.parse(r.stdout) as {
        hookSpecificOutput?: { hookEventName?: string; additionalContext?: string }
        systemMessage?: string
      }
      expect(parsed.systemMessage).toBeUndefined()
      expect(parsed.hookSpecificOutput?.hookEventName).toBe('PostToolUse')
      expect(typeof parsed.hookSpecificOutput?.additionalContext).toBe('string')
      expect(parsed.hookSpecificOutput?.additionalContext ?? '').toContain('was edited')
      expect(parsed.hookSpecificOutput?.additionalContext ?? '').toContain('token-goat section')
    })
  }

  it('codex: the real CODEX_HOOK_SCRIPT shim forwards a bundle post-edit context hint and injects hookSpecificOutput.hookEventName "PostToolUse"', () => {
    const cwd = mkIsolated('tg-wireformat-post-codexshim-')
    const sessionId = 'wireformat-post-codex-shim'
    const filePath = path.join(cwd, 'notes.md')
    fs.writeFileSync(filePath, MD_BODY)
    // CODEX_TOOL_NAME_MAP maps 'edit_file'/'edit'/'apply_patch' -> 'Edit'.
    const payload = { tool_name: 'edit', tool_input: { file_path: filePath }, session_id: sessionId }
    const env = tgEnv('codex', cwd, cwd)
    const r = runShim(CODEX_HOOK_SCRIPT, cwd, 'post_tool_use', payload, env)
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    const parsed = JSON.parse(r.stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string }
    }
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('PostToolUse')
    expect(typeof parsed.hookSpecificOutput?.additionalContext).toBe('string')
    expect(parsed.hookSpecificOutput?.additionalContext ?? '').toContain('was edited')
  })

  it('copilot_cli: the real COPILOT_CLI_HOOK_SCRIPT shim reshapes a bundle post-edit context hint into its own top-level {additionalContext} shape (no hookSpecificOutput wrapper)', () => {
    // Native Copilot CLI wire shape confirmed directly against
    // COPILOT_CLI_HOOK_SCRIPT's own translate()/extractContext(): postToolUse
    // pulls hookSpecificOutput.additionalContext (or systemMessage) out of the
    // bundle's response and re-emits it as a bare top-level `additionalContext`
    // key -- a genuinely different shape than every RAW_PASSTHROUGH harness
    // above, and from Codex's hookSpecificOutput-preserving reshape.
    const cwd = mkIsolated('tg-wireformat-post-copilotshim-')
    const sessionId = 'wireformat-post-copilot-shim'
    const filePath = path.join(cwd, 'notes.md')
    fs.writeFileSync(filePath, MD_BODY)
    // TOOL_TO_TG maps Copilot's 'edit' -> 'Edit'; FILE_PATH_ARG_KEY.edit === 'path'.
    const payload = { sessionId, cwd, toolName: 'edit', toolArgs: { path: filePath } }
    const env = tgEnv('copilot_cli', cwd, cwd)
    const r = runShim(COPILOT_CLI_HOOK_SCRIPT, cwd, 'postToolUse', payload, env)
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    const parsed = JSON.parse(r.stdout) as { additionalContext?: string; hookSpecificOutput?: unknown }
    expect(parsed.hookSpecificOutput).toBeUndefined()
    expect(typeof parsed.additionalContext).toBe('string')
    expect(parsed.additionalContext ?? '').toContain('was edited')
  })
})

describe('wire-format contract matrix: pre_compact `context` -> raw stdout on Claude Code, top-level systemMessage everywhere else, never hookSpecificOutput (real bundle, real preCompactHandler)', () => {
  let dataBase: string
  let homeBase: string

  beforeAll(() => {
    dataBase = mkIsolated('tg-wireformat-compact-data-')
    homeBase = mkIsolated('tg-wireformat-compact-home-')
  })

  // Harnesses whose default install path wires pre_compact at all (per
  // EXPECTED_SUPPORTED_EVENTS in tests/hook_event_harness_matrix.test.ts) --
  // codex is deliberately excluded, since its default install never wires
  // pre_compact in the first place (CODEX_EVENT_ARG has no pre_compact entry).
  // Claude Code is the one harness that reads a PreCompact hook's stdout verbatim: its executor sets the hook result's `output` to the raw stdout and the compaction path joins every succeeding hook's `output` into the summarizing model's customInstructions. `systemMessage` is lifted onto a separate field nothing in that path reads, so a JSON-wrapped manifest was delivered to the summarizer as literal JSON text rather than as instructions. Bare text is what actually lands.
  it('claudecode: preCompactHandler\'s manifest reaches stdout as raw text, not wrapped in JSON, because Claude Code feeds PreCompact stdout to the summarizer verbatim', () => {
    const sessionId = 'wireformat-compact-claudecode'
    const env = tgEnv('claudecode', dataBase, homeBase)
    const payload = { session_id: sessionId, trigger: 'auto' }
    const r = run(['hook', 'pre_compact'], env, JSON.stringify(payload))
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    expect(r.stdout.trim().length).toBeGreaterThan(0)
    expect(r.stdout.trimStart().startsWith('{')).toBe(false)
    expect(r.stdout).not.toContain('systemMessage')
    expect(r.stdout).not.toContain('hookSpecificOutput')
    // The preamble is the part that only makes sense as instructions rather than as a quoted JSON string value, so it doubles as proof the manifest is being delivered in the register the summarizer reads.
    expect(r.stdout).toContain('When summarizing this session')
  })

  for (const harness of RAW_PASSTHROUGH_HARNESSES.filter((h) => h !== 'claudecode')) {
    it(`${harness}: preCompactHandler's manifest reaches stdout as a top-level systemMessage, with no hookSpecificOutput field at all`, () => {
      const sessionId = `wireformat-compact-${harness}`
      const env = tgEnv(harness, dataBase, homeBase)
      const payload = { session_id: sessionId, trigger: 'auto' }
      const r = run(['hook', 'pre_compact'], env, JSON.stringify(payload))
      expect(r.status, `stderr: ${r.stderr}`).toBe(0)
      const parsed = JSON.parse(r.stdout) as { systemMessage?: string; hookSpecificOutput?: unknown }
      // This is the exact wire-format bug hook_registry.ts's own comment
      // documents (2026-07-02): a pre_compact context output must NEVER be
      // nested under hookSpecificOutput.additionalContext -- Claude Code's
      // schema rejects additionalContext there outright.
      expect(parsed.hookSpecificOutput).toBeUndefined()
      expect(typeof parsed.systemMessage).toBe('string')
      expect((parsed.systemMessage ?? '').length).toBeGreaterThan(0)
    })
  }

  it('copilot_cli: the real COPILOT_CLI_HOOK_SCRIPT shim discards preCompact\'s response entirely, per its own documented no-surfacing-channel contract', () => {
    // translate()'s preCompact branch (the shared fallthrough for
    // preCompact/userPromptSubmitted) always returns {} regardless of what the
    // bundle produced -- Copilot's hooks reference documents both events as
    // notification-only with no response body read. Still routes through the
    // real token-goat hook call (so the handler's own side effects run); only
    // the wire response is asserted empty here.
    const cwd = mkIsolated('tg-wireformat-compact-copilotshim-')
    const sessionId = 'wireformat-compact-copilot-shim'
    const payload = { sessionId, cwd }
    const env = tgEnv('copilot_cli', cwd, cwd)
    const r = runShim(COPILOT_CLI_HOOK_SCRIPT, cwd, 'preCompact', payload, env)
    expect(r.status, `stderr: ${r.stderr}`).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({})
  })
})
