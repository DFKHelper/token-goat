/**
 * Regression: `token-goat index` counted a file it never indexed.
 *
 * A file that git still tracks but that no longer exists in the worktree (the state left by a
 * plain `rm`, and by every rename until the result is staged) is still returned by
 * getTrackedFiles, so it reached cmdIndex's per-file loop on every run. fingerprintFile returns
 * null for it, indexFileSync fail-softs on ENOENT without throwing, so nothing was written and
 * nothing was counted as failed -- and then `indexed += 1` at the bottom of the loop counted the
 * work anyway. Nothing converged it either: deleting the file is exactly what keeps it tracked
 * and absent, so the phantom count repeated on every subsequent run forever.
 *
 * After a rename this produced the headline symptom: `Indexed 1 file into the symbol index`
 * printed by the same run that had just pruned the index empty.
 *
 * Driven through the real cmdIndex against a real git repo with no --walk, because the tracked
 * file list is the only way a path that does not exist reaches the loop at all: the --walk form
 * the sibling tests in cmdindex_unchanged_skip.test.ts use enumerates the filesystem, where a
 * deleted file is simply absent and this branch is unreachable.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cmdIndex } from '../src/cli.js'
import { closeAllDbs } from '../src/db.js'
import { querySymbols } from '../src/index_reader.js'
import * as fingerprintModule from '../src/fingerprint.js'
import * as parserModule from '../src/parser.js'

let TMP: string
let dbPath: string

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: TMP, stdio: 'ignore' })
}

/** Collect everything cmdIndex writes to stdout, which is where the summary line lands. */
async function captureIndex(opts: Parameters<typeof cmdIndex>[1]): Promise<string> {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    await cmdIndex(TMP, opts)
    return spy.mock.calls.map((c) => String(c[0])).join('')
  } finally {
    spy.mockRestore()
  }
}

beforeEach(() => {
  TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cmdindex-vanished-')))
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

describe('cmdIndex and a tracked file that is gone from the worktree', () => {
  it('does not count a file it never indexed, on the run that deletes it or on any run after', async () => {
    fs.writeFileSync(path.join(TMP, 'gone.ts'), 'export function zqGone(): number {\n  return 1\n}\n')
    fs.writeFileSync(path.join(TMP, 'stays.ts'), 'export function zqStays(): number {\n  return 2\n}\n')
    git('add', '-A')
    git('commit', '-qm', 'seed')

    await captureIndex({ dbPath })
    expect(querySymbols({ name: 'zqGone', limit: 10 }, dbPath).length).toBe(1)

    fs.rmSync(path.join(TMP, 'gone.ts'))

    // A file known to be gone must not be handed to the parser at all. Asserted separately from
    // the count because the post-parse guard below would otherwise mask this one: with only that
    // guard, a vanished file is still opened and parsed before being dropped, and the count comes
    // out right for the wrong reason.
    const realIndexFileSync = parserModule.indexFileSync
    const parseSpy = vi
      .spyOn(parserModule, 'indexFileSync')
      .mockImplementation((filePath, dbp) => realIndexFileSync(filePath, dbp))

    // The run that notices the deletion. One file is unchanged and one is gone, so nothing at
    // all was indexed: the count must say so rather than crediting the file it could not read.
    const first = await captureIndex({ dbPath })
    expect(first, 'nothing was indexed on this run').toContain('Indexed 0 files into the symbol index.')
    expect(first).toContain('Pruned 1 deleted file(s).')
    expect(first, 'the vanished file must not be counted as indexed').not.toContain('Indexed 1 file ')
    expect(querySymbols({ name: 'zqGone', limit: 10 }, dbPath).length).toBe(0)
    expect(querySymbols({ name: 'zqStays', limit: 10 }, dbPath).length).toBe(1)
    expect(
      parseSpy.mock.calls.map((c) => String(c[0])).filter((f) => f.endsWith('gone.ts')),
      'a file already known to be gone must not be opened',
    ).toEqual([])

    // The run after. Its rows are already pruned, so there is no longer even a prune to explain
    // a non-zero number -- this is the run where the old count was purely phantom, and it
    // repeated forever, because a deleted file stays tracked and absent indefinitely.
    const second = await captureIndex({ dbPath })
    expect(second).toContain('Indexed 0 files into the symbol index.')
    expect(second).toContain('Skipped 1 unchanged file(s).')
    expect(second).not.toContain('Pruned')
  })

  // The same credit, through a narrower window: the file is present when the guard above checks
  // it and gone by the time its parse runs. indexFileSync fail-softs on ENOENT, so nothing is
  // written and nothing throws, and the count must still not claim it. Simulated by deleting the
  // file from inside the parse call, which is the one point where the race is deterministic.
  it('does not count a file that is deleted while its own parse is running', async () => {
    const racing = path.join(TMP, 'racing.ts')
    fs.writeFileSync(racing, 'export function zqRacing(): number { return 1 }')
    git('add', '-A')
    git('commit', '-qm', 'seed')

    vi.spyOn(parserModule, 'indexFileSync').mockImplementation((filePath) => {
      if (String(filePath).endsWith('racing.ts')) fs.rmSync(racing)
    })

    const out = await captureIndex({ dbPath })

    expect(out, 'nothing was written, so nothing may be counted').toContain(
      'Indexed 0 files into the symbol index.',
    )
    expect(out).not.toContain('Indexed 1 file ')
  })

  // The narrow half: the fix keys on the file being absent, not on the fingerprint being null.
  // A file that exists but cannot be read right now (a lock held by an AV scanner or an open
  // editor) also fingerprints as null, and must still get its normal reindex attempt rather than
  // being silently skipped as though it had been deleted.
  it('still attempts a file that exists but could not be fingerprinted', async () => {
    const locked = path.join(TMP, 'locked.ts')
    fs.writeFileSync(locked, 'export function zqLocked(): number {\n  return 1\n}\n')
    git('add', '-A')
    git('commit', '-qm', 'seed')

    vi.spyOn(fingerprintModule, 'fingerprintFile').mockReturnValue(null)

    const out = await captureIndex({ dbPath })

    expect(out, 'the file is on disk, so it is not a vanished file').toContain(
      'Indexed 1 file into the symbol index.',
    )
    expect(querySymbols({ name: 'zqLocked', limit: 10 }, dbPath).length).toBe(1)
  })
})
