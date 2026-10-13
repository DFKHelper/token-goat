/** Claude Code's PowerShell tool runs a command the way the Bash tool does, and until now got only the Bash post hook's output handling: no pre hook ran for it at all, and the post hook skipped everything that is not output. A file a `git checkout` or `Set-Content` rewrote was never reindexed, a `Get-Content` of a file never reached the session read cache, a repeated `token-goat read` got no dedup note, a `gh api` permission wall got no advisory, and a whole-file `Get-Content` of a large source file was never redirected to the surgical commands. Every test here goes through the production registry (relay registers every hook module), with the payload shape the PowerShell tool reports: `{ command }` in, `{ stdout, stderr, interrupted, isImage }` out, CRLF line endings, no exit code. Provenance: HAND-DERIVED payloads in the CAPTURE shape tests/powershell_tool_output_handling.test.ts documents. */
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildEvent } from '../src/relay.js'
import { runHook, toolMatcherFor, type HookEvent } from '../src/hook_registry.js'
import { extractPowerShellWriteTargets } from '../src/hooks_bash_commands.js'
import { clearDirtyQueue, getDirtyPaths } from '../src/hooks_index.js'
import { resolveIndexPath } from '../src/paths.js'
import { clearPerRequestCaches } from '../src/reset.js'
import { takeBashStartCwd, wasFileReadThisSession } from '../src/session.js'
import { foldPath } from '../src/util.js'
import { BUNDLE } from './helpers/bundle.js'
import { gitRepoWithCommit } from './helpers/git-repo.js'
import { indexableDir } from './helpers/temp-config.js'

/** A source file well past the size at which a whole-file shell dump is refused: 400 distinct functions. */
const BIG_SOURCE = Array.from({ length: 400 }, (_, i) => `export function handler${i}(input: string): string {\n  return input.trim() + '-${i}'\n}\n`).join('\n')

let dir: string

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-pwsh-parity-')))
  vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
  clearPerRequestCaches()
  clearDirtyQueue()
})

afterEach(() => {
  vi.unstubAllEnvs()
  clearPerRequestCaches()
  fs.rmSync(dir, { recursive: true, force: true })
})

function event(eventName: 'pre_tool_use' | 'post_tool_use', toolName: 'Bash' | 'PowerShell', command: string, stdout = '', toolUseId?: string, sessionId = 'pwsh-parity'): HookEvent {
  const ev = buildEvent(eventName, {
    tool_name: toolName,
    tool_input: { command },
    session_id: sessionId,
    cwd: dir,
    ...(toolUseId !== undefined ? { tool_use_id: toolUseId } : {}),
    ...(eventName === 'post_tool_use' ? { tool_response: { stdout, stderr: '', interrupted: false, isImage: false } } : {}),
  })
  return { ...ev, raw: { ...ev.raw, _tg_harness: 'claude' } }
}

const crlf = (text: string): string => text.split('\n').join('\r\n')
const folded = (): string[] => getDirtyPaths().map(foldPath)

function git(args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'ignore' })
}

describe("Claude Code's PowerShell tool gets the Bash pre hook's checks", () => {
  it('is in the generated PreToolUse matcher', () => {
    expect((toolMatcherFor('pre_tool_use') ?? '').split('|')).toContain('^PowerShell$')
  })

  it('answers a read-shaped command exactly as the Bash tool is answered', async () => {
    fs.writeFileSync(path.join(dir, 'big.ts'), BIG_SOURCE)
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ a: 1, b: [1, 2, 3] }))
    for (const command of ['Get-Content big.ts', 'cat big.ts', 'Get-Content data.json | ConvertFrom-Json']) {
      clearPerRequestCaches()
      const bash = await runHook(event('pre_tool_use', 'Bash', command, '', undefined, `bash-${command}`))
      expect(bash.hookType, `${command}: the Bash tool gets an answer, so the comparison is not two passes`).not.toBe('pass')
      clearPerRequestCaches()
      expect(await runHook(event('pre_tool_use', 'PowerShell', command, '', undefined, `pwsh-${command}`)), command).toEqual(bash)
    }
  })

  it('never rewrites the command, since the permission check behind a rewrite models Bash rules only', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { build: 'tsc' } }))
    const bash = await runHook(event('pre_tool_use', 'Bash', 'npm run build'))
    expect(bash.hookType, 'the Bash tool has this command rewritten, so the PowerShell answer below is a real difference').toBe('rewriteInput')
    expect((await runHook(event('pre_tool_use', 'PowerShell', 'npm run build'))).hookType).toBe('pass')
  })

  it('refuses an inline interpreter read the Bash tool would run capped, since the cap is a rewrite', async () => {
    fs.writeFileSync(path.join(dir, 'big.ts'), BIG_SOURCE)
    const command = `python -c "print(open('big.ts').read())"`
    expect((await runHook(event('pre_tool_use', 'Bash', command, '', undefined, 'bash-interp'))).hookType).toBe('rewriteInput')
    expect((await runHook(event('pre_tool_use', 'PowerShell', command, '', undefined, 'pwsh-interp'))).hookType).toBe('deny')
  })

  it('leaves out the Git Bash checks: a doubled backslash and a here-string run unchanged under PowerShell', async () => {
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', '')
    vi.stubEnv('CLAUDE_CODE_VERSION', '2.1.0')
    try {
      const doubled = 'Write-Output "C:\\\\Users\\\\me"'
      clearPerRequestCaches()
      const bash = await runHook(event('pre_tool_use', 'Bash', doubled))
      expect(bash.hookType === 'deny' && bash.message.includes('two backslashes')).toBe(true)
      clearPerRequestCaches()
      expect((await runHook(event('pre_tool_use', 'PowerShell', doubled))).hookType).toBe('pass')
      // A PowerShell string doubles its quote to escape it, which bash quoting reads as unbalanced.
      expect((await runHook(event('pre_tool_use', 'PowerShell', "Write-Output 'it''s done'"))).hookType).toBe('pass')
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    }
  })

  it('holds the start directory for the post hook, which takes it', async () => {
    await runHook(event('pre_tool_use', 'PowerShell', 'Get-Date', '', 'toolu_pwsh_held'))
    expect(takeBashStartCwd('toolu_pwsh_held')).toBe(dir)
    await runHook(event('pre_tool_use', 'PowerShell', 'Get-Date', '', 'toolu_pwsh_taken'))
    await runHook(event('post_tool_use', 'PowerShell', 'Get-Date', '13:23\r\n', 'toolu_pwsh_taken'))
    expect(takeBashStartCwd('toolu_pwsh_taken')).toBeNull()
  })

  it('notes a repeated token-goat read, recorded by the post hook and answered by the pre hook', async () => {
    fs.writeFileSync(path.join(dir, 'small.ts'), 'export function one(): number {\n  return 1\n}\n')
    const command = 'token-goat read "small.ts::one"'
    expect((await runHook(event('pre_tool_use', 'PowerShell', command))).hookType).toBe('pass')
    await runHook(event('post_tool_use', 'PowerShell', command, crlf('export function one(): number {\n  return 1\n}\n')))
    const repeat = await runHook(event('pre_tool_use', 'PowerShell', command))
    expect(repeat.hookType, JSON.stringify(repeat)).not.toBe('pass')
  })
})

describe("Claude Code's PowerShell tool gets the Bash post hook's bookkeeping", () => {
  // Both reindex tests work outside the OS temp dir, whose paths the dirty queue refuses.
  it('reindexes a file a git checkout rewrote', async () => {
    dir = gitRepoWithCommit()
    const main = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir }).toString().trim()
    git(['checkout', '-q', '-b', 'feature'])
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n')
    git(['commit', '-q', '-am', 'two'])
    git(['checkout', '-q', main])
    await runHook(event('post_tool_use', 'PowerShell', 'git checkout feature', "Switched to branch 'feature'\r\n"))
    expect(folded()).toContain(foldPath(resolveIndexPath('a.txt', dir)))
  })

  it('reindexes a file Set-Content or Out-File wrote, by a relative or a backslashed absolute path', async () => {
    dir = indexableDir()
    fs.writeFileSync(path.join(dir, 'notes.ts'), 'export const a = 1\n')
    fs.writeFileSync(path.join(dir, 'other.ts'), 'export const b = 2\n')
    await runHook(event('post_tool_use', 'PowerShell', "Set-Content -Path notes.ts -Value 'export const a = 1'"))
    const backslashed = path.join(dir, 'other.ts').split('/').join('\\')
    await runHook(event('post_tool_use', 'PowerShell', `'export const b = 2' | Out-File ${backslashed} -Encoding utf8`))
    expect(folded()).toContain(foldPath(resolveIndexPath('notes.ts', dir)))
    expect(folded()).toContain(foldPath(resolveIndexPath('other.ts', dir)))
  })

  it('records a Get-Content the model was shown in full as a read, and not one it got compressed', async () => {
    const small = 'export function one(): number {\n  return 1\n}\n'
    fs.writeFileSync(path.join(dir, 'small.ts'), small)
    await runHook(event('post_tool_use', 'PowerShell', 'Get-Content small.ts', crlf(small)))
    expect(wasFileReadThisSession(path.join(dir, 'small.ts'))).toBe(true)

    fs.writeFileSync(path.join(dir, 'big.ts'), BIG_SOURCE)
    const result = await runHook(event('post_tool_use', 'PowerShell', 'Get-Content big.ts', crlf(BIG_SOURCE)))
    expect(result.hookType, 'the large read was compressed, the case this guards').toBe('rewriteOutput')
    expect(wasFileReadThisSession(path.join(dir, 'big.ts'))).toBe(false)
  })

  it('answers a gh api permission wall with the scope advisory', async () => {
    const result = await runHook(event('post_tool_use', 'PowerShell', 'gh api repos/o/r/secret-scanning/alerts', crlf('{"message":"Resource not accessible by integration","status":"403"}\ngh: Resource not accessible by integration (HTTP 403)\n')))
    expect(result.hookType, JSON.stringify(result)).toBe('context')
  })
})

describe('extractPowerShellWriteTargets', () => {
  it.each([
    ['Set-Content -Path a.ts -Value x', ['a.ts']],
    ["Set-Content a.ts 'x'", ['a.ts']],
    ['Set-Content -Value x a.ts', ['a.ts']],
    ['Add-Content -LiteralPath "C:\\src\\a b.ts" -Value x', ['C:\\src\\a b.ts']],
    ['Out-File -FilePath:C:\\out\\log.txt -Append', ['C:\\out\\log.txt']],
    ['out-file -Encoding utf8 -Force C:\\out\\x.txt', ['C:\\out\\x.txt']],
    ["Tee-Object 'it''s.txt'", ["it's.txt"]],
    ['Set-Content', []],
    ['Get-Content a.ts', []],
    ['Set-ContentX a.ts', []],
  ])('%s -> %j', (segment, expected) => {
    expect(extractPowerShellWriteTargets(segment)).toEqual(expected)
  })
})

describe("Claude Code's PowerShell tool (built-bundle e2e)", () => {
  it('reaches the pre hook in the shipped artifact', () => {
    fs.writeFileSync(path.join(dir, 'big.ts'), BIG_SOURCE)
    const payload = { session_id: 'pwsh-pre-bundle', hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'PowerShell', tool_input: { command: 'Get-Content big.ts' } }
    const env = { ...process.env, TOKEN_GOAT_HOME: dir, LOCALAPPDATA: dir, XDG_DATA_HOME: dir, TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_HARNESS_OVERRIDE: 'claudecode' }
    const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'pre_tool_use'], { input: JSON.stringify(payload), encoding: 'utf-8', env })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('token-goat')
    expect(res.stdout).toContain('big.ts')
  })
})
