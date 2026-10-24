/** A file a Copilot CLI shell call wrote reaches the index through the shipped path: the real Copilot hook shim, the built bundle's hook entry, and the production worker drain with no injected callback, ending in a symbol lookup. PROVENANCE: the postToolUse envelope (sessionId, timestamp, cwd, toolName, toolArgs, toolResult, traceparent) is CAPTURE from tests/fixtures/copilot_cli_1_0_88/C6-006-postToolUse-powershell.json (Copilot CLI 1.0.88); the extra toolArgs keys (initial_wait, mode, shellId) are FORMAT-DERIVED from the same captured session family, and every command value and symbol name is HAND-DERIVED and synthetic. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { HOOKS_SCRIPT_FILE, installCopilotHooksFile } from '../src/bridges/copilot_cli_install.js'
import { reconcileRequestPathFor } from '../src/dirty_queue.js'
import { closeAllDbs } from '../src/db.js'
import { querySymbols } from '../src/index_reader.js'
import { normalizePath } from '../src/paths.js'
import { drainReconcileRequestsAsync } from '../src/reconcile_requests.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { copilotCapture } from './fixtures/copilot_cli_1_0_88.js'
import { BUNDLE, tgIsolatedEnv } from './helpers/bundle.js'
import { findGlobalDb } from './helpers/find_global_db.js'
import { indexableDir } from './helpers/temp-config.js'

const fn = (name: string): string => `export function ${name}(): number {\n  return 1\n}\n`

const homes: string[] = []
afterEach(() => {
  closeAllDbs()
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function findFile(dir: string, name: string): string | null {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(full, name)
      if (found !== null) return found
    } else if (entry.name === name) return full
  }
  return null
}

/** An indexed git project holding `a.ts` with one symbol, an isolated data home, and the installed Copilot shim. */
function indexedProject(extra: Record<string, string> = {}): { proj: string; home: string; hooksDir: string; env: NodeJS.ProcessEnv; dbPath: string } {
  const proj = indexableDir()
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'tg-shell-write-e2e-')))
  homes.push(home)
  writeFileSync(join(proj, 'a.ts'), fn('shellWriteBefore'))
  for (const [rel, body] of Object.entries(extra)) {
    mkdirSync(dirname(join(proj, rel)), { recursive: true })
    writeFileSync(join(proj, rel), body)
  }
  for (const args of [['init', '-q'], ['add', '-A']]) expect(spawnSync('git', args, { cwd: proj, encoding: 'utf8' }).status).toBe(0)
  const env = tgIsolatedEnv(home, { TOKEN_GOAT_HOME: home, TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_HOOK_SERVER: '0' })
  const indexed = spawnSync(process.execPath, [BUNDLE, 'index', '.'], { cwd: proj, env, encoding: 'utf8', timeout: 60_000 })
  expect(indexed.status, indexed.stderr).toBe(0)
  const hooksDir = join(home, 'hooks')
  installCopilotHooksFile(hooksDir, 'copilot')
  const dbPath = findGlobalDb(home) as string
  // Calibration: the old symbol is indexed, so the new one can only arrive through the hook and the drain.
  expect(querySymbols({ name: 'shellWriteBefore' }, dbPath)).toHaveLength(1)
  return { proj, home, hooksDir, env, dbPath }
}

/** The captured Copilot `powershell` postToolUse for `command`, sent through the shim into the built bundle. */
function copilotShellCall(ctx: { proj: string; hooksDir: string; env: NodeJS.ProcessEnv }, command: string): void {
  const captured = copilotCapture('C6-006-postToolUse-powershell', { proj: ctx.proj })
  const payload = { ...captured, toolArgs: { command, description: 'edit', initial_wait: 30, mode: 'sync', shellId: 'synthetic-shell' } }
  const res = spawnSync(process.execPath, [join(ctx.hooksDir, HOOKS_SCRIPT_FILE), 'postToolUse', BUNDLE], { cwd: ctx.proj, env: ctx.env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 60_000 })
  expect(res.status, res.stderr).toBe(0)
}

describe('a file a Copilot CLI shell call wrote reaches the index', () => {
  it('names a Set-Content target to the dirty queue, which the production drain indexes', async () => {
    const ctx = indexedProject()
    writeFileSync(join(ctx.proj, 'a.ts'), fn('shellWriteAfterCmdlet'))
    copilotShellCall(ctx, "Set-Content -Path a.ts -Value 'export function shellWriteAfterCmdlet() {}'")

    const queueFile = findFile(ctx.home, 'dirty.txt')
    expect(queueFile, 'the shell hook queued nothing for a Set-Content write').not.toBeNull()
    drainOnce(dirname(dirname(queueFile as string)))
    await pendingEmbeddings()
    expect(querySymbols({ name: 'shellWriteAfterCmdlet' }, ctx.dbPath).map((s) => normalizePath(s.filePath))).toEqual([normalizePath(join(ctx.proj, 'a.ts'))])
    expect(querySymbols({ name: 'shellWriteBefore' }, ctx.dbPath)).toEqual([])
  }, 60_000)

  it('asks the worker to reconcile after a write through a program it cannot read, and the sweep indexes the file', async () => {
    const ctx = indexedProject()
    const file = join(ctx.proj, 'a.ts')
    writeFileSync(file, fn('shellWriteAfterPython'))
    // A fresh mtime, so the sweep's stat check sees the file move even when the write landed in the same clock tick as the index.
    const later = new Date(Date.now() + 60_000)
    utimesSync(file, later, later)
    copilotShellCall(ctx, 'python scripts/rewrite_a.py')

    const requestFile = findFile(ctx.home, 'reconcile.txt')
    expect(requestFile, 'the shell hook asked the worker for no reconcile').not.toBeNull()
    const dataDirPath = dirname(dirname(requestFile as string))
    expect(requestFile).toBe(reconcileRequestPathFor(dataDirPath))
    expect(await drainReconcileRequestsAsync(dataDirPath)).toBe(1)
    drainOnce(dataDirPath)
    await pendingEmbeddings()
    expect(querySymbols({ name: 'shellWriteAfterPython' }, ctx.dbPath).map((s) => normalizePath(s.filePath))).toEqual([normalizePath(file)])
  }, 60_000)

  it('indexes a brand-new untracked file a redirected python script created', async () => {
    const ctx = indexedProject()
    // Never staged: a git ls-files of tracked files alone cannot see it.
    const created = join(ctx.proj, 'fresh.ts')
    writeFileSync(created, fn('shellWriteUntracked'))
    copilotShellCall(ctx, 'python scripts/gen.py > gen.log')

    const requestFile = findFile(ctx.home, 'reconcile.txt')
    expect(requestFile, 'a redirected program that may write files asked the worker for no reconcile').not.toBeNull()
    const dataDirPath = dirname(dirname(requestFile as string))
    expect(await drainReconcileRequestsAsync(dataDirPath)).toBe(1)
    drainOnce(dataDirPath)
    await pendingEmbeddings()
    expect(querySymbols({ name: 'shellWriteUntracked' }, ctx.dbPath).map((s) => normalizePath(s.filePath))).toEqual([normalizePath(created)])
  }, 60_000)

  it('stops resolving the symbols of a directory a recursive remove deleted', async () => {
    const ctx = indexedProject({ 'gone/inner.ts': fn('shellWriteInsideDir') })
    expect(querySymbols({ name: 'shellWriteInsideDir' }, ctx.dbPath)).toHaveLength(1)
    rmSync(join(ctx.proj, 'gone'), { recursive: true, force: true })
    copilotShellCall(ctx, 'Remove-Item -Recurse -Force gone')

    const requestFile = findFile(ctx.home, 'reconcile.txt')
    expect(requestFile, 'a recursive remove asked the worker for no reconcile').not.toBeNull()
    const dataDirPath = dirname(dirname(requestFile as string))
    expect(await drainReconcileRequestsAsync(dataDirPath)).toBe(1)
    drainOnce(dataDirPath)
    await pendingEmbeddings()
    expect(querySymbols({ name: 'shellWriteInsideDir' }, ctx.dbPath)).toEqual([])
  }, 60_000)

  it('leaves the queue and the request file alone for a read-only command', () => {
    const ctx = indexedProject()
    copilotShellCall(ctx, 'git status')
    expect(findFile(ctx.home, 'dirty.txt')).toBeNull()
    expect(findFile(ctx.home, 'reconcile.txt')).toBeNull()
  }, 60_000)
})
