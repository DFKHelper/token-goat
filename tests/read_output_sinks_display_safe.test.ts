// Built-bundle check that the read commands escape a file name and a symbol name before they print one: a bidi override in a file name and a zero-width joiner in an identifier are legal on every filesystem and in JavaScript, and used to reach the terminal as written.

// HAND-DERIVED: the names are invented to hold U+202E (bidi override, a format character) and U+200D (zero-width joiner, legal inside a JavaScript identifier); the expected spellings are displaySafeText's `\uNNNN` escape for a format character worked out from that rule, not read off the implementation's output.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

const RLO = '\u202e'
const ZWJ = '‍'
const FORMAT_CHARS = /\p{Cf}/u

let home: string
let proj: string

function tg(args: string[]): string {
  const r = runBundle(args, { cwd: proj, env: tgIsolatedEnv(home, { TOKEN_GOAT_HOME: home, TOKEN_GOAT_BASH_COMPRESS: '0' }), timeout: 90_000 })
  return `${r.stdout}\n${r.stderr}`
}

/** The path part of every output line that names the hostile file, cut at its extension so the source text a context window prints on purpose is not part of what is checked. */
function pathParts(out: string, needle: string): string[] {
  return out.split('\n').filter((l) => l.includes(needle)).map((l) => l.slice(0, l.indexOf('.ts')))
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sink-home-'))
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sink-proj-'))
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"sink","version":"0.0.0"}\n')
  fs.writeFileSync(path.join(proj, `lib${RLO}a.ts`), 'export function target(): number {\n  return 1\n}\n')
  fs.writeFileSync(path.join(proj, `use${RLO}b.ts`), `import { target } from './lib'\nexport function call${ZWJ}er(): number {\n  return target()\n}\n`)
  spawnSync('git', ['init'], { cwd: proj })
  spawnSync('git', ['add', '-A'], { cwd: proj })
  const indexed = runBundle(['index', '.'], { cwd: proj, env: tgIsolatedEnv(home, { TOKEN_GOAT_HOME: home, TOKEN_GOAT_BASH_COMPRESS: '0' }), timeout: 120_000 })
  expect(indexed.status, `index failed: ${indexed.stderr}`).toBe(0)
}, 180_000)

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(proj, { recursive: true, force: true })
})

describe('read commands escape the names they print', () => {
  it('grep --symbol -C escapes the file name and the enclosing symbol name', () => {
    const out = tg(['grep', 'target', '.', '--symbol', '-C', '1'])
    const rows = pathParts(out, 'use')
    expect(rows.length, out).toBeGreaterThan(0)
    for (const row of rows) expect(row, row).not.toMatch(FORMAT_CHARS)
    expect(out).toContain('[call\\u200der (function)]')
    expect(out).not.toContain(`[call${ZWJ}er`)
  })

  it('brief escapes the caller name and the caller file in the caller rows and the -C window', () => {
    const out = tg(['brief', `lib${RLO}a.ts::target`, '-C', '1'])
    const rows = pathParts(out, 'use')
    expect(rows.length, out).toBeGreaterThan(0)
    for (const row of rows) expect(row, row).not.toMatch(FORMAT_CHARS)
    expect(out).toContain('call\\u200der\t')
  })

  it('refs -C escapes the file name in the window rows', () => {
    const out = tg(['refs', 'target', '-C', '1'])
    const rows = pathParts(out, 'use')
    expect(rows.length, out).toBeGreaterThan(0)
    for (const row of rows) expect(row, row).not.toMatch(FORMAT_CHARS)
  })
})
