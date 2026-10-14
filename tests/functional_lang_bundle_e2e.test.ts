/** Built-bundle check for the F# (src/languages/fsharp.ts), Haskell (haskell.ts), Nix (nix.ts) and OCaml (ocaml.ts) adapters: the shipped dist/token-goat.mjs, not source, indexes one small project holding a file per language in a single `index . --walk`, and answers `outline`, `symbol` and `read` for each. Modeled directly on tests/lisp_family_bundle_e2e.test.ts, this repo's own established shape for proving a new masker-then-scan adapter survived bundling and is reached from the real CLI path rather than only from a source-level unit test. These four were separate per-language files that differed only in their fixture and symbol names; they share the one index spawn here, and the symbol names (fsGreet, hsGreet, nixGreet, mlGreet) and extensions are distinct, so no assertion can be satisfied by another language's file. */
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-functional-bundle-'))
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
  // HAND-DERIVED: minimal F# per the F# Language Specification's "String, Character, and Byte Array Literals" section (see fsharp.ts's module doc for the section-citation caveat), using `+` for string concatenation.
  fs.writeFileSync(
    project + '/sample.fs',
    'let fsGreet name = "hello, " + name\n',
  )
  // HAND-DERIVED: minimal Haskell per the Haskell 2010 Report section 4.4.3 (type signatures) and 4.4.3.1 (function bindings).
  fs.writeFileSync(
    project + '/sample.hs',
    'hsGreet :: String -> String\nhsGreet name = "hello, " ++ name\n',
  )
  // HAND-DERIVED: minimal Nix per the Nix Reference Manual's "Syntax" page (see nix.ts's module doc), a `let`-bound attribute set with one attribute-set key.
  fs.writeFileSync(
    project + '/sample.nix',
    ['let', '  nixGreet = "hello, world";', 'in', '{', '  message = nixGreet;', '}', ''].join('\n'),
  )
  // HAND-DERIVED: minimal OCaml per The OCaml Manual's "String literals" section (https://v2.ocaml.org/manual/lex.html#sss:stringliterals), using `^` for string concatenation.
  fs.writeFileSync(
    project + '/sample.ml',
    'let mlGreet name = "hello, " ^ name\n',
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

describe('the built bundle indexes Haskell', () => {
  it('outlines hsGreet and reads its body', () => {
    const outline = tg(['outline', 'sample.hs'])
    expect(outline.status, outline.stderr).toBe(0)
    expect(outline.stdout).toContain('hsGreet')

    const read = tg(['read', 'sample.hs::hsGreet'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('hello, ')
  })

  it('resolves the symbol by name via symbol', () => {
    const sym = tg(['symbol', 'hsGreet'])
    expect(sym.status, sym.stderr).toBe(0)
    expect(sym.stdout).toContain('sample.hs')
  })
})

describe('the built bundle indexes Nix', () => {
  it('outlines nixGreet and reads its body', () => {
    const outline = tg(['outline', 'sample.nix'])
    expect(outline.status, outline.stderr).toBe(0)
    expect(outline.stdout).toContain('nixGreet')

    const read = tg(['read', 'sample.nix::nixGreet'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('hello, world')
  })

  it('resolves the symbol by name via symbol', () => {
    const sym = tg(['symbol', 'nixGreet'])
    expect(sym.status, sym.stderr).toBe(0)
    expect(sym.stdout).toContain('sample.nix')
  })
})

describe('the built bundle indexes OCaml', () => {
  it('outlines mlGreet and reads its body', () => {
    const outline = tg(['outline', 'sample.ml'])
    expect(outline.status, outline.stderr).toBe(0)
    expect(outline.stdout).toContain('mlGreet')

    const read = tg(['read', 'sample.ml::mlGreet'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('hello, ')
  })

  it('resolves the symbol by name via symbol', () => {
    const sym = tg(['symbol', 'mlGreet'])
    expect(sym.status, sym.stderr).toBe(0)
    expect(sym.stdout).toContain('sample.ml')
  })
})
