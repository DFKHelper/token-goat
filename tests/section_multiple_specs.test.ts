/** Regression: `section a b` read only the first spec and printed "Note: 1 extra spec argument ignored ...", so agents spawned one `section` per heading (14 spawns across three recorded commands, about 1-2 s each). Several positional specs are now served in one call the way their comma form is. Runs the built bundle, as the agents did. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE, tgIsolatedEnv } from './helpers/bundle.js'

let root: string
let env: NodeJS.ProcessEnv

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: root, env, encoding: 'utf8', timeout: 60000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-section-specs-')))
  fs.writeFileSync(path.join(root, 'f.md'), '# Guide\n\n## Alpha\n\nalpha body\n\n## Beta\n\nbeta body\n\n## Gamma, Delta\n\ncomma body\n')
  fs.writeFileSync(path.join(root, 'g.md'), '# Other\n\n## Omega\n\nomega body\n')
  env = tgIsolatedEnv(path.join(root, 'home'), { TOKEN_GOAT_HOME: path.join(root, 'data'), TOKEN_GOAT_EMBEDDINGS_ENABLED: 'false' })
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('section with several positional specs', () => {
  it('reads every heading of one file, as the comma form does, with no ignored-argument note', () => {
    const r = run(['section', 'f.md::Alpha', 'f.md::Beta'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('# Alpha — ')
    expect(r.stdout).toContain('alpha body')
    expect(r.stdout).toContain('# Beta — ')
    expect(r.stdout).toContain('beta body')
    expect(r.stdout + r.stderr).not.toContain('ignored')
    expect(r.stdout).toBe(run(['section', 'f.md::Alpha,f.md::Beta']).stdout)
  })

  it('reads headings across files', () => {
    const r = run(['section', 'f.md::Alpha', 'g.md::Omega'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('alpha body')
    expect(r.stdout).toContain('omega body')
  })

  it('keeps a heading that holds a comma whole, which a comma-joined spec would split', () => {
    const r = run(['section', 'f.md::Gamma, Delta', 'f.md::Beta'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('comma body')
    expect(r.stdout).toContain('beta body')
  })

  it('runs specs that cannot merge one after another and still serves the valid one', () => {
    const r = run(['section', 'nonsense', 'f.md::Beta'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('Invalid section spec')
    expect(r.stdout).toContain('beta body')
  })

  it('keeps the quoting note for a heading a shell split into words', () => {
    const r = run(['section', 'f.md::Gamma,', 'Delta'])
    expect(r.stdout + r.stderr).toContain('which a shell splits unless it is quoted')
  })
})
