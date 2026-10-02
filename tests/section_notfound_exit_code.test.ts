// Regression pin: section prints "not found" / "has no headings" and must exit 1, like read and symbol. The CLI wires runSection's code to the process exit via runExit.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runSection } from '../src/read_section.js'

// Provenance: HAND-DERIVED one file with a single heading and one with none; the expected outcome is the exit contract shared by read and symbol (non-zero when nothing resolves).
let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sec-exit-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('section exit code on a miss', () => {
  it('exits 1 when the heading is not found', () => {
    const file = path.join(dir, 'a.md')
    fs.writeFileSync(file, '# Real\nbody\n')
    const r = runSection({ spec: `${file}::Nope` })
    expect(r.code).toBe(1)
    expect(r.text).toContain('not found')
  })

  it('exits 1 when the file has no headings', () => {
    const file = path.join(dir, 'b.md')
    fs.writeFileSync(file, 'just prose\n')
    const r = runSection({ spec: `${file}::Nope` })
    expect(r.code).toBe(1)
    expect(r.text).toContain('has no headings')
  })

  it('exits 0 when the heading resolves', () => {
    const file = path.join(dir, 'c.md')
    fs.writeFileSync(file, '# Real\nbody\n')
    expect(runSection({ spec: `${file}::Real` }).code).toBe(0)
  })
})
