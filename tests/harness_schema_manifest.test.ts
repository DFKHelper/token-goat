import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createHash } from 'node:crypto'

import { COPILOT_CLI_HOOK_SCRIPT } from '../src/bridges/copilot_cli.js'
import { runAdapter } from '../src/hook_adapters.js'
import { copilotCapture } from './fixtures/copilot_cli_1_0_88.js'

/**
 * Cross-checks the Copilot shim against a shape manifest derived from Copilot's own published
 * TypeScript declarations (`schemas/copilot_cli.hooks.json`, produced by
 * `scripts/extract_harness_schema.mjs`).
 *
 * Why this file exists, concretely. Four separate features have shipped from this repo wired,
 * tested, green, and doing nothing at runtime, all with one mechanism: the repo restated its belief
 * about a harness's wire format in a fixture, the belief was wrong, and the fixture agreed with the
 * bug. `tests/hook_event_harness_matrix.test.ts` was written to close that gap and does not: driving
 * all four historical defects back in as mutations leaves it green on all four, because its
 * `toolPayload` sends Copilot a Claude Code shaped payload that Copilot never sends.
 *
 * The manifest is not a belief -- it is read out of the vendor's declarations. So the check here is
 * *totality*, not shape: every REQUIRED field the vendor declares on a hook input must be accounted
 * for, either by a mapping onto the canonical field the bridge builds, or by an explicit entry in
 * `DELIBERATELY_UNMAPPED` giving a reason. A vendor field with neither fails this test. That is the
 * property that makes the `error`-field defect impossible to reintroduce: `error` is declared
 * required on `PostToolUseFailureHookInput`, so dropping it from the builder leaves it unaccounted.
 *
 * Note the manifest is derived, not vendored: Copilot's `types.d.ts` carries no license grant and
 * this repo is PolyForm Noncommercial, so field names and types are extracted and no vendor source
 * is redistributed.
 */

const MANIFEST_PATH = path.join(__dirname, '..', 'schemas', 'copilot_cli.hooks.json')

interface FieldSpec {
  type: string
  optional: boolean
}
interface Manifest {
  harness: string
  sourceVersion: string
  hooks: Record<string, Record<string, FieldSpec>>
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest

/**
 * Copilot hook events this bridge wires, and the vendor interface that describes each one's
 * payload. Only events with a declared interface appear: `preCompact` has no `PreCompactHookInput`
 * in the declarations at all, which is consistent with the bridge's own note that Copilot's
 * preCompact is notification-only, and there is nothing to cross-check for it here.
 */
const EVENT_TO_INTERFACE: Record<string, string> = {
  preToolUse: 'PreToolUseHookInput',
  postToolUse: 'PostToolUseHookInput',
  postToolUseFailure: 'PostToolUseFailureHookInput',
  sessionStart: 'SessionStartHookInput',
  userPromptSubmitted: 'UserPromptSubmittedHookInput',
  agentStop: 'AgentStopHookInput',
}

/** Vendor field name -> the key the shim's canonical payload carries it under. */
const VENDOR_TO_CANONICAL: Record<string, string> = {
  sessionId: 'session_id',
  workingDirectory: 'cwd',
  toolName: 'tool_name',
  toolArgs: 'tool_input',
  toolResult: 'tool_response',
  error: 'error',
  prompt: 'prompt',
}

/**
 * Vendor fields the bridge deliberately does not carry, each with the reason. An entry here is a
 * decision on the record, which is the point: the failure this file exists to prevent is a field
 * disappearing without anyone deciding anything.
 */
const DELIBERATELY_UNMAPPED: Record<string, string> = {
  timestamp:
    'token-goat stamps its own receipt time when it records a stat; the harness emit time is not used by any handler.',
  source:
    'Copilot reports how the session began ("startup" | "resume" | "new"). sessionStartHandler does not branch on it -- it emits the same index/hint output regardless -- so forwarding it would add a field no handler reads. Revisit if a source-conditional hint is ever added.',
}

describe('Copilot hook-input shape manifest', () => {
  it('is pinned to a real extraction rather than an empty or truncated one', () => {
    // A parser that quietly recognizes nothing would make every assertion below vacuously true.
    expect(Object.keys(manifest.hooks).length).toBeGreaterThanOrEqual(6)
    expect(manifest.hooks['PostToolUseFailureHookInput']?.['error']).toEqual({
      type: 'string',
      optional: false,
    })
  })

  it('accounts for every required vendor field on every hook event the bridge wires', () => {
    const unaccounted: string[] = []
    for (const [event, iface] of Object.entries(EVENT_TO_INTERFACE)) {
      const fields = manifest.hooks[iface]
      expect(fields, `${iface} missing from the manifest -- EVENT_TO_INTERFACE is stale`).toBeDefined()
      for (const [name, spec] of Object.entries(fields as Record<string, FieldSpec>)) {
        if (spec.optional) continue
        if (name in VENDOR_TO_CANONICAL) continue
        if (name in DELIBERATELY_UNMAPPED) continue
        unaccounted.push(`${event}/${iface}.${name}: ${spec.type}`)
      }
    }
    expect(
      unaccounted,
      'Copilot declares these required hook-input fields and the bridge neither maps nor documents ' +
        'them. Add a VENDOR_TO_CANONICAL entry if a handler needs the field, or a ' +
        'DELIBERATELY_UNMAPPED entry with a reason if not. Silently ignoring one is how the ' +
        'postToolUseFailure `error` field was dropped for a whole release.',
    ).toEqual([])
  })

  it('actually delivers each mapped field through the real shim, not just on paper', () => {
    // The mapping table above is itself a belief until something drives the shipping path with it.
    const cwd = mkIsolated()
    const capturePath = path.join(cwd, 'captured.json')
    writeCaptureBin(cwd, capturePath)
    const env = { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }

    const payload = {
      sessionId: 'sess-42',
      timestamp: '2026-08-23T00:00:00.000Z',
      workingDirectory: cwd,
      toolName: 'bash',
      toolArgs: { command: 'nope' },
      error: 'command not found: nope',
    }
    runShim('postToolUseFailure', JSON.stringify(payload), cwd, env)
    const canonical = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as Record<string, unknown>

    expect(canonical['session_id']).toBe('sess-42')
    expect(canonical['tool_name']).toBe('Bash')
    expect(canonical['error']).toBe('command not found: nope')
    // The SDK declares `workingDirectory`; the shim reads it first, then `cwd`, which is what the CLI's command hooks send (see the capture test below).
    expect(canonical['cwd']).toBe(cwd)
  })

  it('carries the userPromptSubmitted prompt text, which the prompt handler gates every branch on', () => {
    const cwd = mkIsolated()
    const capturePath = path.join(cwd, 'captured.json')
    writeCaptureBin(cwd, capturePath)
    const env = { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }

    runShim(
      'userPromptSubmitted',
      JSON.stringify({
        sessionId: 'sess-43',
        timestamp: '2026-08-23T00:00:00.000Z',
        workingDirectory: cwd,
        prompt: 'summarize the failing test',
      }),
      cwd,
      env,
    )
    const canonical = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as Record<string, unknown>
    // hooks_session.ts's userPromptSubmitHandler reads event.raw['prompt'] and returns early on
    // '', so a missing key here is not a degraded hint -- it is every prompt-keyed branch dead.
    expect(canonical['prompt']).toBe('summarize the failing test')
    expect(canonical['cwd']).toBe(cwd)
  })
})

/**
 * The key Copilot CLI's command hooks really send for the working directory is `cwd`, not the SDK's `workingDirectory`: every payload Copilot CLI 1.0.88 sent in the tg-captures run carried `cwd` and none carried `workingDirectory`.
 *
 * PROVENANCE: CAPTURE. tests/fixtures/copilot_cli_1_0_88/C1a-005-postToolUse-view.json and C7-007-userPromptSubmitted.json, the stdin Copilot CLI 1.0.88 handed a hook (see tests/fixtures/copilot_cli_1_0_88.ts). The payload's `cwd` is set to a directory different from the one the shim runs in, so a builder that ignored `cwd` and fell back to process.cwd() fails here instead of being accidentally right, as it would be when Copilot spawns the hook in the project directory.
 */
describe('Copilot CLI 1.0.88 working directory (CAPTURE C1a, C7)', () => {
  const fallbackId = (dir: string): string => 'copilot-' + createHash('sha256').update(dir).digest('hex').slice(0, 16)

  function captured(name: string, proj: string, dropSessionId: boolean): Record<string, unknown> {
    const payload = copilotCapture(name, { proj })
    expect(payload['cwd']).toBe(proj)
    expect(payload).not.toHaveProperty('workingDirectory')
    if (dropSessionId) delete payload['sessionId']
    return payload
  }

  it('the shim carries the captured `cwd` and derives the fallback session id from it', () => {
    const proj = mkIsolated()
    const shimDir = mkIsolated()
    const capturePath = path.join(shimDir, 'captured.json')
    writeCaptureBin(shimDir, capturePath)
    const env = { ...process.env, PATH: shimDir + path.delimiter + (process.env['PATH'] ?? '') }
    runShim('postToolUse', JSON.stringify(captured('C1a-005-postToolUse-view', proj, true)), shimDir, env)
    const canonical = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as Record<string, unknown>
    expect(canonical['cwd']).toBe(proj)
    expect(canonical['session_id']).toBe(fallbackId(proj))
    expect(canonical['session_id']).not.toBe(fallbackId(shimDir))
  })

  it('the in-process adapter carries the captured `cwd` the same way', async () => {
    const proj = mkIsolated()
    const seen: unknown[] = []
    const io = { early: (): number => 0, relay: (_event: string, payload: unknown): Promise<string> => (seen.push(payload), Promise.resolve('{}')) }
    await runAdapter('copilot_cli', { event: 'userPromptSubmitted', input: JSON.stringify(captured('C7-007-userPromptSubmitted', proj, false)) }, io)
    await runAdapter('copilot_cli', { event: 'postToolUse', input: JSON.stringify(captured('C1a-005-postToolUse-view', proj, true)) }, io)
    const [prompt, post] = seen as Array<Record<string, unknown>>
    expect(prompt?.['cwd']).toBe(proj)
    expect(prompt?.['session_id']).toBe('7c0de7c7-0000-4000-8000-00000000c007')
    expect(post?.['cwd']).toBe(proj)
    expect(post?.['session_id']).toBe(fallbackId(proj))
  })
})

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function mkIsolated(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'tg-schema-manifest-'))
  tempDirs.push(dir)
  return dir
}

/** A stand-in `token-goat` on PATH that records the canonical payload the shim hands it. */
function writeCaptureBin(cwd: string, capturePath: string): void {
  const escaped = capturePath.replace(/\\/g, '\\\\')
  const script =
    process.platform === 'win32'
      ? `@echo off\r\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${escaped}"\r\necho {}\r\n`
      : `#!/bin/sh\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath}"\necho '{}'\n`
  const binPath = path.join(cwd, process.platform === 'win32' ? 'token-goat.cmd' : 'token-goat')
  fs.writeFileSync(binPath, script, 'utf8')
  if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755)
}

function runShim(eventName: string, stdin: string, cwd: string, env: NodeJS.ProcessEnv): void {
  const scriptPath = path.join(cwd, 'shim.js')
  fs.writeFileSync(scriptPath, COPILOT_CLI_HOOK_SCRIPT, 'utf8')
  spawnSync(process.execPath, [scriptPath, eventName], {
    cwd,
    input: stdin,
    encoding: 'utf8',
    timeout: 15000,
    env,
  })
}
