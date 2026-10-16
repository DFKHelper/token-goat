/** A Bash command Claude Code on Windows would hand to Git Bash damaged is run from a script file instead of refused. PROVENANCE: the damage is CAPTURE from anthropics/claude-code#85856 (Claude Code 2.1.300): `printf '%s\n' 'A:\\' 'B:\\\\' 'D:\\"x' 'E:\\$x' 'H:a\\\b'` printed `A:\ B:\\ D:\\"x E:\$x H:a\\b`, so a run before a double quote survived and every other run arrived as ceil(n/2); the expected output of the repaired command is HAND-DERIVED from the POSIX rule that nothing inside single quotes is special; the settings shape is FORMAT-DERIVED from https://code.claude.com/docs/en/permissions (`permissions.deny`, `permissions.ask`, `Bash(curl:*)`). */
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasHalvedRun, MSYS_SAFE_COMMAND_CHARS, msysDamagesCommand, msysPathOf, planRepair, repairIsUnsafe, writeRepairScript } from '../src/bash_backslash_repair.js'
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import type { HookEvent } from '../src/hook_registry.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { normalizePath, shellMountToWindowsPath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { loadHiddenRuleCheck, resetPermissionSourceCache } from '../src/rewrite_permission.js'
import { resolveWindowsBash } from '../src/shell.js'
import { detectUnboundedWalk } from '../src/unbounded_walk.js'
import { BUNDLE } from './helpers/bundle.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { startWatchdog } from './helpers/stall_proof_watchdog.js'

// The reported command without its `E:\\$x` word, which the repair now declines for its `$`.
const REPORTED = String.raw`printf '%s\n' 'A:\\' 'B:\\\\' 'D:\\"x' 'H:a\\\b'`
// What the command means: each single-quoted word verbatim, one per line.
const REPORTED_OUTPUT = [String.raw`A:\\`, String.raw`B:\\\\`, String.raw`D:\\"x`, String.raw`H:a\\\b`].join('\n') + '\n'
const BEFORE_QUOTE_ONLY = String.raw`printf '%s\n' 'D:\\"x'`
const BASH = process.platform === 'win32' ? resolveWindowsBash() : null
const SCRIPT_NAME = /^tg-cmd-[0-9a-f]{32}\.sh$/

describe('msysDamagesCommand -- which commands Git Bash receives different from what was written', () => {
  it('a run of two or more backslashes not directly before a double quote is damaged', () => {
    expect(msysDamagesCommand(String.raw`echo 'A:\\'`)).toBe(true)
    expect(msysDamagesCommand(String.raw`echo H:a\\\b`)).toBe(true)
    expect(msysDamagesCommand(String.raw`echo "x\\ y"`)).toBe(true)
  })

  it('a run directly before a double quote survives, whatever its length', () => {
    expect(msysDamagesCommand(BEFORE_QUOTE_ONLY)).toBe(false)
    expect(msysDamagesCommand(String.raw`echo "a\\\"b" "c:\\"`)).toBe(false)
  })

  it('a lone backslash and a command with none are intact', () => {
    expect(msysDamagesCommand(String.raw`printf "a\tb"`)).toBe(false)
    expect(msysDamagesCommand('git status')).toBe(false)
  })

  it('the longest run is judged whole: a long run before a quote does not split into a damaged shorter one', () => {
    expect(msysDamagesCommand(String.raw`echo "a\\\\\"`)).toBe(false)
    expect(msysDamagesCommand(String.raw`echo "a\\\\\ "`)).toBe(true)
  })

  it('a command past the length bound is damaged even with no backslash, and one at the bound is not', () => {
    expect(msysDamagesCommand('x'.repeat(MSYS_SAFE_COMMAND_CHARS))).toBe(false)
    expect(msysDamagesCommand('x'.repeat(MSYS_SAFE_COMMAND_CHARS + 1))).toBe(true)
    expect(hasHalvedRun('x'.repeat(MSYS_SAFE_COMMAND_CHARS + 1))).toBe(false)
  })

  it('the bound sits below the reported 8,186-character cut-off with room for the wrapper', () => {
    expect(MSYS_SAFE_COMMAND_CHARS).toBeLessThan(8186 - 500)
  })
})

describe('msysPathOf -- the Git Bash spelling of a Windows path', () => {
  it('writes the drive as a lower-case mount and every separator as a slash', () => {
    expect(msysPathOf(String.raw`C:\Users\me\.token-goat\bash_repair\tg-cmd-a.sh`)).toBe('/c/Users/me/.token-goat/bash_repair/tg-cmd-a.sh')
    expect(msysPathOf('D:/x y/z')).toBe('/d/x y/z')
  })

  it('declines a path with no drive letter and one a single-quoted word could not carry', () => {
    expect(msysPathOf(String.raw`\\server\share\x`)).toBeNull()
    expect(msysPathOf('/tmp/x')).toBeNull()
    expect(msysPathOf("C:/Users/O'Brien/x")).toBeNull()
  })
})

describe('repairIsUnsafe -- a command whose quoting hides what runs from Claude Code\'s own checks', () => {
  it.each([
    ['an expansion', String.raw`echo "$HOME" 'A:\\'`],
    ['a command substitution in backticks', 'echo `id` ' + String.raw`'A:\\'`],
    ['eval', String.raw`eval 'echo A:\\'`],
    ['rm', String.raw`rm -rf x 'A:\\'`],
    ['rm split by empty quotes', String.raw`r""m -rf x 'A:\\'`],
    ['rm with one quoted letter', String.raw`"r"m x 'A:\\'`],
    ['rm behind a backslash escape', String.raw`r\m x 'A:\\'`],
    ['rm quoted again inside a nested shell', String.raw`bash -c 'r""m x' 'A:\\'`],
    ['rmdir', String.raw`rmdir x 'A:\\'`],
    ['a protected path split by quotes', String.raw`cat .cl""aude/settings.json 'A:\\'`],
    ['a protected path', String.raw`cat .git/config 'A:\\'`],
    ['a protected path behind a variable', String.raw`P=.cla; echo ${'${P}'}ude/x 'A:\\'`],
  ])('%s is unsafe', (_name, command) => {
    expect(repairIsUnsafe(command)).toBe(true)
  })

  it('a plain command with backslashes is safe, and so is one whose words merely contain rm or eval', () => {
    expect(repairIsUnsafe(String.raw`printf '%s\n' 'A:\\' 'D:\\"x'`)).toBe(false)
    expect(repairIsUnsafe(String.raw`node -e "console.log('a\\\\b')"`)).toBe(false)
    expect(repairIsUnsafe(String.raw`echo "format" 'A:\\' evaluate`)).toBe(false)
  })
})

interface Box {
  readonly root: string
  readonly project: string
  readonly home: string
  readonly config: string
  readonly dir: string
}

function bashEvent(box: Box, command: string, extra: Record<string, unknown> = {}, harness = 'claude'): HookEvent {
  return makeHookEvent({
    toolName: 'Bash',
    toolInput: { command, description: 'd', timeout: 5000 },
    sessionId: 'bs-repair-session',
    raw: { tool_name: 'Bash', tool_input: { command }, _tg_harness: harness, cwd: box.project, permission_mode: 'default', ...extra },
  })
}

// A user allow rule is what pre-approves the original in default mode; bypassPermissions needs a claude process the hook can read, which a test has none of.
const ALLOW_RULES = ['Bash(printf:*)', 'Bash(npm:*)']

function listScripts(box: Box): string[] {
  try {
    return fs.readdirSync(box.dir)
  } catch {
    return []
  }
}

function sourcedCommand(result: ReturnType<typeof preBashHandler>): string {
  if (result.hookType !== 'rewriteInput') throw new Error(`expected a rewrite, got ${result.hookType}${result.hookType === 'deny' ? `: ${result.message}` : ''}`)
  return result.updatedInput['command'] as string
}

function denyMessage(result: ReturnType<typeof preBashHandler>): string {
  if (result.hookType !== 'deny') throw new Error(`expected a refusal, got ${result.hookType}`)
  return result.message
}

function setSettings(box: Box, settings: Record<string, unknown>): void {
  fs.writeFileSync(path.join(box.config, 'settings.json'), JSON.stringify(settings))
}

/** Spawns bash the way Claude Code does (an argv array, `-c <command>`), awaits its exit, and kills its tree on every path. */
async function runInGitBash(command: string): Promise<{ stdout: string; code: number | null }> {
  if (BASH === null) throw new Error('no Git Bash')
  const child = spawn(BASH, ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const watchdog = startWatchdog({ quietLimitMs: 20_000, label: 'Git Bash round trip' })
  const out: Buffer[] = []
  child.stdout.on('data', (c: Buffer) => { out.push(c); watchdog.progress('stdout') })
  child.stderr.on('data', () => watchdog.progress('stderr'))
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => { watchdog.progress('close'); resolve(code) })
  })
  try {
    const code = await Promise.race([closed, watchdog.failed])
    return { stdout: Buffer.concat(out).toString('utf8'), code }
  } finally {
    watchdog.stop()
    if (child.exitCode === null && child.pid !== undefined) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true })
  }
}

describe.skipIf(process.platform !== 'win32')('preBashHandler -- repairs a damaged command for Claude Code on Windows', () => {
  let box: Box

  beforeEach(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bs-repair-'))
    const home = path.join(root, 'home')
    box = { root, project: path.join(root, 'proj'), home, config: path.join(root, 'config'), dir: path.join(home, 'bash_repair') }
    for (const d of [box.project, box.config]) fs.mkdirSync(d, { recursive: true })
    setSettings(box, { permissions: { allow: ALLOW_RULES } })
    vi.stubEnv('TOKEN_GOAT_HOME', home)
    vi.stubEnv('CLAUDE_CONFIG_DIR', box.config)
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', '')
    vi.stubEnv('HERMES_SESSION_ID', '')
    vi.stubEnv('HERMES_HOME', '')
    vi.stubEnv('CLAUDE_CODE_VERSION', '2.1.0')
    // A host session reads no claude command line, so the approval is not withheld for a rule it could not see.
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'claude-vscode')
    vi.stubEnv('TOKEN_GOAT_DENY_BASH_DOUBLE_BACKSLASH', '')
    clearModuleCaches()
    invalidateConfigCache()
    resetPermissionSourceCache()
    await loadHiddenRuleCheck()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    clearModuleCaches()
    invalidateConfigCache()
    resetPermissionSourceCache()
    fs.rmSync(box.root, { recursive: true, force: true })
  })

  it('a run directly before a double quote passes untouched and writes nothing', () => {
    const result = preBashHandler(bashEvent(box, BEFORE_QUOTE_ONLY))
    expect(result.hookType).not.toBe('deny')
    expect(result.hookType).not.toBe('rewriteInput')
    expect(listScripts(box)).toEqual([])
  })

  it.each([
    ['the reported command', REPORTED],
    ['a run before a letter', String.raw`printf '%s\n' 'A:\\'`],
    ['three backslashes before a letter', String.raw`printf '%s\n' 'H:a\\\b'`],
  ])('%s is rewritten, approved, to source a script that holds it unchanged', (_name, command) => {
    const result = preBashHandler(bashEvent(box, command))
    const sourced = sourcedCommand(result)
    expect(sourced).toMatch(/^\. '\/[a-z]\/[^']+\/bash_repair\/tg-cmd-[0-9a-f]{32}\.sh'$/)
    expect(sourced).not.toContain('\\')
    if (result.hookType !== 'rewriteInput') throw new Error('unreachable')
    expect(result.updatedInput['description']).toBe('d')
    expect(result.updatedInput['timeout']).toBe(5000)
    expect(result.approve).toBe(true)
    const names = listScripts(box)
    expect(names).toHaveLength(1)
    const msys = /'([^']+)'/.exec(sourced)?.[1] as string
    expect(path.basename(shellMountToWindowsPath(msys))).toBe(names[0])
    expect(names[0]).toMatch(SCRIPT_NAME)
    const bytes = fs.readFileSync(path.join(box.dir, names[0] as string))
    expect(bytes.toString('utf8')).toBe(`rm -f -- '${msys}'\n${command}`)
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false)
  })

  it('keeps non-ASCII text byte for byte', () => {
    const command = String.raw`printf '%s' 'caf\u00e9 \u4e2d A:\\'`
    sourcedCommand(preBashHandler(bashEvent(box, command)))
    const [name] = listScripts(box)
    const bytes = fs.readFileSync(path.join(box.dir, name as string))
    expect(bytes.subarray(bytes.indexOf(0x0a) + 1).equals(Buffer.from(command, 'utf8'))).toBe(true)
  })

  it('writes line endings untouched', () => {
    const command = String.raw`printf '%s' 'A:\\'` + '\r\necho done\r\n'
    const plan = planRepair(command)
    if (plan === null) throw new Error('no plan')
    expect(writeRepairScript(plan)).toBe(true)
    const bytes = fs.readFileSync(plan.file)
    expect(bytes.subarray(bytes.indexOf(0x0a) + 1).equals(Buffer.from(command, 'utf8'))).toBe(true)
  })

  it('a command a user allow rule covers in default mode is repaired and approved', () => {
    const result = preBashHandler(bashEvent(box, REPORTED))
    expect(sourcedCommand(result)).toMatch(/^\. '/)
    if (result.hookType === 'rewriteInput') expect(result.approve).toBe(true)
  })

  it('a command that is not pre-approved is refused for that reason, not repaired, and writes no script', () => {
    setSettings(box, {})
    const message = denyMessage(preBashHandler(bashEvent(box, REPORTED)))
    expect(message).toContain('two backslashes in a row')
    expect(message).toContain('not one your permission rules already allow')
    expect(fs.existsSync(box.dir)).toBe(false)
  })

  it('a PermissionRequest hook in the settings withholds the approval, so the command is refused', () => {
    setSettings(box, { permissions: { allow: ALLOW_RULES }, hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'x' }] }] } })
    expect(denyMessage(preBashHandler(bashEvent(box, REPORTED)))).toContain('not one your permission rules already allow')
    expect(fs.existsSync(box.dir)).toBe(false)
  })

  it.each([
    ['an expansion', String.raw`printf '%s' "$HOME" 'A:\\'`],
    ['a command substitution in backticks', 'printf %s `id` ' + String.raw`'A:\\'`],
    ['eval', String.raw`eval 'printf A:\\'`],
    ['rm', String.raw`rm -rf x 'A:\\'`],
    ['rm split by empty quotes', String.raw`r""m -rf x 'A:\\'`],
    ['rm with one quoted letter', String.raw`"r"m x 'A:\\'`],
    ['a protected path split by quotes', String.raw`cat .cl""aude/settings.json 'A:\\'`],
    ['a protected path behind a variable', String.raw`P=.cla; cat ${'${P}'}ude/settings.json 'A:\\'`],
  ])('%s is refused for what it is, even where a rule allows the command, and writes no script', (_name, command) => {
    setSettings(box, { permissions: { allow: [...ALLOW_RULES, 'Bash(rm:*)', 'Bash(cat:*)', 'Bash(eval:*)'] } })
    const message = denyMessage(preBashHandler(bashEvent(box, command)))
    expect(message).toContain('two backslashes in a row')
    expect(message).toContain('`$`, a backtick, `eval`, rm, a protected path or a control character')
    expect(fs.existsSync(box.dir)).toBe(false)
  })

  it('a command past the length bound with no backslash is repaired when it is approved', () => {
    const command = `printf %s ${'a'.repeat(MSYS_SAFE_COMMAND_CHARS)}`
    expect(sourcedCommand(preBashHandler(bashEvent(box, command)))).toMatch(/^\. '/)
    expect(listScripts(box)).toHaveLength(1)
  })

  it.each([MSYS_SAFE_COMMAND_CHARS + 1, 7500, 8100])('a %i-character command with no backslash that is not approved is left alone, as it always was', (length) => {
    setSettings(box, {})
    const command = `printf %s ${'a'.repeat(length - 'printf %s '.length)}`
    expect(command).toHaveLength(length)
    const result = preBashHandler(bashEvent(box, command))
    expect(result.hookType).not.toBe('deny')
    expect(result.hookType === 'rewriteInput' ? (result.updatedInput['command'] as string).startsWith('. ') : false).toBe(false)
    expect(fs.existsSync(box.dir)).toBe(false)
  })

  it('a command that would also be compress-wrapped is repaired only, not wrapped', () => {
    const wrapped = preBashHandler(bashEvent(box, 'npm test'))
    expect(sourcedCommandOrEmpty(wrapped)).toContain('token-goat compress')
    const damaged = String.raw`npm test -- 'a\\b'`
    const result = preBashHandler(bashEvent(box, damaged))
    const sourced = sourcedCommand(result)
    expect(sourced).toMatch(/^\. '/)
    expect(sourced).not.toContain('compress')
  })

  it('the unbounded-walk refusal judges the command as written, before any repair', () => {
    const command = String.raw`find / -name 'a\\b'`
    const walk = detectUnboundedWalk(command, { windows: true, powershell: false })
    expect(walk).not.toBeNull()
    const result = preBashHandler(bashEvent(box, command))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') expect(result.message).toContain((walk as { message: string }).message)
    expect(listScripts(box)).toEqual([])
  })

  it('a Bash deny rule keeps the refusal and writes no script', () => {
    setSettings(box, { permissions: { allow: ALLOW_RULES, deny: ['Bash(printf:*)'] } })
    expect(denyMessage(preBashHandler(bashEvent(box, REPORTED)))).toContain('two backslashes in a row')
    expect(fs.existsSync(box.dir)).toBe(false)
  })

  it('an ask rule gives no rewrite and writes no script', () => {
    setSettings(box, { permissions: { allow: ALLOW_RULES, ask: ['Bash(printf:*)'] } })
    expect(preBashHandler(bashEvent(box, REPORTED)).hookType).toBe('deny')
    expect(fs.existsSync(box.dir)).toBe(false)
  })

  it('a deny rule written for another tool does not stop the repair', () => {
    setSettings(box, { permissions: { allow: ALLOW_RULES, deny: ['WebFetch'] } })
    expect(preBashHandler(bashEvent(box, REPORTED)).hookType).toBe('rewriteInput')
  })

  it('refuses, and says why, when the script cannot be written', () => {
    fs.mkdirSync(path.dirname(box.dir), { recursive: true })
    fs.writeFileSync(box.dir, 'a file where the directory should be')
    const message = denyMessage(preBashHandler(bashEvent(box, REPORTED)))
    expect(message).toContain('it could not be written')
  })

  it('a length-only command whose script cannot be written is left alone, not refused', () => {
    fs.mkdirSync(path.dirname(box.dir), { recursive: true })
    fs.writeFileSync(box.dir, 'blocked')
    expect(preBashHandler(bashEvent(box, `printf %s ${'a'.repeat(MSYS_SAFE_COMMAND_CHARS)}`)).hookType).not.toBe('deny')
  })

  it('writing a repair sweeps scripts past the bound and keeps a fresh one and anything that is not a script', () => {
    fs.mkdirSync(box.dir, { recursive: true })
    const stale = `tg-cmd-${'a'.repeat(32)}.sh`
    const fresh = `tg-cmd-${'b'.repeat(32)}.sh`
    for (const n of [stale, fresh, 'notes.txt']) fs.writeFileSync(path.join(box.dir, n), 'x')
    const old = new Date(Date.now() - 11 * 60 * 1000)
    const recent = new Date(Date.now() - 9 * 60 * 1000)
    fs.utimesSync(path.join(box.dir, stale), old, old)
    fs.utimesSync(path.join(box.dir, fresh), recent, recent)
    fs.utimesSync(path.join(box.dir, 'notes.txt'), old, old)
    sourcedCommand(preBashHandler(bashEvent(box, REPORTED)))
    const left = listScripts(box)
    expect(left).not.toContain(stale)
    expect(left).toContain(fresh)
    expect(left).toContain('notes.txt')
    expect(left).toHaveLength(3)
  })

  it('a script that was never run is gone after the next Bash call finishes, with no further repair', async () => {
    sourcedCommand(preBashHandler(bashEvent(box, REPORTED)))
    const [name] = listScripts(box)
    const file = path.join(box.dir, name as string)
    const old = new Date(Date.now() - 11 * 60 * 1000)
    fs.utimesSync(file, old, old)
    const post = makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command: 'echo hi' }, sessionId: 'bs-repair-session', raw: { tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_response: { stdout: 'hi\n' }, cwd: box.project } })
    await postBashHandler(post)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('a script written moments ago survives the sweep that runs after a Bash call', async () => {
    sourcedCommand(preBashHandler(bashEvent(box, REPORTED)))
    const post = makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command: 'echo hi' }, sessionId: 'bs-repair-session', raw: { tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_response: { stdout: 'hi\n' }, cwd: box.project } })
    await postBashHandler(post)
    expect(listScripts(box)).toHaveLength(1)
  })

  it('does nothing when the setting is off', () => {
    const cfg = defaultConfig()
    cfg.hints.deny_bash_double_backslash = false
    saveConfig(cfg)
    invalidateConfigCache()
    try {
      const result = preBashHandler(bashEvent(box, REPORTED))
      expect(result.hookType).not.toBe('deny')
      expect(result.hookType).not.toBe('rewriteInput')
      expect(fs.existsSync(box.dir)).toBe(false)
    } finally {
      saveConfig(defaultConfig())
      invalidateConfigCache()
    }
  })

  it('is unchanged off Windows and for a harness that is not Claude Code', () => {
    expect(preBashHandler(bashEvent(box, REPORTED, {}, 'codex')).hookType).not.toBe('rewriteInput')
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'opencode')
    expect(preBashHandler(bashEvent(box, REPORTED)).hookType).not.toBe('rewriteInput')
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', '')
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const result = preBashHandler(bashEvent(box, REPORTED))
      expect(result.hookType).not.toBe('rewriteInput')
      expect(result.hookType).not.toBe('deny')
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    }
    expect(fs.existsSync(box.dir)).toBe(false)
  })

  describe.skipIf(BASH === null)('through real Git Bash', () => {
    it('the rewritten command prints the reported string intact and the script is gone afterwards', async () => {
      const sourced = sourcedCommand(preBashHandler(bashEvent(box, REPORTED)))
      expect(listScripts(box)).toHaveLength(1)
      const run = await runInGitBash(sourced)
      expect(run.stdout).toBe(REPORTED_OUTPUT)
      expect(run.code).toBe(0)
      expect(listScripts(box)).toEqual([])
    })

    it('an export in the script is still set in the shell that sourced it, so it ran in that shell and not in a child', async () => {
      setSettings(box, { permissions: { allow: ['Bash(export:*)'] } })
      const sourced = sourcedCommand(preBashHandler(bashEvent(box, String.raw`export TG_X='a\\b'`)))
      const run = await runInGitBash(`${sourced}; printf '%s' "$TG_X"`)
      expect(run.stdout).toBe(String.raw`a\\b`)
      expect(run.code).toBe(0)
      expect(listScripts(box)).toEqual([])
    })

    it('a cd in the script moves the shell that sourced it', async () => {
      setSettings(box, { permissions: { allow: ['Bash(cd:*)'] } })
      const dir = normalizePath(path.join(box.root, 'w'))
      fs.mkdirSync(dir)
      // The damage is length alone: blanks between the words push the command past the bound.
      const sourced = sourcedCommand(preBashHandler(bashEvent(box, `cd${' '.repeat(MSYS_SAFE_COMMAND_CHARS)}'${dir}'`)))
      const run = await runInGitBash(`${sourced}; pwd -W`)
      expect(run.stdout.trim().toLowerCase()).toBe(dir.toLowerCase())
      expect(listScripts(box)).toEqual([])
    })

    it('a script that deletes itself on its first line still runs to the end, even when it is large', async () => {
      // The premise of the self-delete: `.` reads the whole file before it runs any of it.
      const body = Array.from({ length: 4000 }, (_v, i) => `echo line-${String(i)}-${'x'.repeat(40)}`).join('\n')
      const file = path.join(box.root, 'self-delete.sh')
      const msys = msysPathOf(file) as string
      const text = `rm -f -- '${msys}'\n${body}\ncat <<'EOF'\nheredoc-ok\nEOF\necho last\n`
      expect(Buffer.byteLength(text)).toBeGreaterThan(200_000)
      fs.writeFileSync(file, text)
      const run = await runInGitBash(`. '${msys}'`)
      const lines = run.stdout.split('\n')
      expect(lines[0]).toBe(`line-0-${'x'.repeat(40)}`)
      expect(lines.slice(-4)).toEqual([`line-3999-${'x'.repeat(40)}`, 'heredoc-ok', 'last', ''])
      expect(fs.existsSync(file)).toBe(false)
    })

    it('the bundled hook rewrites the reported payload with an allow when a rule allows it, and the result runs intact', async () => {
      const env: NodeJS.ProcessEnv = { ...process.env, TOKEN_GOAT_HOME: box.home, CLAUDE_CONFIG_DIR: box.config, HOME: box.home, USERPROFILE: box.home, TOKEN_GOAT_HARNESS_OVERRIDE: 'claudecode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', TOKEN_GOAT_OFFLINE: '1' }
      const payload = { session_id: 'bs-repair-bundle', cwd: box.project, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: REPORTED } }
      const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'pre_tool_use'], { cwd: box.project, env, input: JSON.stringify(payload), encoding: 'utf8' })
      expect(res.status, res.stderr).toBe(0)
      const out = JSON.parse(res.stdout) as { hookSpecificOutput?: { updatedInput?: { command?: string }; permissionDecision?: string } }
      const command = out.hookSpecificOutput?.updatedInput?.command as string
      expect(command).toMatch(/^\. '\//)
      expect(out.hookSpecificOutput?.permissionDecision).toBe('allow')
      const run = await runInGitBash(command)
      expect(run.stdout).toBe(REPORTED_OUTPUT)
      expect(listScripts(box)).toEqual([])
    })

    it('the bundled hook refuses the same payload in default mode with no allow rule, and writes no script', () => {
      setSettings(box, {})
      const env: NodeJS.ProcessEnv = { ...process.env, TOKEN_GOAT_HOME: box.home, CLAUDE_CONFIG_DIR: box.config, HOME: box.home, USERPROFILE: box.home, TOKEN_GOAT_HARNESS_OVERRIDE: 'claudecode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', TOKEN_GOAT_OFFLINE: '1' }
      const payload = { session_id: 'bs-repair-bundle', cwd: box.project, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: REPORTED } }
      const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'pre_tool_use'], { cwd: box.project, env, input: JSON.stringify(payload), encoding: 'utf8' })
      expect(res.status, res.stderr).toBe(0)
      const out = JSON.parse(res.stdout) as { decision?: string; reason?: string; hookSpecificOutput?: unknown }
      expect(out.decision).toBe('block')
      expect(out.hookSpecificOutput).toBeUndefined()
      expect(out.reason).toContain('not one your permission rules already allow')
      expect(listScripts(box)).toEqual([])
    })
  })
})

function sourcedCommandOrEmpty(result: ReturnType<typeof preBashHandler>): string {
  return result.hookType === 'rewriteInput' ? (result.updatedInput['command'] as string) : ''
}
