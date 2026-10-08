// Built-bundle check that `callers` and `install` escape the file, caller and directory names they print: a bidi override in a file name, a zero-width joiner in an identifier and a bidi override in the Claude config directory are legal on every filesystem and used to reach the terminal as written.

// HAND-DERIVED: the names are invented to hold U+202E (bidi override, a format character) and U+200D (zero-width joiner, legal inside a JavaScript identifier); the expected spellings are displaySafeText's `\uNNNN` escape for a format character worked out from that rule, not read off the implementation's output.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'
import { renderContextWindow } from '../src/util_context.js'

const RLO = '‮'
const ZWJ = '‍'
const FORMAT_CHARS = /\p{Cf}/u

let home: string
let proj: string

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return tgIsolatedEnv(home, { TOKEN_GOAT_HOME: home, TOKEN_GOAT_BASH_COMPRESS: '0', ...extra })
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sink2-home-'))
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sink2-proj-'))
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"sink2","version":"0.0.0"}\n')
  fs.writeFileSync(path.join(proj, `lib${RLO}a.ts`), 'export function target(): number {\n  return 1\n}\n')
  fs.writeFileSync(path.join(proj, `use${RLO}b.ts`), `import { target } from './lib'\nexport function call${ZWJ}er(): number {\n  return target()\n}\n`)
  spawnSync('git', ['init'], { cwd: proj })
  spawnSync('git', ['add', '-A'], { cwd: proj })
  const indexed = runBundle(['index', '.'], { cwd: proj, env: env(), timeout: 120_000 })
  expect(indexed.status, `index failed: ${indexed.stderr}`).toBe(0)
}, 180_000)

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(proj, { recursive: true, force: true })
})

describe('renderContextWindow', () => {
  it('escapes the file name on the match line and on the surrounding lines', () => {
    const rows = renderContextWindow(`a${RLO}b.ts`, 2, [{ line: 1, text: 'x' }, { line: 2, text: 'y' }, { line: 3, text: 'z' }])
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(row, row).not.toMatch(FORMAT_CHARS)
    expect(rows[1]).toBe('a\\u202eb.ts:2: y')
    expect(rows[0]).toBe('a\\u202eb.ts-1- x')
  })
})

describe('callers and install escape the names they print', () => {
  it('callers -C escapes the caller name and the caller file in the row and in the window', () => {
    const r = runBundle(['callers', 'target', '-C', '1'], { cwd: proj, env: env(), timeout: 90_000 })
    const out = `${r.stdout}\n${r.stderr}`
    const rows = out.split('\n').filter((l) => l.includes('use')).map((l) => l.slice(0, l.indexOf('.ts')))
    expect(rows.length, out).toBeGreaterThan(0)
    for (const row of rows) expect(row, row).not.toMatch(FORMAT_CHARS)
    expect(out).toContain('call\\u200der\tuse\\u202eb.ts:3')
  })

  it('install --user escapes a bidi override in the Claude config directory it reports', () => {
    const cfg = path.join(home, `cl${RLO}aude`)
    fs.mkdirSync(cfg, { recursive: true })
    const r = runBundle(['install', '--user'], { cwd: proj, env: env({ CLAUDE_CONFIG_DIR: cfg }), timeout: 90_000 })
    const out = `${r.stdout}\n${r.stderr}`
    const reported = out.split('\n').filter((l) => l.includes('→'))
    expect(reported.length, out).toBeGreaterThanOrEqual(3)
    for (const line of reported) expect(line, line).not.toMatch(FORMAT_CHARS)
    expect(out).toContain('cl\\u202eaude')
  })
})
