/** `token-goat doctor --probe <harness>` starts a harness headless with a probe nonce set, and the session_start/user_prompt_submit hooks add a marker line to what they hand the model and leave a receipt saying they ran. The verdict per event is "reached the model", "hook ran but its output never reached the model", "hook did not run", or "not wired for this harness". The probe exists because every other doctor check stops at token-goat's own side of the wire: a hook that is installed, runs, and returns context can still be dropped by the harness, and nothing in this repo could tell. Provenance: the classifier cases are CAPTURE, the stdout of real headless runs with the marker hooks installed (claude 2.1.284 `-p`, codex-cli 0.158.0 `exec`, Copilot CLI 1.0.88 `-p`), including Copilot's timestamp run straight onto the session_start marker and codex answering with the prompt marker only because its SessionStart is unwired. The applyProbeMarker cases are HAND-DERIVED from the output contract in src/types.ts, and the probePassed cases from the four per-event verdicts. The end-to-end cases drive runProbe over a stand-in harness that runs the built bundle's real `hook` command, so the spawn, the child env, the hooks, the marker and the receipt directory are all the shipping path; only the model is replaced, by a script that repeats (or withholds) what the hooks returned. */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { classifyProbeEvent, formatProbeReport, isProbeHarness, PROBE_PROMPT, probeEnv, probePassed, runProbe } from '../src/doctor_probe.js'
import { applyProbeMarker, PROBE_NONCE_ENV, probeDir, probeMarkerLine } from '../src/probe_marker.js'
import { relayInProcess } from '../src/relay.js'
import { HOOK_PROBE_ENV } from '../src/stats.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')
const NONCE = '0123456789abcdef0123'

describe('applyProbeMarker', () => {
  const env = { [PROBE_NONCE_ENV]: NONCE }

  it('leaves output alone when no probe is running', () => {
    const out = { hookType: 'context', context: 'hello' } as const
    expect(applyProbeMarker('session_start', out, {})).toBe(out)
  })

  it('ignores a nonce that is not 16-32 lowercase hex, so it can never name a path', () => {
    const out = { hookType: 'pass' } as const
    for (const bad of ['../../etc', 'ABCDEF0123456789', 'abc', `${NONCE}${NONCE}`]) {
      expect(applyProbeMarker('session_start', out, { [PROBE_NONCE_ENV]: bad })).toBe(out)
    }
  })

  it('leaves events the probe does not cover alone', () => {
    const out = { hookType: 'pass' } as const
    expect(applyProbeMarker('pre_tool_use', out, env)).toBe(out)
  })

  it('appends the marker to existing context', () => {
    const out = applyProbeMarker('session_start', { hookType: 'context', context: 'routing reminder' }, env)
    expect(out).toEqual({ hookType: 'context', context: `routing reminder\n\n${probeMarkerLine(NONCE, 'S')}` })
  })

  it('turns a pass into context carrying only the marker, keeping the user notice', () => {
    expect(applyProbeMarker('user_prompt_submit', { hookType: 'pass' }, env)).toEqual({ hookType: 'context', context: probeMarkerLine(NONCE, 'P') })
    expect(applyProbeMarker('user_prompt_submit', { hookType: 'pass', notice: 'saved 3k' }, env)).toEqual({ hookType: 'context', context: probeMarkerLine(NONCE, 'P'), notice: 'saved 3k' })
  })

  it('leaves a deny alone', () => {
    const out = { hookType: 'deny', message: 'no' } as const
    expect(applyProbeMarker('user_prompt_submit', out, env)).toBe(out)
  })

  it('writes a receipt per event under the data directory', () => {
    const nonce = 'fedcba9876543210'
    applyProbeMarker('session_start', { hookType: 'pass' }, { [PROBE_NONCE_ENV]: nonce })
    expect(existsSync(join(probeDir(), `${nonce}.S`))).toBe(true)
    expect(existsSync(join(probeDir(), `${nonce}.P`))).toBe(false)
  })
})

describe('relay carries the marker on the real output path', () => {
  const saved = { override: process.env['TOKEN_GOAT_HARNESS_OVERRIDE'], session: process.env['CLAUDE_CODE_SESSION_ID'], nonce: process.env[PROBE_NONCE_ENV] }
  afterEach(() => {
    for (const [key, value] of [['TOKEN_GOAT_HARNESS_OVERRIDE', saved.override], ['CLAUDE_CODE_SESSION_ID', saved.session], [PROBE_NONCE_ENV, saved.nonce]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('puts the marker in the additionalContext Claude Code reads', async () => {
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'claudecode'
    process.env[PROBE_NONCE_ENV] = NONCE
    const raw = await relayInProcess('user_prompt_submit', JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'probe-relay', cwd: process.cwd(), prompt: 'hi' }))
    const parsed = JSON.parse(raw) as { hookSpecificOutput?: { additionalContext?: string } }
    expect(parsed.hookSpecificOutput?.additionalContext ?? '').toContain(probeMarkerLine(NONCE, 'P'))
  })
})

describe('classifyProbeEvent on captured harness output', () => {
  const none = new Set<string>()
  const both = new Set(['S', 'P'])

  it('claude -p repeats both markers', () => {
    const stdout = `token-goat probe marker: ${NONCE}-S\ntoken-goat probe marker: ${NONCE}-P\n`
    expect(classifyProbeEvent({ wired: true, nonce: NONCE, tag: 'S', stdout, receipts: both })).toBe('reached')
    expect(classifyProbeEvent({ wired: true, nonce: NONCE, tag: 'P', stdout, receipts: both })).toBe('reached')
  })

  it('codex exec repeats the prompt marker only, and its session start is not wired', () => {
    const nonce = 'aaaaaaaaaaaaaaaa1111'
    const stdout = `token-goat probe marker: ${nonce}-P\n`
    expect(classifyProbeEvent({ wired: false, nonce, tag: 'S', stdout, receipts: new Set(['P']) })).toBe('not_wired')
    expect(classifyProbeEvent({ wired: true, nonce, tag: 'P', stdout, receipts: new Set(['P']) })).toBe('reached')
  })

  it('copilot -p runs a timestamp onto the session_start marker, and it still counts', () => {
    const nonce = 'bbbbbbbbbbbbbbbb2222'
    const stdout = `token-goat probe marker: ${nonce}-S2026-09-29T04:19:52.132-05:00\ntoken-goat probe marker: ${nonce}-P\n`
    expect(classifyProbeEvent({ wired: true, nonce, tag: 'S', stdout, receipts: both })).toBe('reached')
  })

  it('tells a hook that ran from one that did not when the model never saw either', () => {
    expect(classifyProbeEvent({ wired: true, nonce: NONCE, tag: 'S', stdout: 'NONE', receipts: both })).toBe('fired_not_delivered')
    expect(classifyProbeEvent({ wired: true, nonce: NONCE, tag: 'S', stdout: 'NONE', receipts: none })).toBe('not_fired')
  })
})

describe('probeEnv', () => {
  it('drops the markers of the session it was started from and adds the nonce and the stats flag', () => {
    const env = probeEnv(NONCE, { PATH: 'p', ANTHROPIC_API_KEY: 'k', TERM_PROGRAM: 'claude-code', CLAUDE_CODE_SESSION_ID: 's', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_VERSION: '2', CODEX_SESSION_ID: 'c', TOKEN_GOAT_HARNESS_OVERRIDE: 'codex' })
    expect(env).toEqual({ PATH: 'p', ANTHROPIC_API_KEY: 'k', [PROBE_NONCE_ENV]: NONCE, [HOOK_PROBE_ENV]: '1' })
  })

  it('keeps a TERM_PROGRAM some other terminal set', () => {
    expect(probeEnv(NONCE, { TERM_PROGRAM: 'vscode' })['TERM_PROGRAM']).toBe('vscode')
  })
})

describe('isProbeHarness', () => {
  it('accepts only harnesses with a captured headless mode', () => {
    expect(['claudecode', 'codex', 'copilot_cli'].every(isProbeHarness)).toBe(true)
    expect(isProbeHarness('opencode')).toBe(false)
    expect(isProbeHarness('toString')).toBe(false)
  })
})

describe('probePassed', () => {
  const report = (status: 'ok' | 'failed', session: 'reached' | 'not_wired' | 'not_fired', prompt: 'reached' | 'fired_not_delivered') => ({
    harness: 'codex' as const, command: 'codex exec', status, exitCode: status === 'ok' ? 0 : 1,
    events: [{ event: 'session_start' as const, result: session }, { event: 'user_prompt_submit' as const, result: prompt }],
  })

  it('passes codex, whose session start is not wired, when its prompt hook reaches the model', () => {
    expect(probePassed(report('ok', 'not_wired', 'reached'))).toBe(true)
  })

  it('fails on any event that ran without reaching the model, or a run that did not finish', () => {
    expect(probePassed(report('ok', 'not_fired', 'reached'))).toBe(false)
    expect(probePassed(report('ok', 'reached', 'fired_not_delivered'))).toBe(false)
    expect(probePassed(report('failed', 'reached', 'reached'))).toBe(false)
  })
})

describe('runProbe end to end through the built bundle', () => {
  let harnessPath = ''
  let cwd = ''

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-probe-harness-'))
    cwd = join(dir, 'proj')
    mkdirSync(cwd)
    // Stand-in for `claude -p`: runs the installed-style hook command for each event through the real bundle, then answers the way the mode says the model would.
    const script = [
      "import { spawnSync } from 'node:child_process'",
      `const bundle = ${JSON.stringify(BUNDLE)}`,
      `if (process.argv[2] !== '-p' || process.argv[3] !== ${JSON.stringify(PROBE_PROMPT)}) { console.error('prompt mangled: ' + JSON.stringify(process.argv.slice(2))); process.exit(3) }`,
      "const mode = process.env.FAKE_MODE ?? 'echo'",
      'const contexts = []',
      "if (mode !== 'skip') {",
      "  for (const [event, payload] of [['session_start', { hook_event_name: 'SessionStart', source: 'startup' }], ['user_prompt_submit', { hook_event_name: 'UserPromptSubmit', prompt: process.argv[3] }]]) {",
      "    const res = spawnSync(process.execPath, [bundle, 'hook', event, '--harness', 'claudecode'], { input: JSON.stringify({ ...payload, session_id: 'probe-e2e', cwd: process.cwd() }), encoding: 'utf8' })",
      "    contexts.push(JSON.parse(res.stdout || '{}').hookSpecificOutput?.additionalContext ?? '')",
      '  }',
      '}',
      "const lines = contexts.join('\\n').split('\\n').filter((l) => l.startsWith('token-goat probe marker'))",
      "console.log(mode === 'echo' && lines.length > 0 ? lines.join('\\n') : 'NONE')",
    ].join('\n')
    writeFileSync(join(dir, 'fake.mjs'), script)
    if (process.platform === 'win32') {
      harnessPath = join(dir, 'claude.cmd')
      writeFileSync(harnessPath, `@"${process.execPath}" "${join(dir, 'fake.mjs')}" %*\r\n`)
    } else {
      harnessPath = join(dir, 'claude')
      writeFileSync(harnessPath, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'fake.mjs')}" "$@"\n`)
      chmodSync(harnessPath, 0o755)
    }
  })

  function probe(mode: string) {
    const saved = process.env['FAKE_MODE']
    process.env['FAKE_MODE'] = mode
    try {
      return runProbe('claudecode', { cwd, resolve: () => harnessPath, timeoutMs: 60_000 })
    } finally {
      if (saved === undefined) delete process.env['FAKE_MODE']
      else process.env['FAKE_MODE'] = saved
    }
  }

  it('reports both events as reaching the model when the model repeats the markers', () => {
    const report = probe('echo')
    expect(report.detail ?? '', 'the stand-in harness failed').toBe('')
    expect(report.status).toBe('ok')
    expect(report.events).toEqual([{ event: 'session_start', result: 'reached' }, { event: 'user_prompt_submit', result: 'reached' }])
    expect(probePassed(report)).toBe(true)
  })

  it('reports hooks that ran but whose output the model never saw', () => {
    const report = probe('swallow')
    expect(report.events.map((e) => e.result)).toEqual(['fired_not_delivered', 'fired_not_delivered'])
    expect(probePassed(report)).toBe(false)
    expect(formatProbeReport(report)).toContain('hook ran, but the model never saw its output')
  })

  it('reports hooks that never ran', () => {
    const report = probe('skip')
    expect(report.events.map((e) => e.result)).toEqual(['not_fired', 'not_fired'])
    expect(probePassed(report)).toBe(false)
  })

  it('leaves no receipts behind', () => {
    const list = (): string[] => (existsSync(probeDir()) ? readdirSync(probeDir()).sort() : [])
    const before = list()
    const report = probe('echo')
    expect(report.events.map((e) => e.result), 'no receipts were written, so their removal proves nothing').toEqual(['reached', 'reached'])
    expect(list()).toEqual(before)
  })

  it('reports a harness that is not installed without running anything', () => {
    const report = runProbe('codex', { resolve: () => null })
    expect(report.status).toBe('not_installed')
    expect(report.events).toEqual([{ event: 'session_start', result: 'not_wired' }, { event: 'user_prompt_submit', result: 'not_fired' }])
    expect(formatProbeReport(report)).toContain('codex is not on PATH')
  })
})

describe('doctor --probe on the built bundle', () => {
  it('refuses a harness it has no headless probe for, naming the ones it has', () => {
    const res = spawnSync(process.execPath, [BUNDLE, 'doctor', '--probe', 'opencode'], { encoding: 'utf8' })
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('supported: claudecode, codex, copilot_cli')
  })
})
