/** The repair under bypassPermissions, where Claude Code asks nothing and the hook's own checks are the only ones. PROVENANCE: the NUL case is CAPTURE from the security audit C:/tgwt/sec-bs2.md (round 2, F1): under real Git Bash `r<NUL>m -rf ./victim` ran rm and deleted the directory, because Git Bash drops the NUL while the lexical rm check saw the word `r<NUL>m`; the brace and glob cases are FORMAT-DERIVED from the bash manual (brace expansion `{r,}m` gives `rm` and `m`, pathname expansion `r[m]` matches the file `rm`); the unmocked hidden-rule check cannot be satisfied by a test process (it needs a readable claude command line), so it is replaced by one that finds no hidden rule, which is the state of a real terminal session with none. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { repairIsUnsafe } from '../src/bash_backslash_repair.js'
import { invalidateConfigCache } from '../src/config.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { clearModuleCaches } from '../src/reset.js'
import { loadHiddenRuleCheck, resetPermissionSourceCache } from '../src/rewrite_permission.js'
import { makeHookEvent } from './helpers/hook-event.js'

vi.mock('../src/claude_hidden_rules.js', () => ({ hiddenRules: () => ({ hidden: () => false, lineRules: () => false, prime: async () => undefined }) }))

const NUL = String.fromCharCode(0)
const DAMAGE = String.raw` 'A:\\'`

describe('repairIsUnsafe -- control characters', () => {
  it.each([[0], [1], [8], [11], [12], [14], [31], [127]])('character code %i is unsafe, anywhere in the command', (code) => {
    const c = String.fromCharCode(code)
    expect(repairIsUnsafe(`r${c}m -rf x` + DAMAGE)).toBe(true)
    expect(repairIsUnsafe(`printf %s 'a${c}b'` + DAMAGE)).toBe(true)
  })

  it('tab, line feed and carriage return are ordinary whitespace', () => {
    expect(repairIsUnsafe('printf\t%s' + DAMAGE)).toBe(false)
    expect(repairIsUnsafe('printf %s' + DAMAGE + '\r\n')).toBe(false)
  })
})

describe.skipIf(process.platform !== 'win32')('preBashHandler -- repair under bypassPermissions', () => {
  let root: string
  let dir: string

  function call(command: string): ReturnType<typeof preBashHandler> {
    return preBashHandler(makeHookEvent({
      toolName: 'Bash',
      toolInput: { command },
      sessionId: 'bs-bypass-session',
      raw: { tool_name: 'Bash', tool_input: { command }, _tg_harness: 'claude', cwd: root, permission_mode: 'bypassPermissions' },
    }))
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bs-bypass-'))
    dir = path.join(root, 'home', 'bash_repair')
    fs.mkdirSync(path.join(root, 'config'))
    vi.stubEnv('TOKEN_GOAT_HOME', path.join(root, 'home'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'config'))
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', '')
    vi.stubEnv('HERMES_SESSION_ID', '')
    vi.stubEnv('HERMES_HOME', '')
    vi.stubEnv('CLAUDE_CODE_VERSION', '2.1.0')
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
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('an ordinary damaged command, a grep for a double-backslash pattern, is still repaired', () => {
    const result = call(String.raw`grep -rn 'C:\\Users' src`)
    expect(result.hookType).toBe('rewriteInput')
    expect(fs.readdirSync(dir)).toHaveLength(1)
  })

  it('a plain quoted literal with no shell metacharacter is still repaired', () => {
    const result = call(String.raw`git log --grep='fix: a b' -n 3 'A:\\'`)
    expect(result.hookType).toBe('rewriteInput')
    expect(fs.readdirSync(dir)).toHaveLength(1)
  })

  it('a simple damaged command is rewritten with an allow and its script is written', () => {
    const result = call(String.raw`printf '%s\n' 'A:\\' 'D:\\"x'`)
    expect(result.hookType).toBe('rewriteInput')
    if (result.hookType === 'rewriteInput') {
      expect(result.approve).toBe(true)
      expect(result.updatedInput['command']).toMatch(/^\. '\/[a-z]\/[^']+\/bash_repair\/tg-cmd-[0-9a-f]{32}\.sh'$/)
    }
    expect(fs.readdirSync(dir)).toHaveLength(1)
  })

  it.each([
    ['a NUL inside the word rm', `r${NUL}m -rf ./victim` + DAMAGE],
    ['a NUL inside a quoted word', `printf %s 'r${NUL}m'` + DAMAGE],
    ['a brace expansion that forms rm', String.raw`{r,}m -rf ./victim 'A:\\'`],
    ['a glob that matches rm', String.raw`/usr/bin/r[m] -rf ./victim 'A:\\'`],
    ['a glob with a question mark', String.raw`/usr/bin/r? -rf ./victim 'A:\\'`],
    ['bash -c holding a brace expansion', String.raw`bash -c '{r,}m -rf ./victim' 'A:\\'`],
    ['sh -c holding a glob', String.raw`sh -c 'r[m] -rf ./victim' 'A:\\'`],
    ['env launching bash -c', String.raw`/usr/bin/env bash -c 'r[m] -rf ./victim' 'A:\\'`],
    ['a shell named by path and .exe', String.raw`/usr/bin/BASH.EXE -c 'r[m] x' 'A:\\'`],
    ['python -c', String.raw`python -c 'import shutil; shutil.rmtree("victim")' 'A:\\'`],
    ['a launcher that is not the first word', String.raw`find . -exec sh -c 'r[m] x' 'A:\\'`],
    ['a git alias that runs a shell command', String.raw`git -c 'alias.x=!{r,}m -rf ./victim' x 'A:\\'`],
    ['a sed e command', String.raw`sed '1e {r,}m -rf ./victim' f 'A:\\'`],
    ['a tar checkpoint action in the --opt=value form', String.raw`tar -cf x.tar --checkpoint=1 --checkpoint-action='exec={r,}m -rf ./victim' f 'A:\\'`],
    ['a tar checkpoint action running cmd with a caret-split rm', String.raw`tar -cf x.tar --checkpoint=1 --checkpoint-action=exec='cmd //c r^m -rf ./vc' f 'A:\\'`],
    ['a double-quoted word holding a semicolon', String.raw`printf %s "a;b" 'A:\\'`],
  ])('%s is refused, and no script is written', (_name, command) => {
    const result = call(command)
    expect(result.hookType).toBe('deny')
    expect(fs.existsSync(dir)).toBe(false)
  })
})
