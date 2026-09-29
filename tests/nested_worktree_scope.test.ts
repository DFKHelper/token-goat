/** Regression: a git linked worktree nested under a project root is a second copy of the project, and every rootDir-scoped read used to include it. Claude Code creates agent worktrees under `<project>/.claude/worktrees/<name>`, so `token-goat symbol drainOnce` run from this repository answered with the real definition plus one per agent worktree, and search and semantic ranked the stale copies against the live file. The prefix range over the root takes in anything below it; nested_worktrees.ts subtracts each linked worktree git records under the root.
 *
 * Provenance: the worktrees are made by the real `git worktree add` (CAPTURE of git's own gitdir format, e.g. git 2.53.0.windows.1 writes `C:/Projects/token-goat/.claude/worktrees/agent-a02f3e7ed18567383/.git` into `.git/worktrees/<name>/gitdir`); the relative-gitdir case is written by hand in the shape git documents for `worktree.useRelativePaths` (FORMAT-DERIVED, git-worktree(1) "worktree.useRelativePaths"); the symbol rows and expected sets are HAND-DERIVED. */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs, getDb } from '../src/db.js'
import { DEFAULT_DIM, fetchScopedExactHits, fetchScopedHits, insertChunkVector } from '../src/embeddings.js'
import { resolveSubject } from '../src/answer_router.js'
import { getOwnProjectFileEntries, getProjectFileEntries, querySymbols, searchSymbolsFts } from '../src/index_reader.js'
import { nestedWorktreeRoots } from '../src/nested_worktrees.js'
import { normalizePath } from '../src/paths.js'
import { executeParallelSearch } from '../src/search/parallel_search.js'
import { searchSymbolsFtsByKind } from '../src/search/symbol_fts.js'
import Database from '../src/sqlite_driver.js'
import { forEachSymbol, projectStructuredFiles, projectSymbolNames } from '../src/symbol_scan.js'
import { isCaseInsensitiveFs } from '../src/util.js'

function vec0Working(): boolean {
  const req = createRequire(import.meta.url)
  try {
    const sqliteVec = req('sqlite-vec') as { load: (db: unknown) => void }
    const probe = new Database(':memory:')
    sqliteVec.load(probe)
    probe.prepare('SELECT vec_version()').get()
    probe.close()
    return true
  } catch {
    return false
  }
}

const QUERY_VEC: number[] = Array(DEFAULT_DIM).fill(0.01)

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'ignore' })
}

let base: string
let root: string
let nested: string
let sibling: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-nested-wt-'))
  root = normalizePath(path.join(base, 'proj'))
  fs.mkdirSync(root)
  git(root, 'init', '-q')
  git(root, 'commit', '-q', '--allow-empty', '-m', 'x')
  nested = `${root}/.claude/worktrees/x`
  sibling = `${root}-sib`
  git(root, 'worktree', 'add', '-q', nested)
  git(root, 'worktree', 'add', '-q', sibling)
})

afterEach(() => {
  vi.restoreAllMocks()
  closeAllDbs()
  fs.rmSync(base, { recursive: true, force: true })
})

/** One `dup` definition in each copy, plus a name only the nested copy has, so a leak shows as an extra row or an extra name. */
function seedSymbols(): void {
  const ins = getDb(globalDbPath()).prepare(
    'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?,?,?,?,?,?,?)',
  )
  ins.run(`${root}/a.ts`, 'dup', 'function', 1, 3, 'function dup() {}', null)
  ins.run(`${nested}/a.ts`, 'dup', 'function', 1, 3, 'function dup() {}', null)
  ins.run(`${nested}/b.ts`, 'onlyInNested', 'function', 1, 3, 'function onlyInNested() {}', null)
  ins.run(`${sibling}/a.ts`, 'dup', 'function', 1, 3, 'function dup() {}', null)
}

describe('nestedWorktreeRoots', () => {
  it('lists a worktree git created under the root, and not one beside it', () => {
    expect(nestedWorktreeRoots(root).map((p) => p.toLowerCase())).toEqual([nested.toLowerCase()])
  })

  it('is empty for the worktree itself and for a directory that is not a checkout', () => {
    expect(nestedWorktreeRoots(nested)).toEqual([])
    const plain = normalizePath(path.join(base, 'plain'))
    fs.mkdirSync(plain)
    expect(nestedWorktreeRoots(plain)).toEqual([])
  })

  it('follows a relative gitdir, as git writes under worktree.useRelativePaths', () => {
    const entry = path.join(root, '.git', 'worktrees', 'rel')
    fs.mkdirSync(entry, { recursive: true })
    fs.writeFileSync(path.join(entry, 'gitdir'), '../../../sub/rel/.git\n')
    const listed = nestedWorktreeRoots(root).map((p) => p.toLowerCase())
    expect(listed).toContain(`${root}/sub/rel`.toLowerCase())
    expect(listed).toContain(nested.toLowerCase())
  })

  it('re-spells a worktree under the root as given when the root is reached through a link', () => {
    // macOS's /var -> /private/var and a Windows 8.3 temp path are this case: git records the resolved path, the index stores the one the project was opened by
    const link = normalizePath(path.join(base, 'link'))
    fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(nestedWorktreeRoots(link).map((p) => p.toLowerCase())).toEqual([`${link}/.claude/worktrees/x`.toLowerCase()])
  })

  it('drops a worktree once git removes it, in a process that already asked', () => {
    expect(nestedWorktreeRoots(root)).toHaveLength(1)
    // mtime resolution on some filesystems is coarse; the removal changes the directory listing either way, and the check is on mtime, so step it explicitly
    git(root, 'worktree', 'remove', '--force', nested)
    const listDir = path.join(root, '.git', 'worktrees')
    const later = new Date(Date.now() + 5_000)
    if (fs.existsSync(listDir)) fs.utimesSync(listDir, later, later)
    expect(nestedWorktreeRoots(root)).toEqual([])
  })
})

describe('rootDir-scoped reads leave out a nested worktree', () => {
  it('querySymbols returns only the root copy', () => {
    seedSymbols()
    const rows = querySymbols({ name: 'dup', rootDir: root })
    expect(rows.map((r) => r.filePath.toLowerCase())).toEqual([`${root}/a.ts`.toLowerCase()])
  })

  it('both FTS paths return only the root copy', () => {
    seedSymbols()
    expect(searchSymbolsFts('dup', 50, globalDbPath(), root).map((r) => r.filePath.toLowerCase())).toEqual([`${root}/a.ts`.toLowerCase()])
    expect(searchSymbolsFtsByKind('dup', 50, globalDbPath(), root, { notEquals: 'heading' }).map((r) => r.filePath.toLowerCase())).toEqual([
      `${root}/a.ts`.toLowerCase(),
    ])
  })

  it('forEachSymbol and projectSymbolNames see only the root copy', () => {
    seedSymbols()
    const seen: string[] = []
    forEachSymbol({ rootDir: root }, (s) => seen.push(`${s.name}@${s.filePath.toLowerCase()}`))
    expect(seen).toEqual([`dup@${root}/a.ts`.toLowerCase()])
    expect(projectSymbolNames(root)).toEqual(['dup'])
  })

  it('projectStructuredFiles leaves out the nested copy of a JSON file', () => {
    const db = getDb(globalDbPath())
    const insFile = db.prepare('INSERT INTO files (path, sha, mtime) VALUES (?,?,?)')
    const insSym = db.prepare('INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?,?,?,?,?,?,?)')
    for (const dir of [root, nested]) {
      insFile.run(`${dir}/package.json`, 'x', 0)
      insSym.run(`${dir}/package.json`, 'name', 'key', 1, 1, '"name"', null)
    }
    expect(projectStructuredFiles(root).map((p) => p.toLowerCase())).toEqual([`${root}/package.json`.toLowerCase()])
  })

  it('the worktree, queried as its own project, still sees its own rows', () => {
    seedSymbols()
    expect(querySymbols({ name: 'dup', rootDir: nested }).map((r) => r.filePath.toLowerCase())).toEqual([`${nested}/a.ts`.toLowerCase()])
    expect(projectSymbolNames(nested)?.sort()).toEqual(['dup', 'onlyInNested'])
  })

  it('a sibling worktree is its own project and was never in scope', () => {
    seedSymbols()
    expect(querySymbols({ name: 'dup', rootDir: sibling }).map((r) => r.filePath.toLowerCase())).toEqual([`${sibling}/a.ts`.toLowerCase()])
  })

  it.skipIf(!isCaseInsensitiveFs())('holds when the root is spelled in a different case', () => {
    seedSymbols()
    const upper = root.toUpperCase()
    expect(querySymbols({ name: 'dup', rootDir: upper }).map((r) => r.filePath.toLowerCase())).toEqual([`${root}/a.ts`.toLowerCase()])
    const seen: string[] = []
    forEachSymbol({ rootDir: upper, name: 'dup' }, (s) => seen.push(s.filePath.toLowerCase()))
    expect(seen).toEqual([`${root}/a.ts`.toLowerCase()])
  })

  it('once the worktree is removed its leftover rows are in scope again, like any other file under the root', () => {
    seedSymbols()
    git(root, 'worktree', 'remove', '--force', nested)
    const listDir = path.join(root, '.git', 'worktrees')
    const later = new Date(Date.now() + 5_000)
    if (fs.existsSync(listDir)) fs.utimesSync(listDir, later, later)
    expect(querySymbols({ name: 'dup', rootDir: root })).toHaveLength(2)
  })
})

describe('file-list read paths leave out a nested worktree', () => {
  /** The same file, on disk and in the `files` table, in the root and in the nested worktree. Below `src/` so that a bare basename does not resolve as a path relative to the working directory, which would skip the basename scan under test. */
  function seedFiles(): void {
    const ins = getDb(globalDbPath()).prepare('INSERT INTO files (path, sha, mtime) VALUES (?,?,?)')
    for (const dir of [root, nested]) {
      fs.mkdirSync(`${dir}/src`, { recursive: true })
      fs.writeFileSync(`${dir}/src/unique_mod.ts`, 'export const needleQz7 = 1\n')
      ins.run(`${dir}/src/unique_mod.ts`, 'x', 0)
    }
  }

  it('the search text channel matches only the root copy', async () => {
    seedFiles()
    const summary = await executeParallelSearch({ query: 'needleQz7', channels: ['text'], projectRoot: root })
    expect(summary.results.map((r) => r.filePath.toLowerCase())).toEqual([`${root}/src/unique_mod.ts`.toLowerCase()])
  })

  it('answer resolves a bare file name to the root copy instead of calling it ambiguous', () => {
    seedFiles()
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    const resolved = resolveSubject('unique_mod.ts', 'file-only')
    expect(resolved?.kind).toBe('file')
    expect(resolved?.kind === 'file' ? resolved.path.toLowerCase() : null).toBe(`${root}/src/unique_mod.ts`.toLowerCase())
  })

  it('reconcile still sees the nested rows, so it can clean up after a deleted worktree file', () => {
    seedFiles()
    const keys = [...getProjectFileEntries(root).values()].map((e) => e.filePath.toLowerCase()).sort()
    expect(keys).toEqual([`${nested}/src/unique_mod.ts`.toLowerCase(), `${root}/src/unique_mod.ts`.toLowerCase()].sort())
    expect([...getOwnProjectFileEntries(root).values()].map((e) => e.filePath.toLowerCase())).toEqual([`${root}/src/unique_mod.ts`.toLowerCase()])
  })
})

describe.skipIf(!vec0Working())('semantic candidates leave out a nested worktree', () => {
  function seedChunk(filePath: string): void {
    const db = getDb(globalDbPath())
    const r = db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?,?,?,?,?)').run(filePath, 1, 1, 'dup chunk', 'code')
    insertChunkVector(db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)'), r.lastInsertRowid, QUERY_VEC)
  }

  it('fetchScopedHits and fetchScopedExactHits return only the root chunk', () => {
    seedChunk(`${root}/a.ts`)
    seedChunk(`${nested}/a.ts`)
    seedChunk(`${sibling}/a.ts`)
    const db = getDb(globalDbPath())
    const { hits } = fetchScopedHits(db, QUERY_VEC, 10, 1.2, root)
    expect(hits.map((h) => h.filePath.toLowerCase())).toEqual([`${root}/a.ts`.toLowerCase()])
    expect(fetchScopedExactHits(db, QUERY_VEC, 10, 1.2, root).map((h) => h.filePath.toLowerCase())).toEqual([`${root}/a.ts`.toLowerCase()])
  })
})
