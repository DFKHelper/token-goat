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

/** A shell post hook for `command` that exited 1. */
function failedShellCall(command: string, cwd: string): HookEvent {
  const toolInput = { command }
  return makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', toolInput, sessionId: 'shell-write-session', raw: { tool_name: 'Bash', tool_input: toolInput, tool_response: { stdout: '', stderr: 'boom', exit_code: 1 }, cwd } })
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

  it('still asks to reconcile when the command failed, since it may have written before it did', async () => {
    const dir = repo()
    await postBashHandler(failedShellCall('node scripts/generate.js', dir))
    expect(reconcileRequests()).toContain(foldPath(normalizePath(dir)))
  })

  it('still queues the file a failed redirect named', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'x')
    await postBashHandler(failedShellCall('echo hi > a.txt', dir))
    expect(reconcileRequests()).toEqual([])
    expect(getDirtyPaths().map(foldPath)).toContain(foldPath(resolveIndexPath('a.txt', dir)))
  })

  it('asks for nothing when a read-only command failed', async () => {
    const dir = repo()
    await postBashHandler(failedShellCall('git status', dir))
    expect(reconcileRequests()).toEqual([])
    expect(getDirtyPaths()).toEqual([])
  })

  it('asks for nothing more when a sed -i already named its file', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    await postBashHandler(shellCall("sed -i 's/one/two/' a.txt", dir, 'claude'))
    expect(reconcileRequests()).toEqual([])
    expect(getDirtyPaths().map(foldPath)).toContain(foldPath(resolveIndexPath('a.txt', dir)))
  })
})

describe('a redirect does not make the program behind it innocent', () => {
  it.each([
    ['python gen.py > out.log'],
    ['npm run build > b.log'],
    ['python w.py 2>/dev/null'],
    ['node gen.js >> out.log 2> err.log'],
  ])('%s asks the worker to reconcile', async (command) => {
    const dir = repo()
    await postBashHandler(shellCall(command, dir, 'claude'))
    expect(reconcileRequests()).toContain(foldPath(normalizePath(dir)))
  })

  it('still queues the redirect target itself', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'out.log'), 'x')
    await postBashHandler(shellCall('python gen.py > out.log', dir, 'claude'))
    expect(getDirtyPaths().map(foldPath)).toContain(foldPath(resolveIndexPath('out.log', dir)))
  })

  it.each([['echo hi > a.txt'], ['printf x >> a.txt'], ['cat b.txt > a.txt']])('%s, a bare writer, asks for nothing more', async (command) => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'x')
    await postBashHandler(shellCall(command, dir, 'claude'))
    expect(reconcileRequests()).toEqual([])
    expect(getDirtyPaths().map(foldPath)).toContain(foldPath(resolveIndexPath('a.txt', dir)))
  })

  it.each([['git status > /dev/null'], ['ls > NUL'], ['rg x 2>/dev/null']])('%s queues and asks for nothing', async (command) => {
    const dir = repo()
    await postBashHandler(shellCall(command, dir, 'claude'))
    expect(reconcileRequests()).toEqual([])
    expect(getDirtyPaths()).toEqual([])
  })
})

describe('a remove that may have taken a directory', () => {
  it.each([['rm -rf build'], ['Remove-Item -Recurse build'], ['Remove-Item -Recurse -Force build'], ['Remove-Item build']])('%s asks the worker to reconcile', async (command) => {
    const dir = repo()
    await postBashHandler(shellCall(command, dir, 'copilot'))
    expect(reconcileRequests()).toContain(foldPath(normalizePath(dir)))
  })

  it.each([['Remove-Item old.txt'], ['Remove-Item -Force old.txt'], ['rm src/old.ts']])('%s, a file, only drops that path', async (command) => {
    const dir = repo()
    await postBashHandler(shellCall(command, dir, 'copilot'))
    expect(reconcileRequests()).toEqual([])
  })
})

describe('a wrapped command and a script block are judged by their own segments', () => {
  it('names the cmdlet target and still asks for a reconcile for the python segment of one -Command string', async () => {
    const dir = repo()
    await postBashHandler(shellCall('powershell -NoProfile -Command "Set-Content -Path a.txt -Value 1; python w.py"', dir, 'copilot'))
    expect(getDirtyPaths().map(foldPath)).toContain(foldPath(resolveIndexPath('a.txt', dir)))
    expect(reconcileRequests()).toContain(foldPath(normalizePath(dir)))
  })

  it.each([
    ['pwsh -c "powershell -Command \'python w.py\'"'],
    ['Get-ChildItem *.ts | Where-Object { python w.py }'],
    ['Get-ChildItem *.ts | ForEach-Object { python w.py }'],
  ])('%s asks the worker to reconcile', async (command) => {
    const dir = repo()
    await postBashHandler(shellCall(command, dir, 'copilot'))
    expect(reconcileRequests()).toContain(foldPath(normalizePath(dir)))
  })

  it('treats a -Command nested past the depth it reads as a possible writer', async () => {
    const dir = repo()
    await postBashHandler(shellCall('powershell -c "powershell -c \'powershell -c \\"powershell -c x\\"\'"', dir, 'copilot'))
    expect(reconcileRequests()).toContain(foldPath(normalizePath(dir)))
  })

  it.each([
    ['powershell -Command "Get-Content a.txt; git status"'],
    ['Get-ChildItem | Where-Object { $_.Length -gt 1 }'],
    ["rg '{x}' a.txt"],
    ['Get-Content a.txt | ForEach-Object { $_ }'],
  ])('%s asks for nothing', async (command) => {
    const dir = repo()
    await postBashHandler(shellCall(command, dir, 'copilot'))
    expect(reconcileRequests()).toEqual([])
  })
})

describe('a read-only program with a flag that writes, or one that is not the one on the path', () => {
  it.each([
    ['tree -o out.txt'],
    ['fd -x rm'],
    ['fd -X rm'],
    ['fd --exec rm'],
    ['fd --exec-batch rm'],
    ['rg --pre ./p x'],
    ['./cat x'],
    ['C:/tools/cat.exe x'],
    ['./ls'],
  ])('%s asks the worker to reconcile', async (command) => {
    const dir = repo()
    await postBashHandler(shellCall(command, dir, 'claude'))
    expect(reconcileRequests()).toContain(foldPath(normalizePath(dir)))
  })

  it.each([['tree -a'], ['fd -e ts'], ['fd x'], ['rg -o x a.txt'], ['ls -x'], ['cat x'], ['cat.exe x']])('%s asks for nothing', async (command) => {
    const dir = repo()
    await postBashHandler(shellCall(command, dir, 'claude'))
    expect(reconcileRequests()).toEqual([])
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
    ['echo hi > out.txt', false],
    ['echo hi>out.txt', false],
    ['echo hi &> out.txt', false],
    ['echo hi > "$f"', true],
    ['echo hi > $OUT', true],
    ['echo "$(python gen.py)"', true],
    ['cat `npm run gen`', true],
    ['diff <(make x) y', true],
    ['find . -fls out.txt', true],
    ['echo hi >', true],
    ['echo "unterminated', true],
    ['echo $(echo hi > f)', true],
    ['echo $(echo $(echo $(echo $(pwd))))', true],
    ['echo $(pwd)', false],
    ['diff <(ls a) <(ls b)', false],
    ['rg ">" src', false],
    ['rg foo 2>&1', false],
    ['ls 2>/dev/null', false],
    ['echo $((1 + 2))', false],
    ['find . \\( -name a -o -name b \\)', false],
  ])('%s -> %s', (segment, expected) => {
    expect(segmentMayWriteFiles(segment)).toBe(expected)
  })
})

describe('a read-only head does not excuse a write the segment makes itself', () => {
  it.each([
    ['echo hi > "$f"'],
    ['echo hi > $OUT'],
    ['echo "$(python gen.py)"'],
    ['cat `npm run gen`'],
    ['diff <(make x) y'],
    ['Get-ChildItem | ForEach-Object { $o = npm run gen }'],
    ['find . -fls out.txt'],
    ['echo hi >| out.txt'],
    ['echo $(echo hi > f)'],
    ['echo $(cat a | tee b)'],
    ['Write-Output (npm run gen)'],
    ['echo $((1 + $(npm run gen)))'],
    ['echo "unterminated'],
    ['rm --recursive dist.old'],
    ['rm dist.old --recursive'],
    ['Remove-Item -Path dist.old -Rec'],
    ['docker cp c:/app/out.txt ./out.txt'],
    ['Set-Content out.txt (npm run gen)'],
  ])('%s asks the worker to reconcile', async (command) => {
    const dir = repo()
    await postBashHandler(shellCall(command, dir, 'claude'))
    expect(reconcileRequests()).toContain(foldPath(normalizePath(dir)))
  })

  it.each([
    ['echo hi > a.txt', 'a.txt'],
    ['echo hi>out.txt', 'out.txt'],
    ['cat a>b', 'b'],
    ['echo hi &> out.txt', 'out.txt'],
    ['Write-Output hi *> out.txt', 'out.txt'],
    ['echo hi >> a.txt', 'a.txt'],
    ['echo hi >out.txt 2>&1', 'out.txt'],
    ['echo "C:\\dir\\" > out.txt', 'out.txt'],
  ])('%s queues %s and asks for nothing more', async (command, file) => {
    const dir = repo()
    writeFileSync(join(dir, file), 'x')
    await postBashHandler(shellCall(command, dir, 'claude'))
    expect(reconcileRequests()).toEqual([])
    expect(getDirtyPaths().map(foldPath)).toContain(foldPath(resolveIndexPath(file, dir)))
  })

  it.each([
    ['git status'],
    ['rg foo'],
    ['ls -la'],
    ['Get-ChildItem'],
    ['rg ">" src'],
    ['rg foo 2>&1'],
    ['ls 2>/dev/null'],
    ['cat a.txt >&2'],
    ['echo $(pwd)'],
    ['ls $(git rev-parse --show-toplevel)'],
    ['echo "$(date)"'],
    ['diff <(ls a) <(ls b)'],
    ['echo $((1 + 2))'],
    ['Get-ChildItem | ForEach-Object { $o = Get-Date }'],
    ['Get-ChildItem | ForEach-Object { $_.Name }'],
  ])('%s asks for nothing', async (command) => {
    const dir = repo()
    await postBashHandler(shellCall(command, dir, 'claude'))
    expect(reconcileRequests()).toEqual([])
    expect(getDirtyPaths()).toEqual([])
  })
})
