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
import { buildCopilotWasteReport, findLatestCopilotSession, type CopilotWasteReport } from './copilot_waste.js'
import { copilotCliMcpToolsDir } from './bridges/copilot_cli_install.js'
import { countNoun } from './util.js'
import { formatBytes, formatTokenEstimate } from './resident_context.js'
import { estimateTokensFromLength } from './overflow_guard.js'

export interface WasteCommandOptions {
  project?: string
  transcript?: string
  json?: boolean
  top?: number
  copilot?: boolean
}

/**
 * Copilot's ledger, which is a different report rather than the same one with different inputs.
 *
 * The Claude Code report is denominated in bytes because nothing in a transcript states a token
 * count. Copilot states its own, so this one leads with them: reporting an estimate next to a
 * figure the harness already published would be strictly worse information.
 */
function printCopilotReport(report: CopilotWasteReport): void {
  const w = (text: string) => { process.stdout.write(text) }
  w('\n# token-goat waste (Copilot CLI)\n')
  w(`Session: ${report.sessionId}\n`)
  w(`  ${report.sessionPath}\n`)

  w('\n## Per-request fixed overhead (Copilot\'s own token counts)\n')
  if (report.tokens === null) {
    w('  No shutdown record yet, so Copilot has not published a token split for this session.\n')
  } else {
    const { systemTokens, toolDefinitionsTokens, conversationTokens } = report.tokens
    const fixed = systemTokens + toolDefinitionsTokens
    const total = fixed + conversationTokens
    w(`  System prompt:     ${systemTokens.toLocaleString()} tok\n`)
    w(`  Tool definitions:  ${toolDefinitionsTokens.toLocaleString()} tok\n`)
    w(`  Conversation:      ${conversationTokens.toLocaleString()} tok\n`)
    if (total > 0) {
      const pct = ((fixed / total) * 100).toFixed(1)
      // Deliberately not phrased as "N% of every request": the split is a snapshot taken at
      // shutdown, and conversation grows over a session while the other two do not. The
      // re-sent-every-request claim is true of the numerator; the percentage is true of this
      // moment only, and saying otherwise would be the same overstatement this report exists
      // to avoid.
      // An earlier version of these lines said no hook can reach this and that fewer MCP servers
      // is the only lever. The first half stands; the second was wrong. An adversarial read of the
      // 1.0.80 bundle found --excluded-tools/--available-tools, --agent, --no-ask-user,
      // disabledSkills and --no-custom-instructions all feeding the tool-filter state that
      // sessionPrepareToolsForModelRequest builds from, and Copilot itself passes
      // excludedTools:["*"] to make a cheap call. That those flags shrink the counted definitions
      // rather than merely gating invocation is entailed by the wiring and the help text, not
      // measured -- so it is offered as a place to look, not as a promised saving.
      w(`  ${fixed.toLocaleString()} tok of system prompt and tool definitions ships with every\n`)
      w(`  request; at shutdown that was ${pct}% of the context. No hook can reach it: Copilot\n`)
      w('  assembles both natively, with nothing between assembly and send. The levers are all\n')
      w('  config: fewer MCP servers and custom tools, and --excluded-tools / --available-tools /\n')
      w('  --agent / --no-ask-user / --no-custom-instructions, whose effect on this number is\n')
      w('  entailed by how they are wired but has not been measured here. Copilot also ships\n')
      w('  built-in MCP servers, which --disable-builtin-mcps turns off wholesale. Note that\n')
      w('  --enable-all-github-mcp-tools moves this number the wrong way: its own help text calls\n')
      w('  the default a subset, so enabling everything adds definitions rather than removing\n')
      w('  them. --add-github-mcp-tool and --add-github-mcp-toolset replace that subset too.\n')
    }
  }

  // The aggregate above is the largest number in this report and the least
  // actionable one: it says the tool definitions are expensive without saying
  // which tools. Copilot caches the resolved tool list per MCP server, so that
  // question is answerable, but only as an estimate and only for part of the
  // total -- Copilot's built-in tools are never cached there. Both limits are
  // stated in the output rather than left for the reader to work out, because
  // a per-server number printed under an exact one reads as a split of it.
  w('\n## Tool definitions by MCP server (estimated)\n')
  const mcp = report.mcpTools
  if (!mcp.cacheFound) {
    w(`  No MCP tool cache at ${copilotCliMcpToolsDir()}.\n`)
    w('  That is not the same as having no MCP servers: it means nothing has been cached\n')
    w('  there yet, which is also what a Copilot that has never connected one looks like.\n')
  } else if (mcp.servers.length === 0) {
    w('  Cache is present but holds no servers, so none of the tool-definition budget\n')
    w(`  above is MCP: it is all Copilot's own tools, which the flags above can narrow\n`)
    w('  but dropping a server cannot.\n')
  } else {
    for (const server of mcp.servers) {
      const tokens = server.estimatedTokens.toLocaleString()
      w(`  ${server.serverName}: ${countNoun(server.toolCount, 'tool')}, `)
      w(`${formatBytes(server.definitionBytes)}, ~${tokens} tok\n`)
    }
    const mcpTokens = mcp.servers.reduce((sum, server) => sum + server.estimatedTokens, 0)
    w(`  ~${mcpTokens.toLocaleString()} tok estimated across `)
    w(`${countNoun(mcp.servers.length, 'server')}, re-sent every request.\n`)
    if (report.tokens !== null && report.tokens.toolDefinitionsTokens > 0) {
      const share = ((mcpTokens / report.tokens.toolDefinitionsTokens) * 100).toFixed(1)
      w(`  Copilot counted ${report.tokens.toolDefinitionsTokens.toLocaleString()} tok of tool `)
      w(`definitions in total, so this is roughly ${share}% of it.\n`)
      w('  The two are not a split of each other and come from different places: Copilot\n')
      w('  counted its own with its own tokeniser, while these are estimated from the bytes\n')
      w(`  of the cached definitions. The remainder is mostly Copilot's own non-MCP tools,\n`)
      w('  which are not cached here: dropping a server does not touch them, though the\n')
      w('  tool-filter flags above still can.\n')
    }
    w('  Dropping a server saves its line above on every request for the rest of the session.\n')
  }
  if (mcp.unreadable > 0) {
    const verb = mcp.unreadable === 1 ? 'is' : 'are'
    w(`  ${countNoun(mcp.unreadable, 'cache file')} could not be read and ${verb} not counted above.\n`)
  }

  w('\n## Injected blocks in the assembled prompt\n')
  if (report.blocks.length === 0) {
    w(`  none across ${countNoun(report.turns, 'turn')}\n`)
  } else {
    for (const block of report.blocks) {
      const pct = block.bytes > 0 ? ((block.repeatBytes / block.bytes) * 100).toFixed(1) : '0.0'
      w(`  ${block.kind}: ${countNoun(block.count, 'injection')}, ${formatBytes(block.bytes)}`)
      w(block.repeatBytes > 0 ? `, ${formatBytes(block.repeatBytes)} re-sent verbatim (${pct}%)\n` : '\n')
    }
  }

  w('\n## Compactions\n')
  if (report.compactions.length === 0) {
    w(`  ${countNoun(report.compactions.length, 'compaction')} recorded this session\n`)
  } else {
    for (const c of report.compactions) {
      w(`  ${c.trigger}: summary ${formatBytes(c.summaryBytes)}, ${c.preTokens.toLocaleString()} -> ${c.postTokens.toLocaleString()} tok\n`)
    }
  }

  w('\n## On disk but never billed\n')
  w(`  Hook records: ${formatBytes(report.hookRecordBytes)} of ${formatBytes(report.totalEventBytes)} in the event log.\n`)
  w('  hook.start/hook.end never reach the model, so this is log weight, not context weight.\n')
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

  // "ceiling"/"upper bound" MUST stay visible in the rendered label -- resendCeilingTokens is a
  // cache-unaware worst case, not real spend; see the doc comment on AssistantOutputCost in waste.ts.
  w('\n## Assistant output (re-send CEILING, not real spend)\n')
  const ao = report.assistantOutput
  w(`  ${countNoun(ao.turnCount, 'turn')}, ${ao.generatedTokens} tok generated\n`)
  w(`  Re-send upper bound: ${ao.resendCeilingTokens} tok if every turn were resent at full price on every later request\n`)
  w('  Real cost is substantially lower: prompt caching bills resent conversation history at cache-read rates, not full input price.\n')

  printResidentContext(report.residentContext, w)
}

/**
 * The harness-injected half of the ledger: context that never passes through a hook and so was
 * never attributed above.
 *
 * Every figure here is *injected bytes*, read from the transcript's own records. How long any of it
 * stays resident and what it is billed at is not recorded anywhere this code can see, so the
 * heading says "injected" and the token figures stay marked as estimates -- the same discipline the
 * assistant-output section above applies to its re-send ceiling.
 */
function printResidentContext(resident: WasteReport['residentContext'], w: (text: string) => void): void {
  w('\n## Harness-injected context (never passes through a hook)\n')
  if (resident.attachmentClasses.length === 0) {
    w('  none\n')
  } else {
    w(`  Total injected: ${formatBytes(resident.totalAttachmentBytes)} across ${countNoun(resident.attachmentClasses.length, 'class', 'classes')}\n`)
    for (const c of resident.attachmentClasses.slice(0, 8)) {
      w(`  ${c.type}: ${countNoun(c.count, 'injection')}, ${formatBytes(c.bytes)}\n`)
    }
  }

  const task = resident.latestTaskList
  if (task !== null) {
    w('\n## Task list (re-injected in full whenever it changes)\n')
    w(`  Latest: ${formatBytes(task.bytes)} (~${formatTokenEstimate(estimateTokensFromLength(task.bytes))} tok est), ${countNoun(task.itemCount, 'item')}\n`)
    w(`  ${task.completed} completed, ${task.inProgress} in progress, ${task.pending} pending\n`)
    w(`  Descriptions: ${formatBytes(task.descriptionBytes)} total, ${formatBytes(task.completedDescriptionBytes)} of it on completed items\n`)
    w(`  Injected ${countNoun(resident.taskReminderCount, 'time')} this session, ${formatBytes(resident.taskReminderBytes)} cumulative\n`)
  }

  if (resident.repeatedSkillBodies.length > 0) {
    w('\n## Skill bodies injected more than once\n')
    w('  Slash expansion and the Skill tool both send the whole body every time; no hook sees either.\n')
    for (const s of resident.repeatedSkillBodies.slice(0, 8)) {
      w(`  ${s.skill}: ${countNoun(s.count, 'injection')}, ${formatBytes(s.bytes)} (~${formatTokenEstimate(estimateTokensFromLength(s.bytes))} tok est)\n`)
    }
  }

  w('\n## Compactions\n')
  w(`  ${countNoun(resident.compactionCount, 'compaction')} this session`)
  w(resident.compactionCount === 0 ? '\n' : ', each re-injecting the fixed preamble (CLAUDE.md, memory, skill and agent listings)\n')
}

/** Run the `token-goat waste` command. */
export async function runWasteCommand(opts: WasteCommandOptions = {}): Promise<void> {
  if (opts.copilot === true) {
    const eventsPath = opts.transcript !== undefined ? path.resolve(opts.transcript) : findLatestCopilotSession()
    if (eventsPath === null || !fs.existsSync(eventsPath)) {
      const detail = eventsPath === null
        ? 'no Copilot CLI session found under <copilot-home>/session-state'
        : `Copilot session event log not found: ${eventsPath}`
      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify({ error: detail })}\n`)
      } else {
        process.stdout.write('\n# token-goat waste (Copilot CLI)\n')
        process.stdout.write(`${detail}\n`)
      }
      process.exitCode = 1
      return
    }
    const copilotReport = buildCopilotWasteReport(eventsPath)
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify(copilotReport)}\n`)
      return
    }
    printCopilotReport(copilotReport)
    return
  }

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
