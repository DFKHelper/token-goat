import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- a maintainer script in plain JavaScript, deliberately outside the typed source tree.
import { mergeComments } from '../scripts/merge-comments.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(repoRoot, 'scripts', 'merge-comments.mjs')

describe('scripts/merge-comments.mjs', () => {
  // The script carries its own case list; running it here is what keeps that list from rotting, and it is one source of cases rather than two copies that drift.
  it('passes its own self-test', () => {
    const run = spawnSync(process.execPath, [script, '--self-test'], { encoding: 'utf8' })
    expect(run.stdout.trim()).toBe('SELF-TEST OK')
    expect(run.status).toBe(0)
  })

  // The defect this script exists to prevent, reproduced directly. An ad-hoc fold swallowed the `*/` closing a JSDoc block, which silently commented out the code beneath it; two guard files shipped that way into the working tree and were caught by an unused-import lint error rather than by anything that understood what had happened.
  it('keeps the closer when folding a block comment', () => {
    const folded = mergeComments('/**\n * one\n * two\n */\nexport const a = 1\n')
    expect(folded).toContain('*/')
    expect(folded).toContain('export const a = 1')
    expect(folded.split('\n').filter((l: string) => l.trim()).length).toBe(2)
  })

  // Folding is lexical on line starts, so a delimiter that appears inside a string is data and must survive untouched.
  it('leaves comment delimiters inside string literals alone', () => {
    const source = 'const open = "/*"\nconst close = "*/"\n'
    expect(mergeComments(source)).toBe(source)
  })

  // An unterminated block is a malformed file. Folding it would invent a closer and change what the file means, so the script declines rather than repairs.
  it('leaves an unterminated block verbatim', () => {
    const source = '/* unterminated\nexport const a = 1\n'
    expect(mergeComments(source)).toBe(source)
  })

  it('is idempotent', () => {
    const once = mergeComments('// one\n// two\nexport const a = 1\n')
    expect(mergeComments(once)).toBe(once)
  })

  // The guard files this script was written for must already be folded, so a later edit that re-wraps one fails here instead of landing.
  it('leaves the already-folded guard sources unchanged', () => {
    const files = [
      'tests/guards/bundle_specifiers.ts',
      'tests/guards/runtime_dependency_set_is_locked.test.ts',
      'tests/guards/lifecycle_script_is_published.test.ts',
    ]
    const run = spawnSync(process.execPath, [script, '--check', ...files], { cwd: repoRoot, encoding: 'utf8' })
    expect(run.stdout.trim()).toBe('')
    expect(run.status).toBe(0)
  })

  // The bridges hold each harness's shim as JavaScript inside a template literal. Before the script knew where literals are it refused eleven of these files outright, reading the shim's own `//` lines as comments to fold, so they stayed wrapped.
  it('leaves the folded bridge sources unchanged, shim templates included', () => {
    const dir = path.join(repoRoot, 'src', 'bridges')
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => path.join('src', 'bridges', f))
    expect(files.length).toBeGreaterThan(20)
    const run = spawnSync(process.execPath, [script, '--check', ...files], { cwd: repoRoot, encoding: 'utf8' })
    expect(run.stdout.trim()).toBe('')
    expect(run.status).toBe(0)
  })

  // The notices generator's header explains esbuild's legal comments, naming `@license`, which esbuild keeps even when minifying; the identity check compared that kept comment and refused the fold as if it moved code.
  it('leaves the folded build scripts unchanged, a header that mentions @license included', () => {
    const files = ['esbuild.config.mjs', 'scripts/build-options.mjs', 'scripts/generate-third-party-notices.mjs', 'scripts/merge-comments.mjs']
    const run = spawnSync(process.execPath, [script, '--check', ...files], { cwd: repoRoot, encoding: 'utf8' })
    expect(run.stdout.trim()).toBe('')
    expect(run.status).toBe(0)
  })
})
