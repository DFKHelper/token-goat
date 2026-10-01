import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DoctorResult } from './doctor_result.js'
import { buildGuidanceBlock } from './bridges/guidance_block.js'
import { upsertDelimitedBlock } from './util.js'
import { loadConfig } from './config.js'

export const INSTRUCTION_GATE_BEGIN = '<!-- token-goat-begin -->'
export const INSTRUCTION_GATE_END = '<!-- token-goat-end -->'

export const CODEX_GATE_BEGIN = '<!-- token-goat-codex-begin -->'
export const CODEX_GATE_END = '<!-- token-goat-codex-end -->'

export interface InstructionGateCandidate {
  readonly filename: string
  readonly relativePath: string
  readonly fullPath: string
  readonly harnessName: string
  readonly exists: boolean
  readonly hasGate: boolean
  readonly beginMarker: string
  readonly endMarker: string
  readonly fallbackToolClause: string
}

/** Identify possible instruction files in the workspace or home that should carry the token-goat gate. */
export function findInstructionGateCandidates(rootDir: string = process.cwd()): InstructionGateCandidate[] {
  const candidates: InstructionGateCandidate[] = []

  // 1. CLAUDE.md in project root
  const claudeMdPath = path.join(rootDir, 'CLAUDE.md')
  const claudeMdExists = fs.existsSync(claudeMdPath)
  let claudeMdHasGate = false
  if (claudeMdExists) {
    try {
      const content = fs.readFileSync(claudeMdPath, 'utf8')
      claudeMdHasGate = content.includes(INSTRUCTION_GATE_BEGIN)
    } catch {
      // ignore
    }
  }
  candidates.push({
    filename: 'CLAUDE.md',
    relativePath: 'CLAUDE.md',
    fullPath: claudeMdPath,
    harnessName: 'Claude Code',
    exists: claudeMdExists,
    hasGate: claudeMdHasGate,
    beginMarker: INSTRUCTION_GATE_BEGIN,
    endMarker: INSTRUCTION_GATE_END,
    fallbackToolClause: "Claude Code's own Read, Grep, and Glob preference rules",
  })

  // 2. AGENTS.md in project root (Codex / cross-agent standard)
  const agentsMdPath = path.join(rootDir, 'AGENTS.md')
  const agentsMdExists = fs.existsSync(agentsMdPath)
  let agentsMdHasGate = false
  if (agentsMdExists) {
    try {
      const content = fs.readFileSync(agentsMdPath, 'utf8')
      agentsMdHasGate = content.includes(CODEX_GATE_BEGIN) || content.includes(INSTRUCTION_GATE_BEGIN)
    } catch {
      // ignore
    }
  }
  candidates.push({
    filename: 'AGENTS.md',
    relativePath: 'AGENTS.md',
    fullPath: agentsMdPath,
    harnessName: 'Codex / AGENTS.md',
    exists: agentsMdExists,
    hasGate: agentsMdHasGate,
    beginMarker: CODEX_GATE_BEGIN,
    endMarker: CODEX_GATE_END,
    fallbackToolClause: "Codex's native `exec`, `apply_patch`, and `view_image` tools (shell commands like `cat`/`type` run inside `exec`)",
  })

  // 3. .github/copilot-instructions.md
  const copilotInstructionsPath = path.join(rootDir, '.github', 'copilot-instructions.md')
  const copilotInstructionsExists = fs.existsSync(copilotInstructionsPath)
  let copilotInstructionsHasGate = false
  if (copilotInstructionsExists) {
    try {
      const content = fs.readFileSync(copilotInstructionsPath, 'utf8')
      copilotInstructionsHasGate = content.includes(INSTRUCTION_GATE_BEGIN)
    } catch {
      // ignore
    }
  }
  candidates.push({
    filename: 'copilot-instructions.md',
    relativePath: path.join('.github', 'copilot-instructions.md'),
    fullPath: copilotInstructionsPath,
    harnessName: 'GitHub Copilot CLI',
    exists: copilotInstructionsExists,
    hasGate: copilotInstructionsHasGate,
    beginMarker: INSTRUCTION_GATE_BEGIN,
    endMarker: INSTRUCTION_GATE_END,
    fallbackToolClause: "Copilot CLI's native `view`, `grep`, and `glob` tools (with PowerShell commands `Get-Content`/`Select-String` as search fallbacks)",
  })

  return candidates
}

/** Check whether project instructions files contain the token-goat routing gate. */
export function checkInstructionGates(rootDir: string = process.cwd()): DoctorResult {
  const candidates = findInstructionGateCandidates(rootDir)
  const existingFiles = candidates.filter((c) => c.exists)
  const gatedFiles = existingFiles.filter((c) => c.hasGate)

  if (gatedFiles.length > 0) {
    const names = gatedFiles.map((c) => c.relativePath).join(', ')
    return {
      name: 'Instruction gate',
      status: 'ok',
      message: `active in ${names}`,
    }
  }

  // If instruction files exist but lack the gate:
  if (existingFiles.length > 0) {
    const unGated = existingFiles.map((c) => c.relativePath).join(', ')
    return {
      name: 'Instruction gate',
      status: 'warn',
      message: `missing in ${unGated} (agents will bypass token-goat and read whole files). Run 'token-goat doctor --fix' to inject automatically.`,
    }
  }

  // No instruction files exist at all in project
  return {
    name: 'Instruction gate',
    status: 'warn',
    message: "no project instruction file found (CLAUDE.md, AGENTS.md, or .github/copilot-instructions.md). Run 'token-goat doctor --fix' to create CLAUDE.md with routing gate.",
  }
}

/** Injects missing routing gates into appropriate project instruction files. */
export function repairInstructionGates(rootDir: string = process.cwd()): { repairs: string[]; errors: string[] } {
  const repairs: string[] = []
  const errors: string[] = []
  const candidates = findInstructionGateCandidates(rootDir)
  const existingUngated = candidates.filter((c) => c.exists && !c.hasGate)

  const fallback = candidates[0]
  if (!fallback) return { repairs, errors }
  const targets = existingUngated.length > 0 ? existingUngated : [fallback]

  const cfg = loadConfig(rootDir)
  const gdrive = cfg.gdrive?.enabled ?? true

  for (const target of targets) {
    try {
      const block = buildGuidanceBlock({
        beginMarker: target.beginMarker,
        endMarker: target.endMarker,
        fallbackToolClause: target.fallbackToolClause,
        gdrive,
      })
      const parentDir = path.dirname(target.fullPath)
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true })
      }
      upsertDelimitedBlock(target.fullPath, target.beginMarker, target.endMarker, block)
      repairs.push(`Injected token-goat routing gate into ${target.relativePath}`)
    } catch (e) {
      errors.push(`Failed to inject routing gate into ${target.relativePath}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return { repairs, errors }
}

/** Warns if only IDE workspaces are detected without CLI harness config, highlighting prompt cache retention and enforcement advantages of CLI harnesses. */
export function checkHarnessCacheEfficiency(rootDir: string = process.cwd()): DoctorResult | null {
  const hasVscode = fs.existsSync(path.join(rootDir, '.vscode'))
  const hasIdea = fs.existsSync(path.join(rootDir, '.idea'))
  const hasCursor = fs.existsSync(path.join(rootDir, '.cursor')) || fs.existsSync(path.join(rootDir, '.cursorrules'))
  const hasVs = fs.existsSync(path.join(rootDir, '.vs'))

  const ideDetected = [
    hasVscode && 'VS Code',
    hasIdea && 'JetBrains',
    hasCursor && 'Cursor',
    hasVs && 'Visual Studio',
  ].filter(Boolean) as string[]

  const hasClaude = fs.existsSync(path.join(rootDir, '.claude')) || fs.existsSync(path.join(rootDir, 'CLAUDE.md'))
  const hasCopilot =
    fs.existsSync(path.join(rootDir, '.github', 'hooks')) ||
    fs.existsSync(path.join(rootDir, '.github', 'copilot-instructions.md'))
  const hasCodex = fs.existsSync(path.join(rootDir, '.codex')) || fs.existsSync(path.join(rootDir, 'AGENTS.md'))

  const cliDetected = [
    hasClaude && 'Claude Code',
    hasCopilot && 'Copilot CLI',
    hasCodex && 'Codex',
  ].filter(Boolean) as string[]

  if (ideDetected.length > 0 && cliDetected.length === 0) {
    return {
      name: 'Harness efficiency',
      status: 'warn',
      message: `${ideDetected.join(', ')} workspace detected without CLI harness config. IDE hooks cannot fold/trim built-in reads, and dynamic editor context churns prompt cache. Use Claude Code or Copilot CLI for 90%+ prompt cache reuse and hard pre-tool denials.`,
    }
  }

  if (cliDetected.length > 0) {
    return {
      name: 'Harness efficiency',
      status: 'ok',
      message: `CLI harness configured (${cliDetected.join(', ')}) — maximum prompt cache preservation and hard pre-tool denial enabled`,
    }
  }

  return null
}
