/** End-to-end check against the BUILT bundle that Jekyll front matter is never indexed as a heading. It indexes a temp project through dist/token-goat.mjs (the real default worker/indexer path, no injected callback) and reads the result back through `outline`, `symbol` and `section`. Fixture provenance: CAPTURE. README.md below is lines 1-8 of the repository README at commit 9c9b7688, where the closing `---` underlined `permalink: /` as a setext heading. */
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

const README = [
  '---',
  'title: "AI Token Optimizer — Cuts Costs, Sharpens Focus, Blocks Prompt Injection"',
  'description: "Cuts AI tool costs 40–80% and guards against prompt injection. Stops re-reads, extracts one function vs. whole file, shrinks screenshots 97%."',
  'image: /token-goat/assets/goat-social.png',
  'permalink: /',
  '---',
  '',
  '# Token-Goat',
  '',
].join('\n')

let repo: string
let dataBase: string

function runBundle(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: repo,
    env: { ...process.env, HOME: dataBase, USERPROFILE: dataBase, LOCALAPPDATA: dataBase, XDG_DATA_HOME: dataBase, TOKEN_GOAT_HOME: path.join(dataBase, 'tg') },
    encoding: 'utf8',
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

beforeAll(() => {
  dataBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fm-data-'))
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fm-repo-'))
  fs.writeFileSync(path.join(repo, 'README.md'), README)
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })
}, 120000)

afterAll(() => {
  if (dataBase) fs.rmSync(dataBase, { recursive: true, force: true })
  if (repo) fs.rmSync(repo, { recursive: true, force: true })
})

describe('front matter in the built bundle', () => {
  it('indexes only the real heading, not the line above the closing fence', () => {
    expect(runBundle(['index', repo]).status).toBe(0)

    const outline = runBundle(['outline', 'README.md'])
    expect(outline.status).toBe(0)
    const rows = outline.stdout.split('\n').filter((l) => l.includes('heading'))
    expect(rows[0]).toMatch(/8-8\s+heading\s+Token-Goat/)
    expect(outline.stdout).not.toContain('permalink')

    const sym = runBundle(['symbol', 'permalink: /'])
    expect(sym.stdout).not.toMatch(/heading\s+permalink/)

    const sec = runBundle(['section', 'README.md::permalink: /'])
    expect(sec.stdout + sec.stderr).toMatch(/not found|no section|no match/i)
  }, 120000)
})
