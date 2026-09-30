// `token-goat index C:\x --walk` under WSL has to walk /mnt/c/x, the folder behind that spelling there; POSIX resolves `c:/x` as a relative path to nothing. tests/cmdindex_root_spelled_as_a_mount.test.ts pins the Windows half, where a mount spelling has to open at its drive letter, with its CAPTURE. A runner cannot create /mnt/<letter>, so one mount is mapped onto a temp directory through node:fs as tests/hook_reads_of_a_drive_letter_key_open_its_wsl_mount.test.ts does, adding readdirSync for the walk. The spellings are HAND-DERIVED from WSL's documented convention of mounting drive Q: at /mnt/q.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cmdIndex } from '../src/cli.js'
import { closeAllDbs } from '../src/db.js'
import { querySymbols } from '../src/index_reader.js'

const MOUNT = '/mnt/q/'

const mounted = vi.hoisted(() => ({ root: null as string | null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const onHost = (p: unknown): unknown =>
    mounted.root !== null && typeof p === 'string' && p.startsWith(MOUNT) ? path.join(mounted.root, p.slice(MOUNT.length)) : p
  const wrap = <F>(fn: F): F => ((p: unknown, ...rest: unknown[]) => (fn as (...args: unknown[]) => unknown)(onHost(p), ...rest)) as F
  const overrides = {
    statSync: wrap(actual.statSync),
    lstatSync: wrap(actual.lstatSync),
    readFileSync: wrap(actual.readFileSync),
    openSync: wrap(actual.openSync),
    existsSync: wrap(actual.existsSync),
    readdirSync: wrap(actual.readdirSync),
  }
  return { ...actual, ...overrides, default: { ...actual, ...overrides } }
})

let dbPath: string

beforeEach(() => {
  mounted.root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cmdindex-winform-'))
  fs.mkdirSync(path.join(mounted.root, 'proj'))
  fs.writeFileSync(path.join(mounted.root, 'proj', 'y.ts'), 'export function zqWinFormProbe(): number {\n  return 3\n}\n')
  dbPath = path.join(os.tmpdir(), `tg-cmdindex-winform-${process.pid}-${Math.random().toString(36).slice(2)}.db`)
})

afterEach(() => {
  vi.restoreAllMocks()
  closeAllDbs()
  if (mounted.root !== null) fs.rmSync(mounted.root, { recursive: true, force: true })
  mounted.root = null
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true })
})

describe.runIf(process.platform !== 'win32')('cmdIndex given a root typed in Windows form on a POSIX host', () => {
  it('walks the folder at its WSL mount and keys the file there', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    let out: string
    try {
      await cmdIndex('Q:\\proj', { walk: true, dbPath })
      out = spy.mock.calls.map((c) => String(c[0])).join('')
    } finally {
      spy.mockRestore()
    }
    expect(out).toContain('Indexed 1 file into the symbol index.')
    const hits = querySymbols({ name: 'zqWinFormProbe', limit: 10 }, dbPath)
    expect(hits.map((h) => h.filePath)).toEqual(['/mnt/q/proj/y.ts'])
  })
})
