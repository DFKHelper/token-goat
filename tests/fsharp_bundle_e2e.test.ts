/**
 * Built-bundle check for the F# adapter (src/languages/fsharp.ts): the shipped
 * dist/token-goat.mjs, not source, indexes a small project with one F# file and answers
 * `outline`, `symbol` and `read` from it. Modeled directly on tests/ocaml_bundle_e2e.test.ts,
 * this repo's own established shape for proving a new masker-then-scan adapter survived bundling
 * and is reached from the real CLI path rather than only from a source-level unit test.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

let root: string
let project: string
let env: NodeJS.ProcessEnv

function tg(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: project, env, encoding: 'utf8', timeout: 60000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fsharp-bundle-'))
  project = path.join(root, 'project')
  const home = path.join(root, 'home')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
  env = {
    ...process.env,
    TOKEN_GOAT_HOME: path.join(root, 'tg-home'),
    LOCALAPPDATA: path.join(root, 'data'),
    XDG_DATA_HOME: path.join(root, 'data'),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    TOKEN_GOAT_EMBEDDINGS_ENABLED: '0',
  }
  // HAND-DERIVED: minimal F# per the F# Language Specification's "String, Character, and Byte
  // Array Literals" section (see fsharp.ts's module doc for the section-citation caveat), using
  // `+` for string concatenation.
  fs.writeFileSync(
    project + '/sample.fs',
    'let fsGreet name = "hello, " + name\n',
  )
  const idx = tg(['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the built bundle indexes F#', () => {
  it('outlines fsGreet and reads its body', () => {
    const outline = tg(['outline', 'sample.fs'])
    expect(outline.status, outline.stderr).toBe(0)
    expect(outline.stdout).toContain('fsGreet')

    const read = tg(['read', 'sample.fs::fsGreet'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('hello, ')
  })

  it('resolves the symbol by name via symbol', () => {
    const sym = tg(['symbol', 'fsGreet'])
    expect(sym.status, sym.stderr).toBe(0)
    expect(sym.stdout).toContain('sample.fs')
  })
})
