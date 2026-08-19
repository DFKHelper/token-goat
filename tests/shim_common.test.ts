/**
 * Guards the shared hook-shim fragments in src/bridges/shim_common.ts.
 *
 * The `require` preamble, the hook-event allowlist, `tryInProcess()` and the
 * `spawnSync` fallback ladder were byte-identical copies in four bridge shims,
 * so a fix to any of them had to land four times or silently diverge. These
 * tests fail if a shim re-inlines its own copy instead of interpolating the
 * shared fragment, and if a fragment stops being valid standalone JavaScript.
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { CLAUDECODE_HOOK_SCRIPT } from '../src/bridges/claudecode.js'
import { CODEX_HOOK_SCRIPT } from '../src/bridges/codex.js'
import { GROK_HOOK_SCRIPT } from '../src/bridges/grok.js'
import { KIMI_HOOK_SCRIPT } from '../src/bridges/kimi.js'
import { SHIM_REQUIRES, SHIM_SPAWN_LADDER, SHIM_TRY_IN_PROCESS, SHIM_VALID_HOOK_EVENTS } from '../src/bridges/shim_common.js'

const SHIMS: ReadonlyArray<readonly [string, string]> = [
  ['claudecode', CLAUDECODE_HOOK_SCRIPT],
  ['codex', CODEX_HOOK_SCRIPT],
  ['grok', GROK_HOOK_SCRIPT],
  ['kimi', KIMI_HOOK_SCRIPT],
]

// grok is absent here on purpose: it genuinely has no `session_start` event, so it keeps its own
// seven-entry allowlist rather than being forced through the shared eight-entry one.
const EVENT_ALLOWLIST_SHIMS = SHIMS.filter(([name]) => name !== 'grok')

// The assertions that actually guard the DRY fix read the bridge SOURCE, not the generated shim: a
// re-inlined copy is byte-identical in the output, so checking the output alone would pass happily
// while the duplication came back. The source must carry the `${SHIM_...}` interpolation and must
// not carry the fragment text itself.
const SOURCES: ReadonlyArray<readonly [string, string]> = SHIMS.map(([name]) => [
  name,
  readFileSync(new URL(`../src/bridges/${name}.ts`, import.meta.url), 'utf8'),
])

function assertInterpolates(name: string, source: string, constName: string, fragment: string): void {
  expect(source, `${name}.ts must interpolate \${${constName}} instead of inlining it`).toContain(`\${${constName}}`)
  expect(source, `${name}.ts must not inline a copy of ${constName}`).not.toContain(fragment)
}

describe('shared hook-shim fragments', () => {
  it.each(SOURCES)('%s.ts interpolates the shared require preamble rather than inlining it', (name, source) => {
    assertInterpolates(name, source, 'SHIM_REQUIRES', SHIM_REQUIRES)
  })

  it.each(SOURCES)('%s.ts interpolates the shared tryInProcess rather than inlining it', (name, source) => {
    assertInterpolates(name, source, 'SHIM_TRY_IN_PROCESS', SHIM_TRY_IN_PROCESS)
  })

  it.each(SOURCES)('%s.ts interpolates the shared spawnSync ladder rather than inlining it', (name, source) => {
    assertInterpolates(name, source, 'SHIM_SPAWN_LADDER', SHIM_SPAWN_LADDER)
  })

  it.each(SOURCES.filter(([name]) => name !== 'grok'))(
    '%s.ts interpolates the shared hook-event allowlist rather than inlining it',
    (name, source) => {
      assertInterpolates(name, source, 'SHIM_VALID_HOOK_EVENTS', SHIM_VALID_HOOK_EVENTS)
    },
  )

  it.each(SHIMS)('%s renders each shared fragment exactly once into the generated shim', (name, script) => {
    expect(script.split(SHIM_REQUIRES).length - 1, `${name} shim must render SHIM_REQUIRES once`).toBe(1)
    expect(script.split(SHIM_TRY_IN_PROCESS).length - 1, `${name} shim must render SHIM_TRY_IN_PROCESS once`).toBe(1)
    expect(script.split(SHIM_SPAWN_LADDER).length - 1, `${name} shim must render SHIM_SPAWN_LADDER once`).toBe(1)
    expect(script.split('async function tryInProcess(').length - 1, `${name} shim must define tryInProcess once`).toBe(1)
    expect(script.split('spawnSync(process.execPath').length - 1, `${name} shim must spawn the baked entry once`).toBe(1)
  })

  it.each(EVENT_ALLOWLIST_SHIMS)('%s renders the shared hook-event allowlist exactly once', (name, script) => {
    expect(script.split(SHIM_VALID_HOOK_EVENTS).length - 1, `${name} shim must render SHIM_VALID_HOOK_EVENTS once`).toBe(1)
  })

  it('grok keeps its own allowlist because it has no session_start event', () => {
    expect(GROK_HOOK_SCRIPT).not.toContain(SHIM_VALID_HOOK_EVENTS)
    expect(GROK_HOOK_SCRIPT).toContain("const VALID_HOOK_EVENTS = new Set([")
    expect(GROK_HOOK_SCRIPT).not.toContain("'session_start',")
  })

  it('fragments interpolate verbatim: no backtick or template placeholder can survive', () => {
    for (const [name, fragment] of [
      ['SHIM_REQUIRES', SHIM_REQUIRES],
      ['SHIM_VALID_HOOK_EVENTS', SHIM_VALID_HOOK_EVENTS],
      ['SHIM_TRY_IN_PROCESS', SHIM_TRY_IN_PROCESS],
      ['SHIM_SPAWN_LADDER', SHIM_SPAWN_LADDER],
    ] as const) {
      expect(fragment, `${name} must not contain a backtick`).not.toContain('`')
      expect(fragment, `${name} must not contain a template placeholder`).not.toContain('${')
    }
  })

  it('the shared allowlist covers every hook event the shims accept', () => {
    for (const event of ['pre_tool_use', 'post_tool_use', 'notification', 'stop', 'pre_compact', 'user_prompt_submit', 'subagent_stop', 'session_start']) {
      expect(SHIM_VALID_HOOK_EVENTS, `allowlist must contain ${event}`).toContain(`'${event}',`)
    }
  })
})
