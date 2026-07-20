/**
 * Hook-event x harness bundle matrix (mirrors tests/command_matrix_e2e.test.ts's
 * built-bundle philosophy, applied to hook EVENTS instead of CLI commands).
 *
 * Every harness (Claude Code, Codex, Gemini, grok, Copilot CLI, pi, opencode,
 * OpenClaw, Hermes, and the generic fallback) invokes `token-goat hook <event>`
 * with its own wire-format payload for a subset of the seven HOOK_EVENTS -- not
 * every harness wires up every event; see each bridge's install file. Historical
 * wire-format bugs (Copilot CLI denying every call, a wrong tool-name mapping,
 * Grok's camelCase payload, Codex's additionalProperties:false schema) were
 * only ever found by manual dogfooding, one harness at a time, after shipping,
 * because nothing spawned the REAL built bundle with a REAL per-harness payload
 * across the full event surface. This file closes that gap.
 *
 * The harness x supported-event cross product is derived from source (each
 * bridge's install-time event-list constant, or its embedded callHook(...)
 * script for pi/opencode/openclaw), then cross-checked against a hand-authored
 * EXPECTED_SUPPORTED_EVENTS spec below -- so either a real wiring change in a
 * bridge's source, or an edit to the hand-authored spec that no longer matches
 * source, fails loudly. This is the same "two lists, assert sync" shape
 * tests/guards/cli_registration.test.ts already establishes for CLI commands,
 * plus a compile-time backstop: EXPECTED_SUPPORTED_EVENTS's type
 * (Record<HarnessName, ...>) forces every HarnessName union member to have an
 * entry, so a new harness added to that union without a matching spec entry is
 * a `tsc` error, not a silent runtime gap.
 *
 * Two dispatch mechanisms exist and this file exercises both:
 *  - claudecode/grok/hermes/gemini/generic wire `token-goat hook <event>`
 *    directly into their own settings file with no wrapper script, so the raw
 *    JSON serializeOutput() (src/hook_registry.ts) emits IS their wire
 *    contract -- verified by spawning dist/token-goat.mjs directly.
 *  - codex/copilot_cli reshape that raw JSON through a standalone Node shim
 *    script (CODEX_HOOK_SCRIPT / COPILOT_CLI_HOOK_SCRIPT) before the harness
 *    ever sees it -- verified by spawning the REAL shim script (pointed at the
 *    real bundle via its own entryPath argv), mirroring the runShim() pattern
 *    tests/bridges/shims.test.ts already establishes.
 *  - pi/opencode/openclaw wire hooks as plugin-API modules (callHook(...)
 *    invoked from inside a framework-specific extension export, not a
 *    standalone CLI script with a process.argv/stdin entry point), so they
 *    cannot be spawned and driven end-to-end without also faking each host
 *    framework's own plugin API -- out of scope here. Their deny-reshaping
 *    logic is instead verified statically against their documented native
 *    wire contract (see the last describe block).
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CODEX_HOOK_SCRIPT } from '../src/bridges/codex.js'
import { COPILOT_CLI_HOOK_SCRIPT } from '../src/bridges/copilot_cli.js'
import { OPENCLAW_PLUGIN_SCRIPT } from '../src/bridges/openclaw.js'
import { OPENCODE_PLUGIN_SCRIPT } from '../src/bridges/opencode.js'
import { PI_EXTENSION_SCRIPT } from '../src/bridges/pi.js'
import type { HarnessName } from '../src/bridges/types.js'
import { HOOK_EVENTS, type HookEventName } from '../src/types.js'

import { BUNDLE, ROOT } from './helpers/bundle.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', 'src')

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC_DIR, rel), 'utf8')
}

function isHookEventName(name: string): name is HookEventName {
  return (HOOK_EVENTS as readonly string[]).includes(name)
}

/** Extract every quoted `'([a-z_]+)'` value from `block`, asserting each is a real HOOK_EVENTS member. */
function extractKnownEvents(block: string, sourceLabel: string): HookEventName[] {
  const values = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => {
    const v = m[1]
    if (v === undefined) throw new Error(`extractKnownEvents: capture group missing in ${sourceLabel}`)
    return v
  })
  const unknown = values.filter((v) => !isHookEventName(v))
  if (unknown.length > 0) {
    throw new Error(
      `${sourceLabel} contains value(s) not in HOOK_EVENTS: ${unknown.join(', ')} -- update the matrix derivation in tests/hook_event_harness_matrix.test.ts`,
    )
  }
  return values as HookEventName[]
}

/**
 * claudecode's HOOK_EVENT_MAP (src/install.ts): [PascalCaseSettingsKey, internal
 * snake_case event] pairs written into ~/.claude/settings.json. grok and hermes
 * both ride these same entries by default: absent an explicit `install --grok`
 * (src/bridges/grok_install.ts, added after this comment was first written --
 * an OPT-IN, additive bridge that writes its own `~/.grok/hooks/token-goat.json`
 * + shim, never touching this shared settings.json), grok just runs Claude
 * Code's settings.json hooks directly with a camelCase payload; hermes's own
 * `install --hermes` only verifies these entries exist rather than writing its
 * own (see src/bridges/registry.ts's module docstring and
 * harnessForNormalization() in src/relay.ts). This matrix only exercises the
 * default (no `--grok`) path for grok, below.
 */
function claudecodeFamilyEvents(): HookEventName[] {
  const src = readSrc('install.ts')
  const m = src.match(/const HOOK_EVENT_MAP:[^\r\n]*\r?\n([\s\S]*?)\r?\n\]/)
  if (!m || m[1] === undefined) {
    throw new Error('HOOK_EVENT_MAP not found in src/install.ts -- update the matrix derivation')
  }
  return extractKnownEvents(m[1], 'src/install.ts HOOK_EVENT_MAP')
}

/** Codex's CODEX_EVENT_ARG (src/bridges/codex_install.ts): Codex TOML event key -> internal event arg passed to `token-goat hook`. */
function codexEvents(): HookEventName[] {
  const src = readSrc('bridges/codex_install.ts')
  const m = src.match(/const CODEX_EVENT_ARG:[^\r\n]*\r?\n([\s\S]*?)\r?\n\}/)
  if (!m || m[1] === undefined) {
    throw new Error('CODEX_EVENT_ARG not found in src/bridges/codex_install.ts -- update the matrix derivation')
  }
  return extractKnownEvents(m[1], 'src/bridges/codex_install.ts CODEX_EVENT_ARG')
}

/** Gemini's GEMINI_EVENT_ARG (src/bridges/gemini_install.ts): Gemini event key -> internal event arg. */
function geminiEvents(): HookEventName[] {
  const src = readSrc('bridges/gemini_install.ts')
  const m = src.match(/const GEMINI_EVENT_ARG:[^\r\n]*\r?\n([\s\S]*?)\r?\n\}/)
  if (!m || m[1] === undefined) {
    throw new Error('GEMINI_EVENT_ARG not found in src/bridges/gemini_install.ts -- update the matrix derivation')
  }
  return extractKnownEvents(m[1], 'src/bridges/gemini_install.ts GEMINI_EVENT_ARG')
}

/** Qwen Code's QWEN_EVENT_ARG (src/bridges/qwen_install.ts): Qwen event key -> internal event arg. */
function qwenEvents(): HookEventName[] {
  const src = readSrc('bridges/qwen_install.ts')
  const m = src.match(/const QWEN_EVENT_ARG:[^\r\n]*\r?\n([\s\S]*?)\r?\n\}/)
  if (!m || m[1] === undefined) {
    throw new Error('QWEN_EVENT_ARG not found in src/bridges/qwen_install.ts -- update the matrix derivation')
  }
  return extractKnownEvents(m[1], 'src/bridges/qwen_install.ts QWEN_EVENT_ARG')
}

/** Copilot CLI's COPILOT_TO_TG_EVENT (src/bridges/copilot_cli.ts): Copilot event name -> internal event, already the value passed as the CLI event arg. */
function copilotCliEvents(): HookEventName[] {
  const src = readSrc('bridges/copilot_cli.ts')
  const m = src.match(/const COPILOT_TO_TG_EVENT = \{\r?\n([\s\S]*?)\r?\n\}/)
  if (!m || m[1] === undefined) {
    throw new Error('COPILOT_TO_TG_EVENT not found in src/bridges/copilot_cli.ts -- update the matrix derivation')
  }
  return extractKnownEvents(m[1], 'src/bridges/copilot_cli.ts COPILOT_TO_TG_EVENT')
}

/**
 * pi / opencode / openclaw wire their hooks by calling `callHook("<event>", ...)`
 * directly inside a hand-authored, auto-discovered extension/plugin script,
 * rather than through an install-time event-list constant -- scan the embedded
 * script source for every literal `callHook("...")` call instead.
 */
function callHookEvents(script: string, sourceLabel: string): HookEventName[] {
  const calls = [...script.matchAll(/callHook\(\s*"([a-z_]+)"/g)].map((m) => {
    const v = m[1]
    if (v === undefined) throw new Error(`callHookEvents: capture group missing in ${sourceLabel}`)
    return v
  })
  const unique = [...new Set(calls)]
  const unknown = unique.filter((v) => !isHookEventName(v))
  if (unknown.length > 0) {
    throw new Error(`${sourceLabel} calls callHook() with unknown event(s): ${unknown.join(', ')}`)
  }
  return unique as HookEventName[]
}

/**
 * The harness x supported-event cross product, derived from source. `generic`
 * is the one exception: it is detectHarness()'s fallback identity when nothing
 * else matches (src/bridges/registry.ts), not something `install` ever writes
 * hook entries for, so there is no install-file source to scan -- it is tested
 * against the full HOOK_EVENTS set instead, since relay.ts must stay safe for
 * literally any event under an unrecognized harness by design, not because any
 * real generic-harness install wires up all seven.
 */
const DERIVED_SUPPORTED_EVENTS: Record<HarnessName, HookEventName[]> = {
  claudecode: claudecodeFamilyEvents(),
  grok: claudecodeFamilyEvents(),
  hermes: claudecodeFamilyEvents(),
  codex: codexEvents(),
  gemini: geminiEvents(),
  qwen: qwenEvents(),
  pi: callHookEvents(PI_EXTENSION_SCRIPT, 'PI_EXTENSION_SCRIPT'),
  opencode: callHookEvents(OPENCODE_PLUGIN_SCRIPT, 'OPENCODE_PLUGIN_SCRIPT'),
  openclaw: callHookEvents(OPENCLAW_PLUGIN_SCRIPT, 'OPENCLAW_PLUGIN_SCRIPT'),
  copilot_cli: copilotCliEvents(),
  generic: [...HOOK_EVENTS],
}

/**
 * Hand-authored spec of the same cross product, read directly off each
 * bridge's source at the time this file was written. Cross-checked against
 * DERIVED_SUPPORTED_EVENTS below so a genuine wiring change in source -- not
 * just a bug in the regex scanners above -- also fails loudly with a clear
 * per-harness diff.
 */
const EXPECTED_SUPPORTED_EVENTS: Record<HarnessName, HookEventName[]> = {
  claudecode: ['pre_tool_use', 'post_tool_use', 'pre_compact', 'user_prompt_submit', 'subagent_stop'],
  grok: ['pre_tool_use', 'post_tool_use', 'pre_compact', 'user_prompt_submit', 'subagent_stop'],
  hermes: ['pre_tool_use', 'post_tool_use', 'pre_compact', 'user_prompt_submit', 'subagent_stop'],
  codex: ['pre_tool_use', 'post_tool_use'],
  gemini: ['pre_tool_use', 'post_tool_use', 'pre_compact'],
  qwen: ['pre_tool_use', 'post_tool_use', 'pre_compact', 'user_prompt_submit', 'subagent_stop'],
  pi: ['pre_tool_use', 'post_tool_use', 'pre_compact'],
  opencode: ['pre_tool_use', 'post_tool_use', 'pre_compact'],
  openclaw: ['pre_tool_use', 'post_tool_use', 'pre_compact'],
  copilot_cli: ['pre_tool_use', 'post_tool_use', 'pre_compact', 'stop', 'subagent_stop', 'user_prompt_submit'],
  generic: [...HOOK_EVENTS],
}

const HARNESS_NAMES = Object.keys(EXPECTED_SUPPORTED_EVENTS) as HarnessName[]

describe('hook-event x harness coverage derivation', () => {
  it('every HarnessName is present in the hand-authored spec (compile-time exhaustiveness backstop)', () => {
    // EXPECTED_SUPPORTED_EVENTS's type (Record<HarnessName, ...>) already forces
    // every HarnessName key to be present at compile time -- a HarnessName union
    // member added without a matching object property is a `tsc` error, not a
    // silent runtime gap. This just documents that invariant for a reader who
    // only sees the vitest output, not a type error.
    expect(HARNESS_NAMES.length).toBeGreaterThanOrEqual(10)
  })

  for (const harness of HARNESS_NAMES) {
    it(`${harness}: source-derived supported events match the hand-authored spec`, () => {
      const derived = [...DERIVED_SUPPORTED_EVENTS[harness]].sort()
      const expected = [...EXPECTED_SUPPORTED_EVENTS[harness]].sort()
      expect(derived).toEqual(expected)
    })
  }
})

/** Every {harness, event} pair the matrix below spawns a case for, generated straight off the source-derived cross product -- not a second hand-maintained list. */
const MATRIX_CASES: Array<{ harness: HarnessName; event: HookEventName }> = HARNESS_NAMES.flatMap((harness) =>
  DERIVED_SUPPORTED_EVENTS[harness].map((event) => ({ harness, event })),
)

describe('hook-event x harness bundle matrix coverage gate', () => {
  it('covers every harness x source-derived-supported-event combination exactly once (no silent gaps or dupes)', () => {
    const expectedTotal = HARNESS_NAMES.reduce((sum, h) => sum + EXPECTED_SUPPORTED_EVENTS[h].length, 0)
    expect(MATRIX_CASES.length).toBe(expectedTotal)
    const keys = MATRIX_CASES.map((c) => `${c.harness}::${c.event}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

// --- Bundle spawning helpers -------------------------------------------------

const tempDirs: string[] = []

function mkIsolated(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

let dataBase: string
let homeBase: string

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function tgEnv(harness: HarnessName, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
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

/** Runs a bridge shim's embedded script exactly as the external harness would: a standalone Node process with the harness-native event name as argv[2], an optional entry-path arg for a direct real-bundle call, and the hook payload on stdin. Mirrors runShim() in tests/bridges/shims.test.ts, extended with an explicit env so the isolated data/home dirs and harness override reach the shim's own process (and, from there, its inner spawnSync call, which inherits it). */
function runShim(
  script: string,
  cwd: string,
  eventArg: string,
  extraArgv: string[],
  payload: unknown,
  env: NodeJS.ProcessEnv,
): RunResult {
  const scriptPath = path.join(cwd, 'shim.js')
  fs.writeFileSync(scriptPath, script, 'utf8')
  const res = spawnSync(process.execPath, [scriptPath, eventArg, ...extraArgv], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
    env,
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

beforeAll(() => {
  dataBase = mkIsolated('tg-hookmatrix-data-')
  homeBase = mkIsolated('tg-hookmatrix-home-')

  // This file exercises the deny/context wire-shape reshaping across harnesses,
  // not hints.protect_recent_reads (that field has its own dedicated coverage in
  // tests/hooks_read.test.ts). Its default (4) would otherwise exempt each of
  // this file's single-immediate-re-read fixtures from the re-read deny they're
  // asserting on, so pin it to 0 in the isolated config this bundle process
  // reads (dataDir() resolution mirrors src/constants.ts's defaultDataDir()).
  const configDir = process.platform === 'win32'
    ? path.join(dataBase, 'dfk-helper', 'token-goat')
    : path.join(dataBase, 'token-goat')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'config.toml'), '[hints]\nprotect_recent_reads = 0\n', 'utf8')
}, 30000)

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
 * A realistic wire payload for `harness` at a tool-scoped event, reusing real
 * fixture shapes already established for each harness's payload format in
 * tests/hooks_cli.test.ts (Codex/Gemini/grok tool-name remapping), not
 * invented from scratch. Every harness other than codex/gemini/grok
 * normalizes as a plain claudecode-shaped canonical payload: see
 * harnessForNormalization() in src/relay.ts, which only special-cases those
 * three -- copilot_cli/pi/opencode/openclaw/hermes/generic all fall through to
 * the 'claude' branch (passthrough), because by the time `token-goat hook
 * <event>` itself is invoked, each of those harnesses' own bridge/shim has
 * already remapped its native payload into this canonical shape (confirmed for
 * copilot_cli directly against COPILOT_CLI_HOOK_SCRIPT's own remapToolInput()).
 */
function toolPayload(harness: HarnessName, sessionId: string, filePath: string): Record<string, unknown> {
  if (harness === 'codex') {
    // Real fixture from tests/hooks_cli.test.ts ("remaps Codex snake_case tool names to PascalCase").
    return { tool_name: 'bash', tool_input: { command: 'ls -la' }, session_id: sessionId }
  }
  if (harness === 'gemini') {
    // Real fixture from tests/hooks_cli.test.ts ("leaves Gemini read_file input keys untouched").
    return { tool_name: 'read_file', tool_input: { file_path: filePath }, session_id: sessionId }
  }
  if (harness === 'grok') {
    // Real fixture from tests/hooks_cli.test.ts's grok describe block (confirmed live against grok 0.2.93).
    return {
      hookEventName: 'pre_tool_use',
      sessionId,
      toolName: 'read_file',
      toolInput: { target_file: filePath },
    }
  }
  return { tool_name: 'Read', tool_input: { file_path: filePath }, session_id: sessionId }
}

function nonToolPayload(event: HookEventName, sessionId: string): Record<string, unknown> {
  if (event === 'pre_compact') return { session_id: sessionId, trigger: 'auto' }
  return { session_id: sessionId }
}

describe('hook-event x harness bundle matrix (real bundle, non-crash coverage)', () => {
  for (const { harness, event } of MATRIX_CASES) {
    it(`${harness} :: ${event} does not crash the real bundle`, () => {
      const sessionId = `matrix-${harness}-${event}`
      const isToolEvent = event === 'pre_tool_use' || event === 'post_tool_use'
      const filePath = path.join(dataBase, `${sessionId}.txt`)
      if (isToolEvent && !fs.existsSync(filePath)) fs.writeFileSync(filePath, 'hello from the matrix test\n')
      const payload = isToolEvent ? toolPayload(harness, sessionId, filePath) : nonToolPayload(event, sessionId)
      const r = run(['hook', event], tgEnv(harness), JSON.stringify(payload))
      expect(r.status, `harness=${harness} event=${event} stderr: ${r.stderr}`).toBe(0)
      expect(() => JSON.parse(r.stdout)).not.toThrow()
    })
  }
})

describe('hook-event x harness bundle matrix (pre_tool_use deny wire shape)', () => {
  // claudecode/grok/hermes/gemini/generic have no bridge/shim that reshapes
  // serializeOutput's own {decision:'block', reason} wire JSON on their
  // DEFAULT install path: claudecode/hermes always, and grok absent an
  // explicit `install --grok` (see the note above claudecodeFamilyEvents()),
  // read ~/.claude/settings.json's `token-goat hook <event>` command directly
  // with no wrapper script; gemini_install.ts wires the same command directly
  // into ~/.gemini/settings.json with no shim file either (confirmed against
  // gemini-cli's own BeforeTool contract in tests/relay.test.ts's "relay
  // Gemini deny wire format" suite, which -- unlike grok -- documents 'block'
  // as an accepted alias for 'deny'); generic is the raw-CLI fallback with no
  // bridge at all. For these five on their default path, the raw bundle
  // response IS the harness's expected wire shape. `install --grok`'s own
  // shim (GROK_HOOK_SCRIPT, src/bridges/grok.ts) instead translates this
  // 'block' shape into Grok's documented '{"decision":"deny",...}' -- verified
  // separately in tests/install_grok.test.ts, not exercised here.
  const RAW_PASSTHROUGH_HARNESSES: HarnessName[] = ['claudecode', 'grok', 'hermes', 'gemini', 'qwen', 'generic']

  for (const harness of RAW_PASSTHROUGH_HARNESSES) {
    it(`${harness}: denies a re-read of an already-read large file via raw {decision:'block'} JSON`, () => {
      const sessionId = `matrix-deny-${harness}`
      const filePath = path.join(dataBase, `${sessionId}-large.bin`)
      // >50KB non-source file denies unconditionally on the 2nd read (see the
      // real unit test this mirrors: "denies re-read of a large file (>50KB)
      // that was already read this session" in tests/hooks_read.test.ts).
      fs.writeFileSync(filePath, 'x'.repeat(60 * 1024))
      const env = tgEnv(harness)
      const payload = toolPayload(harness, sessionId, filePath)
      const first = run(['hook', 'pre_tool_use'], env, JSON.stringify(payload))
      expect(first.status, `first read, stderr: ${first.stderr}`).toBe(0)
      const second = run(['hook', 'pre_tool_use'], env, JSON.stringify(payload))
      expect(second.status, `second read, stderr: ${second.stderr}`).toBe(0)
      const parsed = JSON.parse(second.stdout) as { decision?: string; reason?: string }
      expect(parsed.decision).toBe('block')
      expect(typeof parsed.reason).toBe('string')
      expect((parsed.reason ?? '').length).toBeGreaterThan(0)
    })
  }

  it('codex: the real CODEX_HOOK_SCRIPT shim forwards a bundle deny unchanged (a plain decision/reason deny has no hookSpecificOutput field to reshape)', () => {
    // CODEX_TOOL_NAME_MAP (src/hooks_cli.ts) has no 'Read' entry, so a
    // tool_name of 'Read' passes through normalizePayload's codex branch
    // unmapped -- i.e. unchanged -- reaching the canonical Read handler
    // exactly as claudecode's own payload would. This lets the shim test
    // exercise a confirmed-real code path without guessing at Codex's actual
    // native read-tool name (not established in any existing fixture).
    const cwd = mkIsolated('tg-hookmatrix-codexshim-')
    const sessionId = 'matrix-deny-codex-shim'
    const filePath = path.join(cwd, 'large.bin')
    fs.writeFileSync(filePath, 'x'.repeat(60 * 1024))
    const payload = { tool_name: 'Read', tool_input: { file_path: filePath }, session_id: sessionId }
    const env = tgEnv('codex')
    const first = runShim(CODEX_HOOK_SCRIPT, cwd, 'pre_tool_use', [BUNDLE], payload, env)
    expect(first.status, `first read, stderr: ${first.stderr}`).toBe(0)
    const second = runShim(CODEX_HOOK_SCRIPT, cwd, 'pre_tool_use', [BUNDLE], payload, env)
    expect(second.status, `second read, stderr: ${second.stderr}`).toBe(0)
    const parsed = JSON.parse(second.stdout) as { decision?: string; reason?: string }
    expect(parsed.decision).toBe('block')
    expect(typeof parsed.reason).toBe('string')
  })

  it('copilot_cli: the real COPILOT_CLI_HOOK_SCRIPT shim reshapes a bundle deny into {permissionDecision:"deny"}', () => {
    // Native Copilot CLI wire shape confirmed directly against
    // COPILOT_CLI_HOOK_SCRIPT's own main()/TOOL_TO_TG/FILE_PATH_ARG_KEY: the
    // 'view' tool (Copilot's read-file tool, TOOL_TO_TG.view === 'Read') sends
    // its target path under toolArgs.path (FILE_PATH_ARG_KEY.view === 'path'),
    // and the top-level event arg is Copilot's own camelCase 'preToolUse', not
    // token-goat's internal 'pre_tool_use' -- COPILOT_TO_TG_EVENT translates it
    // internally before the shim's own inner call.
    const cwd = mkIsolated('tg-hookmatrix-copilotshim-')
    const sessionId = 'matrix-deny-copilot-shim'
    const filePath = path.join(cwd, 'large.bin')
    fs.writeFileSync(filePath, 'x'.repeat(60 * 1024))
    const payload = { sessionId, cwd, toolName: 'view', toolArgs: { path: filePath } }
    // The shim's own inner spawnSync call always sets
    // TOKEN_GOAT_HARNESS_OVERRIDE:'copilot_cli' itself (Object.assign({},
    // process.env, {...})), so this env only needs to supply the isolated
    // data/home dirs the shim process inherits into that inner call.
    const env = tgEnv('copilot_cli')
    const first = runShim(COPILOT_CLI_HOOK_SCRIPT, cwd, 'preToolUse', [BUNDLE], payload, env)
    expect(first.status, `first read, stderr: ${first.stderr}`).toBe(0)
    const second = runShim(COPILOT_CLI_HOOK_SCRIPT, cwd, 'preToolUse', [BUNDLE], payload, env)
    expect(second.status, `second read, stderr: ${second.stderr}`).toBe(0)
    const parsed = JSON.parse(second.stdout) as { permissionDecision?: string; permissionDecisionReason?: string }
    expect(parsed.permissionDecision).toBe('deny')
    expect(typeof parsed.permissionDecisionReason).toBe('string')
    expect((parsed.permissionDecisionReason ?? '').length).toBeGreaterThan(0)
  })
})

describe('hook-event x harness bundle matrix (pre_tool_use deny wire shape -- static verification for plugin-host-only harnesses)', () => {
  // pi/opencode/openclaw wire their hooks as plugin-API modules (callHook(...)
  // invoked from inside a framework-specific extension/plugin export, not a
  // standalone CLI script with a process.argv/stdin entry point like
  // CODEX_HOOK_SCRIPT/COPILOT_CLI_HOOK_SCRIPT above), so they cannot be spawned
  // and driven end-to-end without also faking each host framework's own plugin
  // API (pi's extension API, opencode's tool.execute.before, OpenClaw's plugin
  // hooks) -- a substantially larger undertaking than this matrix's scope.
  // Each script's own deny-reshaping logic is verified statically here
  // instead, against the exact source confirmed in each file directly.
  it('pi: reshapes a bundle deny into {block:true, reason} (PI_EXTENSION_SCRIPT)', () => {
    expect(PI_EXTENSION_SCRIPT).toMatch(/resp\["decision"\]\s*===\s*"block"/)
    expect(PI_EXTENSION_SCRIPT).toMatch(/block:\s*true/)
  })

  it('opencode: throws on a bundle deny -- no context-injection channel in tool.execute.before (OPENCODE_PLUGIN_SCRIPT)', () => {
    expect(OPENCODE_PLUGIN_SCRIPT).toMatch(/resp\.decision === "block"/)
    expect(OPENCODE_PLUGIN_SCRIPT).toMatch(/throw new Error\(resp\.reason/)
  })

  it('openclaw: reshapes a bundle deny into {block:true, blockReason} (OPENCLAW_PLUGIN_SCRIPT)', () => {
    expect(OPENCLAW_PLUGIN_SCRIPT).toMatch(/resp\["decision"\]\s*===\s*"block"/)
    expect(OPENCLAW_PLUGIN_SCRIPT).toMatch(/blockReason:\s*resp\["reason"\]/)
  })
})
