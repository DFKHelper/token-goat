/** One project, reached from a cwd whose drive letter differs only in case (`C:/proj` vs `c:/proj`, the same directory on NTFS), must give one identical hooks file: the written hook command embeds the shim path and the up-to-date check compares it byte for byte, so a case difference rewrote the file and left a new .bak on every switch. PROVENANCE: HAND-DERIVED. The two spellings are computed from the temp dir's own drive letter, so no value here comes from the implementation; the expected behaviour (second install a no-op, no backup) is the file-lifecycle contract at src/util.ts::writeIfDifferent, and the reproduction is the observed one (`install --copilot --local --no-index` spawned from `C:/...` then `c:/...`, one .bak per switch). Windows-only: POSIX treats `c:/x` as a relative path. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return { ...original, homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)) }
})

import * as os from 'node:os'

import { copilotCliProjectHooksDir, installCopilotCli, isCopilotCliInstalled, wiredCopilotHookWords } from '../src/bridges/copilot_cli_install.js'
import { installVscode, vscodeHooksDir } from '../src/bridges/vscode_install.js'

const onWindows = process.platform === 'win32'

let TMP: string

beforeEach(() => {
  TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-copilot-drive-case-')))
  ;(os.homedir as unknown as ReturnType<typeof vi.fn>).mockReturnValue(path.join(TMP, 'home'))
  fs.mkdirSync(path.join(TMP, 'proj'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

function withDrive(p: string, upper: boolean): string {
  return (upper ? p[0]!.toUpperCase() : p[0]!.toLowerCase()) + p.slice(1)
}

function backups(root: string): string[] {
  return fs.readdirSync(path.join(root, '.github', 'hooks')).filter((f) => f.includes('.bak'))
}

describe.skipIf(!onWindows)('Copilot project hooks file and drive-letter case', () => {
  it('copilotCliProjectHooksDir gives one directory for both spellings', () => {
    const root = path.join(TMP, 'proj')
    expect(copilotCliProjectHooksDir(withDrive(root, false))).toBe(copilotCliProjectHooksDir(withDrive(root, true)))
  })

  it('install from the other spelling is a no-op: already installed, same bytes, no backup', () => {
    const root = path.join(TMP, 'proj')
    const upper = { local: true, projectRoot: withDrive(root, true) }
    const lower = { local: true, projectRoot: withDrive(root, false) }
    expect(installCopilotCli(upper).alreadyInstalled).toBe(false)
    const file = path.join(root, '.github', 'hooks', 'token-goat.json')
    const before = fs.readFileSync(file, 'utf8')
    expect(installCopilotCli(lower).alreadyInstalled).toBe(true)
    expect(installCopilotCli(upper).alreadyInstalled).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(backups(root)).toEqual([])
  })

  it('reads a file written from one spelling as current from the other', () => {
    const root = path.join(TMP, 'proj')
    installCopilotCli({ local: true, projectRoot: withDrive(root, true) })
    const lower = { local: true, projectRoot: withDrive(root, false) }
    expect(isCopilotCliInstalled(lower)).toBe(true)
    const wired = wiredCopilotHookWords(lower)
    expect(wired.length).toBeGreaterThan(0)
    expect(wired.every((w) => w.current)).toBe(true)
  })

  it('the VS Code project install shares the same file without a rewrite', () => {
    const root = path.join(TMP, 'proj')
    expect(vscodeHooksDir({ project: true, projectRoot: withDrive(root, false) })).toBe(vscodeHooksDir({ project: true, projectRoot: withDrive(root, true) }))
    installVscode({ project: true, projectRoot: withDrive(root, true) })
    expect(installVscode({ project: true, projectRoot: withDrive(root, false) }).alreadyInstalled).toBe(true)
    expect(backups(root)).toEqual([])
  })
})
