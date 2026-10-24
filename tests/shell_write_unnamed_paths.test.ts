/** A shell segment counts as handled only when every file it names is one this hook can resolve; otherwise the project is reconciled. PROVENANCE: the Claude Code Bash post-hook payload shape is FORMAT-DERIVED from tests/fixtures/claude_code_2_1_281 (CAPTURE, PROVENANCE.tsv), as in tests/shell_write_requests.test.ts; every command value is HAND-DERIVED and synthetic. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { gitRepoWithCommit } from './helpers/git-repo.js'
import { tempConfigPath } from './helpers/temp-config.js'

// dataDir() points at a per-file temp dir so the queue and the reconcile-request file the hook writes never touch a real one.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, configPath: () => _testConfigPath, dataDir: () => _testDataDir }
})

const _testConfigPath = tempConfigPath('tg-shell-unnamed-config-test.toml')
const _testDataDir = mkdtempSync(join(tmpdir(), 'tg-shell-unnamed-data-'))

import { postBashHandler } from '../src/hooks_bash_post.js'
import { parseReconcileRequests, reconcileRequestPathFor } from '../src/dirty_queue.js'
import { clearDirtyQueue, getDirtyPaths } from '../src/hooks_index.js'
import { normalizePath, resolveIndexPath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { foldPath } from '../src/util.js'

function reconcileRequests(): string[] {
  try {
    return parseReconcileRequests(readFileSync(reconcileRequestPathFor(_testDataDir), 'utf8')).map((d) => foldPath(normalizePath(d)))
  } catch {
    return []
  }
}

/** A Claude Code Bash post hook for `command` that exited with `exitCode`. */
function shellCall(command: string, cwd: string, exitCode = 0): HookEvent {
  const toolInput = { command }
  return makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', toolInput, sessionId: 'shell-unnamed-session', raw: { tool_name: 'Bash', tool_input: toolInput, tool_response: { stdout: '', stderr: exitCode === 0 ? '' : 'boom', exit_code: exitCode }, cwd } })
}

const dirs: string[] = []
function repo(): string {
  const dir = gitRepoWithCommit()
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  clearModuleCaches()
  clearDirtyQueue()
  rmSync(reconcileRequestPathFor(_testDataDir), { force: true })
})

afterEach(() => {
  clearModuleCaches()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('a segment whose named files the hook cannot resolve still reconciles', () => {
  it.each([
    ['sed -i over a glob', 'sed -i s/a/b/ src/*.ts'],
    ['sed -i over a variable', 'sed -i s/a/b/ "$f"'],
    ['tee into a variable', 'echo x | tee "$f"'],
    ['tee into a home path', 'echo x | tee ~/out.txt'],
    ['sed -i naming one file and one glob', 'sed -i s/a/b/ a.txt src/*.ts'],
  ])('%s', async (_name, command) => {
    const dir = repo()
    await postBashHandler(shellCall(command, dir))
    expect(reconcileRequests(), `reconcile requests after ${command}`).toContain(foldPath(normalizePath(dir)))
  })

  it.each([
    ['sed -i naming a file', 'sed -i s/one/two/ a.txt'],
    ['tee naming a file', 'echo x | tee a.txt'],
  ])('control: %s names its file and asks for no reconcile', async (_name, command) => {
    const dir = repo()
    await postBashHandler(shellCall(command, dir))
    expect(getDirtyPaths().map(foldPath), `dirty queue after ${command}`).toContain(foldPath(resolveIndexPath('a.txt', dir)))
    expect(reconcileRequests()).toEqual([])
  })
})

describe('a git restore inside a chain is queued', () => {
  it('queues the file `ls && git restore a.txt` put back', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'edited\n')
    await postBashHandler(shellCall('ls && git restore a.txt', dir))
    expect(getDirtyPaths().map(foldPath), 'dirty queue after a chained restore').toContain(foldPath(resolveIndexPath('a.txt', dir)))
  })

  it('reconciles a chained restore whose pathspec is a glob', async () => {
    const dir = repo()
    await postBashHandler(shellCall('ls && git restore src/*.ts', dir))
    expect(reconcileRequests(), 'reconcile requests after a chained glob restore').toContain(foldPath(normalizePath(dir)))
  })
})

describe('a formatter that exits non-zero is still swept', () => {
  it.each([
    ['eslint --fix', 'npx eslint --fix src'],
    ['prettier --write', 'npx prettier --write src'],
  ])('%s', async (_name, command) => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'formatted before failing\n')
    await postBashHandler(shellCall(command, dir, 1))
    expect(getDirtyPaths().map(foldPath), `dirty queue after a failed ${command}`).toContain(foldPath(resolveIndexPath('a.txt', dir)))
  })
})
