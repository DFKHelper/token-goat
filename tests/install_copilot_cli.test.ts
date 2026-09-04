import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted -- wrap homedir (delegating to the real implementation by
// default) so each test below can point `~` at an isolated temp dir instead of
// touching the real `~/.copilot/` (mirrors the pattern in install_codex.test.ts /
// install_pi.test.ts).
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import {
  copilotCliConfigPath,
  copilotCliInstructionsPath,
  copilotCliProjectHooksDir,
  copilotCliScriptPath,
  copilotCliUserHooksDir,
  installCopilotCli,
  isCopilotCliInstalled,
  uninstallCopilotCli,
} from '../src/bridges/copilot_cli_install.js'
import { COPILOT_CLI_HOOK_SCRIPT } from '../src/bridges/copilot_cli.js'
import { HOOK_EVENTS } from '../src/types.js'

let TMP: string
let origCwd: string
let origCopilotHome: string | undefined

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-copilot-cli-install-'))
  const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
  homedirMock.mockReturnValue(path.join(TMP, 'home'))

  // COPILOT_HOME now outranks os.homedir() for the user scope, so a developer or CI
  // machine that happens to export it would silently redirect every user-scope
  // assertion below away from the mocked home. Pin it off; the tests that exercise
  // the override set it themselves.
  origCopilotHome = process.env['COPILOT_HOME']
  delete process.env['COPILOT_HOME']

  origCwd = process.cwd()
  // Project-scope install resolves against process.cwd() (mirrors install_pi.test.ts's
  // handling of --local); chdir into an isolated project dir so `{ local: true }`
  // writes under {TMP}/project/.github/hooks, never this repo's own .github/.
  fs.mkdirSync(path.join(TMP, 'project'), { recursive: true })
  process.chdir(path.join(TMP, 'project'))
})

afterEach(() => {
  process.chdir(origCwd)
  if (origCopilotHome === undefined) delete process.env['COPILOT_HOME']
  else process.env['COPILOT_HOME'] = origCopilotHome
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('installCopilotCli (user scope)', () => {
  it('writes the shim script and a hooks config registering all eight implemented events on a fresh install', () => {
    const result = installCopilotCli()
    expect(result.alreadyInstalled).toBe(false)
    expect(result.configPath).toBe(copilotCliConfigPath())
    expect(result.scriptPath).toBe(copilotCliScriptPath())
    expect(fs.existsSync(result.configPath)).toBe(true)
    expect(fs.existsSync(result.scriptPath)).toBe(true)
    expect(fs.readFileSync(result.scriptPath, 'utf8')).toBe(COPILOT_CLI_HOOK_SCRIPT)

    const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8')) as {
      version: number
      hooks: Record<string, Array<{ type: string; command: string }>>
    }
    expect(config.version).toBe(1)
    // Locked to the exact set, not a subset: a silently dropped event (sessionStart was
    // missing entirely for months) has to fail here rather than pass a per-event loop.
    expect(Object.keys(config.hooks).sort()).toEqual(
      [
        'sessionStart',
        'preToolUse',
        'postToolUse',
        'preCompact',
        'agentStop',
        'subagentStop',
        'userPromptSubmitted',
        'postToolUseFailure',
      ].sort(),
    )
    for (const event of [
      'sessionStart',
      'preToolUse',
      'postToolUse',
      'preCompact',
      'agentStop',
      'subagentStop',
      'userPromptSubmitted',
      'postToolUseFailure',
    ]) {
      expect(config.hooks[event]).toBeDefined()
      expect(config.hooks[event]?.[0]?.type).toBe('command')
      expect(config.hooks[event]?.[0]?.command).toContain(result.scriptPath)
    }

    expect(isCopilotCliInstalled()).toBe(true)
  })

  it('uses the absolute Node binary path (process.execPath), not bare node, in the generated hook command (github/copilot-cli#4001 regression)', () => {
    const result = installCopilotCli()
    const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8')) as {
      hooks: Record<string, Array<{ command: string }>>
    }
    const command = config.hooks['preToolUse']?.[0]?.command
    expect(command).toBeDefined()
    expect(command).toContain(process.execPath)
    expect(command).not.toBe(`node "${result.scriptPath}" preToolUse`)
    expect(command?.startsWith('node ')).toBe(false)
  })

  it("bakes the running token-goat entry's absolute path (process.argv[1]) as a third arg in the generated hook command, so the shim's own inner call can bypass PATH resolution too", () => {
    const result = installCopilotCli()
    const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8')) as {
      hooks: Record<string, Array<{ command: string }>>
    }
    const command = config.hooks['preToolUse']?.[0]?.command
    expect(command).toBeDefined()
    expect(process.argv[1]).toBeDefined()
    expect(command).toContain(`"${process.argv[1]}"`)
    // Ordering: execPath, then scriptPath, then event, then entryPath -- the shim reads the
    // entry path from argv[3], so it must be the fourth quoted/bare token on the line.
    expect(command).toBe(`"${process.execPath}" "${result.scriptPath}" preToolUse "${process.argv[1]}"`)
  })

  it('emits a separate powershell field prefixed with the call operator (&), since Copilot CLI feeds it directly to PowerShell on Windows, not cmd.exe (github/copilot-cli hooks-reference: command is only copied to bash/powershell as a fallback)', () => {
    const result = installCopilotCli()
    const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8')) as {
      hooks: Record<string, Array<{ command: string; bash: string; powershell: string }>>
    }
    const entry = config.hooks['preToolUse']?.[0]
    expect(entry).toBeDefined()
    // A bare quoted-exe-then-quoted-args string (valid cmd.exe syntax) is a PowerShell parse
    // error without a leading call operator -- two adjacent quoted string literals are not a
    // valid expression/statement in PowerShell. Confirmed live via Copilot CLI's own logged
    // ParserError: "Unexpected token '"...\token-goat-shim.js"' in expression or statement."
    expect(entry?.powershell.startsWith('& "')).toBe(true)
    expect(entry?.powershell).toBe(`& ${entry?.command}`)
    // bash doesn't need a call operator for a quoted path, so it matches command verbatim.
    expect(entry?.bash).toBe(entry?.command)
  })

  it('sets a generous timeoutSec on every generated hook entry', () => {
    const result = installCopilotCli()
    const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8')) as {
      hooks: Record<string, Array<{ timeoutSec: number }>>
    }
    for (const event of [
      'preToolUse',
      'postToolUse',
      'preCompact',
      'agentStop',
      'subagentStop',
      'userPromptSubmitted',
      'postToolUseFailure',
    ]) {
      const timeoutSec = config.hooks[event]?.[0]?.timeoutSec
      // Copilot's own documented default is 30s; this must be strictly more generous, not
      // just present, or a slow cold start gains nothing from the override.
      expect(typeof timeoutSec).toBe('number')
      expect(timeoutSec).toBeGreaterThan(30)
    }
  })

  it('populates allowedEnvVars including TRACEPARENT and TRACESTATE on every generated hook entry', () => {
    const result = installCopilotCli()
    const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8')) as {
      hooks: Record<string, Array<{ allowedEnvVars?: string[] }>>
    }
    for (const event of [
      'sessionStart',
      'preToolUse',
      'postToolUse',
      'preCompact',
      'agentStop',
      'subagentStop',
      'userPromptSubmitted',
      'postToolUseFailure',
    ]) {
      const allowed = config.hooks[event]?.[0]?.allowedEnvVars
      expect(allowed).toBeDefined()
      expect(allowed).toContain('TRACEPARENT')
      expect(allowed).toContain('TRACESTATE')
      expect(allowed).toContain('COPILOT_HOME')
    }
  })

  it('is idempotent: a second install reports alreadyInstalled and does not duplicate or alter entries', () => {
    installCopilotCli()
    const second = installCopilotCli()
    expect(second.alreadyInstalled).toBe(true)

    const config = JSON.parse(fs.readFileSync(second.configPath, 'utf8')) as {
      hooks: Record<string, unknown[]>
    }
    for (const event of [
      'preToolUse',
      'postToolUse',
      'preCompact',
      'agentStop',
      'subagentStop',
      'userPromptSubmitted',
      'postToolUseFailure',
    ]) {
      expect(config.hooks[event]).toHaveLength(1)
    }
  })

  it('overwrites a hand-modified shim script wholesale instead of merging or warning', () => {
    const result = installCopilotCli()
    fs.writeFileSync(result.scriptPath, '#!/usr/bin/env node\n// hand-edited\n')

    const second = installCopilotCli()
    expect(second.alreadyInstalled).toBe(false)
    expect(fs.readFileSync(result.scriptPath, 'utf8')).toBe(COPILOT_CLI_HOOK_SCRIPT)
  })

  it('does not touch unrelated files already present in the hooks directory', () => {
    const dir = copilotCliUserHooksDir()
    fs.mkdirSync(dir, { recursive: true })
    const unrelatedPath = path.join(dir, 'some-other-tool.json')
    fs.writeFileSync(unrelatedPath, '{"version":1,"hooks":{}}\n')

    installCopilotCli()

    expect(fs.readFileSync(unrelatedPath, 'utf8')).toBe('{"version":1,"hooks":{}}\n')
  })

  it('backs up a hand-edited hooks config (with the OLD content) before overwriting it on reinstall', () => {
    const result = installCopilotCli()
    const handEdited = JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'command', command: 'custom', timeoutSec: 30 }] } })
    fs.writeFileSync(result.configPath, handEdited)

    installCopilotCli()

    const dir = path.dirname(result.configPath)
    const bakFiles = fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(result.configPath) + '.bak.'))
    expect(bakFiles.length).toBe(1)
    expect(fs.readFileSync(path.join(dir, bakFiles[0] as string), 'utf8')).toBe(handEdited)
    // and the config itself was regenerated back to the desired shape
    expect(fs.readFileSync(result.configPath, 'utf8')).not.toBe(handEdited)
  })

  it('does not create a spurious .bak file when reinstalling with no actual config change', () => {
    const result = installCopilotCli()
    installCopilotCli()

    const dir = path.dirname(result.configPath)
    const bakFiles = fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(result.configPath) + '.bak.'))
    expect(bakFiles.length).toBe(0)
  })
})

describe('COPILOT_HOME override (user scope)', () => {
  // Copilot CLI documents COPILOT_HOME as replacing ~/.copilot for hooks and instructions.
  // Ignoring it fails silently in the worst way: install reports success, writes a valid
  // config under ~/.copilot, and Copilot reads a different directory entirely, so every
  // hook never fires and nothing surfaces the mismatch.
  it('redirects the hooks dir, config, shim, and instructions file to $COPILOT_HOME', () => {
    const custom = path.join(TMP, 'custom-copilot')
    process.env['COPILOT_HOME'] = custom

    expect(copilotCliUserHooksDir()).toBe(path.join(custom, 'hooks'))
    expect(copilotCliConfigPath()).toBe(path.join(custom, 'hooks', 'token-goat.json'))
    expect(copilotCliScriptPath()).toBe(path.join(custom, 'hooks', 'token-goat-shim.js'))
    expect(copilotCliInstructionsPath()).toBe(path.join(custom, 'copilot-instructions.md'))

    const result = installCopilotCli()
    expect(fs.existsSync(result.configPath)).toBe(true)
    expect(fs.existsSync(result.scriptPath)).toBe(true)
    expect(fs.existsSync(result.instructionsPath)).toBe(true)
    expect(isCopilotCliInstalled()).toBe(true)
    // The whole point: nothing lands in the home-relative default.
    expect(fs.existsSync(path.join(TMP, 'home', '.copilot'))).toBe(false)
  })

  it('treats an exported-but-empty COPILOT_HOME as unset rather than installing into the process cwd', () => {
    process.env['COPILOT_HOME'] = '   '
    // path.resolve('   ') would silently resolve to a whitespace-named dir under cwd.
    expect(copilotCliUserHooksDir()).toBe(path.join(TMP, 'home', '.copilot', 'hooks'))
  })

  it('leaves the project scope alone -- COPILOT_HOME is a user-scope concept only', () => {
    process.env['COPILOT_HOME'] = path.join(TMP, 'custom-copilot')
    expect(copilotCliConfigPath({ local: true })).toBe(
      path.join(process.cwd(), '.github', 'hooks', 'token-goat.json'),
    )
  })
})

describe('installCopilotCli ({ local: true })', () => {
  it('writes to the project-scoped path instead of the user-scoped one', () => {
    const result = installCopilotCli({ local: true })
    expect(result.configPath).toBe(copilotCliConfigPath({ local: true }))
    expect(result.configPath).toBe(path.join(process.cwd(), '.github', 'hooks', 'token-goat.json'))
    expect(fs.existsSync(copilotCliUserHooksDir())).toBe(false)
    expect(fs.existsSync(result.configPath)).toBe(true)
  })

  it('is idempotent for the project scope too', () => {
    installCopilotCli({ local: true })
    const second = installCopilotCli({ local: true })
    expect(second.alreadyInstalled).toBe(true)
  })

  it('does not collide with a user-scope install in the same run', () => {
    const userResult = installCopilotCli()
    const localResult = installCopilotCli({ local: true })
    expect(userResult.configPath).not.toBe(localResult.configPath)
    expect(fs.existsSync(userResult.configPath)).toBe(true)
    expect(fs.existsSync(localResult.configPath)).toBe(true)
  })

  it('resolves copilotCliProjectHooksDir() to <cwd>/.github/hooks', () => {
    expect(copilotCliProjectHooksDir()).toBe(path.join(process.cwd(), '.github', 'hooks'))
  })
})

describe('isCopilotCliInstalled / uninstallCopilotCli', () => {
  it('isCopilotCliInstalled is false before install, true after (user scope)', () => {
    expect(isCopilotCliInstalled()).toBe(false)
    installCopilotCli()
    expect(isCopilotCliInstalled()).toBe(true)
  })

  it('isCopilotCliInstalled is false before install, true after (project scope)', () => {
    expect(isCopilotCliInstalled({ local: true })).toBe(false)
    installCopilotCli({ local: true })
    expect(isCopilotCliInstalled({ local: true })).toBe(true)
  })

  it('uninstallCopilotCli removes the config and the shim script, and returns true', () => {
    const result = installCopilotCli()
    expect(uninstallCopilotCli()).toBe(true)
    expect(isCopilotCliInstalled()).toBe(false)
    expect(fs.existsSync(result.configPath)).toBe(false)
    expect(fs.existsSync(result.scriptPath)).toBe(false)
  })

  it('uninstallCopilotCli returns false when nothing is installed', () => {
    expect(uninstallCopilotCli()).toBe(false)
  })

  it('uninstallCopilotCli removes exactly token-goat\'s entries, leaving an unrelated sibling file in the hooks dir intact', () => {
    const dir = copilotCliUserHooksDir()
    fs.mkdirSync(dir, { recursive: true })
    const unrelatedPath = path.join(dir, 'some-other-tool.json')
    fs.writeFileSync(unrelatedPath, '{"version":1,"hooks":{}}\n')

    installCopilotCli()
    uninstallCopilotCli()

    expect(fs.existsSync(unrelatedPath)).toBe(true)
    expect(fs.readFileSync(unrelatedPath, 'utf8')).toBe('{"version":1,"hooks":{}}\n')
  })

  // Regression: uninstallCopilotCli used to require the caller to pass the exact
  // scope opts it was installed with -- since the CLI's --copilot uninstall always
  // forced { local: opts.local === true } (never left undefined), a plain
  // `token-goat uninstall --copilot` (no --local) could never clean up a --local
  // install; the user had to remember to also pass --local, or it silently
  // survived. uninstallCopilotCli() with no explicit local now cleans up wherever
  // the hook config actually is, both scopes at once.
  it('uninstallCopilotCli() with no explicit scope removes both a user-scope and a project-scope install', () => {
    const userResult = installCopilotCli()
    const localResult = installCopilotCli({ local: true })
    expect(uninstallCopilotCli()).toBe(true)
    expect(fs.existsSync(userResult.configPath)).toBe(false)
    expect(fs.existsSync(localResult.configPath)).toBe(false)
  })

  it('uninstallCopilotCli({ local: true }) narrows removal to the project scope, leaving a user-scope install untouched', () => {
    const userResult = installCopilotCli()
    installCopilotCli({ local: true })
    uninstallCopilotCli({ local: true })
    expect(fs.existsSync(userResult.configPath)).toBe(true)
  })
})

const TG_BEGIN = '<!-- token-goat-begin -->'
const TG_END = '<!-- token-goat-end -->'

describe('copilot-instructions.md routing block', () => {
  it('writes a delimited token-goat gate block on a fresh install and surfaces its path', () => {
    const result = installCopilotCli()
    expect(result.instructionsPath).toBe(copilotCliInstructionsPath())
    expect(fs.existsSync(result.instructionsPath)).toBe(true)

    const text = fs.readFileSync(result.instructionsPath, 'utf8')
    expect(text).toContain(TG_BEGIN)
    expect(text).toContain(TG_END)
    // Phrased as a pre-call gate, not an advisory tip.
    expect(text).toContain('Gate')
    expect(text).toContain('violation, not an oversight')
    expect(text).toContain('per file')
    expect(text).toContain('~200 lines')
    // The Copilot instructions surface is sanitized so the body contains no backtick-quoted
    // command names for the fallback parser to misclassify.
    expect(text).not.toContain('`')
    expect(text).toContain('Fallback clauses may name')
    expect(text).toContain("Copilot CLI's native view, grep, and glob tools")
    expect(text).toContain('PowerShell commands Get-Content/Select-String as search fallbacks')
    expect(text).toContain('Get-Content')
    expect(text).toContain('Select-String')
    // Carries the sub-agent instruction and the stats self-check.
    expect(text).toContain('Sub-agent briefs')
    expect(text).toContain('token-goat stats')

    expect(isCopilotCliInstalled()).toBe(true)
  })

  it('resolves copilotCliInstructionsPath() to <userHooksDir>/../copilot-instructions.md (user) and <cwd>/.github/copilot-instructions.md (project)', () => {
    expect(copilotCliInstructionsPath()).toBe(path.join(path.dirname(copilotCliUserHooksDir()), 'copilot-instructions.md'))
    expect(copilotCliInstructionsPath({ local: true })).toBe(path.join(process.cwd(), '.github', 'copilot-instructions.md'))
  })

  it('is idempotent: a reinstall neither duplicates the block nor reports a change', () => {
    const first = installCopilotCli()
    const before = fs.readFileSync(first.instructionsPath, 'utf8')
    const second = installCopilotCli()
    expect(second.alreadyInstalled).toBe(true)
    const after = fs.readFileSync(second.instructionsPath, 'utf8')
    expect(after).toBe(before)
    // Exactly one block, never two.
    expect(after.split(TG_BEGIN).length - 1).toBe(1)
    expect(after.split(TG_END).length - 1).toBe(1)
  })

  it('preserves every byte outside the markers when upserting into a large hand-written file', () => {
    const p = copilotCliInstructionsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    // A large, user-authored file with NO existing token-goat block: the writer
    // must append its block and leave all prior content byte-for-byte intact.
    const preamble = '# My personal instructions\n\n' + 'Some paragraph about my workflow. '.repeat(400) + '\n'
    fs.writeFileSync(p, preamble)

    installCopilotCli()

    const after = fs.readFileSync(p, 'utf8')
    expect(after.startsWith(preamble.replace(/\s+$/, ''))).toBe(true)
    expect(after).toContain(TG_BEGIN)
    // Everything before the injected block equals the original (trailing whitespace normalized by upsert).
    expect(after.slice(0, after.indexOf(TG_BEGIN)).trim()).toBe(preamble.trim())
  })

  it('upgrades a legacy/older token-goat block in place rather than appending a second one', () => {
    const p = copilotCliInstructionsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const head = '# My instructions\n\nKeep me above.\n\n'
    const legacyBlock = `${TG_BEGIN}\n## token-goat\n\nPrefer token-goat commands over reading whole files.\n${TG_END}`
    const tail = '\n\nKeep me below.\n'
    fs.writeFileSync(p, head + legacyBlock + tail)

    const result = installCopilotCli()
    expect(result.alreadyInstalled).toBe(false)

    const after = fs.readFileSync(p, 'utf8')
    // Still exactly one block, upgraded to the new gate wording.
    expect(after.split(TG_BEGIN).length - 1).toBe(1)
    expect(after).not.toContain('Prefer token-goat commands over reading whole files.')
    expect(after).toContain('violation, not an oversight')
    // Surrounding user content untouched.
    expect(after).toContain('Keep me above.')
    expect(after).toContain('Keep me below.')
  })

  it('uninstall strips the block and leaves surrounding content intact, without deleting the file', () => {
    const p = copilotCliInstructionsPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const head = '# My instructions\n\nAbove content.\n'
    const tail = 'Below content.\n'
    fs.writeFileSync(p, head)

    installCopilotCli()
    // Append user content after the injected block to prove both sides survive.
    fs.appendFileSync(p, '\n' + tail)
    expect(fs.readFileSync(p, 'utf8')).toContain(TG_BEGIN)

    expect(uninstallCopilotCli()).toBe(true)

    const after = fs.readFileSync(p, 'utf8')
    expect(fs.existsSync(p)).toBe(true)
    expect(after).not.toContain(TG_BEGIN)
    expect(after).not.toContain(TG_END)
    expect(after).toContain('Above content.')
    expect(after).toContain('Below content.')
  })

  it('project scope writes the block to <cwd>/.github/copilot-instructions.md', () => {
    const result = installCopilotCli({ local: true })
    expect(result.instructionsPath).toBe(path.join(process.cwd(), '.github', 'copilot-instructions.md'))
    expect(fs.readFileSync(result.instructionsPath, 'utf8')).toContain(TG_BEGIN)
    expect(isCopilotCliInstalled({ local: true })).toBe(true)
  })
})

// --- shim script (COPILOT_CLI_HOOK_SCRIPT) behavior ---
// Mirrors tests/bridges/shims.test.ts's approach: run the embedded script as a
// standalone Node process exactly as Copilot CLI would (argv[2] = event name,
// stdin = the hook payload JSON), and inspect what it writes to stdout.

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function mkIsolated(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'tg-copilot-shim-test-'))
  tempDirs.push(dir)
  return dir
}

function runShim(eventName: string, stdin: string, cwd: string, env?: NodeJS.ProcessEnv): string {
  const scriptPath = path.join(cwd, 'shim.js')
  fs.writeFileSync(scriptPath, COPILOT_CLI_HOOK_SCRIPT, 'utf8')
  const res = spawnSync(process.execPath, [scriptPath, eventName], {
    cwd,
    input: stdin,
    encoding: 'utf8',
    timeout: 15000,
    env: env ?? process.env,
  })
  return res.stdout ?? ''
}

/**
 * Writes a fake `token-goat` executable into `cwd` and returns a PATH-prepended env pointing
 * at it, so the shim's internal `spawnSync('token-goat', ['hook', event], { shell: true })`
 * resolves to `jsonStdout` instead of the real installed binary (mirrors
 * tests/bridges/shims.test.ts's withFakeTokenGoat).
 */
/**
 * Like `withFakeTokenGoat`, but the fake records that it ran instead of answering with content.
 *
 * The shim translates whatever token-goat returns into a Copilot hook response and writes `{}` for
 * anything it does not recognise, so a fake that only echoes JSON is invisible from stdout: an
 * assertion on the envelope passes whether the inner command ran or not. Whether the spawn happened
 * at all is the one difference that shows, so the fake touches a file and the test reads that.
 */
function withRecordingTokenGoat(cwd: string): { env: NodeJS.ProcessEnv; spawned: () => boolean } {
  const marker = path.join(cwd, 'token-goat-was-spawned')
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(cwd, 'token-goat.cmd'), `@echo off
echo x > "${marker}"
echo {}
`, 'utf8')
  } else {
    const scriptPath = path.join(cwd, 'token-goat')
    fs.writeFileSync(scriptPath, `#!/bin/sh
echo x > '${marker}'
echo '{}'
`, 'utf8')
    fs.chmodSync(scriptPath, 0o755)
  }
  return {
    env: { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') },
    spawned: () => fs.existsSync(marker),
  }
}

function withFakeTokenGoat(cwd: string, jsonStdout: string): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(cwd, 'token-goat.cmd'), `@echo off\r\necho ${jsonStdout}\r\n`, 'utf8')
  } else {
    const scriptPath = path.join(cwd, 'token-goat')
    fs.writeFileSync(scriptPath, `#!/bin/sh\necho '${jsonStdout}'\n`, 'utf8')
    fs.chmodSync(scriptPath, 0o755)
  }
  return { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }
}

/**
 * Writes a fake token-goat "entry" -- a plain Node script, not a PATH-resolvable binary --
 * that records the argv it was invoked with to `captured-argv.json` in `cwd` and exits 0
 * with an empty JSON response. Used to prove the shim's inner call, when given a third argv
 * (the baked entry path), invokes that path directly via process.execPath rather than
 * shelling out to a PATH-resolved `token-goat` at all.
 */
function writeFakeEntry(cwd: string): { entryPath: string; capturePath: string } {
  const entryPath = path.join(cwd, 'fake-entry.js')
  const capturePath = path.join(cwd, 'captured-argv.json')
  const captureLiteral = JSON.stringify(capturePath)
  fs.writeFileSync(
    entryPath,
    `require('fs').writeFileSync(${captureLiteral}, JSON.stringify(process.argv.slice(2)))\nprocess.stdout.write('{}')\n`,
    'utf8',
  )
  return { entryPath, capturePath }
}

describe('COPILOT_CLI_HOOK_SCRIPT', () => {
  it("invokes the baked entry path (argv[3]) directly via process.execPath, bypassing PATH resolution entirely, when the shim receives one", () => {
    const cwd = mkIsolated()
    const { entryPath, capturePath } = writeFakeEntry(cwd)
    // Deliberately no PATH-resolvable `token-goat` anywhere -- if the shim fell back to the
    // old shell:true PATH lookup instead of using entryPath, this would fail to launch and
    // captured-argv.json would never be written.
    const scriptPath = path.join(cwd, 'shim.js')
    fs.writeFileSync(scriptPath, COPILOT_CLI_HOOK_SCRIPT, 'utf8')
    const res = spawnSync(
      process.execPath,
      [scriptPath, 'preToolUse', entryPath],
      {
        cwd,
        input: JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: 'view', toolArgs: { path: '/f.txt' } }),
        encoding: 'utf8',
        timeout: 15000,
        env: process.env,
      },
    )
    expect(res.status).toBe(0)
    expect(fs.existsSync(capturePath)).toBe(true)
    const capturedArgv = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as string[]
    expect(capturedArgv).toEqual(['hook', 'pre_tool_use'])
  })

  it('every Copilot event name it maps to a token-goat event resolves to a real HOOK_EVENTS member', () => {
    const mapMatch = /COPILOT_TO_TG_EVENT = \{([\s\S]*?)\}/.exec(COPILOT_CLI_HOOK_SCRIPT)
    expect(mapMatch).not.toBeNull()
    const mapped = [...(mapMatch?.[1] ?? '').matchAll(/:\s*'([^']+)'/g)].map((m) => m[1])
    // 8 entries: sessionStart, preToolUse, postToolUse, preCompact, agentStop, subagentStop,
    // userPromptSubmitted, postToolUseFailure.
    expect(mapped.length).toBe(8)
    for (const eventName of mapped) {
      expect(HOOK_EVENTS as readonly string[]).toContain(eventName)
    }
  })

  // sessionStart is the only channel that reaches the model before it chooses its first read
  // tool, so it is where token-goat's command-routing reminder has to land. It used to be a
  // hard-coded early return, justified in a comment by the claim that token-goat had no
  // session_start handler -- untrue, and the reason Copilot CLI sessions alone were never told
  // token-goat exists. Verified live against Copilot CLI 1.0.77 before wiring: with the hook
  // registered, a session asked for a canary that appears only in the reminder answered
  // "131072, boundSymbolBody"; with sessionStart removed and nothing else changed, the same
  // question in the same directory answered "ABSENT".
  it('forwards sessionStart to the real session_start handler instead of short-circuiting it', () => {
    const cwd = mkIsolated()
    const { entryPath, capturePath } = writeFakeEntry(cwd)
    const scriptPath = path.join(cwd, 'shim.js')
    fs.writeFileSync(scriptPath, COPILOT_CLI_HOOK_SCRIPT, 'utf8')
    const res = spawnSync(process.execPath, [scriptPath, 'sessionStart', entryPath], {
      cwd,
      input: JSON.stringify({ sessionId: 's1', cwd: '/tmp' }),
      encoding: 'utf8',
      timeout: 15000,
      env: process.env,
    })
    expect(res.status).toBe(0)
    // The proof the early return is gone: token-goat was actually invoked, with the mapped
    // internal event name. A behavioural '{}' assertion could not distinguish "no-op" from
    // "invoked and had nothing to say".
    expect(fs.existsSync(capturePath)).toBe(true)
    expect(JSON.parse(fs.readFileSync(capturePath, 'utf8')) as string[]).toEqual([
      'hook',
      'session_start',
    ])
  })

  it("surfaces the session_start handler's context to Copilot as additionalContext", () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(
      cwd,
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ROUTING GATE' },
      }),
    )
    const stdout = runShim('sessionStart', JSON.stringify({ sessionId: 's1', cwd }), cwd, env)
    expect(JSON.parse(stdout) as Record<string, unknown>).toEqual({ additionalContext: 'ROUTING GATE' })
  })

  it('still emits {} for sessionStart when the handler produces no context, rather than a stray key', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(cwd, '{}')
    const stdout = runShim('sessionStart', JSON.stringify({ sessionId: 's1', cwd }), cwd, env)
    expect(stdout.trim()).toBe('{}')
  })

  it('no-ops on an event name it does not implement', () => {
    const cwd = mkIsolated()
    const stdout = runShim('sessionEnd', '{}', cwd)
    expect(stdout.trim()).toBe('{}')
  })

  // The event map is a plain object literal and its value is concatenated into a shell command
  // string further down the shim, so every name Object.prototype supplies has to be rejected the
  // same way an unknown name is. Fixtures are HAND-DERIVED: the list is Object.prototype's own
  // enumerable-by-lookup members, taken from the language, not from the map or the check.
  it.each([
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
  ])('no-ops on the inherited property name %s rather than resolving it to an event', (name) => {
    const cwd = mkIsolated()
    const { env, spawned } = withRecordingTokenGoat(cwd)
    expect(runShim(name, '{}', cwd, env).trim()).toBe('{}')
    expect(
      spawned(),
      `The shim resolved ${name} to a value and built "token-goat hook <value>" from it, then ran ` +
        'that string through a shell. The stdout envelope is identical either way -- the spawn is ' +
        'the only observable difference -- so this assertion, not the envelope, is what proves the ' +
        'name was rejected.',
    ).toBe(false)
  })

  // Calibration for the eight cases above. A "did not spawn" assertion is worth nothing until the
  // same harness is shown to report a spawn when one really happens, and to report none for a name
  // that is merely unknown: without both poles this file would stay green against a shim that never
  // spawned at all. Measured 2026-09-04 against this shim: preToolUse spawns, nosuchevent does not,
  // and with the own-property check reverted all eight inherited names spawn.
  it('the spawn recorder above distinguishes a real event from an unknown one', () => {
    const real = mkIsolated()
    const realFake = withRecordingTokenGoat(real)
    runShim('preToolUse', '{}', real, realFake.env)
    expect(realFake.spawned(), 'preToolUse did not reach the spawn fallback, so the eight assertions above cannot fail').toBe(true)

    const unknown = mkIsolated()
    const unknownFake = withRecordingTokenGoat(unknown)
    runShim('nosuchevent', '{}', unknown, unknownFake.env)
    expect(unknownFake.spawned()).toBe(false)
  })

  it('fails open ({}) on malformed JSON on stdin', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(cwd, '{}')
    const stdout = runShim('preToolUse', 'not json', cwd, env)
    expect(stdout.trim()).toBe('{}')
  })

  it('fails open ({}) when the token-goat child process exits non-zero', () => {
    const cwd = mkIsolated()
    const scriptPath =
      process.platform === 'win32' ? path.join(cwd, 'token-goat.cmd') : path.join(cwd, 'token-goat')
    if (process.platform === 'win32') {
      fs.writeFileSync(scriptPath, '@echo off\r\nexit /b 1\r\n', 'utf8')
    } else {
      fs.writeFileSync(scriptPath, '#!/bin/sh\nexit 1\n', 'utf8')
      fs.chmodSync(scriptPath, 0o755)
    }
    const env = { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }
    const stdout = runShim('preToolUse', '{}', cwd, env)
    expect(stdout.trim()).toBe('{}')
  })

  it('sets TOKEN_GOAT_HARNESS_OVERRIDE=copilot_cli when invoking token-goat, since Copilot has no ambient env-var signal of its own', () => {
    expect(COPILOT_CLI_HOOK_SCRIPT).toMatch(/TOKEN_GOAT_HARNESS_OVERRIDE:\s*'copilot_cli'/)
  })

  it('translates a preToolUse deny (decision:"block") into permissionDecision:"deny"', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(cwd, JSON.stringify({ decision: 'block', reason: 'already read this session' }))
    const stdout = runShim(
      'preToolUse',
      JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: 'read', toolArgs: { path: '/f.txt' } }),
      cwd,
      env,
    )
    const parsed = JSON.parse(stdout)
    expect(parsed.permissionDecision).toBe('deny')
    expect(parsed.permissionDecisionReason).toBe('already read this session')
  })

  it('translates a preToolUse rewriteInput (hookSpecificOutput.updatedInput) into modifiedArgs', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(
      cwd,
      JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'compressed-command' } } }),
    )
    const stdout = runShim(
      'preToolUse',
      JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: 'shell', toolArgs: { command: 'original' } }),
      cwd,
      env,
    )
    const parsed = JSON.parse(stdout)
    expect(parsed.modifiedArgs).toEqual({ command: 'compressed-command' })
  })

  it('translates a postToolUse context response (hookSpecificOutput.additionalContext) into additionalContext', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(
      cwd,
      JSON.stringify({ hookSpecificOutput: { additionalContext: 'you already read this file' } }),
    )
    const stdout = runShim(
      'postToolUse',
      JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: 'read', toolArgs: {}, toolResult: {} }),
      cwd,
      env,
    )
    const parsed = JSON.parse(stdout)
    expect(parsed.additionalContext).toBe('you already read this file')
  })

  it('translates a postToolUse rewriteOutput (hookSpecificOutput.updatedToolOutput) into modifiedResult', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(
      cwd,
      JSON.stringify({ hookSpecificOutput: { updatedToolOutput: 'compressed body' } }),
    )
    const stdout = runShim(
      'postToolUse',
      JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: 'read', toolArgs: {}, toolResult: {} }),
      cwd,
      env,
    )
    const parsed = JSON.parse(stdout)
    expect(parsed.modifiedResult).toEqual({ resultType: 'success', textResultForLlm: 'compressed body' })
    expect(parsed.additionalContext).toBeUndefined()
  })

  it('emits both modifiedResult and additionalContext when a postToolUse response carries both', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(
      cwd,
      JSON.stringify({
        hookSpecificOutput: { updatedToolOutput: 'compressed body', additionalContext: 'a hint' },
      }),
    )
    const stdout = runShim(
      'postToolUse',
      JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: 'read', toolArgs: {}, toolResult: {} }),
      cwd,
      env,
    )
    const parsed = JSON.parse(stdout)
    expect(parsed.modifiedResult).toEqual({ resultType: 'success', textResultForLlm: 'compressed body' })
    expect(parsed.additionalContext).toBe('a hint')
  })

  it('does not emit modifiedResult for sessionStart even when the response carries updatedToolOutput', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(
      cwd,
      JSON.stringify({ hookSpecificOutput: { updatedToolOutput: 'should never surface here' } }),
    )
    const stdout = runShim('sessionStart', JSON.stringify({ sessionId: 's1', cwd: '/tmp' }), cwd, env)
    const parsed = JSON.parse(stdout)
    expect(parsed.modifiedResult).toBeUndefined()
    expect(parsed.additionalContext).toBeUndefined()
  })

  it('forwards postToolUse toolResult.textResultForLlm to token-goat as canonical.tool_response', () => {
    const cwd = mkIsolated()
    const capturePath = path.join(cwd, 'captured.json')
    const script =
      process.platform === 'win32'
        ? `@echo off\r\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath.replace(/\\/g, '\\\\')}"\r\necho {}\r\n`
        : `#!/bin/sh\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath}"\necho '{}'\n`
    const binPath = process.platform === 'win32' ? path.join(cwd, 'token-goat.cmd') : path.join(cwd, 'token-goat')
    fs.writeFileSync(binPath, script, 'utf8')
    if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755)
    const env = { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }

    const stdout = runShim(
      'postToolUse',
      JSON.stringify({
        sessionId: 's1',
        cwd: '/tmp',
        toolName: 'view',
        toolArgs: { path: '/big.txt' },
        toolResult: { resultType: 'success', textResultForLlm: 'this file returned 219KB of text' },
      }),
      cwd,
      env,
    )

    expect(stdout.trim()).toBe('{}')
    const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as Record<string, unknown>
    expect(captured.tool_response).toBe('this file returned 219KB of text')
  })

  it('does not set canonical.tool_response when postToolUse has no toolResult (e.g. preToolUse-shaped payloads)', () => {
    const cwd = mkIsolated()
    const capturePath = path.join(cwd, 'captured.json')
    const script =
      process.platform === 'win32'
        ? `@echo off\r\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath.replace(/\\/g, '\\\\')}"\r\necho {}\r\n`
        : `#!/bin/sh\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath}"\necho '{}'\n`
    const binPath = process.platform === 'win32' ? path.join(cwd, 'token-goat.cmd') : path.join(cwd, 'token-goat')
    fs.writeFileSync(binPath, script, 'utf8')
    if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755)
    const env = { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }

    runShim(
      'postToolUse',
      JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: 'view', toolArgs: { path: '/f.txt' } }),
      cwd,
      env,
    )

    const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as Record<string, unknown>
    expect(captured.tool_response).toBeUndefined()
  })

  it.each([
    ['view', '/f.txt'],
    ['edit', '/g.txt'],
    ['create', '/h.txt'],
  ])(
    "remaps %s's 'path' toolArgs key to 'file_path' -- the only key token-goat's Read/Edit/Write handlers read",
    (copilotTool, filePath) => {
      const cwd = mkIsolated()
      const capturePath = path.join(cwd, 'captured.json')
      const script =
        process.platform === 'win32'
          ? `@echo off\r\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath.replace(/\\/g, '\\\\')}"\r\necho {}\r\n`
          : `#!/bin/sh\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath}"\necho '{}'\n`
      const binPath = process.platform === 'win32' ? path.join(cwd, 'token-goat.cmd') : path.join(cwd, 'token-goat')
      fs.writeFileSync(binPath, script, 'utf8')
      if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755)
      const env = { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }

      runShim(
        'preToolUse',
        JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: copilotTool, toolArgs: { path: filePath } }),
        cwd,
        env,
      )

      const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as Record<string, unknown>
      const toolInput = captured.tool_input as Record<string, unknown>
      expect(toolInput.file_path).toBe(filePath)
      // The original 'path' key must survive too -- remap is additive, not a rename.
      expect(toolInput.path).toBe(filePath)
    },
  )

  it('preCompact discards any token-goat response and always emits {} -- Copilot treats preCompact as notification-only', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(cwd, JSON.stringify({ systemMessage: 'session manifest here' }))
    const stdout = runShim('preCompact', JSON.stringify({ sessionId: 's1' }), cwd, env)
    expect(stdout.trim()).toBe('{}')
  })

  it('maps userPromptSubmitted to user_prompt_submit and forwards the response as additionalContext, which Copilot does honor despite its docs', () => {
    const cwd = mkIsolated()
    const argvPath = path.join(cwd, 'argv.txt')
    const capturePath = path.join(cwd, 'captured.json')
    const script =
      process.platform === 'win32'
        ? `@echo off\r\necho %* > "${argvPath}"\r\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath.replace(/\\/g, '\\\\')}"\r\necho {"systemMessage":"branch: main"}\r\n`
        : `#!/bin/sh\necho "$@" > "${argvPath}"\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath}"\necho '{"systemMessage":"branch: main"}'\n`
    const binPath = process.platform === 'win32' ? path.join(cwd, 'token-goat.cmd') : path.join(cwd, 'token-goat')
    fs.writeFileSync(binPath, script, 'utf8')
    if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755)
    const env = { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }

    const stdout = runShim(
      'userPromptSubmitted',
      JSON.stringify({ sessionId: 's1', cwd: '/tmp', prompt: 'fix the bug please' }),
      cwd,
      env,
    )

    // Asserted as a whole object, not just the presence of additionalContext: modifiedPrompt is
    // the field Copilot's docs actually describe for this event, and forwarding it would rewrite
    // the user's prompt. An extra-key assertion is the only thing that catches that regression.
    expect(JSON.parse(stdout)).toEqual({ additionalContext: 'branch: main' })
    expect(fs.readFileSync(argvPath, 'utf8')).toContain('user_prompt_submit')
    const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as Record<string, unknown>
    expect(captured.session_id).toBe('s1')
  })

  it('emits {} for userPromptSubmitted when token-goat returns no context, rather than an empty additionalContext', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(cwd, JSON.stringify({}))
    const stdout = runShim(
      'userPromptSubmitted',
      JSON.stringify({ sessionId: 's1', cwd: '/tmp', prompt: 'fix the bug please' }),
      cwd,
      env,
    )
    // An empty additionalContext would still cost a <system_reminder> wrapper in the prompt for
    // zero content, so the absence of the key matters and is not merely cosmetic.
    expect(JSON.parse(stdout)).toEqual({})
  })

  it('translates an agentStop deny (decision:"block") into {decision:"block", reason}, never additionalContext', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(cwd, JSON.stringify({ decision: 'block', reason: 'clean up before stopping' }))
    const stdout = runShim('agentStop', JSON.stringify({ sessionId: 's1', cwd: '/tmp' }), cwd, env)
    const parsed = JSON.parse(stdout)
    expect(parsed).toEqual({ decision: 'block', reason: 'clean up before stopping' })
    expect(parsed.additionalContext).toBeUndefined()
  })

  it('translates a non-blocking agentStop response into {decision:"allow"}', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(cwd, JSON.stringify({}))
    const stdout = runShim('agentStop', JSON.stringify({ sessionId: 's1', cwd: '/tmp' }), cwd, env)
    const parsed = JSON.parse(stdout)
    expect(parsed).toEqual({ decision: 'allow' })
  })

  it('translates a subagentStop deny (decision:"block") into {decision:"block", reason}, never additionalContext', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(cwd, JSON.stringify({ decision: 'block', reason: 'possible hallucination' }))
    const stdout = runShim('subagentStop', JSON.stringify({ sessionId: 's1', cwd: '/tmp' }), cwd, env)
    const parsed = JSON.parse(stdout)
    expect(parsed).toEqual({ decision: 'block', reason: 'possible hallucination' })
    expect(parsed.additionalContext).toBeUndefined()
  })

  it('translates a non-blocking subagentStop response into {decision:"allow"}', () => {
    const cwd = mkIsolated()
    const env = withFakeTokenGoat(cwd, JSON.stringify({}))
    const stdout = runShim('subagentStop', JSON.stringify({ sessionId: 's1', cwd: '/tmp' }), cwd, env)
    const parsed = JSON.parse(stdout)
    expect(parsed).toEqual({ decision: 'allow' })
  })

  it('maps bash/powershell/view/create/edit/web_fetch/grep/glob tool names to their token-goat equivalents before calling token-goat', () => {
    for (const [copilotTool, tgTool] of [
      ['bash', 'Bash'],
      ['powershell', 'Bash'],
      ['view', 'Read'],
      ['create', 'Write'],
      ['edit', 'Edit'],
      ['web_fetch', 'WebFetch'],
      ['grep', 'Grep'],
      ['glob', 'Glob'],
    ] as const) {
      const cwd = mkIsolated()
      const capturePath = path.join(cwd, 'captured.json')
      const script =
        process.platform === 'win32'
          ? `@echo off\r\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath.replace(/\\/g, '\\\\')}"\r\necho {}\r\n`
          : `#!/bin/sh\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath}"\necho '{}'\n`
      const binPath = process.platform === 'win32' ? path.join(cwd, 'token-goat.cmd') : path.join(cwd, 'token-goat')
      fs.writeFileSync(binPath, script, 'utf8')
      if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755)
      const env = { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }

      runShim('preToolUse', JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: copilotTool, toolArgs: {} }), cwd, env)

      const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as { tool_name: string }
      expect(captured.tool_name).toBe(tgTool)
    }
  })

  it('passes task/ask_user tool names through unmapped, since neither has a token-goat equivalent', () => {
    for (const copilotTool of ['task', 'ask_user']) {
      const cwd = mkIsolated()
      const capturePath = path.join(cwd, 'captured.json')
      const script =
        process.platform === 'win32'
          ? `@echo off\r\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath.replace(/\\/g, '\\\\')}"\r\necho {}\r\n`
          : `#!/bin/sh\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath}"\necho '{}'\n`
      const binPath = process.platform === 'win32' ? path.join(cwd, 'token-goat.cmd') : path.join(cwd, 'token-goat')
      fs.writeFileSync(binPath, script, 'utf8')
      if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755)
      const env = { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }

      runShim('preToolUse', JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: copilotTool, toolArgs: {} }), cwd, env)

      const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as { tool_name: string }
      expect(captured.tool_name).toBe(copilotTool)
    }
  })

  /** Runs one hook call through the shim and hands back the canonical payload it sent on to token-goat. */
  function canonicalFor(
    copilotTool: string,
    toolArgs: Record<string, unknown>,
    event = 'preToolUse',
    extraPayload: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const cwd = mkIsolated()
    const capturePath = path.join(cwd, 'captured.json')
    const script =
      process.platform === 'win32'
        ? `@echo off\r\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath.replace(/\\/g, '\\\\')}"\r\necho {}\r\n`
        : `#!/bin/sh\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath}"\necho '{}'\n`
    const binPath = process.platform === 'win32' ? path.join(cwd, 'token-goat.cmd') : path.join(cwd, 'token-goat')
    fs.writeFileSync(binPath, script, 'utf8')
    if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755)
    const env = { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }
    runShim(
      event,
      JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: copilotTool, toolArgs, ...extraPayload }),
      cwd,
      env,
    )
    return JSON.parse(fs.readFileSync(capturePath, 'utf8')) as Record<string, unknown>
  }

  // Copilot's background-shell pollers. Names and argument key both come from the
  // shipping 1.0.80 bundle: runtime.node's builtin tool-name table lists
  // read_bash/read_powershell, and app.js's input schema for the poller is
  // {shellId, delay}. Nothing here is inferred from the internal read_shell /
  // list_shells identifiers, which are Rust-side names that never reach the wire.
  it('maps read_bash/read_powershell to BashOutput, and mirrors their shellId onto bash_id so the poll handler can key on it', () => {
    for (const copilotTool of ['read_bash', 'read_powershell']) {
      const captured = canonicalFor(copilotTool, { shellId: 'shell-7', delay: 2 })
      expect(captured['tool_name']).toBe('BashOutput')
      const toolInput = captured['tool_input'] as Record<string, unknown>
      // bash_id is what postBashOutputHandler (src/hooks_bashoutput.ts) reads; without
      // it the name mapping above is inert and every poll costs the full buffer again.
      expect(toolInput['bash_id']).toBe('shell-7')
      // Added alongside, never renamed -- the original key still has to survive.
      expect(toolInput['shellId']).toBe('shell-7')
      expect(toolInput['delay']).toBe(2)
    }
  })

  // These are deliberate omissions, not oversights, so they get pinned like any other
  // behavior. write_bash/write_powershell are real Copilot tools but they are NOT the
  // shell executor -- their schema is {shellId, input, delay} under the bundle's
  // "write_shell" subtype, i.e. sending stdin to a shell that is already running -- so
  // calling them Bash would label a stdin write as a command execution. stop_bash and
  // list_bash have no token-goat handler to reach at all. read_agent and the memory
  // tools would put an output-rewriting handler in front of a result shape nobody has
  // seen. read_shell is not a wire name in the first place.
  it('leaves the shell tools token-goat has no correct handler for unmapped, rather than guessing at their result shape', () => {
    for (const copilotTool of [
      'write_bash',
      'write_powershell',
      'stop_bash',
      'stop_powershell',
      'list_bash',
      'list_powershell',
      'read_shell',
      'read_agent',
      'memory',
    ]) {
      expect(canonicalFor(copilotTool, { shellId: 'shell-7' })['tool_name']).toBe(copilotTool)
    }
  })

  // Copilot's PostToolUseFailureHookInput (copilot-sdk/types.d.ts:1042) is
  // {toolName, toolArgs, error} -- there is no toolResult, so the failure text only
  // ever arrives in `error`, a plain string. src/hooks_tool_failure.ts keys the
  // repeat-failure brake on that text and returns pass when it finds none, so a shim
  // that drops the field leaves the whole feature wired, green and doing nothing on
  // every single call. The handler's own tests hand it a payload that already has
  // `error`, which is exactly why they could not catch this.
  it('forwards postToolUseFailure error text into the canonical payload, which is the only place the failure text exists', () => {
    const captured = canonicalFor('bash', { command: 'nope' }, 'postToolUseFailure', {
      error: 'command not found: nope',
    })
    expect(captured['error']).toBe('command not found: nope')
  })

  it('does not invent an error field on hook events that have none', () => {
    expect(canonicalFor('bash', { command: 'ls' })).not.toHaveProperty('error')
  })

  it('never propagates an uncaught exception or a non-zero exit code, even for adversarial/malformed payloads the per-step guards were not written against', () => {
    const cwd = mkIsolated()
    const scriptPath = path.join(cwd, 'shim.js')
    fs.writeFileSync(scriptPath, COPILOT_CLI_HOOK_SCRIPT, 'utf8')
    const env = withFakeTokenGoat(cwd, JSON.stringify({ hookSpecificOutput: { updatedInput: null } }))

    const adversarialStdins = [
      '[1,2,3]',
      '"just a string"',
      '42',
      'null',
      JSON.stringify({ toolName: 'bash', toolArgs: { a: { b: { c: { d: { e: 'deeply nested' } } } } } }),
      JSON.stringify({ toolName: { nested: 'object as tool name' }, toolArgs: [] }),
    ]

    for (const stdin of adversarialStdins) {
      const res = spawnSync(process.execPath, [scriptPath, 'preToolUse'], {
        cwd,
        input: stdin,
        encoding: 'utf8',
        timeout: 15000,
        env,
      })
      expect(res.status).toBe(0)
      expect(() => JSON.parse(res.stdout ?? '')).not.toThrow()
    }
  })

  it('parses a JSON-encoded-string toolArgs (github/copilot-cli#3349) into an object instead of forwarding a raw string', () => {
    const cwd = mkIsolated()
    const capturePath = path.join(cwd, 'captured.json')
    const script =
      process.platform === 'win32'
        ? `@echo off\r\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath.replace(/\\/g, '\\\\')}"\r\necho {}\r\n`
        : `#!/bin/sh\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath}"\necho '{}'\n`
    const binPath = process.platform === 'win32' ? path.join(cwd, 'token-goat.cmd') : path.join(cwd, 'token-goat')
    fs.writeFileSync(binPath, script, 'utf8')
    if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755)
    const env = { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }

    // toolArgs sent as a JSON-encoded string, not a parsed object -- the documented-vs-real
    // schema mismatch confirmed in the still-open github/copilot-cli#3349.
    runShim(
      'preToolUse',
      JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: 'shell', toolArgs: JSON.stringify({ command: 'ls -la' }) }),
      cwd,
      env,
    )

    const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as { tool_input: unknown }
    expect(captured.tool_input).toEqual({ command: 'ls -la' })
  })

  it('falls back to {} (never crashes) when toolArgs is a malformed, unparsable string', () => {
    const cwd = mkIsolated()
    const capturePath = path.join(cwd, 'captured.json')
    const script =
      process.platform === 'win32'
        ? `@echo off\r\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath.replace(/\\/g, '\\\\')}"\r\necho {}\r\n`
        : `#!/bin/sh\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath}"\necho '{}'\n`
    const binPath = process.platform === 'win32' ? path.join(cwd, 'token-goat.cmd') : path.join(cwd, 'token-goat')
    fs.writeFileSync(binPath, script, 'utf8')
    if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755)
    const env = { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }

    const stdout = runShim(
      'preToolUse',
      JSON.stringify({ sessionId: 's1', cwd: '/tmp', toolName: 'shell', toolArgs: 'not valid json {{{' }),
      cwd,
      env,
    )

    expect(stdout.trim()).toBe('{}')
    const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as { tool_input: unknown }
    expect(captured.tool_input).toEqual({})
  })

  it('derives a stable fallback session_id from cwd (not process.pid) when Copilot omits sessionId, so two separate hook-invocation processes for the same session agree', () => {
    // Copilot spawns a brand-new process for every single hook call (no long-lived plugin
    // process), so process.pid necessarily differs between these two runShim invocations even
    // though they represent the same logical session. Before the fix, falling back to
    // 'copilot-' + process.pid meant every call minted a different session_id, so token-goat's
    // session-based dedup/state ledger never accumulated across calls. cwd is the one thing
    // that's actually constant across calls for the same session, so the fallback must be
    // derived from it instead.
    const cwd = mkIsolated()
    const capturePath1 = path.join(cwd, 'captured1.json')
    const capturePath2 = path.join(cwd, 'captured2.json')
    const makeScript = (capturePath: string): string =>
      process.platform === 'win32'
        ? `@echo off\r\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath.replace(/\\/g, '\\\\')}"\r\necho {}\r\n`
        : `#!/bin/sh\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath}"\necho '{}'\n`
    const binPath = process.platform === 'win32' ? path.join(cwd, 'token-goat.cmd') : path.join(cwd, 'token-goat')
    const env = { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }
    const payload = JSON.stringify({ cwd: '/same/project/dir', toolName: 'view', toolArgs: { path: '/f.txt' } })

    fs.writeFileSync(binPath, makeScript(capturePath1), 'utf8')
    if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755)
    runShim('preToolUse', payload, cwd, env)
    const captured1 = JSON.parse(fs.readFileSync(capturePath1, 'utf8')) as { session_id: string }

    fs.writeFileSync(binPath, makeScript(capturePath2), 'utf8')
    if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755)
    runShim('preToolUse', payload, cwd, env)
    const captured2 = JSON.parse(fs.readFileSync(capturePath2, 'utf8')) as { session_id: string }

    expect(captured1.session_id).toBeTruthy()
    expect(captured1.session_id).toBe(captured2.session_id)
  })

  it('forwards agent_id, traceparent, and tracestate from Copilot payload to canonical', () => {
    const cwd = mkIsolated()
    const capturePath = path.join(cwd, 'captured.json')
    const script =
      process.platform === 'win32'
        ? `@echo off\r\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath.replace(/\\/g, '\\\\')}"\r\necho {}\r\n`
        : `#!/bin/sh\nnode -e "require('fs').writeFileSync(process.argv[1], require('fs').readFileSync(0,'utf8'))" "${capturePath}"\necho '{}'\n`
    const binPath = process.platform === 'win32' ? path.join(cwd, 'token-goat.cmd') : path.join(cwd, 'token-goat')
    fs.writeFileSync(binPath, script, 'utf8')
    if (process.platform !== 'win32') fs.chmodSync(binPath, 0o755)
    const env = { ...process.env, PATH: cwd + path.delimiter + (process.env['PATH'] ?? '') }

    runShim(
      'preToolUse',
      JSON.stringify({
        sessionId: 's1',
        cwd: '/tmp',
        agent_id: 'subagent-abc',
        traceparent: '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01',
        tracestate: 'rojo=1',
        toolName: 'view',
        toolArgs: { path: '/f.txt' },
      }),
      cwd,
      env,
    )

    const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8')) as Record<string, unknown>
    expect(captured.agent_id).toBe('subagent-abc')
    expect(captured.traceparent).toBe('00-1234567890abcdef1234567890abcdef-1234567890abcdef-01')
    expect(captured.tracestate).toBe('rojo=1')
  })
})
