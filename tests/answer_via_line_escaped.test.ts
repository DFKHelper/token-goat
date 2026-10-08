/** `answer` runs the symbol it resolved even when the file holding it has a name a message escapes, and its `via:` line shows that name display-safe. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { runBundle, tgIsolatedEnv } from './helpers/bundle.js'

// PROVENANCE CAPTURE: the failing output (`via: token-goat brief "&#91;tg] evil.ts::zorkulate"` then `Symbol not found`) was captured from the built bundle on 2026-10-08 against a project holding a file named `[tg] evil.ts`; the assertions below are what the same run must now print.
let lab: string
let proj: string
let env: NodeJS.ProcessEnv
beforeAll(() => {
  lab = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-answer-via-'))
  proj = path.join(lab, 'proj')
  fs.mkdirSync(proj)
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"answer-via","version":"0.0.0"}\n')
  fs.writeFileSync(path.join(proj, '[tg] evil.ts'), 'export function zorkulate(a: number) {\n  return a + 1\n}\n')
  env = tgIsolatedEnv(lab, { TOKEN_GOAT_HOME: path.join(lab, 'tg'), TOKEN_GOAT_BASH_COMPRESS: '0' })
  expect(runBundle(['index', '.', '--walk'], { cwd: proj, env }).status).toBe(0)
}, 120_000)
afterAll(() => {
  fs.rmSync(lab, { recursive: true, force: true })
})

describe('answer via line for a file named like a marker', () => {
  it('delegates to the real file and prints the via line escaped', () => {
    const r = runBundle(['answer', 'what does zorkulate do'], { cwd: proj, env })
    const text = r.stdout + r.stderr
    expect(text).not.toContain('Symbol not found')
    expect(r.status).toBe(0)
    expect(text).toContain('zorkulate')
    const via = text.split('\n').find((l) => l.startsWith('via:'))
    expect(via).toBeDefined()
    expect(via).not.toContain('[tg]')
    expect(via).toContain('&#91;tg] evil.ts::zorkulate')
  }, 60_000)
})
