/** Regression: `token-goat index <root>` indexed nothing, and said so as a success, when the root did not open on this host. cmdIndex handed its root argument to getTrackedFiles and collectWalkIndexFiles as typed. On Windows, a root spelled at its WSL mount (`/mnt/c/x`) or its Git Bash mount (`/c/x`) reaches the CLI unconverted when it is typed in PowerShell or cmd, or passed from a script run with MSYS_NO_PATHCONV=1, and node resolves it against the current drive as `C:\mnt\c\x`, a folder that does not exist. CAPTURE (Windows 11, built bundle 2.9.29, isolated home, a folder holding one `y.ts`, MSYS_NO_PATHCONV=1): `index /mnt/c/Projects/tg-idx-probe --walk` and `index /c/Projects/tg-idx-probe --walk` each printed `Indexed 0 files into the symbol index.` and exited 0, while `index C:\Projects\tg-idx-probe --walk` found the file. A root that does not exist at all behaved the same way under --walk (`Indexed 0 files`, exit 0), and without --walk it was reported as a folder that is not a git repo. Every per-file key in the loop already went through resolveIndexPath, which folds a mount to the drive-letter key on Windows; only the root that finds the files did not. */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cmdIndex } from '../src/cli.js'
import { closeAllDbs } from '../src/db.js'
import { querySymbols } from '../src/index_reader.js'
import { normalizePath, resolveIndexPath } from '../src/paths.js'

let TMP: string
let dbPath: string

async function captureIndex(root: string, opts: Parameters<typeof cmdIndex>[1]): Promise<string> {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    await cmdIndex(root, opts)
    return spy.mock.calls.map((c) => String(c[0])).join('')
  } finally {
    spy.mockRestore()
  }
}

/** The mount spellings of a Windows path. HAND-DERIVED from each shell's documented convention: WSL mounts drive C: at `/mnt/c`, Git Bash (MSYS2) at `/c`. */
function mountSpellings(winPath: string): { wsl: string; msys: string } {
  const m = /^([a-z]):\/(.*)$/.exec(normalizePath(winPath))
  if (!m) throw new Error(`not a drive-letter path: ${winPath}`)
  const [, drive, rest] = m
  return { wsl: `/mnt/${drive}/${rest}`, msys: `/${drive}/${rest}` }
}

beforeEach(() => {
  TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cmdindex-mount-')))
  dbPath = path.join(os.tmpdir(), `tg-cmdindex-mount-${process.pid}-${Math.random().toString(36).slice(2)}.db`)
  fs.writeFileSync(path.join(TMP, 'y.ts'), 'export function zqMountProbe(): number {\n  return 2\n}\n')
})

afterEach(() => {
  vi.restoreAllMocks()
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true })
})

describe.runIf(process.platform === 'win32')('cmdIndex given a root spelled at its drive mount on Windows', () => {
  it.each(['wsl', 'msys'] as const)('indexes the folder behind a %s mount spelling, under the drive-letter key', async (kind) => {
    const root = mountSpellings(TMP)[kind]
    const out = await captureIndex(root, { walk: true, dbPath })
    expect(out, `the ${kind} spelling ${root} names this folder`).toContain('Indexed 1 file into the symbol index.')
    const hits = querySymbols({ name: 'zqMountProbe', limit: 10 }, dbPath)
    expect(hits.map((h) => h.filePath)).toEqual([resolveIndexPath(path.join(TMP, 'y.ts'))])
  })
})

describe('cmdIndex given a root that does not exist', () => {
  it('refuses under --walk instead of reporting 0 files indexed', async () => {
    const missing = path.join(TMP, 'no-such-dir')
    await expect(captureIndex(missing, { walk: true, dbPath })).rejects.toThrow(/does not exist/)
  })

  it('says the root does not exist rather than that it is not a git repo', async () => {
    const missing = path.join(TMP, 'no-such-dir')
    await expect(captureIndex(missing, { dbPath })).rejects.toThrow(/does not exist/)
  })

  it('still indexes a root that is a single file', async () => {
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', '.'], { cwd: TMP, stdio: 'ignore' })
    execFileSync('git', ['add', 'y.ts'], { cwd: TMP, stdio: 'ignore' })
    const out = await captureIndex(path.join(TMP, 'y.ts'), { dbPath })
    expect(out).toContain('Indexed 1 file into the symbol index.')
  })
})
