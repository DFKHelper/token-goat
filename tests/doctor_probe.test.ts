/** `token-goat doctor --probe <harness>` starts a harness headless with a probe nonce set, and the session_start/user_prompt_submit hooks add a marker line to what they hand the model and leave a receipt saying they ran. The verdict per event is "reached the model", "hook ran but its output never reached the model", "hook did not run", or "not wired for this harness". The probe exists because every other doctor check stops at token-goat's own side of the wire: a hook that is installed, runs, and returns context can still be dropped by the harness, and nothing in this repo could tell. Provenance: the classifier cases are CAPTURE, the stdout of real headless runs with the marker hooks installed (claude 2.1.284 `-p`, codex-cli 0.158.0 `exec`, Copilot CLI 1.0.88 `-p`), including Copilot's timestamp run straight onto the session_start marker and codex answering with the prompt marker only because its SessionStart is unwired. The failure-cause cases read tests/fixtures/doctor_probe, CAPTURE of the real stderr or stdout of claude 2.1.296 and codex-cli 0.159.3 run with a bad flag, logged out, or outside a trusted directory (rows in tests/fixtures/PROVENANCE.tsv); no rate-limit pattern ships because none could be captured. The applyProbeMarker cases are HAND-DERIVED from the output contract in src/types.ts, and the probePassed cases from the four per-event verdicts. The end-to-end cases drive runProbe over a stand-in harness that runs the built bundle's real `hook` command, so the spawn, the child env, the hooks, the marker and the receipt directory are all the shipping path; only the model is replaced, by a script that repeats (or withholds) what the hooks returned. */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { classifyProbeEvent, formatProbeReport, isProbeHarness, PROBE_PROMPT, probeCause, probeEnv, probePassed, probeVerdict, runProbe } from '../src/doctor_probe.js'
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
    expect(classifyProbeEvent({ wired: true, nonce: NONCE, tag: 'S', stdout, receipts: both, modelReplied: true })).toBe('reached')
    expect(classifyProbeEvent({ wired: true, nonce: NONCE, tag: 'P', stdout, receipts: both, modelReplied: true })).toBe('reached')
  })

  it('codex exec repeats the prompt marker only, and its session start is not wired', () => {
    const nonce = 'aaaaaaaaaaaaaaaa1111'
    const stdout = `token-goat probe marker: ${nonce}-P\n`
    expect(classifyProbeEvent({ wired: false, nonce, tag: 'S', stdout, receipts: new Set(['P']), modelReplied: true })).toBe('not_wired')
    expect(classifyProbeEvent({ wired: true, nonce, tag: 'P', stdout, receipts: new Set(['P']), modelReplied: true })).toBe('reached')
  })

  it('copilot -p runs a timestamp onto the session_start marker, and it still counts', () => {
    const nonce = 'bbbbbbbbbbbbbbbb2222'
    const stdout = `token-goat probe marker: ${nonce}-S2026-09-29T04:19:52.132-05:00\ntoken-goat probe marker: ${nonce}-P\n`
    expect(classifyProbeEvent({ wired: true, nonce, tag: 'S', stdout, receipts: both, modelReplied: true })).toBe('reached')
  })

  it('tells a hook that ran from one that did not when the model never saw either', () => {
    expect(classifyProbeEvent({ wired: true, nonce: NONCE, tag: 'S', stdout: 'NONE', receipts: both, modelReplied: true })).toBe('fired_not_delivered')
    expect(classifyProbeEvent({ wired: true, nonce: NONCE, tag: 'S', stdout: 'NONE', receipts: none, modelReplied: true })).toBe('not_fired')
  })

  it('marks events inconclusive when the model never replied with the nonce', () => {
    const stdout = 'some response but no nonce'
    expect(classifyProbeEvent({ wired: true, nonce: NONCE, tag: 'S', stdout, receipts: both, modelReplied: false })).toBe('inconclusive')
    expect(classifyProbeEvent({ wired: true, nonce: NONCE, tag: 'P', stdout, receipts: none, modelReplied: false })).toBe('inconclusive')
  })

  it('marks not_wired events as not_wired even when model did not reply', () => {
    expect(classifyProbeEvent({ wired: false, nonce: NONCE, tag: 'S', stdout: '', receipts: both, modelReplied: false })).toBe('not_wired')
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
  const report = (status: 'ok' | 'failed', session: 'reached' | 'not_wired' | 'not_fired' | 'inconclusive', prompt: 'reached' | 'fired_not_delivered' | 'inconclusive') => ({
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

describe('probeVerdict', () => {
  const report = (status: 'ok' | 'failed' | 'timeout', session: 'reached' | 'not_wired' | 'not_fired' | 'inconclusive', prompt: 'reached' | 'fired_not_delivered' | 'inconclusive') => ({
    harness: 'claudecode' as const, command: 'claude -p', status, exitCode: status === 'ok' ? 0 : 1,
    events: [{ event: 'session_start' as const, result: session }, { event: 'user_prompt_submit' as const, result: prompt }],
  })

  it('passes when every wired event reached the model and the run finished cleanly', () => {
    expect(probeVerdict(report('ok', 'reached', 'reached'))).toBe('pass')
    expect(probeVerdict(report('ok', 'not_wired', 'reached'))).toBe('pass')
  })

  it('fails when a wired event did not reach the model, but the harness ran', () => {
    expect(probeVerdict(report('ok', 'not_fired', 'reached'))).toBe('fail')
    expect(probeVerdict(report('ok', 'reached', 'fired_not_delivered'))).toBe('fail')
  })

  it('fails a run that did not finish when its events were still judged, and calls it inconclusive when they were not', () => {
    expect(probeVerdict(report('timeout', 'reached', 'reached'))).toBe('fail')
    expect(probeVerdict(report('failed', 'not_fired', 'fired_not_delivered'))).toBe('fail')
    expect(probeVerdict(report('failed', 'inconclusive', 'inconclusive'))).toBe('inconclusive')
    expect(probeVerdict(report('timeout', 'inconclusive', 'inconclusive'))).toBe('inconclusive')
  })

  it('is inconclusive when the model never replied with the nonce', () => {
    expect(probeVerdict(report('ok', 'inconclusive', 'reached'))).toBe('inconclusive')
    expect(probeVerdict(report('ok', 'reached', 'inconclusive'))).toBe('inconclusive')
  })
})

describe('probeCause on captured harness failures', () => {
  const fixture = (name: string): string => readFileSync(join(process.cwd(), 'tests', 'fixtures', 'doctor_probe', name), 'utf8')

  it.each([
    ['claude_not_logged_in.stdout', 'the harness is not logged in'],
    ['claude_unknown_option.stderr', 'the harness rejected a command-line flag'],
    ['codex_unexpected_argument.stderr', 'the harness rejected a command-line flag'],
    ['codex_untrusted_directory.stderr', 'the harness refused to run in an untrusted directory'],
    ['copilot_no_authentication.stderr', 'the harness is not logged in'],
    ['copilot_access_denied.stderr', 'the account or its organization policy denied the harness'],
  ])('names the cause in %s', (name, cause) => {
    expect(probeCause(fixture(name))?.cause).toBe(cause)
  })

  // HAND-DERIVED: each captured spelling alone, so dropping either alternative of the login pattern is caught; the fixtures above hold one each.
  it.each(['Not logged in · Please run /login', 'Error: No authentication information found.'])('names a login cause for %s alone', (text) => {
    expect(probeCause(text)?.cause).toBe('the harness is not logged in')
  })

  // HAND-DERIVED: a failing token-goat hook prints its own `unknown option` and a harness may echo it mid-line or after a prefix; none of these is the harness rejecting its own flag, so none may name a cause.
  it.each([
    "token-goat: unknown option '--top'",
    "hook failed: error: unknown option '--top'",
    'the docs say to run /login if prompted',
    'hook said: Not logged in · Please run /login',
    'wrapper: Error: No authentication information found.',
    "unrecognized subcommand 'x'",
  ])('does not read %s as a harness cause', (text) => {
    expect(probeCause(text)).toBeNull()
  })

  it('finds a cause that is not in the last five lines of the output', () => {
    const output = [fixture('claude_unknown_option.stderr').trim(), ...Array.from({ length: 12 }, (_, i) => `later line ${i}`)].join('\n')
    expect(probeCause(output)?.cause).toBe('the harness rejected a command-line flag')
  })

  it('names no cause for output it has no captured pattern for', () => {
    expect(probeCause('Error: connection reset by peer')).toBeNull()
  })

  it('prints the cause and its remedy above the event lines of an inconclusive report', () => {
    const report = { harness: 'claudecode' as const, command: 'claude -p', status: 'failed' as const, exitCode: 1, detail: fixture('claude_not_logged_in.stdout').trim(), events: [{ event: 'session_start' as const, result: 'inconclusive' as const }, { event: 'user_prompt_submit' as const, result: 'inconclusive' as const }] }
    const lines = formatProbeReport(report).split('\n')
    expect(lines[1]).toBe('  [WARN] the harness exited with code 1')
    expect(lines[2]).toBe('  Probe inconclusive: the harness is not logged in. sign in to the harness, then run the probe again')
    expect(lines[3]).toContain('[??]')
  })

  it('says only that the harness failed when the output matches no cause', () => {
    const report = { harness: 'codex' as const, command: 'codex exec', status: 'failed' as const, exitCode: 1, detail: 'boom', events: [{ event: 'user_prompt_submit' as const, result: 'inconclusive' as const }] }
    expect(formatProbeReport(report)).toContain('Probe inconclusive: the harness failed before the model replied; see its output below')
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
      "if (mode === 'die') { console.error(\"error: unknown option '--x'\"); process.exit(1) }",
      "if (mode === 'loggedout') { console.log('Not logged in · Please run /login'); process.exit(1) }",
      "if (mode === 'hangloggedout') { console.log('Not logged in · Please run /login'); setTimeout(() => process.exit(1), 8000); await new Promise(() => {}) }",
      "if (mode === 'hang') { setTimeout(() => process.exit(0), 8000); await new Promise(() => {}) }",
      "if (mode === 'blocked') process.exit(1)",
      "if (mode === 'dieburied') { console.error(\"error: unknown option '--x'\"); for (let i = 0; i < 8; i++) console.error('usage line ' + i); process.exit(1) }",
      'const contexts = []',
      "if (mode !== 'skip') {",
      "  for (const [event, payload] of [['session_start', { hook_event_name: 'SessionStart', source: 'startup' }], ['user_prompt_submit', { hook_event_name: 'UserPromptSubmit', prompt: process.argv[3] }]]) {",
      "    const res = spawnSync(process.execPath, [bundle, 'hook', event, '--harness', 'claudecode'], { input: JSON.stringify({ ...payload, session_id: 'probe-e2e', cwd: process.cwd() }), encoding: 'utf8' })",
      "    contexts.push(JSON.parse(res.stdout || '{}').hookSpecificOutput?.additionalContext ?? '')",
      '  }',
      '}',
      "const lines = contexts.join('\\n').split('\\n').filter((l) => l.startsWith('token-goat probe marker'))",
      "console.log(mode === 'echo' && lines.length > 0 ? lines.join('\\n') : mode === 'silent' ? '' : 'NONE')",
      "process.exitCode = mode === 'swallowfail' ? 1 : 0",
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

  function probe(mode: string, timeoutMs = 60_000) {
    const saved = process.env['FAKE_MODE']
    process.env['FAKE_MODE'] = mode
    try {
      return runProbe('claudecode', { cwd, resolve: () => harnessPath, timeoutMs })
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

  it('still judges a clean exit that printed nothing, by its receipts', () => {
    const report = probe('silent')
    expect(report.status).toBe('ok')
    expect(report.events.map((e) => e.result)).toEqual(['fired_not_delivered', 'fired_not_delivered'])
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

  it('calls a run that died before any reply inconclusive, with the cause from its stderr', () => {
    const report = probe('die')
    expect(report.status).toBe('failed')
    expect(report.events.map((e) => e.result)).toEqual(['inconclusive', 'inconclusive'])
    expect(probeVerdict(report)).toBe('inconclusive')
    expect(formatProbeReport(report)).toContain('Probe inconclusive: the harness rejected a command-line flag.')
  })

  it('finds the cause when the harness printed eight more lines after it', () => {
    const report = probe('dieburied')
    expect(report.detail).not.toContain('unknown option')
    expect(report.events.map((e) => e.result)).toEqual(['inconclusive', 'inconclusive'])
    expect(formatProbeReport(report)).toContain('Probe inconclusive: the harness rejected a command-line flag.')
  })

  it('does not take a not-logged-in notice on stdout for a model reply', () => {
    const report = probe('loggedout')
    expect(report.events.map((e) => e.result)).toEqual(['inconclusive', 'inconclusive'])
    expect(formatProbeReport(report)).toContain('Probe inconclusive: the harness is not logged in.')
  })

  it('keeps blaming the hooks when a run exits non-zero after the model replied', () => {
    const report = probe('swallowfail')
    expect(report.status).toBe('failed')
    expect(report.events.map((e) => e.result)).toEqual(['fired_not_delivered', 'fired_not_delivered'])
    expect(probeVerdict(report)).toBe('fail')
  })

  // HAND-DERIVED: a hook that hangs or blocks the prompt looks, from outside, like a harness that timed out or exited non-zero with nothing to say; neither names a captured harness-side cause, so both are judged on the receipts and fail rather than warn.
  it('fails a run that timed out, since a hung hook looks the same', () => {
    const report = probe('hang', 2_000)
    expect(report.status).toBe('timeout')
    expect(report.events.map((e) => e.result)).toEqual(['not_fired', 'not_fired'])
    expect(probeVerdict(report)).toBe('fail')
  })

  // HAND-DERIVED: with the timeout clause gone, the captured login notice printed before the hang would be set aside as inconclusive; a hung run must still be judged.
  it('fails a run that printed a login notice and then timed out', () => {
    const report = probe('hangloggedout', 2_000)
    expect(report.status).toBe('timeout')
    expect(probeVerdict(report)).toBe('fail')
  })

  it('reports a harness that could not be started as its own status, not as hooks that did not fire', () => {
    const missing = join(dirname(harnessPath), 'no-such-dir', 'claude.exe')
    const report = runProbe('claudecode', { cwd, resolve: () => missing })
    expect(report.status).toBe('spawn_failed')
    expect(report.exitCode).toBeNull()
    expect(probeVerdict(report)).toBe('fail')
    const text = formatProbeReport(report)
    expect(text).toContain('[FAIL] the harness could not be started: ')
    expect(text).toMatch(/ENOENT|EACCES|EINVAL/)
    expect(text).not.toContain('hook did not run')
  })

  it('fails a run that exited non-zero with empty output and no known cause', () => {
    const report = probe('blocked')
    expect(report.status).toBe('failed')
    expect(report.events.map((e) => e.result)).toEqual(['not_fired', 'not_fired'])
    expect(probeVerdict(report)).toBe('fail')
  })

  const doctorProbe = (mode: string) => spawnSync(process.execPath, [BUNDLE, 'doctor', '--probe', 'claudecode'], { cwd, encoding: 'utf8', env: { ...process.env, FAKE_MODE: mode, PATH: `${dirname(harnessPath)}${delimiter}${process.env['PATH'] ?? ''}` } })

  it('exits 2 from doctor --probe when the harness failed before the model replied', () => {
    const res = doctorProbe('loggedout')
    expect(res.stdout).toContain('Probe inconclusive: the harness is not logged in.')
    expect(res.status).toBe(2)
  })

  it('exits 1 from doctor --probe when the run died with empty output and no known cause', () => {
    const res = doctorProbe('blocked')
    expect(res.stdout).toContain('[FAIL] the harness exited with code 1')
    expect(res.status).toBe(1)
  })

  it('exits 1 from doctor --probe when a hook ran but the model never saw its output', () => {
    const res = doctorProbe('swallow')
    expect(res.stdout).toContain('hook ran, but the model never saw its output')
    expect(res.status).toBe(1)
  })

  it('exits 0 from doctor --probe when the model repeats the markers', () => {
    expect(doctorProbe('echo').status).toBe(0)
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
