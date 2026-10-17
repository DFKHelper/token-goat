/** Guard: git is started in exactly one place, `runGit` in src/util.ts. That one site is where `core.fsmonitor` is turned off, diff drivers are kept from running, and (on Windows) the real git is started instead of its launcher so a timeout ends the process that matters. A second spawn site skips all three. tests/git_chokepoint.test.ts looks only at spawn, spawnSync, exec and execSync with a literal 'git'; this one also covers execFile, execFileSync, spawnOwned and a call that takes the resolved file from gitExecutable(). */

// tg-no-regex-preload
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** A process-starting call whose first argument is the literal git (or a literal command line beginning with git) or the file gitExecutable() resolves. */
const GIT_SPAWN = /(?:^|[^\w$])(?:spawn|spawnSync|spawnOwned|execFile|execFileSync|exec|execSync)\(\s*(?:['"`]git\b|gitExecutable\()/

/** One entry per line of `source` that starts git, whole-line comments skipped: `line: text`. */
function gitSpawnSites(source: string): string[] {
  const found: string[] = []
  source.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    if (GIT_SPAWN.test(line)) found.push(`${i + 1}: ${trimmed}`)
  })
  return found
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
  it('no file in src/ but util.ts starts git', () => {
    const files = pinnedPopulation({
      what: 'src/**/*.ts files scanned for git spawns',
      items: walkSrc(SRC_DIR).map((f) => f.split(path.sep).join('/')),
      floor: 150,
      mustInclude: ['src/util.ts', 'src/manifest.ts', 'src/hooks_session.ts'],
    })
    const stray: string[] = []
    for (const file of files) {
      if (file.endsWith('/src/util.ts')) continue
      for (const site of gitSpawnSites(fs.readFileSync(file, 'utf8'))) stray.push(`${path.relative(SRC_DIR, file)}:${site}`)
    }
    expect(stray, 'git must be started through runGit in src/util.ts, never by a spawn of its own').toEqual([])
  })

  it('src/util.ts, the one sanctioned site, is seen by the matcher', () => {
    expect(gitSpawnSites(fs.readFileSync(path.join(SRC_DIR, 'util.ts'), 'utf8')).length).toBeGreaterThan(0)
  })

  // Provenance: HAND-DERIVED. Each line is written to be, or not to be, a git spawn by reading it, not by running the matcher.
  it.each([
    ["spawn('git', args)", true],
    ['spawnSync("git", args)', true],
    ['const r = cp.execFileSync(`git`, args)', true],
    ["execFile('git', ['status'])", true],
    ["exec('git status')", true],
    ["execSync('git log')", true],
    ["spawnOwned('git', args, opts)", true],
    ['spawnSync(gitExecutable(), args)', true],
    ['spawnSync(\n', false],
    ["spawnSync('gitk', args)", false],
    ["spawnSync('node', ['git'])", false],
    ["// spawnSync('git', args)", false],
    [" * exec('git status') is the old form", false],
    ["const sparse = respawn('git')", false],
  ])('%s -> %s', (line, expected) => {
    expect(gitSpawnSites(line).length > 0).toBe(expected)
  })
})
