import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DoctorResult } from './doctor_result.js'
import { recordCreatedBy } from './bridges/created_configs.js'
import { buildGuidanceBlock } from './bridges/guidance_block.js'
import { upsertDelimitedBlock } from './util.js'
import { loadConfig } from './config.js'
import { claudeMdPath, isInstalled } from './install.js'
import { codexAgentsPath, isCodexInstalled } from './bridges/codex_install.js'
import { copilotCliInstructionsPath, isCopilotCliInstalled } from './bridges/copilot_cli_install.js'

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
      claudeMdHasGate = content.includes(INSTRUCTION_GATE_BEGIN) && content.includes(INSTRUCTION_GATE_END)
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
      agentsMdHasGate = (content.includes(CODEX_GATE_BEGIN) && content.includes(CODEX_GATE_END)) || (content.includes(INSTRUCTION_GATE_BEGIN) && content.includes(INSTRUCTION_GATE_END))
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
      copilotInstructionsHasGate = content.includes(INSTRUCTION_GATE_BEGIN) && content.includes(INSTRUCTION_GATE_END)
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

/** Whether `fullPath` holds a complete token-goat block under any of the given marker pairs. A begin marker without its end is a truncated or hand-damaged block, not a gate. */
function fileHasGate(fullPath: string, markers: readonly (readonly [string, string])[]): boolean {
  let content: string
  try {
    content = fs.readFileSync(fullPath, 'utf8')
  } catch {
    return false
  }
  return markers.some(([begin, end]) => content.includes(begin) && content.includes(end))
}

/** The user-level instruction files `token-goat install` writes its gate into, which each harness loads in every project: `~/.claude/CLAUDE.md` (or under CLAUDE_CONFIG_DIR), `~/.codex/AGENTS.md`, and Copilot CLI's `~/.copilot/copilot-instructions.md` (or under COPILOT_HOME). Returns the ones that carry a complete gate. */
export function findActiveGlobalGates(): string[] {
  const globals: { fullPath: string; markers: readonly (readonly [string, string])[] }[] = [
    { fullPath: claudeMdPath(), markers: [[INSTRUCTION_GATE_BEGIN, INSTRUCTION_GATE_END]] },
    { fullPath: codexAgentsPath(), markers: [[CODEX_GATE_BEGIN, CODEX_GATE_END], [INSTRUCTION_GATE_BEGIN, INSTRUCTION_GATE_END]] },
    { fullPath: copilotCliInstructionsPath(), markers: [[INSTRUCTION_GATE_BEGIN, INSTRUCTION_GATE_END]] },
  ]
  return globals.filter((g) => fileHasGate(g.fullPath, g.markers)).map((g) => g.fullPath)
}

/** Check whether project instructions files contain the token-goat routing gate. */
export function checkInstructionGates(rootDir: string = process.cwd()): DoctorResult {
  const candidates = findInstructionGateCandidates(rootDir)
  const existingFiles = candidates.filter((c) => c.exists)
  const gatedFiles = existingFiles.filter((c) => c.hasGate)
  const activeGlobal = findActiveGlobalGates()

  if (gatedFiles.length > 0 || activeGlobal.length > 0) {
    const names = [...activeGlobal, ...gatedFiles.map((c) => c.relativePath)].join(', ')
    return {
      name: 'Instruction gate',
      status: 'ok',
      message: `active in ${names}`,
    }
  }

  // No gate anywhere, but the project has instruction files to carry one:
  if (existingFiles.length > 0) {
    const unGated = existingFiles.map((c) => c.relativePath).join(', ')
    return {
      name: 'Instruction gate',
      status: 'warn',
      message: `missing in ${unGated} and in the user-level instruction files 'token-goat install' writes (agents will bypass token-goat and read whole files). Run 'token-goat doctor --fix' to inject automatically.`,
    }
  }

  return {
    name: 'Instruction gate',
    status: 'warn',
    message: "missing: no user-level instruction file carries it and no project instruction file was found (CLAUDE.md, AGENTS.md, or .github/copilot-instructions.md). Run 'token-goat install', or 'token-goat doctor --fix' to create CLAUDE.md with the routing gate.",
  }
}

/** Injects the routing gate into the project's instruction files, only when no gate is active anywhere: a user-level gate written by `token-goat install` already reaches every project, and copying it into a project file the user commits would duplicate guidance loaded every session, in a block nothing refreshes or uninstalls. */
export function repairInstructionGates(rootDir: string = process.cwd()): { repairs: string[]; errors: string[] } {
  const repairs: string[] = []
  const errors: string[] = []
  const candidates = findInstructionGateCandidates(rootDir)
  if (candidates.some((c) => c.hasGate) || findActiveGlobalGates().length > 0) return { repairs, errors }
  const existingUngated = candidates.filter((c) => c.exists)

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
      // Recorded as created when it was not there before, so `uninstall -p` removes the file once stripping the block leaves it empty, as it does for the CLAUDE.md install writes.
      recordCreatedBy([target.fullPath], () => {
        fs.mkdirSync(path.dirname(target.fullPath), { recursive: true })
        upsertDelimitedBlock(target.fullPath, target.beginMarker, target.endMarker, block)
      })
      repairs.push(`Injected token-goat routing gate into ${target.relativePath}`)
    } catch (e) {
      errors.push(`Failed to inject routing gate into ${target.relativePath}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return { repairs, errors }
}

/** Warns if only IDE workspace folders are present: the project has a .vscode, .idea, .cursor or .vs folder and no CLI harness is configured, either in the project or at user level by `token-goat install`. */
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

  // `token-goat install` wires the CLI harnesses at user level by default, so a project with no harness files of its own is still covered.
  const cliDetected = [
    (hasClaude || isInstalled('user')) && 'Claude Code',
    (hasCopilot || isCopilotCliInstalled()) && 'Copilot CLI',
    (hasCodex || isCodexInstalled()) && 'Codex',
  ].filter(Boolean) as string[]

  if (ideDetected.length > 0 && cliDetected.length === 0) {
    return {
      name: 'Harness efficiency',
      status: 'warn',
      message: `${ideDetected.join(', ')} workspace detected without CLI harness config. IDE hooks cannot fold/trim built-in reads. If you also use a CLI agent, run 'token-goat install' for Claude Code, or 'token-goat install --codex' or '--copilot' for those.`,
    }
  }

  if (cliDetected.length > 0) {
    return {
      name: 'Harness efficiency',
      status: 'ok',
      message: `CLI harness configured (${cliDetected.join(', ')})`,
    }
  }

  return null
}
