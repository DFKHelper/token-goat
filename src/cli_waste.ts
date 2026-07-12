/**
 * CLI handler for `token-goat waste`.
 *
 * Discovers (or accepts an explicit `--transcript`) the current project's
 * Claude Code session transcript, parses its tool_use/tool_result events, and
 * prints a spend ledger: total tokens by tool, the top N most expensive
 * individual tool calls, files read once and never referenced again, and
 * Bash commands run repeatedly without a token-goat bash-output cache hit.
 * `--json` emits the same data as machine-readable JSON instead.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { resolveProjectRoot } from './project.js'
import { buildWasteReport, findLatestTranscript, type WasteReport } from './waste.js'

export interface WasteCommandOptions {
  project?: string
  transcript?: string
  json?: boolean
  top?: number
}

function printReport(report: WasteReport): void {
  const w = (text: string) => { process.stdout.write(text) }

  w('\n# token-goat waste\n')
  w(`Transcript: ${report.transcriptPath}\n`)
  w(`Total tokens: ${report.totalTokens}\n`)

  w('\n## Tokens by tool\n')
  if (report.tokensByTool.length === 0) {
    w('  none\n')
  } else {
    for (const { key, tokens } of report.tokensByTool) {
      w(`  ${key}: ${tokens} tok\n`)
    }
  }

  w('\n## Top expensive tool calls\n')
  if (report.topCalls.length === 0) {
    w('  none\n')
  } else {
    for (const call of report.topCalls) {
      w(`  [${call.tokens} tok] ${call.name}: ${call.summary}\n`)
    }
  }

  w('\n## Read once, never touched again\n')
  if (report.neverTouchedAgain.length === 0) {
    w('  none\n')
  } else {
    for (const f of report.neverTouchedAgain) {
      w(`  ${f.filePath}: ${f.tokens} tok, never referenced again\n`)
    }
  }

  w('\n## Repeated Bash commands not hitting the token-goat cache\n')
  if (report.repeatedUncompressedBash.length === 0) {
    w('  none\n')
  } else {
    for (const cmd of report.repeatedUncompressedBash) {
      w(`  "${cmd.normalized}": ran ${cmd.count} times, ${cmd.avgTokens} tok each, ${cmd.totalTokens} tok total, uncompressed\n`)
    }
  }
}

/** Run the `token-goat waste` command. */
export async function runWasteCommand(opts: WasteCommandOptions = {}): Promise<void> {
  const projectRoot = resolveProjectRoot(opts.project !== undefined ? { project: opts.project } : {})

  const transcriptPath = opts.transcript !== undefined
    ? path.resolve(opts.transcript)
    : findLatestTranscript(projectRoot)

  if (transcriptPath === null) {
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify({ error: 'no session transcript found', project: projectRoot })}\n`)
    } else {
      process.stdout.write('\n# token-goat waste\n')
      process.stdout.write(`Project: ${projectRoot}\n`)
      process.stdout.write('No session transcript found. Pass --transcript <path> to specify one explicitly.\n')
    }
    process.exitCode = 1
    return
  }

  if (!fs.existsSync(transcriptPath)) {
    process.stderr.write(`token-goat: transcript not found: ${transcriptPath}\n`)
    process.exitCode = 1
    return
  }

  const report = await buildWasteReport(transcriptPath, opts.top !== undefined ? { topN: opts.top } : {})

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return
  }

  printReport(report)
}
