/** `answer` must resolve a quoted file path that holds a space. The router dropped any subject containing whitespace before it looked anything up, so `answer 'what does "src dir/big file.ts" export'` refused with "not an indexed symbol or file" for a file the index held. Provenance: HAND-DERIVED. The fixture is a two-export TypeScript file in a directory and file name each holding one space; which file the question names, and the `exports` command it should route to, follow from the question text alone. The refusal text was CAPTURED from the 2.9.30 bundle in C:/tgdog-pass2/q1. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resolveSubject, runAnswer } from '../src/answer_router.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { captureStdout } from './helpers/capture-stdout.js'

let project: string
let previousCwd: string

function ask(question: string): { out: string; err: string; code: number } {
  let err = ''
  const origErr = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    if (typeof chunk === 'string') err += chunk
    return true
  }) as typeof process.stderr.write
  let code = -1
  const out = captureStdout(() => {
    try {
      code = runAnswer({ question })
    } finally {
      process.stderr.write = origErr
    }
  })
  return { out, err, code }
}

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), 'tg-answer-spaced-'))
  writeFileSync(join(project, 'package.json'), '{"name":"spaced"}\n')
  mkdirSync(join(project, 'src dir'))
  const file = join(project, 'src dir', 'big file.ts')
  writeFileSync(file, 'export function zzSpacedOne(): number {\n  return 1\n}\nexport const zzSpacedTwo = 2\n')
  indexFileSync(normalizePath(file))
  previousCwd = process.cwd()
  process.chdir(project)
})

afterAll(() => {
  process.chdir(previousCwd)
  rmSync(project, { recursive: true, force: true })
})

describe('answer resolves a file path holding a space', () => {
  it('resolves the spaced path as a file subject', () => {
    expect(resolveSubject('src dir/big file.ts', 'file-first')).toEqual({ kind: 'file', path: normalizePath(join(project, 'src dir', 'big file.ts')) })
  })

  it('answers what-does-X-export for a quoted spaced path, quoting the path in its via: line', () => {
    const r = ask('what does "src dir/big file.ts" export')
    expect(r.err).toBe('')
    expect(r.code).toBe(0)
    expect(r.out.split('\n')[0]).toBe('via: token-goat exports "src dir/big file.ts"')
    expect(r.out).toContain('zzSpacedOne')
  })

  it('still refuses a multi-word subject that names no file', () => {
    const r = ask('what does "src dir/no such file.ts" export')
    expect(r.code).toBe(1)
    expect(r.err).toContain('"src dir/no such file.ts" is not an indexed symbol or file')
  })
})
