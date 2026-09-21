/**
 * Regression: `projectTranscriptsDir` resolved Claude Code's transcript root from `os.homedir()` alone, so a run that had isolated everything token-goat owns (LOCALAPPDATA, TOKEN_GOAT_HOME) still read the real transcript of whoever was at the keyboard. It now resolves through `claudeConfigDir`, which honours Claude Code's own `CLAUDE_CONFIG_DIR` -- the variable the shipping `@anthropic-ai/claude-code` binary itself reads (`process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')`, with the transcript root at `join(configHome, 'projects')`), not one token-goat invented.
 *
 * Both cases spawn the built bundle, so they exercise the shipping resolution rather than the resolver in isolation. The second case is the calibration: with no override set the home-directory default must still be chosen, so honouring the variable cannot have silently broken ordinary operation.
 *
 * Fixture provenance: HAND-DERIVED. The two `.jsonl` files are one-line `{}` placeholders. Nothing here asserts on transcript *content* -- only on which of two directories the command read from -- and an empty object is enough for `waste` to parse the file and report the path it picked. No real transcript is read, copied, or written.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

const tempRoots: string[] = []

function mkTemp(prefix: string): string {
  // `realpathSync.native` for the OS's own spelling, as tests/helpers/containment_matrix.ts resolves its base. The slug below is built from `projectRoot`, and the bundle builds the same slug from the path it resolved: where `os.tmpdir()` is reached through a Windows 8.3 alias or the macOS `/var` symlink the two slugs differ, so the command looked in a directory this test never wrote to and exited 1.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tempRoots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true })
})

describe('waste transcript discovery honours CLAUDE_CONFIG_DIR', () => {
  const fakeHome = mkTemp('tg-ccd-home-')
  const altConfig = mkTemp('tg-ccd-alt-')
  const projectRoot = mkTemp('tg-ccd-proj-')
  const slug = path.resolve(projectRoot).replace(/[^A-Za-z0-9]/g, '-')

  const homeTranscriptDir = path.join(fakeHome, '.claude', 'projects', slug)
  const altTranscriptDir = path.join(altConfig, 'projects', slug)
  fs.mkdirSync(homeTranscriptDir, { recursive: true })
  fs.mkdirSync(altTranscriptDir, { recursive: true })
  fs.writeFileSync(path.join(homeTranscriptDir, 'from-home-dir.jsonl'), '{}\n', 'utf-8')
  fs.writeFileSync(path.join(altTranscriptDir, 'from-config-dir.jsonl'), '{}\n', 'utf-8')

  function env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const base = tgIsolatedEnv(fakeHome, { TOKEN_GOAT_HOME: path.join(fakeHome, '.token-goat'), ...extra })
    if (extra?.['CLAUDE_CONFIG_DIR'] === undefined) delete base['CLAUDE_CONFIG_DIR']
    return base
  }

  it('reads the transcript under CLAUDE_CONFIG_DIR, not the one under the home directory', () => {
    const r = runBundle(['waste', '--project', projectRoot, '--top', '1'], { env: env({ CLAUDE_CONFIG_DIR: altConfig }) })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('from-config-dir.jsonl')
    expect(r.stdout).not.toContain('from-home-dir.jsonl')
  })

  it('still reads ~/.claude when CLAUDE_CONFIG_DIR is not set', () => {
    const r = runBundle(['waste', '--project', projectRoot, '--top', '1'], { env: env() })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('from-home-dir.jsonl')
    expect(r.stdout).not.toContain('from-config-dir.jsonl')
  })
})
