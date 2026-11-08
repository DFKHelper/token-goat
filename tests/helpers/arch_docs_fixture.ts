// Fixture helpers shared by the three architecture_docs guard files: each file registers the cleanup with useArchDocFixtures() and builds its own templates, so the files run in parallel workers.
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, expect } from 'vitest'

import { runCli } from '../../scripts/sync-arch-docs.mjs'
import { scrubRepoLocalGitEnv } from './git-env.js'
import { indexableDir } from './temp-config.js'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const ENGINE = path.join(ROOT, 'scripts', 'sync-arch-docs.mjs')
export const START = '<!-- ARCH_COMPONENTS_START -->'
export const END = '<!-- ARCH_COMPONENTS_END -->'

// FIXTURE PROVENANCE. The module sources, the doc and the config below are HAND-DERIVED: written by hand, with the expected rows worked out from the contract rather than read off the engine's output. The finding wording is FORMAT-DERIVED from SKILL.md "--check Output Contract" (arch-doc-sync skill, items 1, 2, 3 and 6), and the table shape from SKILL.md "Component Table Contract".
export const CONFIG = JSON.stringify({ doc: 'ARCH.md', roots: ['src'], layers: [['src/a.ts', 'Core'], ['src', 'Rest']] })
export const A_TS = '/** Alpha does the first thing. It also does more. */\nexport const alpha = 1\n'
export const B_TS = 'export function beta(): void {}\nexport const gamma = 2\n'
export const DOC_HEAD = '# Architecture\n\nProse before the table.\n\n'
export const DOC_TAIL = '\nProse after the table.\n'

export function git(cwd: string, args: string[]): void {
  const env = { ...process.env }
  scrubRepoLocalGitEnv(env)
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, env, stdio: 'ignore' })
}

export interface Fixture {
  dir: string
  doc: string
}

export const DEFAULT_DOC = `${DOC_HEAD}${START}\n${END}\n${DOC_TAIL}`
// A fixture is built once per key and each row copies it: the git and engine starts that build it are paid once per file, not once per row.
export const templates = new Map<string, string>()
export const templateDirs: string[] = []

export function scratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-archdoc-'))
}

/** A fresh copy of the template for `key`, built on first use. Copying is file I/O, so it starts no git or node process. */
export function fromTemplate(key: string, build: (dir: string) => void, dest: () => string): string {
  let template = templates.get(key)
  if (template === undefined) {
    template = scratchDir()
    templateDirs.push(template)
    build(template)
    templates.set(key, template)
  }
  const dir = dest()
  scratchDirs.push(dir)
  fs.cpSync(template, dir, { recursive: true })
  return dir
}

/** Writes the two modules, the config and the doc, not yet in git. */
export function writeModules(dir: string, docText: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), A_TS)
  fs.writeFileSync(path.join(dir, 'src', 'b.ts'), B_TS)
  fs.writeFileSync(path.join(dir, '.arch-doc-sync.json'), CONFIG)
  fs.writeFileSync(path.join(dir, 'ARCH.md'), docText)
}

/** Writes the modules and the doc into a git repo, all tracked. */
export function buildRepo(dir: string, docText: string): void {
  writeModules(dir, docText)
  git(dir, ['init', '-q'])
  git(dir, ['add', '.'])
}

/** A throwaway git repo with two modules, a config and an empty marker pair, all tracked. */
export function makeRepo(docText = DEFAULT_DOC): Fixture {
  const dir = fromTemplate(`makeRepo:${docText}`, (t) => buildRepo(t, docText), indexableDir)
  return { dir, doc: path.join(dir, 'ARCH.md') }
}

/** Runs the engine as a command from `dir`, the way `npm run docs:arch` does. */
export function engineEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  scrubRepoLocalGitEnv(env)
  return { ...env, ...extra }
}

export function engineWithEnv(dir: string, extra: NodeJS.ProcessEnv, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [ENGINE, ...args], { cwd: dir, env: engineEnv(extra), encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Runs the engine in process from `dir`: the same findings, stdout and exit code as the command, with no node start. The repo-local git variables are scrubbed for the call only. Rows that test the command itself use `engineWithEnv`. */
export function engine(dir: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const out = { stdout: '', stderr: '' }
  const saved = { ...process.env }
  scrubRepoLocalGitEnv(process.env)
  try {
    const status = runCli(args, {
      cwd: dir,
      stderr: (line) => {
        out.stderr += `${line}\n`
      },
      stdout: (line) => {
        out.stdout += `${line}\n`
      },
    })
    return { status, ...out }
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
    Object.assign(process.env, saved)
  }
}

export const synced = (): Fixture => {
  const dir = fromTemplate(
    'synced',
    (t) => {
      buildRepo(t, DEFAULT_DOC)
      expect(engine(t, '--write').status).toBe(0)
    },
    indexableDir,
  )
  return { dir, doc: path.join(dir, 'ARCH.md') }
}


// FIXTURE PROVENANCE (staged, JSON and curated-role rows). Module sources, docs and expected rows are HAND-DERIVED from the contract. The finding, warning and note wording, the --staged error texts and the JSON key order are FORMAT-DERIVED from SKILL.md "Core Invariants" item 3, "Operating Modes" (Verification Mode) and "--check Output Contract" items 1, 2, 3 and 7 plus the JSON shape; the note texts also match the reference engine's self_test Cases 14 to 19. The git record bytes in the parseNameStatus row are FORMAT-DERIVED from git-diff(1) "-z" name-status output (R and C records carry a score and two paths).
export const IDENTITY = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
export const BETA_ROLE = 'Hand written beta role'
export const scratchDirs: string[] = []

/** Registers the removal of every scratch repo after each row and of the templates after the file. Called once at the top of each guard file. */
export function useArchDocFixtures(): void {
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })
  
  afterAll(() => {
    for (const dir of templateDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    templates.clear()
  })
}

export function gitOut(cwd: string, args: string[]): string {
  const env = { ...process.env, ...IDENTITY }
  scrubRepoLocalGitEnv(env)
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** A repo under the OS temp dir holding the two modules and the config, an empty marker pair, removed after the test. */
export function scratchRepo(): string {
  return fromTemplate(
    'scratch',
    (t) => {
      writeModules(t, DEFAULT_DOC)
      gitOut(t, ['init', '-q'])
    },
    scratchDir,
  )
}

/** A committed repo whose table is written and whose src/b.ts row carries a curated role. */
export function curatedRepo(): string {
  return fromTemplate(
    'curated',
    (dir) => {
      writeModules(dir, DEFAULT_DOC)
      gitOut(dir, ['init', '-q'])
      gitOut(dir, ['add', '.'])
      expect(engine(dir, '--write').status).toBe(0)
      const doc = path.join(dir, 'ARCH.md')
      fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('Rest module: b.ts', BETA_ROLE))
      gitOut(dir, ['commit', '-q', '-a', '-m', 'base'])
    },
    scratchDir,
  )
}

