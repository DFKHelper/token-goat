/** What the post-shell hook asks of the worker after a command that may have written files. PROVENANCE: the Copilot `powershell` envelope and the tool_response wording are FORMAT-DERIVED from tests/fixtures/copilot_cli_1_0_88/C6-006-postToolUse-powershell.json (CAPTURE); every command value is HAND-DERIVED and synthetic. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const _testConfigPath = tempConfigPath('tg-shell-write-config-test.toml')
const _testDataDir = mkdtempSync(join(tmpdir(), 'tg-shell-write-data-'))

import { postBashHandler } from '../src/hooks_bash_post.js'
import { parseReconcileRequests, reconcileRequestPathFor } from '../src/dirty_queue.js'
import { clearDirtyQueue, getDirtyPaths } from '../src/hooks_index.js'
import { normalizePath, resolveIndexPath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { foldPath } from '../src/util.js'
import { extractPowerShellWriteTargets, segmentMayWriteFiles } from '../src/shell_writes.js'

/** The raw lines of the reconcile-request file, which the worker's parser would collapse but the file itself still holds. */
function pendingRequestLines(): string[] {
  try {
    return readFileSync(reconcileRequestPathFor(_testDataDir), 'utf8').split('\n').filter((l) => l.trim() !== '')
  } catch {
    return []
  }
}

function reconcileRequests(): string[] {
  try {
    return parseReconcileRequests(readFileSync(reconcileRequestPathFor(_testDataDir), 'utf8')).map((d) => foldPath(normalizePath(d)))
  } catch {
    return []
  }
}

/** A successful shell post hook for `command`, as Claude Code's Bash tool (`tool_response` carrying the output) or as Copilot CLI's powershell tool after the shim's remap onto Bash. */
function shellCall(command: string, cwd: string, shape: 'claude' | 'copilot'): HookEvent {
  const toolInput = shape === 'copilot' ? { command, description: 'run', initial_wait: 30, mode: 'sync', shellId: 'synthetic-shell' } : { command }
  const toolResponse = shape === 'copilot' ? { resultType: 'success', textResultForLlm: 'done\n<shellId: 0 completed with exit code 0>' } : { stdout: 'done', stderr: '', exit_code: 0 }
  return makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', toolInput, sessionId: 'shell-write-session', raw: { tool_name: 'Bash', tool_input: toolInput, tool_response: toolResponse, cwd } })
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

describe('a PowerShell write cmdlet names its file to the dirty queue', () => {
  it.each([
    ['Set-Content', "Set-Content -Path a.txt -Value 'two'"],
    ['Add-Content positional', "Add-Content a.txt 'two'"],
    ['Out-File', "'two' | Out-File -FilePath a.txt"],
    ['New-Item', 'New-Item -ItemType File -Path a.txt -Force'],
    ['the .NET writer', "[IO.File]::WriteAllText('a.txt', 'two')"],
    ['a wrapped powershell -Command', 'powershell -NoProfile -Command "Set-Content -Path a.txt -Value two"'],
  ])('%s', async (_name, command) => {
    const dir = repo()
    await postBashHandler(shellCall(command, dir, 'copilot'))
    expect(getDirtyPaths().map(foldPath)).toContain(foldPath(resolveIndexPath('a.txt', dir)))
  })

  it('names both the removed source and the written destination of a Move-Item', async () => {
    const dir = repo()
    await postBashHandler(shellCall('Move-Item -Path a.txt -Destination b.txt', dir, 'copilot'))
    // b.txt does not exist here (the command did not really run), so only the gone source is queued: its rows must be dropped.
    expect(getDirtyPaths().map(foldPath)).toContain(foldPath(resolveIndexPath('a.txt', dir)))
  })

  it('reads a Windows path with backslashes whole', () => {
    expect(extractPowerShellWriteTargets("Set-Content -Path src\\a.ts -Value x").written).toEqual(['src\\a.ts'])
  })

  it('does not name a path only the shell could resolve', () => {
    expect(extractPowerShellWriteTargets('Set-Content -Path $target -Value x')).toEqual({ written: [], removed: [] })
    expect(extractPowerShellWriteTargets('Remove-Item *.log')).toEqual({ written: [], removed: [] })
  })
})

describe('a shell command that writes through a program the hook cannot read', () => {
  it.each([
    ['claude', 'Bash python -c', "python -c \"open('a.txt','w').write('two')\""],
    ['claude', 'Bash node script', 'node scripts/generate.js'],
    ['copilot', 'powershell python -c', "python -c \"open('a.txt','w').write('two')\""],
    ['copilot', 'powershell variable path', '$f = "a.txt"; Set-Content -Path $f -Value two'],
  ] as const)('%s: %s asks the worker to reconcile the project', async (shape, _name, command) => {
    const dir = repo()
    await postBashHandler(shellCall(command, dir, shape))
    expect(reconcileRequests()).toContain(foldPath(normalizePath(dir)))
  })

  it.each([
    ['git status'],
    ['git diff --stat'],
    ['Get-Content a.txt'],
    ['rg one a.txt'],
    ['Get-ChildItem -Recurse | Select-String one'],
    ['cd sub && ls'],
    ['token-goat symbol foo'],
  ])('%s asks for nothing', async (command) => {
    const dir = repo()
    mkdirSync(join(dir, 'sub'), { recursive: true })
    await postBashHandler(shellCall(command, dir, 'copilot'))
    expect(reconcileRequests()).toEqual([])
    expect(getDirtyPaths()).toEqual([])
  })

  it('asks for nothing when the command failed', async () => {
    const dir = repo()
    const toolInput = { command: 'node scripts/generate.js' }
    await postBashHandler(makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', toolInput, sessionId: 'shell-write-session', raw: { tool_name: 'Bash', tool_input: toolInput, tool_response: { stdout: '', stderr: 'boom', exit_code: 1 }, cwd: dir } }))
    expect(reconcileRequests()).toEqual([])
  })

  it('asks for nothing more when a sed -i already named its file', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    await postBashHandler(shellCall("sed -i 's/one/two/' a.txt", dir, 'claude'))
    expect(reconcileRequests()).toEqual([])
    expect(getDirtyPaths().map(foldPath)).toContain(foldPath(resolveIndexPath('a.txt', dir)))
  })
})

describe('a burst of shell writes', () => {
  it('leaves one pending reconcile request for the project, not one per call', async () => {
    const dir = repo()
    for (let i = 0; i < 50; i++) await postBashHandler(shellCall(`node scripts/step${i}.js`, dir, 'copilot'))
    expect(pendingRequestLines()).toEqual([JSON.stringify(dir)])
  })

  it('records a new request once the worker has claimed the earlier one', async () => {
    const dir = repo()
    await postBashHandler(shellCall('node scripts/one.js', dir, 'copilot'))
    rmSync(reconcileRequestPathFor(_testDataDir), { force: true })
    await postBashHandler(shellCall('node scripts/two.js', dir, 'copilot'))
    expect(pendingRequestLines()).toEqual([JSON.stringify(dir)])
  })

  it('keeps a different project as its own request', async () => {
    const one = repo()
    const two = repo()
    await postBashHandler(shellCall('node scripts/a.js', one, 'copilot'))
    await postBashHandler(shellCall('node scripts/b.js', two, 'copilot'))
    await postBashHandler(shellCall('node scripts/c.js', one, 'copilot'))
    expect(pendingRequestLines()).toEqual([JSON.stringify(one), JSON.stringify(two)])
  })
})

describe('segmentMayWriteFiles', () => {
  it.each([
    ['git status', false],
    ['git -C sub log --oneline', false],
    ['git commit -m x', true],
    ['git diff --output=out.txt', true],
    ['ls -la', false],
    ['find . -name x', false],
    ['find . -name x -delete', true],
    ['npm run build', true],
    ['FOO=1 python x.py', true],
    ['Get-ChildItem | Where-Object { Set-Content $_ x }', true],
  ])('%s -> %s', (segment, expected) => {
    expect(segmentMayWriteFiles(segment)).toBe(expected)
  })
})
