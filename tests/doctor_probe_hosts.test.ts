/** `doctor --probe` for the hosts other than Claude Code, through the built bundle. Provenance: the stand-in codex and copilot stderr and exit codes are CAPTURE, read from tests/fixtures/doctor_probe (rows in tests/fixtures/PROVENANCE.tsv: codex-cli 0.159.3 and copilot 1.0.95 run with an empty home); the argv each stand-in insists on (`exec <prompt>`, `-p <prompt>`) is HAND-DERIVED from those CLIs' headless usage, written here rather than read from PROBE_COMMANDS, so a changed table entry fails the run. The hosts with no headless mode and the path-hiding cases are HAND-DERIVED. */
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { hideResolvedPath, PROBE_PROMPT } from '../src/doctor_probe.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')
const fixture = (name: string): string => join(process.cwd(), 'tests', 'fixtures', 'doctor_probe', name)

describe('doctor --probe on a host with no headless mode', () => {
  it.each(['vscode', 'visualstudio', 'jetbrains'])('says %s has no headless mode and exits 3, apart from a hook failure (1) and an inconclusive run (2)', (host) => {
    const res = spawnSync(process.execPath, [BUNDLE, 'doctor', '--probe', host], { encoding: 'utf8' })
    expect(res.stderr).toContain(`${host} has no headless mode`)
    expect(res.stderr).toContain('run token-goat doctor')
    expect(res.stderr).not.toContain('no headless probe for')
    expect(res.status).toBe(3)
  })

  it('still rejects a name that is not a host at all with exit 1', () => {
    const res = spawnSync(process.execPath, [BUNDLE, 'doctor', '--probe', 'nosuchhost'], { encoding: 'utf8' })
    expect(res.stderr).toContain('no headless probe for')
    expect(res.status).toBe(1)
  })
})

describe('doctor --probe through a stand-in codex and copilot', () => {
  // The stand-in directory is the whole PATH and the probe runs from a subdirectory of it, because resolveOnPath skips the working directory: a real codex or copilot elsewhere on PATH would otherwise spend a prompt on the account.
  let dir = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-probe-hosts-'))
    mkdirSync(join(dir, 'proj'))
    const script = (expected: readonly string[]): string => [
      "import { readFileSync } from 'node:fs'",
      `const expected = ${JSON.stringify(expected)}`,
      "if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) { console.error('argv mangled: ' + JSON.stringify(process.argv.slice(2))); process.exit(3) }",
      "process.stderr.write(readFileSync(process.env.FAKE_STDERR_FILE, 'utf8'))",
      'process.exit(Number(process.env.FAKE_EXIT))',
    ].join('\n')
    for (const [bin, expected] of [['codex', ['exec', PROBE_PROMPT]], ['copilot', ['-p', PROBE_PROMPT]]] as const) {
      writeFileSync(join(dir, `${bin}.mjs`), script(expected))
      if (process.platform === 'win32') {
        writeFileSync(join(dir, `${bin}.cmd`), `@"${process.execPath}" "${join(dir, `${bin}.mjs`)}" %*\r\n`)
      } else {
        const shim = join(dir, bin)
        writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, `${bin}.mjs`)}" "$@"\n`)
        chmodSync(shim, 0o755)
      }
    }
  })

  const probe = (host: string, stderrFixture: string, exit: number) => spawnSync(process.execPath, [BUNDLE, 'doctor', '--probe', host], { cwd: join(dir, 'proj'), encoding: 'utf8', env: { ...process.env, FAKE_STDERR_FILE: fixture(stderrFixture), FAKE_EXIT: String(exit), PATH: dir } })

  it.each([
    ['codex', 'codex_untrusted_directory.stderr', 1, 'the harness refused to run in an untrusted directory'],
    ['codex', 'codex_unexpected_argument.stderr', 2, 'the harness rejected a command-line flag'],
    ['copilot_cli', 'copilot_no_authentication.stderr', 1, 'the harness is not logged in'],
    ['copilot_cli', 'copilot_access_denied.stderr', 1, 'the account or its organization policy denied the harness'],
  ])('reads %s failing with %s as inconclusive and exits 2', (host, file, exit, cause) => {
    const res = probe(host, file, exit)
    expect(res.stdout).toContain(`Probe inconclusive: ${cause}`)
    expect(res.stdout).toContain('[??]')
    expect(res.stdout).not.toContain('hook did not run')
    expect(res.status).toBe(2)
  })
})

describe('hiding the resolved binary path', () => {
  const resolved = 'C:/Users/someone/AppData/Roaming/npm/claude.cmd'

  it('replaces the exact spelling on every platform', () => {
    expect(hideResolvedPath(`spawnSync ${resolved} ENOBUFS`, resolved)).toBe('spawnSync <harness> ENOBUFS')
  })

  // HAND-DERIVED: Windows paths name one file in any case and with either slash, and an error message may spell the path differently from the one handed to spawn.
  it.runIf(process.platform === 'win32')('replaces a spelling that differs in case or slash direction', () => {
    const backslashed = resolved.replaceAll('/', String.fromCharCode(92)).toUpperCase()
    expect(hideResolvedPath(`spawnSync ${backslashed} ENOBUFS`, resolved)).toBe('spawnSync <harness> ENOBUFS')
    expect(hideResolvedPath(`${resolved.toLowerCase()} and ${resolved}`, resolved)).toBe('<harness> and <harness>')
  })

  it('leaves a message without the path alone', () => {
    expect(hideResolvedPath('spawnSync ENOBUFS', resolved)).toBe('spawnSync ENOBUFS')
  })
})
