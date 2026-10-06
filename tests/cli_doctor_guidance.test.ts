import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  checkInstructionGates,
  repairInstructionGates,
  checkHarnessCacheEfficiency,
  findActiveGlobalGates,
  INSTRUCTION_GATE_BEGIN,
  INSTRUCTION_GATE_END,
  CODEX_GATE_BEGIN,
  CODEX_GATE_END,
} from '../src/cli_doctor_guidance.js'
import { installHooks } from '../src/install.js'
import { installCodex } from '../src/bridges/codex_install.js'
import { installCopilotCli } from '../src/bridges/copilot_cli_install.js'

// HAND-DERIVED: every fixture below is a file written here from the marker constants, with the user-level paths taken from where `token-goat install` writes its gate (claudeMdPath, codexAgentsPath, copilotCliInstructionsPath). The home directory, Claude config dir and Copilot home all point into the temp dir, so nothing reads or writes the real ones.

/** Every file under `dir`, relative, sorted: a repair that writes nothing leaves this unchanged, including no `.bak.<timestamp>` backup. */
function listTree(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[]).map((p) => p.split(path.sep).join('/')).sort()
}

describe('cli_doctor_guidance', () => {
  let tempDir: string
  let home: string
  let project: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-guidance-test-'))
    home = path.join(tempDir, 'home')
    project = path.join(tempDir, 'project')
    fs.mkdirSync(home)
    fs.mkdirSync(project)
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'))
    vi.stubEnv('COPILOT_HOME', path.join(home, '.copilot'))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function writeGlobal(rel: string, content: string): string {
    const p = path.join(home, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
    return p
  }

  const claudeGate = `# Mine\n${INSTRUCTION_GATE_BEGIN}\nGate body\n${INSTRUCTION_GATE_END}\n`
  const codexGate = `# Mine\n${CODEX_GATE_BEGIN}\nGate body\n${CODEX_GATE_END}\n`

  describe('checkInstructionGates', () => {
    it('returns warn when no gate exists anywhere and the project has no instruction file', () => {
      const result = checkInstructionGates(project)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('no project instruction file was found')
      expect(result.message).toContain("Run `token-goat install`")
    })

    it('returns warn when CLAUDE.md exists without the gate block and no user-level gate exists', () => {
      fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Project Instructions\nSome instructions without gate.')
      const result = checkInstructionGates(project)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('missing in CLAUDE.md')
      expect(result.message).toContain("Run `token-goat doctor --fix` to inject automatically.")
    })

    it('returns ok when CLAUDE.md has the gate block', () => {
      fs.writeFileSync(path.join(project, 'CLAUDE.md'), `# Project Instructions\n${INSTRUCTION_GATE_BEGIN}\nGate body\n${INSTRUCTION_GATE_END}`)
      const result = checkInstructionGates(project)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('active in CLAUDE.md')
    })

    it('returns ok when AGENTS.md has the codex gate block', () => {
      fs.writeFileSync(path.join(project, 'AGENTS.md'), codexGate)
      const result = checkInstructionGates(project)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('active in AGENTS.md')
    })

    it('does not count a begin marker without its end marker as a gate', () => {
      fs.writeFileSync(path.join(project, 'CLAUDE.md'), `# Project\n${INSTRUCTION_GATE_BEGIN}\nTruncated body`)
      writeGlobal('.claude/CLAUDE.md', `# Mine\n${INSTRUCTION_GATE_BEGIN}\nTruncated body`)
      expect(findActiveGlobalGates()).toEqual([])
      expect(checkInstructionGates(project).status).toBe('warn')
    })

    // Regression: the check looked only at project files, so every project on a machine where `token-goat install` had written the user-level gate was reported as missing it.
    it.each([
      ['Claude Code', '.claude/CLAUDE.md', claudeGate],
      ['Codex', '.codex/AGENTS.md', codexGate],
      ['Copilot CLI', '.copilot/copilot-instructions.md', claudeGate],
    ])('returns ok when the %s user-level instruction file carries the gate', (_harness, rel, content) => {
      const p = writeGlobal(rel, content)
      fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Project without a gate\n')
      expect(findActiveGlobalGates()).toEqual([p])
      const result = checkInstructionGates(project)
      expect(result.status).toBe('ok')
      expect(result.message).toContain(p)
    })
  })

  describe('repairInstructionGates', () => {
    it('injects gate into existing ungated CLAUDE.md', () => {
      const claudeMd = path.join(project, 'CLAUDE.md')
      fs.writeFileSync(claudeMd, '# My Custom Project\n')
      const res = repairInstructionGates(project)
      expect(res.repairs.some((r) => r.includes('Injected token-goat routing gate into CLAUDE.md'))).toBe(true)
      expect(res.errors).toHaveLength(0)

      const content = fs.readFileSync(claudeMd, 'utf8')
      expect(content).toContain(INSTRUCTION_GATE_BEGIN)
      expect(content).toContain(INSTRUCTION_GATE_END)
      expect(content).toContain('# My Custom Project')
    })

    it('creates CLAUDE.md with gate if no files exist', () => {
      const claudeMd = path.join(project, 'CLAUDE.md')
      expect(fs.existsSync(claudeMd)).toBe(false)
      const res = repairInstructionGates(project)
      expect(res.repairs.some((r) => r.includes('Injected token-goat routing gate into CLAUDE.md'))).toBe(true)
      expect(fs.existsSync(claudeMd)).toBe(true)
      const content = fs.readFileSync(claudeMd, 'utf8')
      expect(content).toContain(INSTRUCTION_GATE_BEGIN)
    })

    // Regression: with the user-level gate installed, `doctor --fix` appended a second copy of it to every project instruction file it found (or created a CLAUDE.md), each with a .bak backup beside it.
    it('writes nothing to the project when a user-level gate is active', () => {
      writeGlobal('.claude/CLAUDE.md', claudeGate)
      fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Project\n')
      fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Agents\n')
      fs.mkdirSync(path.join(project, '.github'))
      fs.writeFileSync(path.join(project, '.github', 'copilot-instructions.md'), '# Copilot\n')
      const before = listTree(project)

      const res = repairInstructionGates(project)

      expect(res).toEqual({ repairs: [], errors: [] })
      expect(listTree(project)).toEqual(before)
      expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toBe('# Project\n')
      expect(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toBe('# Agents\n')
      expect(fs.readFileSync(path.join(project, '.github', 'copilot-instructions.md'), 'utf8')).toBe('# Copilot\n')
    })

    it('does not create a project CLAUDE.md when a user-level gate is active', () => {
      writeGlobal('.codex/AGENTS.md', codexGate)
      const res = repairInstructionGates(project)
      expect(res).toEqual({ repairs: [], errors: [] })
      expect(listTree(project)).toEqual([])
    })

    // Regression: check reported ok because AGENTS.md was gated, while repair still injected into the ungated CLAUDE.md beside it.
    it('writes nothing when one project instruction file already carries the gate', () => {
      fs.writeFileSync(path.join(project, 'AGENTS.md'), codexGate)
      fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Project\n')
      const before = listTree(project)
      expect(checkInstructionGates(project).status).toBe('ok')

      const res = repairInstructionGates(project)

      expect(res).toEqual({ repairs: [], errors: [] })
      expect(listTree(project)).toEqual(before)
      expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toBe('# Project\n')
    })
  })

  describe('checkHarnessCacheEfficiency', () => {
    it('warns when only IDE harnesses are detected', () => {
      fs.mkdirSync(path.join(project, '.vscode'))
      const result = checkHarnessCacheEfficiency(project)
      expect(result).not.toBeNull()
      expect(result?.status).toBe('warn')
      expect(result?.message).toContain('VS Code workspace detected without CLI harness config')
      expect(result?.message).toContain('IDE hooks cannot fold/trim built-in reads')
    })

    it('reports ok when CLI harness is active', () => {
      fs.mkdirSync(path.join(project, '.claude'))
      const result = checkHarnessCacheEfficiency(project)
      expect(result).not.toBeNull()
      expect(result?.status).toBe('ok')
      expect(result?.message).toBe('CLI harness configured (Claude Code)')
    })

    it('makes no claim it has no measurement for', () => {
      fs.mkdirSync(path.join(project, '.vscode'))
      expect(checkHarnessCacheEfficiency(project)?.message).not.toMatch(/\d+%/)
      fs.mkdirSync(path.join(project, '.claude'))
      expect(checkHarnessCacheEfficiency(project)?.message).not.toMatch(/maximum|\d+%/)
    })

    // The installs below are made by the real installers into the stubbed home, so the fixture is whatever `token-goat install` writes rather than a hand-built settings file.
    it('counts Claude Code hooks installed at user level', () => {
      fs.mkdirSync(path.join(project, '.vscode'))
      installHooks('user')
      const result = checkHarnessCacheEfficiency(project)
      expect(result?.status).toBe('ok')
      expect(result?.message).toBe('CLI harness configured (Claude Code)')
    })

    it('counts Codex hooks installed at user level', () => {
      fs.mkdirSync(path.join(project, '.vscode'))
      installCodex()
      const result = checkHarnessCacheEfficiency(project)
      expect(result?.status).toBe('ok')
      expect(result?.message).toBe('CLI harness configured (Codex)')
    })

    it('counts Copilot CLI hooks installed at user level', () => {
      fs.mkdirSync(path.join(project, '.vscode'))
      installCopilotCli()
      const result = checkHarnessCacheEfficiency(project)
      expect(result?.status).toBe('ok')
      expect(result?.message).toBe('CLI harness configured (Copilot CLI)')
    })
  })
})
