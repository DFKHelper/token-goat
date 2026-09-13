/**
 * The user -> project migration must not delete the recovery copies it just made.
 *
 * `install --vscode` now defaults to project scope, and the first post-upgrade run MIGRATES an
 * existing user-scope install rather than refusing it. That migration is implemented by calling
 * `uninstallVscode()`, which ends by sweeping the `.bak.<ISO>` files token-goat created for the
 * files it touched -- correct for a real uninstall, wrong here. This is the one path that rewrites
 * a user-scope file WITHOUT being asked to, so it is exactly where commit a804e9f9's guarantee
 * ("every existing file the installer overwrites gets a recovery copy") has to hold, and it was
 * the one place it did not: the copy was written and then deleted seconds later, in the same run.
 *
 * The assertion is that the user's own pre-migration content is still RECOVERABLE afterwards, not
 * that some file matching `.bak.` exists. A backup holding the post-rewrite bytes would satisfy the
 * weaker check and recover nothing.
 *
 * PROVENANCE: HAND-DERIVED. The user content is arbitrary marker text this test writes into the
 * files an existing user-scope install leaves behind; the file locations come from the real
 * `installVscode({})` run in the arrange step, not from a hardcoded list.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { installVscode, uninstallVscode, vscodeInstructionsPath, vscodeMcpPath } from '../src/bridges/vscode_install.js'

const USER_MCP_MARKER = 'tg-test-user-authored-server'
const USER_NOTE = 'tg-test-hand-written-note'

let root: string
let project: string
let home: string
let saved: Record<string, string | undefined>

const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_DATA_HOME']

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vscode-migrate-')))
  project = path.join(root, 'project')
  home = path.join(root, 'home')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
  process.env['HOME'] = home
  process.env['USERPROFILE'] = home
  process.env['APPDATA'] = path.join(home, 'AppData', 'Roaming')
  process.env['LOCALAPPDATA'] = path.join(root, 'data')
  process.env['XDG_DATA_HOME'] = path.join(root, 'data')
  _resetDataDirCacheForTesting()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  _resetDataDirCacheForTesting()
  fs.rmSync(root, { recursive: true, force: true })
})

/** Contents of every `<file>.bak.<stamp>` sibling of `file`, in name order. */
function backupsOf(file: string): string[] {
  const dir = path.dirname(file)
  const base = `${path.basename(file)}.bak.`
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => n.startsWith(base))
    .sort()
    .map((n) => fs.readFileSync(path.join(dir, n), 'utf8'))
}

/** An existing user-scope install carrying content the user typed themselves. */
function arrangeUserScopeInstallWithUserContent(): { userMcp: string; userInstructions: string } {
  installVscode({})
  const userMcp = vscodeMcpPath({})
  const userInstructions = vscodeInstructionsPath({})
  const mcp = JSON.parse(fs.readFileSync(userMcp, 'utf8')) as { servers: Record<string, unknown> }
  mcp.servers[USER_MCP_MARKER] = { command: 'my-own-server' }
  fs.writeFileSync(userMcp, `${JSON.stringify(mcp, null, 2)}\n`)
  fs.writeFileSync(userInstructions, `${fs.readFileSync(userInstructions, 'utf8')}\n${USER_NOTE}\n`)
  return { userMcp, userInstructions }
}

describe('installVscode migrating a user-scope install into the project', () => {
  it('leaves the user content recoverable from a backup it created', () => {
    const { userMcp, userInstructions } = arrangeUserScopeInstallWithUserContent()

    const result = installVscode({ project: true, projectRoot: project })
    expect(result.migratedFromUserScope, 'the migration branch did not run, so this proves nothing').toBe(true)

    // The migration really did rewrite both user files -- otherwise "the content survives" would be
    // trivially true because nothing was overwritten.
    expect(fs.readFileSync(userMcp, 'utf8')).not.toContain('token-goat-managed')
    expect(fs.readFileSync(userInstructions, 'utf8')).not.toContain('token-goat-vscode-begin')

    expect(backupsOf(userMcp).some((t) => t.includes(USER_MCP_MARKER)), 'no backup holds the user-authored server entry').toBe(true)
    // Both halves: the note proves the copy predates the rewrite, the marker proves it is a copy of
    // the file as it stood WITH the block, which is the state a recovery would restore.
    expect(
      backupsOf(userInstructions).some((t) => t.includes(USER_NOTE) && t.includes('token-goat-vscode-begin')),
      'no backup holds the instructions file as it stood before the migration',
    ).toBe(true)
  })

  it('still sweeps its own backups on a real uninstall, which is what the user asked for', () => {
    // The other half of the option: without this, "keep the backups" would just be leaking litter
    // on every uninstall, and the fix would have traded one defect for another.
    const { userMcp, userInstructions } = arrangeUserScopeInstallWithUserContent()
    expect(uninstallVscode({})).toBe(true)
    expect(backupsOf(userMcp)).toEqual([])
    expect(backupsOf(userInstructions)).toEqual([])
  })
})
