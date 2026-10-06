import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { installCopilotHooksFile, HOOKS_SCRIPT_FILE } from '../src/bridges/copilot_cli_install.js'
import { copilotCapture } from './fixtures/copilot_cli_1_0_88.js'
import { BUNDLE } from './helpers/bundle.js'

/** Copilot CLI's `skill` tool, driven through the installed shim and the built bundle with the payloads Copilot really sends. The argument key is `toolArgs.skill`, the key hooks_skill.ts's extractSkillName reads first. The tool result is not the skill: Copilot answers the call with a one-line confirmation and delivers the body separately, as a `<skill-context>` user message (tg-captures C5, wire request 2: `Base directory for this skill: <COPILOT_HOME>\skills\tgcap-echo` followed by the body without its front matter). token-goat stored that confirmation line as the skill's body, found no source file because it only looked under Claude Code's skills directory, and then denied the next load of the skill by pointing at `token-goat skill-body`, which could not find the skill at all. PROVENANCE: CAPTURE. tests/fixtures/copilot_cli_1_0_88/C5-004-preToolUse-skill.json and C5-005-postToolUse-skill.json (from %TEMP%/tg-captures/C5/raw/004-preToolUse-skill.json and 005-postToolUse-skill.json, Copilot CLI 1.0.88). The SKILL.md written below is the capture's own file, %TEMP%/tg-captures/C5/home/.copilot/skills/tgcap-echo/SKILL.md, verbatim. The personal skills directory `<COPILOT_HOME>/skills` is where that capture installed it and where its wire request says the body came from; the project directories are FORMAT-DERIVED from `copilot skill --help` on 1.0.88 ("Project .github/skills/, .agents/skills/, or .claude/skills/; Personal ~/.copilot/skills/ or ~/.agents/skills/"). */

const SKILL_MD =
  '---\nname: tgcap-echo\ndescription: Capture-test skill. Use when the user asks for the tgcap-echo skill.\n---\nWhen this skill is loaded, reply with exactly the line TGCAP-C5-SKILL-BODY-2d4a and nothing else.\n'
const BODY_MARKER = 'TGCAP-C5-SKILL-BODY-2d4a'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

function mkTemp(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

interface Rig {
  proj: string
  copilotHome: string
  hook: (event: string, name: string) => Record<string, unknown>
  cli: (...args: string[]) => { status: number | null; stdout: string; stderr: string }
}

function rig(): Rig {
  const proj = mkTemp('tg-copilot-skill-ws-')
  const copilotHome = mkTemp('tg-copilot-skill-home-')
  const claudeHome = mkTemp('tg-copilot-skill-claude-')
  const hooksDir = mkTemp('tg-copilot-skill-hooks-')
  installCopilotHooksFile(hooksDir, 'copilot')
  const sid = `copilot-skill-${Math.random().toString(36).slice(2)}`
  // Claude Code's config home points at an empty directory, so the only copy of the skill is the Copilot one each case writes. Each case gets its own data directory too (LOCALAPPDATA on Windows, XDG_DATA_HOME elsewhere), where the skill cache lives: the cache keeps one copy of an identical body across sessions, so a body a previous case stored would be credited to that case's session rather than this one.
  const dataRoot = mkTemp('tg-copilot-skill-data-')
  const env = {
    ...process.env,
    COPILOT_HOME: copilotHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    TOKEN_GOAT_HOME: mkTemp('tg-copilot-skill-tg-'),
    LOCALAPPDATA: dataRoot,
    XDG_DATA_HOME: dataRoot,
  }
  const hook = (event: string, name: string): Record<string, unknown> => {
    const payload = copilotCapture(name, { proj })
    payload['sessionId'] = sid
    const res = spawnSync(process.execPath, [path.join(hooksDir, HOOKS_SCRIPT_FILE), event, BUNDLE], {
      cwd: proj,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 60000,
      env,
    })
    expect(res.status, res.stderr).toBe(0)
    return JSON.parse(res.stdout) as Record<string, unknown>
  }
  const cli = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const res = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: proj, encoding: 'utf8', timeout: 60000, env })
    return { status: res.status, stdout: res.stdout, stderr: res.stderr }
  }
  return { proj, copilotHome, hook, cli }
}

function writeSkill(root: string): string {
  const file = path.join(root, 'tgcap-echo', 'SKILL.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, SKILL_MD)
  return file
}

describe('Copilot CLI skill tool (CAPTURE C5)', () => {
  it('reads the skill name from toolArgs.skill and caches the SKILL.md Copilot loaded, not its confirmation line', () => {
    const { copilotHome, hook, cli } = rig()
    writeSkill(path.join(copilotHome, 'skills'))

    expect(hook('preToolUse', 'C5-004-preToolUse-skill')).toEqual({})
    expect(hook('postToolUse', 'C5-005-postToolUse-skill')).toEqual({})

    const recalled = cli('skill-body', 'tgcap-echo')
    expect(recalled.status, recalled.stderr).toBe(0)
    expect(recalled.stdout).toContain(BODY_MARKER)
    expect(recalled.stdout).not.toContain('loaded successfully')

    // The second load of the same skill in the session is denied, and the command the deny names returns the body above.
    const again = hook('preToolUse', 'C5-004-preToolUse-skill')
    expect(again['permissionDecision']).toBe('deny')
    expect(again['permissionDecisionReason']).toContain('token-goat skill-body "tgcap-echo"')
  })

  it('finds a project skill under .github/skills in the working directory', () => {
    const { proj, hook, cli } = rig()
    writeSkill(path.join(proj, '.github', 'skills'))

    hook('preToolUse', 'C5-004-preToolUse-skill')
    hook('postToolUse', 'C5-005-postToolUse-skill')

    const recalled = cli('skill-body', 'tgcap-echo')
    expect(recalled.status, recalled.stderr).toBe(0)
    expect(recalled.stdout).toContain(BODY_MARKER)
  })

  it('does not deny a reload it could not cache, when no skill directory holds the skill', () => {
    const { hook } = rig()

    hook('preToolUse', 'C5-004-preToolUse-skill')
    hook('postToolUse', 'C5-005-postToolUse-skill')

    // Nothing recallable was stored, so a deny would point at a command that fails with "skill not found".
    expect(hook('preToolUse', 'C5-004-preToolUse-skill')).toEqual({})
  })
})
