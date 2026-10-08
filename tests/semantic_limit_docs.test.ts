/** `semantic --limit` defaults to 20 and refuses 0 or less; its --help line and its docs/cli.md row say so, in the words the code behaves by. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { ROOT, runBundle, tgIsolatedEnv } from './helpers/bundle.js'

// PROVENANCE FORMAT-DERIVED: the default and the refusal are read off src/cli.ts (`opts.limit !== undefined ? requireInt(...) : 20`) and src/read_semantic.ts (`opts.limit <= 0` -> "--limit must be a positive number"); the bundle runs below are the CAPTURE that the shipped build still behaves that way.
let lab: string
let env: NodeJS.ProcessEnv
beforeAll(() => {
  lab = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-semantic-limit-'))
  env = tgIsolatedEnv(lab, { TOKEN_GOAT_HOME: path.join(lab, 'tg'), TOKEN_GOAT_BASH_COMPRESS: '0' })
})
afterAll(() => {
  fs.rmSync(lab, { recursive: true, force: true })
})

describe('semantic --limit', () => {
  it('--help states the default and the refusal', () => {
    const r = runBundle(['semantic', '--help'], { cwd: lab, env })
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/-l, --limit <n>\s+max results \(default: 20; 0 or less is refused\)/)
  })

  it.each(['0', '-3'])('refuses --limit %s with exit code 1', (value) => {
    const r = runBundle(['semantic', 'zork', `--limit=${value}`], { cwd: lab, env })
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toContain('--limit must be a positive number')
  })

  it('docs/cli.md gives the same default and refusal on the semantic row', () => {
    const row = fs.readFileSync(path.join(ROOT, 'docs', 'cli.md'), 'utf8').split('\n').find((l) => l.startsWith('| `token-goat semantic '))
    expect(row).toBeDefined()
    expect(row).toContain('`--limit <n>` caps result count (default 20; 0 or less is refused with exit code 1)')
  })
})
