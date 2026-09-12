/**
 * Built-bundle check for the five Lisp-family adapters (Common Lisp, Scheme, Racket, Clojure,
 * Emacs Lisp) added in commit 8c16530e: the shipped dist/token-goat.mjs, not source, indexes a
 * small project with one file per dialect and answers `outline`, `symbol` and `read` from it.
 * These adapters shipped with only two enumeration guards and no dedicated test file (source-level
 * or bundle), unlike the six template adapters this file is modeled on
 * (tests/templates_bundle_e2e.test.ts) which shipped both. This is the only test that proves each
 * masker-then-depth-scan adapter survived bundling and is reached from the real CLI path.
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-lisp-bundle-'))
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
  // HAND-DERIVED: minimal Common Lisp per CLHS Chapter 3 (defining forms).
  fs.writeFileSync(project + '/sample.lisp', '(defun cl-greet (name)\n  (format nil "hello, ~a" name))\n')
  // HAND-DERIVED: minimal Scheme per R7RS 5.3 (define).
  fs.writeFileSync(project + '/sample.scm', '(define (scm-greet name)\n  (string-append "hello, " name))\n')
  // HAND-DERIVED: minimal Racket per Racket Reference, "define".
  fs.writeFileSync(project + '/sample.rkt', '#lang racket\n(define (rkt-greet name)\n  (string-append "hello, " name))\n')
  // HAND-DERIVED: minimal Clojure per clojure.org/reference/reader (defn).
  fs.writeFileSync(project + '/sample.clj', '(defn clj-greet [name]\n  (str "hello, " name))\n')
  // HAND-DERIVED: minimal Emacs Lisp per GNU Emacs Lisp Reference Manual (defun).
  fs.writeFileSync(project + '/sample.el', '(defun el-greet (name)\n  (concat "hello, " name))\n')
  const idx = tg(['index', '.', '--walk'])
  expect(idx.status, idx.stderr).toBe(0)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the built bundle indexes the five Lisp-family dialects', () => {
  it('Common Lisp: outlines cl-greet and reads its body', () => {
    const outline = tg(['outline', 'sample.lisp'])
    expect(outline.status, outline.stderr).toBe(0)
    expect(outline.stdout).toContain('cl-greet')

    const read = tg(['read', 'sample.lisp::cl-greet'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('hello, ~a')
  })

  it('Scheme: outlines scm-greet and reads its body', () => {
    const outline = tg(['outline', 'sample.scm'])
    expect(outline.status, outline.stderr).toBe(0)
    expect(outline.stdout).toContain('scm-greet')

    const read = tg(['read', 'sample.scm::scm-greet'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('string-append')
  })

  it('Racket: outlines rkt-greet and reads its body', () => {
    const outline = tg(['outline', 'sample.rkt'])
    expect(outline.status, outline.stderr).toBe(0)
    expect(outline.stdout).toContain('rkt-greet')

    const read = tg(['read', 'sample.rkt::rkt-greet'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('string-append')
  })

  it('Clojure: outlines clj-greet and reads its body', () => {
    const outline = tg(['outline', 'sample.clj'])
    expect(outline.status, outline.stderr).toBe(0)
    expect(outline.stdout).toContain('clj-greet')

    const read = tg(['read', 'sample.clj::clj-greet'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('hello, ')
  })

  it('Emacs Lisp: outlines el-greet and reads its body', () => {
    const outline = tg(['outline', 'sample.el'])
    expect(outline.status, outline.stderr).toBe(0)
    expect(outline.stdout).toContain('el-greet')

    const read = tg(['read', 'sample.el::el-greet'])
    expect(read.status, read.stderr).toBe(0)
    expect(read.stdout).toContain('concat')
  })

  it('resolves a symbol shared by name to the right file via symbol', () => {
    const sym = tg(['symbol', 'clj-greet'])
    expect(sym.status, sym.stderr).toBe(0)
    expect(sym.stdout).toContain('sample.clj')
  })
})
