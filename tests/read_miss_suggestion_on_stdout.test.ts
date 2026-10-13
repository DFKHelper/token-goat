/** Regression: a read command's miss went only to stderr, so `token-goat section "f.md::Development setup" 2>/dev/null | head -60` printed nothing at all; 14 of about 50 recorded agent calls redirected stderr that way, and in one the `||` fallback then put a raw file holding a live API token into context. Each of `section`, `read`, `symbol`, `brief`, `outline` and `skeleton` now repeats the lines after a miss's first one (its Did you mean / Try: guidance) on stdout, keeping exit 1. Every case runs the built bundle with stderr discarded, as the agent did. */
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE, tgIsolatedEnv } from './helpers/bundle.js'

let root: string
let repo: string
let env: NodeJS.ProcessEnv

function runNoStderr(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 })
  return { status: r.status, stdout: r.stdout ?? '' }
}

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-miss-stdout-')))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  fs.writeFileSync(path.join(repo, 'mod.ts'), 'export function alphaSym(): number {\n  return 1\n}\nexport function betaSym(): number {\n  return 2\n}\n')
  fs.writeFileSync(path.join(repo, 'dupfile.ts'), 'export class DupHolder {\n  dup(): number {\n    return 10\n  }\n}\nexport function dup(): number {\n  return 20\n}\n')
  fs.writeFileSync(path.join(repo, 'doc.md'), '# Doc\n\n## Install\n\nRun npm install.\n\n## Usage\n\nRun it.\n')
  fs.writeFileSync(path.join(repo, 'note.xyz'), 'plain\n')
  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, stdio: 'ignore' })
  }
  git('init', '-q', '.')
  git('add', '-A')
  git('-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'seed')
  env = tgIsolatedEnv(path.join(root, 'home'), { TOKEN_GOAT_HOME: path.join(root, 'data'), TOKEN_GOAT_EMBEDDINGS_ENABLED: 'false' })
  const idx = spawnSync(process.execPath, [BUNDLE, 'index', '.'], { cwd: repo, env, encoding: 'utf8', timeout: 120000 })
  expect(idx.status, idx.stderr).toBe(0)
}, 180000)

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('a read-command miss with stderr discarded', () => {
  it('section names the near heading on stdout', () => {
    const r = runNoStderr(['section', 'doc.md::Install steps'])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('Did you mean:')
    expect(r.stdout).toContain('- Install')
  })

  it('section points at outline on stdout when nothing is close', () => {
    const r = runNoStderr(['section', 'doc.md::Zzqx'])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('Try: token-goat outline "doc.md"')
  })

  it('read names the near symbol on stdout', () => {
    const r = runNoStderr(['read', 'mod.ts::alphaSm'])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('Did you mean:')
    expect(r.stdout).toContain('alphaSym')
  })

  it('symbol names the near symbol on stdout', () => {
    const r = runNoStderr(['symbol', 'alphaSm'])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('alphaSym')
  })

  it('brief lists the qualified commands for an ambiguous name on stdout', () => {
    const r = runNoStderr(['brief', 'dupfile.ts::dup'])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('token-goat brief "dupfile.ts::DupHolder.dup"')
  })

  it.each(['outline', 'skeleton'])('%s says what still works on a file type it cannot list', (command) => {
    const r = runNoStderr([command, 'note.xyz'])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('To ask for .xyz file support')
  })

  it('keeps stdout empty for a one-line miss that offers nothing to run', () => {
    const r = runNoStderr(['outline', 'missing.ts'])
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
  })

  it('leaves a hit unchanged', () => {
    const r = runNoStderr(['section', 'doc.md::Install'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Run npm install.')
    expect(r.stdout).not.toContain('Did you mean')
  })
})
