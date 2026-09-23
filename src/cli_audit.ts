/** CLI handler for `token-goat audit`. Runs a session retrospective for the current project (Copilot CLI or Claude Code), separating pre-audit session findings from audit execution self-checks, and emits a structured Maintainer Feedback Card (or JSON via `--json`). */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { resolveProjectRoot } from './project.js'
import { buildWasteReport, type WasteReport } from './waste.js'
import {
  buildCopilotWasteReport,
  findProjectSession,
  isCopilotTranscript,
  MCP_DISABLE_NOTE,
  unusedMcpServers,
  type CopilotWasteReport,
} from './copilot_waste.js'
import { displaySafeJson } from './paths.js'

export interface AuditCommandOptions {
  project?: string | undefined
  transcript?: string | undefined
  json?: boolean | undefined
}

export interface MaintainerFeedbackCard {
  taskSummary: string
  preAuditFindings: string[]
  auditExecutionFindings: string[]
  recommendedFix: string[]
}

export function buildFeedbackCardFromClaude(report: WasteReport): MaintainerFeedbackCard {
  const preAudit: string[] = []
  const fixes: string[] = []

  if (report.neverTouchedAgain.length > 0) {
    const files = report.neverTouchedAgain.map((f) => path.basename(f.filePath)).join(', ')
    preAudit.push(`Whole-file reads without reuse: ${files} (${report.neverTouchedAgain.length} file(s) read once via Read)`)
    fixes.push('Prefer `token-goat symbol` or `read "file::symbol"` instead of reading whole files.')
  }

  if (report.repeatedUncompressedBash.length > 0) {
    const cmds = report.repeatedUncompressedBash.map((b) => `"${b.normalized.slice(0, 40)}" (${b.count}x)`).join(', ')
    preAudit.push(`Repeated uncompressed terminal commands: ${cmds}`)
    fixes.push('Use token-goat bash-output cache or compress flags for repetitive terminal invocations.')
  }

  if (preAudit.length === 0) {
    preAudit.push('Pre-audit session: No missed surgical reads or friction detected; gate adhered to cleanly.')
  }

  if (fixes.length === 0) {
    fixes.push('Maintain current surgical read and caching discipline.')
  }

  return {
    taskSummary: `Engineering session in project (${report.totalTokens.toLocaleString()} tokens recorded across tool invocations).`,
    preAuditFindings: preAudit,
    auditExecutionFindings: [],
    recommendedFix: fixes,
  }
}

export function buildFeedbackCardFromCopilot(report: CopilotWasteReport): MaintainerFeedbackCard {
  const preAudit: string[] = []
  const fixes: string[] = []

  const repeatedBlocks = report.blocks.filter((b) => b.repeatCount > 0)
  if (repeatedBlocks.length > 0) {
    const kinds = repeatedBlocks.map((b) => `${b.kind} (${b.repeatCount}x repeat, ${b.repeatBytes} B)`).join(', ')
    preAudit.push(`Repeated prompt blocks across turns: ${kinds}`)
    fixes.push('Deduplicate repeated prompt instructions or context blocks across turns.')
  }

  if (report.mcpTools && report.mcpTools.servers.length > 0) {
    const totalMcpTokens = report.mcpTools.servers.reduce((sum, s) => sum + s.estimatedTokens, 0)
    const heavy = report.mcpTools.servers.filter((s) => s.estimatedTokens > 1000)
    if (heavy.length > 0 || totalMcpTokens > 1500) {
      const details = report.mcpTools.servers
        .map((s) => `${s.serverName} (${s.toolCount} tool(s), ~${s.estimatedTokens.toLocaleString()} tok/turn)`)
        .join(', ')
      const turns = Math.max(1, report.turns)
      const cumulative = totalMcpTokens * turns
      preAudit.push(
        `High fixed MCP tool definition overhead: ${details}; total ~${totalMcpTokens.toLocaleString()} tok/turn re-sent across ${turns} turn(s) (~${cumulative.toLocaleString()} cumulative tokens).`
      )
      const unused = unusedMcpServers(report)
      if (unused === null) {
        const heavyNames = (heavy.length > 0 ? heavy : report.mcpTools.servers).map((s) => s.serverName).join(', ')
        fixes.push(
          `Disable the MCP server(s) you do not use among ${heavyNames} with 'copilot mcp disable <name>', or exclude individual tools with '--excluded-tools'. This session's log records no tool calls, so it cannot say which went unused.`
        )
      } else if (unused.length > 0) {
        const commands = unused.map((s) => `'copilot mcp disable ${s.serverName}' (~${s.estimatedTokens.toLocaleString()} tok/turn)`).join(', ')
        fixes.push(`Disable the MCP server(s) this session never called: ${commands}. ${MCP_DISABLE_NOTE}`)
      }
    }
  }

  if (preAudit.length === 0) {
    preAudit.push('Pre-audit session: No missed surgical reads or friction detected; gate adhered to cleanly.')
  }

  if (fixes.length === 0) {
    fixes.push('Maintain current token-efficient tooling and MCP server configuration.')
  }

  return {
    taskSummary: `Copilot CLI session (${report.turns} turn(s) recorded in ${report.sessionId}).`,
    preAuditFindings: preAudit,
    auditExecutionFindings: [],
    recommendedFix: fixes,
  }
}

export function formatMaintainerCard(card: MaintainerFeedbackCard): string {
  const lines: string[] = [
    'Maintainer Feedback Card',
    '',
    `• Task Summary: ${card.taskSummary}`,
    '• Friction & Missed Savings:',
  ]
  for (const f of card.preAuditFindings) {
    lines.push(`  - ${f}`)
  }
  if (card.auditExecutionFindings.length > 0) {
    for (const a of card.auditExecutionFindings) {
      lines.push(`  - Audit Execution: ${a}`)
    }
  }
  lines.push('• Recommended Fix:')
  for (const r of card.recommendedFix) {
    lines.push(`  - ${r}`)
  }
  return lines.join('\n') + '\n'
}

export async function runAuditCommand(opts: AuditCommandOptions = {}): Promise<void> {
  const projectRoot = resolveProjectRoot(opts.project !== undefined ? { project: opts.project } : {})

  // 1. Explicit transcript
  if (opts.transcript !== undefined) {
    const resolved = path.resolve(opts.transcript)
    if (!fs.existsSync(resolved)) {
      const err = `transcript not found: ${resolved}`
      if (opts.json === true) {
        process.stdout.write(`${displaySafeJson({ error: err }, 0)}\n`)
      } else {
        process.stderr.write(`token-goat: ${err}\n`)
      }
      process.exitCode = 1
      return
    }

    if (isCopilotTranscript(resolved)) {
      const report = buildCopilotWasteReport(resolved)
      const card = buildFeedbackCardFromCopilot(report)
      if (opts.json === true) {
        process.stdout.write(`${displaySafeJson(card, 0)}\n`)
      } else {
        process.stdout.write(formatMaintainerCard(card))
      }
      return
    }

    const report = await buildWasteReport(resolved)
    const card = buildFeedbackCardFromClaude(report)
    if (opts.json === true) {
      process.stdout.write(`${displaySafeJson(card, 0)}\n`)
    } else {
      process.stdout.write(formatMaintainerCard(card))
    }
    return
  }

  // 2. Discover active or newest session
  const detected = findProjectSession(projectRoot)

  if (detected === null) {
    const err = 'no session transcript found for project'
    if (opts.json === true) {
      process.stdout.write(`${displaySafeJson({ error: err, project: projectRoot }, 0)}\n`)
    } else {
      process.stdout.write(`\n# token-goat audit\nProject: ${projectRoot}\nNo session transcript found. Pass --transcript <path> to specify one explicitly.\n`)
    }
    process.exitCode = 1
    return
  }

  if (detected.kind === 'copilot') {
    const report = buildCopilotWasteReport(detected.path)
    const card = buildFeedbackCardFromCopilot(report)
    if (opts.json === true) {
      process.stdout.write(`${displaySafeJson(card, 0)}\n`)
    } else {
      process.stdout.write(formatMaintainerCard(card))
    }
    return
  }

  const report = await buildWasteReport(detected.path)
  const card = buildFeedbackCardFromClaude(report)
  if (opts.json === true) {
    process.stdout.write(`${displaySafeJson(card, 0)}\n`)
  } else {
    process.stdout.write(formatMaintainerCard(card))
  }
}
