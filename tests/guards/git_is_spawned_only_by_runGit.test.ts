/** Guard: git is started in exactly two places, `runGit` in src/util.ts and `runGitAsync` in src/git_async.ts, which share one argument builder. Those sites are where `core.fsmonitor` is turned off, diff drivers are kept from running, and (on Windows) the real git is started instead of its launcher so a timeout ends the process that matters. A second spawn site skips all three. The scan reads each src file whole with its comments removed (so a call split over lines is seen and prose that mentions a spawn is not), and covers spawn, spawnSync, spawnOwned, spawnResolvedSync, execFile, execFileSync, exec and execSync called with a literal git or the file gitExecutable() resolves, and any resolveOnPath('git'). It replaced an older guard that looked at four of those calls one line at a time. */

// tg-no-regex-preload
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { transformSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** A process-starting call whose first argument is the literal git (or a literal command line beginning with git) or the file gitExecutable() resolves, or any lookup of git on PATH. */
const GIT_SPAWN = /(?:^|[^\w$])(?:(?:spawn|spawnSync|spawnOwned|spawnResolvedSync|execFile|execFileSync|exec|execSync)\(\s*(?:['"`]git\b|gitExecutable\()|resolveOnPath\(\s*['"`]git['"`]\s*\))/g

/** The source with every comment removed. esbuild parses it, so a `//` inside a string or a `/*` inside a glob is never taken for a comment. */
function withoutComments(source: string): string {
  return transformSync(source, { loader: 'ts', legalComments: 'none' }).code
}

/** One entry per place in `source` that starts git, as `line: text` in the comment-free rendering. */
function gitSpawnSites(source: string): string[] {
  const code = withoutComments(source)
  return [...code.matchAll(GIT_SPAWN)].map((m) => `${code.slice(0, m.index).split('\n').length}: ${m[0].trim()}`)
}

function walkSrc(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walkSrc(full))
    else if (e.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('git is spawned only by runGit', () => {
  it('no file in src/ but util.ts and git_async.ts starts git', () => {
    const files = pinnedPopulation({
      what: 'src/**/*.ts files scanned for git spawns',
      items: walkSrc(SRC_DIR).map((f) => f.split(path.sep).join('/')),
      floor: 150,
      mustInclude: ['src/util.ts', 'src/git_async.ts', 'src/manifest.ts', 'src/hooks_session.ts'],
    })
    const stray: string[] = []
    for (const file of files) {
      // util.ts holds runGit; git_async.ts holds runGitAsync, which lives apart so the hook entry's static graph does not carry it. Each is pinned to its one site below.
      if (file.endsWith('/src/util.ts') || file.endsWith('/src/git_async.ts')) continue
      for (const site of gitSpawnSites(fs.readFileSync(file, 'utf8'))) stray.push(`${path.relative(SRC_DIR, file)}:${site}`)
    }
    expect(stray, 'git must be started through runGit in src/util.ts, never by a spawn of its own').toEqual([])
  })

  it('src/util.ts has exactly one git spawn site (runGit, spawnSync) and src/git_async.ts exactly one (runGitAsync, spawnOwned)', () => {
    const siteTexts = (file: string): string[] => gitSpawnSites(fs.readFileSync(path.join(SRC_DIR, file), 'utf8')).map((s) => s.replace(/^\d+: /, '').replace(/^[^\w$]/, ''))
    expect(siteTexts('util.ts')).toEqual(['spawnSync(gitExecutable('])
    expect(siteTexts('git_async.ts')).toEqual(['spawnOwned(gitExecutable('])
  })

  // Provenance: HAND-DERIVED. Each snippet is written to be, or not to be, a git spawn by reading it, not by running the matcher.
  it.each([
    ["spawn('git', args)", true],
    ['spawnSync("git", args)', true],
    ['const r = cp.execFileSync(`git`, args)', true],
    ["execFile('git', ['status'])", true],
    ["exec('git status')", true],
    ["execSync('git log')", true],
    ["spawnOwned('git', args, opts)", true],
    ['spawnSync(gitExecutable(), args)', true],
    ['spawnSync(\n  "git",\n  args)', true],
    ['execFileSync(\n  `git`, [])', true],
    ["const g = resolveOnPath('git')", true],
    ["spawnResolvedSync('git', args, opts)", true],
    ["spawnResolvedSync(resolveOnPath('git') ?? 'git', args, opts)", true],
    ["spawnSync('gitk', args)", false],
    ["spawnSync('node', ['git'])", false],
    ["resolveOnPath('gitk')", false],
    ["// spawnSync('git', args)", false],
    ["/* exec('git status')\n   still prose */ const x = 1", false],
    ["const url = 'http://x/y'; spawnSync('node', [url])", false],
    ["const sparse = respawn('git')", false],
  ])('%s -> %s', (source, expected) => {
    expect(gitSpawnSites(source).length > 0).toBe(expected)
  })
})
