/**
 * Behavioral counterpart to `tests/guards/installer_writes_are_always_backed_up.test.ts`. The
 * static guard catches a write site losing its `backupFile` call in source; this test catches the
 * same class of gap in the shipping path, by running the real built bundle
 * (`dist/token-goat.mjs`, not source) against a disposable `HOME`/`APPDATA` with a real,
 * pre-existing config file already sitting where the installer writes, and checking the literal
 * bytes left on disk afterward.
 *
 * Real incident this guards: `token-goat install --vscode` silently rewrote a user's file with no
 * recovery copy. `mcp.json`/`settings.json` are not token-goat-exclusive files -- VS Code, Visual
 * Studio, and Zed all read them for their own settings too, so a bad merge with no backup is not a
 * one-line loss, it can be a whole config file's worth of unrelated content gone with it.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

const tempDirs: string[] = []

function mkIsolated(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function envFor(home: string, dataDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: dataDir,
    XDG_DATA_HOME: dataDir,
    XDG_CONFIG_HOME: path.join(home, '.config'),
  }
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], { cwd, env, encoding: 'utf8', timeout: 30000 })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** The single `<target>.bak.<ISO>` sibling written for `target`, or null if none exists. Asserts there is at most one, since a single install run must not multiply-back-up the same pre-existing file. */
function soleBackupOf(target: string): string | null {
  const dir = path.dirname(target)
  const base = path.basename(target)
  const matches = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.bak.`))
  expect(matches.length, `expected at most one backup of ${target}, found ${matches.length}: ${matches.join(', ')}`).toBeLessThanOrEqual(1)
  return matches.length === 1 ? path.join(dir, matches[0]!) : null
}

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('install backs up a real pre-existing config before overwriting it, with byte-exact recovery content', () => {
  it('install --vscode --project backs up a hand-authored .vscode/mcp.json before merging token-goat into it', () => {
    const home = mkIsolated('tg-behav-backup-vscode-home-')
    const dataDir = mkIsolated('tg-behav-backup-vscode-data-')
    const project = mkIsolated('tg-behav-backup-vscode-proj-')
    const env = envFor(home, dataDir)

    const mcpPath = path.join(project, '.vscode', 'mcp.json')
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true })
    // Known content, hand-authored (not token-goat's), the way a real developer's file would look before ever running install.
    const originalContent = JSON.stringify({ servers: { 'some-other-server': { type: 'stdio', command: 'other-tool', args: ['serve'] } } }, null, 2) + '\n'
    fs.writeFileSync(mcpPath, originalContent, 'utf8')

    const r = run(['install', '--project', '--vscode'], env, project)
    expect(r.status, r.stderr).toBe(0)

    // Positive control: the install really did rewrite the file (otherwise "a backup exists" would be vacuous).
    const rewritten = fs.readFileSync(mcpPath, 'utf8')
    expect(rewritten).not.toBe(originalContent)
    expect(rewritten).toContain('token-goat')
    // The other server's entry must survive the merge -- a backup is not a substitute for a correct merge.
    expect(rewritten).toContain('some-other-server')

    const backupPath = soleBackupOf(mcpPath)
    expect(backupPath, `no backup was written for ${mcpPath} before install overwrote it`).not.toBeNull()
    const backupBytes = fs.readFileSync(backupPath!)
    const originalBytes = Buffer.from(originalContent, 'utf8')
    expect(backupBytes.equals(originalBytes), 'the backup does not match the original file byte-for-byte').toBe(true)
  })

  it('install --zed backs up a hand-authored settings.json before merging token-goat into it', () => {
    const home = mkIsolated('tg-behav-backup-zed-home-')
    const dataDir = mkIsolated('tg-behav-backup-zed-data-')
    const project = mkIsolated('tg-behav-backup-zed-proj-')
    const env = envFor(home, dataDir)

    const settingsPath = path.join(home, 'AppData', 'Roaming', 'Zed', 'settings.json')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    // A real Zed settings.json has plenty of unrelated user settings alongside any context_servers -- that is exactly the content a missing backup would put at risk.
    const originalContent = JSON.stringify({ theme: 'One Dark', vim_mode: true, font_size: 14 }, null, 2) + '\n'
    fs.writeFileSync(settingsPath, originalContent, 'utf8')

    const r = run(['install', '--zed'], env, project)
    expect(r.status, r.stderr).toBe(0)

    const rewritten = fs.readFileSync(settingsPath, 'utf8')
    expect(rewritten).not.toBe(originalContent)
    expect(rewritten).toContain('context_servers')
    expect(rewritten).toContain('One Dark')

    const backupPath = soleBackupOf(settingsPath)
    expect(backupPath, `no backup was written for ${settingsPath} before install overwrote it`).not.toBeNull()
    const backupBytes = fs.readFileSync(backupPath!)
    const originalBytes = Buffer.from(originalContent, 'utf8')
    expect(backupBytes.equals(originalBytes), 'the backup does not match the original file byte-for-byte').toBe(true)
  })
})
