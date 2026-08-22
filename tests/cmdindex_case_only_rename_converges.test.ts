/**
 * Regression: `token-goat index` reindexed the same unchanged file on every run, forever.
 *
 * On a case-insensitive filesystem an unstaged case-only rename is invisible to git, so
 * `git ls-files` keeps reporting `MixedName.ts` for a file whose directory entry now says
 * `mixedname.ts`. `indexedPathSpellingIsStale` noticed that drift and correctly cleared the sha
 * gate so the file would be reparsed -- but the reparse was then run as `indexFileSync(key)` with
 * the very same stale spelling git had supplied, so `writeParseResult` wrote the stale name
 * straight back. The next run detected the identical drift and did the identical useless work:
 * a full reparse and re-embed of a byte-identical file on every single `index` run, with every
 * `symbol`/`read`/`refs` answer naming a path that has no directory entry behind it.
 *
 * Why didn't a test catch this: the existing guard
 * (tests/guards/case_rename_updates_indexed_path.test.ts) drives `index --walk`, and the
 * filesystem walk supplies the *dirent's* spelling -- the one case where the caller is already
 * right and the row converges on its own. Git enumeration is the only caller that hands the
 * indexer a spelling the filesystem disagrees with, and nothing exercised it. This file does,
 * through the real cmdIndex against a real git repo with no --walk, and asserts convergence
 * rather than a single run's output: run 2 is allowed to do the corrective work, run 3 must find
 * nothing left to do.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cmdIndex } from '../src/cli.js'
import { closeAllDbs } from '../src/db.js'
import { querySymbols } from '../src/index_reader.js'
import { canonicalizeIndexPath, indexFileSync } from '../src/parser.js'

let TMP: string
let dbPath: string

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: TMP, stdio: 'ignore' })
}

async function captureIndex(): Promise<string> {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    await cmdIndex(TMP, { dbPath })
    return spy.mock.calls.map((c) => String(c[0])).join('')
  } finally {
    spy.mockRestore()
  }
}

/**
 * Does the host filesystem itself fold case? Probed rather than inferred from `process.platform`,
 * because this case needs the stale spelling to still open a file, which no environment override
 * can arrange on a genuinely case-sensitive filesystem.
 */
function hostFsIsCaseInsensitive(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-caseprobe-'))
  fs.writeFileSync(path.join(dir, 'CaseProbe.txt'), 'x')
  return fs.existsSync(path.join(dir, 'caseprobe.txt'))
}

beforeEach(() => {
  TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-caseconv-')))
  dbPath = path.join(TMP, 'index.db')
  git('init', '-q', '.')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
})

afterEach(() => {
  vi.restoreAllMocks()
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('cmdIndex and a case-only rename git has not seen', () => {
  it.skipIf(!hostFsIsCaseInsensitive())('converges instead of reindexing the same file forever', async () => {
    fs.writeFileSync(
      path.join(TMP, 'MixedName.ts'),
      'export function zqCaseOnly(): number {\n  return 1\n}\n',
    )
    git('add', '-A')
    git('commit', '-qm', 'seed')
    await captureIndex()

    // Two steps: renaming straight to a case variant is a no-op on a case-insensitive filesystem.
    fs.renameSync(path.join(TMP, 'MixedName.ts'), path.join(TMP, 'tmpname.ts'))
    fs.renameSync(path.join(TMP, 'tmpname.ts'), path.join(TMP, 'mixedname.ts'))
    // The rename is deliberately left unstaged: this is the state git cannot see.
    expect(execFileSync('git', ['ls-files'], { cwd: TMP, encoding: 'utf-8' }).trim()).toBe(
      'MixedName.ts',
    )

    // Run 2 is allowed to do real work -- it is the run that corrects the stored spelling.
    await captureIndex()

    const stored = querySymbols({ name: 'zqCaseOnly' }, dbPath)
    expect(stored.length, 'the symbol vanished from the index entirely').toBe(1)
    expect(
      path.basename(stored[0]!.filePath),
      "the index kept git's spelling, which no directory entry has",
    ).toBe('mixedname.ts')

    // Run 3 is the whole point: with the row corrected there is nothing left to do, so a third
    // run must skip the file. Before the fix it reparsed and re-embedded it again, and so did
    // every run after that.
    const third = await captureIndex()
    expect(third, 'an unchanged file was reindexed again, so the index never converges').toContain(
      'Indexed 0 files',
    )
    expect(third).toContain('Skipped 1 unchanged file')
  })
})

describe('canonicalizeIndexPath', () => {
  it('returns the caller path untouched when the file cannot be resolved', () => {
    // A git-tracked file deleted from the worktree still reaches the indexer on every run. It has
    // to keep the name callers know it by, or the deletion sweep can no longer find its rows.
    const missing = path.join(TMP, 'NoSuchFile.ts')
    expect(canonicalizeIndexPath(missing)).toBe(missing)
  })

  it.skipIf(!hostFsIsCaseInsensitive())('adopts the filesystem spelling of the final segment', () => {
    fs.writeFileSync(path.join(TMP, 'CanonName.ts'), 'export const x = 1\n')
    expect(path.basename(canonicalizeIndexPath(path.join(TMP, 'canonname.ts')))).toBe('CanonName.ts')
  })

  it.skipIf(!hostFsIsCaseInsensitive())('refuses a resolved name that lives in another directory', () => {
    // fs.realpathSync.native follows symlinks and Windows junctions, so a link can resolve to a
    // fold-equal basename belonging to a completely different file. Adopting it would put a name
    // in the row that has no directory entry where the row says it does.
    fs.mkdirSync(path.join(TMP, 'real'))
    fs.writeFileSync(path.join(TMP, 'real', 'Alias.ts'), 'export const z = 1\n')
    const link = path.join(TMP, 'alias.ts')
    try {
      fs.symlinkSync(path.join(TMP, 'real', 'Alias.ts'), link, 'file')
    } catch {
      return // unprivileged Windows cannot create symlinks; nothing to assert
    }
    expect(canonicalizeIndexPath(link), 'a symlink target renamed the link').toBe(link)
  })

  it.skipIf(!hostFsIsCaseInsensitive())('leaves the directory prefix exactly as the caller spelled it', () => {
    // fs.realpathSync.native canonicalizes every parent directory too. Adopting its whole answer
    // would rewrite rows to an ambient prefix spelling the caller never used, churning paths for
    // a difference that is not the file's own.
    fs.mkdirSync(path.join(TMP, 'SubDir'))
    fs.writeFileSync(path.join(TMP, 'SubDir', 'leaf.ts'), 'export const y = 1\n')
    const out = canonicalizeIndexPath(path.join(TMP, 'subdir', 'leaf.ts')).replace(/\\/g, '/')
    expect(out).toContain('/subdir/leaf.ts')
  })
})

describe('indexFileSync, the choke point every writer shares', () => {
  it.skipIf(!hostFsIsCaseInsensitive())('records the filesystem spelling, not the caller\'s', () => {
    // The bulk index command, the background worker, and read\'s --force-refresh all reach the
    // database through this one call, each with its own idea of how the file is spelled. Whatever
    // they pass, one spelling has to come out, or two writers keep overwriting each other\'s row.
    fs.writeFileSync(path.join(TMP, 'Writer.ts'), 'export function zqWriter(): number {\n  return 1\n}\n')
    indexFileSync(path.join(TMP, 'writer.ts'), dbPath)

    const rows = querySymbols({ name: 'zqWriter' }, dbPath)
    expect(rows.length, 'the symbol was never written').toBe(1)
    expect(path.basename(rows[0]!.filePath), 'the caller\'s spelling was stored verbatim').toBe(
      'Writer.ts',
    )
  })
})
