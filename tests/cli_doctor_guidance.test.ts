import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  checkInstructionGates,
  repairInstructionGates,
  checkHarnessCacheEfficiency,
  INSTRUCTION_GATE_BEGIN,
} from '../src/cli_doctor_guidance.js'

describe('cli_doctor_guidance', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-guidance-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('checkInstructionGates', () => {
    it('returns warn when no instruction files exist', () => {
      const result = checkInstructionGates(tempDir)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('no project instruction file found')
    })

    it('returns warn when CLAUDE.md exists without the gate block', () => {
      fs.writeFileSync(path.join(tempDir, 'CLAUDE.md'), '# Project Instructions\nSome instructions without gate.')
      const result = checkInstructionGates(tempDir)
      expect(result.status).toBe('warn')
      expect(result.message).toContain('missing in CLAUDE.md')
      expect(result.message).toContain("Run 'token-goat doctor --fix' to inject automatically.")
    })

    it('returns ok when CLAUDE.md has the gate block', () => {
      fs.writeFileSync(path.join(tempDir, 'CLAUDE.md'), `# Project Instructions\n${INSTRUCTION_GATE_BEGIN}\nGate body\n<!-- token-goat-end -->`)
      const result = checkInstructionGates(tempDir)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('active in CLAUDE.md')
    })

    it('returns ok when AGENTS.md has the codex gate block', () => {
      fs.writeFileSync(path.join(tempDir, 'AGENTS.md'), '# Agents\n<!-- token-goat-codex-begin -->\nGate body\n<!-- token-goat-codex-end -->')
      const result = checkInstructionGates(tempDir)
      expect(result.status).toBe('ok')
      expect(result.message).toContain('active in AGENTS.md')
    })
  })

  describe('repairInstructionGates', () => {
    it('injects gate into existing ungated CLAUDE.md', () => {
      const claudeMd = path.join(tempDir, 'CLAUDE.md')
      fs.writeFileSync(claudeMd, '# My Custom Project\n')
      const res = repairInstructionGates(tempDir)
      expect(res.repairs.some((r) => r.includes('Injected token-goat routing gate into CLAUDE.md'))).toBe(true)
      expect(res.errors).toHaveLength(0)

      const content = fs.readFileSync(claudeMd, 'utf8')
      expect(content).toContain(INSTRUCTION_GATE_BEGIN)
      expect(content).toContain('# My Custom Project')
    })

    it('creates CLAUDE.md with gate if no files exist', () => {
      const claudeMd = path.join(tempDir, 'CLAUDE.md')
      expect(fs.existsSync(claudeMd)).toBe(false)
      const res = repairInstructionGates(tempDir)
      expect(res.repairs.some((r) => r.includes('Injected token-goat routing gate into CLAUDE.md'))).toBe(true)
      expect(fs.existsSync(claudeMd)).toBe(true)
      const content = fs.readFileSync(claudeMd, 'utf8')
      expect(content).toContain(INSTRUCTION_GATE_BEGIN)
    })
  })

  describe('checkHarnessCacheEfficiency', () => {
    it('warns when only IDE harnesses are detected', () => {
      fs.mkdirSync(path.join(tempDir, '.vscode'))
      const result = checkHarnessCacheEfficiency(tempDir)
      expect(result).not.toBeNull()
      expect(result?.status).toBe('warn')
      expect(result?.message).toContain('VS Code workspace detected without CLI harness config')
      expect(result?.message).toContain('IDE hooks cannot fold/trim built-in reads')
    })

    it('reports ok when CLI harness is active', () => {
      fs.mkdirSync(path.join(tempDir, '.claude'))
      const result = checkHarnessCacheEfficiency(tempDir)
      expect(result).not.toBeNull()
      expect(result?.status).toBe('ok')
      expect(result?.message).toContain('maximum prompt cache preservation')
    })
  })
})
