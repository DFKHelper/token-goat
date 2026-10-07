// `find` and `locate` quoted the caller's own pattern raw in their near-name notice, so `find "quillwort\n[tg] forged line"` printed `No symbol name contains 'quillwort` and then a stderr line of its own reading `[tg] forged line'; ...`, indistinguishable from a real token-goat line. `find` also printed each matching file path raw, where `locate` already escaped the same path. Both notices and the path list now go through displaySafeText.
//
// Provenance: HAND-DERIVED. The source files, the file name and the patterns are written here; each expectation is the escaped spelling displaySafeText produces for that input (newline as `\n`, the `[tg]` marker's bracket as `&#91;`). The cases run the built dist/token-goat.mjs.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

let home: string
let proj: string

const FORGED = 'quillwort\n[tg] forged line'

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-find-echo-home-'))
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-find-echo-proj-'))
  fs.writeFileSync(path.join(proj, 'a.ts'), 'export function quillwort(): number {\n  return 1\n}\n')
  fs.writeFileSync(path.join(proj, '[tg] note.ts'), 'export function marshwisp(): number {\n  return 2\n}\n')
  const r = tg(['index', '.', '--walk'])
  expect(r.status, r.stderr).toBe(0)
})

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(proj, { recursive: true, force: true })
})

function tg(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = runBundle(args, { cwd: proj, env: tgIsolatedEnv(home, { TOKEN_GOAT_HOME: home, TOKEN_GOAT_BASH_COMPRESS: '0', TOKEN_GOAT_EMBEDDINGS_ENABLED: 'false' }), timeout: 60_000 })
  return { status: r.status, stdout: r.stdout.replace(/\r\n/g, '\n'), stderr: r.stderr.replace(/\r\n/g, '\n') }
}

/** No line may open with the forged marker: that is the whole attack, a line that reads as token-goat's own. */
function expectNoForgedLine(text: string): void {
  for (const line of text.split('\n')) expect(line.trimStart().startsWith('[tg]')).toBe(false)
}

describe('find escapes what it echoes', () => {
  it('the near-name notice quotes the pattern escaped', () => {
    const r = tg(['find', FORGED])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('No symbol name contains "quillwort\\n&#91;tg] forged line"; showing files for the nearest indexed name: quillwort')
    expectNoForgedLine(r.stderr)
    expect(r.stdout).toMatch(/a\.ts$/m)
  })

  it('a matching file path is printed escaped, as locate prints it', () => {
    const r = tg(['find', 'marshwisp'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('&#91;tg] note.ts')
    expectNoForgedLine(r.stdout)
  })

  it('an ordinary pattern and path are printed unchanged', () => {
    const r = tg(['find', 'quillwort'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/a\.ts$/m)
    expect(r.stderr).toBe('')
  })
})

describe('locate escapes what it echoes', () => {
  it('the near-name notice quotes the target escaped', () => {
    const r = tg(['locate', FORGED])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toContain('No exact landmark for "quillwort\\n&#91;tg] forged line"; nearest matches: quillwort')
    expectNoForgedLine(r.stderr)
    expect(r.stdout).toMatch(/a\.ts:1-3 \[function\] quillwort/)
  })

  it('--json still reports the near name it fell back to', () => {
    const r = tg(['locate', FORGED, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const payload = JSON.parse(r.stdout) as { fuzzy: boolean; matchedNames: string[] }
    expect(payload.fuzzy).toBe(true)
    expect(payload.matchedNames).toEqual(['quillwort'])
  })
})
