// paths.ts::hostPathOfTypedPath is the path the host opens for a path as typed: `token-goat index C:\x` under WSL has to walk /mnt/c/x, and before cmdIndex went through it the typed root named nothing on either platform. CAPTURE (Windows 11, built bundle 2.9.29, MSYS_NO_PATHCONV=1): `index /mnt/c/Projects/tg-idx-probe --walk` printed `Indexed 0 files into the symbol index.` and exited 0; tests/cmdindex_root_spelled_as_a_mount.test.ts pins that half through cmdIndex itself. The Linux half cannot run on a Windows runner, and a runner cannot create /mnt/<letter>, so one mount is mapped onto a temp directory through node:fs as tests/hook_reads_of_a_drive_letter_key_open_its_wsl_mount.test.ts does. The expected spellings are HAND-DERIVED from each shell's documented convention: WSL mounts drive Q: at /mnt/q, Git Bash (MSYS2) at /q.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hostPathOfTypedPath } from '../src/paths.js'

const MOUNT = '/mnt/q/'

const mounted = vi.hoisted(() => ({ root: null as string | null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const onHost = (p: unknown): unknown =>
    mounted.root !== null && typeof p === 'string' && p.startsWith(MOUNT) ? path.join(mounted.root, p.slice(MOUNT.length)) : p
  const wrap = <F>(fn: F): F => ((p: unknown, ...rest: unknown[]) => (fn as (...args: unknown[]) => unknown)(onHost(p), ...rest)) as F
  const overrides = { statSync: wrap(actual.statSync) }
  return { ...actual, ...overrides, default: { ...actual, ...overrides } }
})

beforeEach(() => {
  mounted.root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-typed-path-'))
  fs.mkdirSync(path.join(mounted.root, 'proj'))
})

afterEach(() => {
  if (mounted.root !== null) fs.rmSync(mounted.root, { recursive: true, force: true })
  mounted.root = null
})

describe.runIf(process.platform !== 'win32')('hostPathOfTypedPath on a POSIX host', () => {
  it('opens a path typed in Windows form at its WSL mount', () => {
    expect(hostPathOfTypedPath('Q:\\proj', '/')).toBe('/mnt/q/proj')
    expect(hostPathOfTypedPath('q:/proj', '/')).toBe('/mnt/q/proj')
  })

  it('resolves a relative path against a Windows-form base before looking at the mount', () => {
    expect(hostPathOfTypedPath('proj', 'Q:\\')).toBe('/mnt/q/proj')
  })

  it('leaves the key as it stands when the mount holds nothing', () => {
    expect(hostPathOfTypedPath('Q:\\absent', '/')).toBe('q:/absent')
  })

  it('leaves a mount spelling as the path it names', () => {
    expect(hostPathOfTypedPath('/mnt/q/proj', '/')).toBe('/mnt/q/proj')
  })
})

describe.runIf(process.platform === 'win32')('hostPathOfTypedPath on a Windows host', () => {
  it('opens a WSL or Git Bash mount spelling at its drive letter', () => {
    expect(hostPathOfTypedPath('/mnt/q/proj', 'C:\\')).toBe('q:/proj')
    expect(hostPathOfTypedPath('/q/proj', 'C:\\')).toBe('q:/proj')
  })

  it('opens a path typed in Windows form as it stands', () => {
    expect(hostPathOfTypedPath('Q:\\proj', 'C:\\')).toBe('q:/proj')
  })
})
