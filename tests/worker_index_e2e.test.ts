/**
 * End-to-end smoke test against the BUILT bundle (dist/token-goat.mjs).
 *
 * The indexer regression in worker.test.ts runs against the TypeScript source.
 * That can never catch a parser that gets tree-shaken out of the esbuild
 * bundle — which is exactly what happened when nothing reachable called the
 * real indexer: `parseFile` and every language extractor vanished from the
 * shipped artifact. This test builds the real bundle, runs `index` over a tiny
 * git fixture with an isolated data dir, then runs `symbol` and asserts a known
 * symbol resolves from the shipped binary.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const BUNDLE = path.join(ROOT, 'dist', 'token-goat.mjs')

let repo: string
let dataBase: string

/** Redirect the data dir into a temp base so the e2e never touches the real index. */
function tgEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LOCALAPPDATA: dataBase, XDG_DATA_HOME: dataBase }
}

function runBundle(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: repo,
    env: tgEnv(),
    encoding: 'utf8',
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

beforeAll(() => {
  // Build the real shipping artifact so this test fails if the parser/indexer
  // is missing from the bundle.
  execFileSync(process.execPath, ['esbuild.config.mjs'], { cwd: ROOT, stdio: 'ignore' })

  dataBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-e2e-data-'))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-e2e-repo-'))
  fs.writeFileSync(
    path.join(repo, 'sample.ts'),
    'export function knownBundleSymbol(): number {\n  return 7\n}\n',
  )
  // A nested file so relative ("src/mod.ts") and backslash ("src\\mod.ts")
  // inputs are meaningfully distinct from the stored absolute key.
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(
    path.join(repo, 'src', 'mod.ts'),
    'export function alphaSym(): number {\n  return 1\n}\nexport function betaSym(): number {\n  return 2\n}\n',
  )
  // A file whose exported symbol is called within the same file, so the refs index has a resolvable caller for the `refs --callers` smoke test.
  fs.writeFileSync(
    path.join(repo, 'caller.ts'),
    'export function refHelper(): number {\n  return 1\n}\n' +
      'export function refDriver(): number {\n  return refHelper() + refHelper()\n}\n',
  )
  // `git ls-files` lists staged files, so init + add is enough — no commit
  // (avoids user config and any global commit hooks firing in the test).
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  }
  git(['init'])
  git(['add', '.'])
}, 120000)

afterAll(() => {
  if (dataBase) fs.rmSync(dataBase, { recursive: true, force: true })
  if (repo) fs.rmSync(repo, { recursive: true, force: true })
})

describe('built bundle end-to-end indexing', () => {
  it('builds a bundle that actually contains the indexer', () => {
    const bundle = fs.readFileSync(BUNDLE, 'utf8')
    // The real indexer's write path must survive bundling; the old stub must not.
    expect(bundle).toContain('DELETE FROM symbols WHERE file_path')
    expect(bundle).not.toContain('would index')
    // The call-site ref walker must also survive tree-shaking.
    expect(bundle).toContain('CALL_TYPES_BY_LANG')
  })

  it('index then symbol resolves a known symbol from the built bundle', () => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)
    expect(idx.stdout).toMatch(/Indexed \d+ files/)

    const sym = runBundle(['symbol', 'knownBundleSymbol'])
    expect(sym.status).toBe(0)
    expect(sym.stdout).toContain('knownBundleSymbol')
  }, 60000)

  // Ref extraction must survive bundling too: a build that tree-shakes the ref walker out would leave the refs table empty and this would return exit 1.
  it('refs --callers resolves a caller from the built bundle', () => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)

    const refs = runBundle(['refs', 'caller.ts::refHelper', '--callers'])
    expect(refs.status).toBe(0)
    expect(refs.stdout).toContain('refDriver')
    expect(refs.stdout).toContain('caller.ts')
  }, 60000)
})

describe('built bundle resolves relative reader paths (regression for path keying)', () => {
  // The index is keyed by the absolute normalized path; before the resolver was
  // wired in, skeleton/outline used exact equality against the user-typed
  // relative path and silently returned "not indexed". These run the SHIPPED
  // binary from the repo root with a relative path and a Windows backslash path.
  beforeAll(() => {
    const idx = runBundle(['index', repo])
    expect(idx.status).toBe(0)
  }, 60000)

  it('skeleton resolves a relative path to indexed symbols', () => {
    const res = runBundle(['skeleton', 'src/mod.ts'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('alphaSym')
    expect(res.stdout).toContain('betaSym')
  }, 30000)

  it('outline resolves a relative path to indexed symbols', () => {
    const res = runBundle(['outline', 'src/mod.ts'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('alphaSym')
  }, 30000)

  it('read resolves a relative file::symbol spec', () => {
    const res = runBundle(['read', 'src/mod.ts::alphaSym'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('alphaSym')
  }, 30000)

  it('skeleton resolves a Windows-style backslash path', () => {
    const res = runBundle(['skeleton', 'src\\mod.ts'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('alphaSym')
  }, 30000)
})
