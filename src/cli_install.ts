/** The `install`, `uninstall` and `mcp-status` commands and the helpers only they use: the Claude Code base gate, post-install notes, the leftover-integration report and the purge. */
import * as fs from 'fs'
import * as path from 'path'
import { claudeConfigDir } from './claude_config_dir.js'
import { getSessionId } from './session.js'
import { displaySafePath, displaySafeText, displaySafeJson } from './paths.js'
import { installHooks, isInstalled, uninstallHooks, installClaudeMd, uninstallClaudeMd, findStrayClaudeMdBlocks, installSkill, uninstallSkill, settingsPath } from './install.js'
import type { HookScope } from './install.js'
import { installCodex, isCodexInstalled, uninstallCodex } from './bridges/codex_install.js'
import { installGemini, isGeminiInstalled, uninstallGemini } from './bridges/gemini_install.js'
import { installQwen, isQwenInstalled, uninstallQwen } from './bridges/qwen_install.js'
import { installKimi, isKimiInstalled, uninstallKimi } from './bridges/kimi_install.js'
import { installPi, isPiInstalled, uninstallPi } from './bridges/pi_install.js'
import { installOpencode, isOpencodeInstalled, uninstallOpencode } from './bridges/opencode_install.js'
import { installOpenclaw, isOpenclawInstalled, uninstallOpenclaw } from './bridges/openclaw_install.js'
import { HOOKS_SCRIPT_FILE, installCopilotCli, isCopilotCliInstalled, uninstallCopilotCli } from './bridges/copilot_cli_install.js'
import { installGrok, isGrokInstalled, uninstallGrok } from './bridges/grok_install.js'
import { installAntigravity, isAntigravityInstalled, uninstallAntigravity } from './bridges/antigravity_install.js'
import { installVscode, otherScopeHasManagedServer, uninstallVscode, vscodeDecoderConfigured, vscodeScopeFromFlags, vscodeUsesClaudeHooks } from './bridges/vscode_install.js'
import { installCursor, isCursorInstalled, uninstallCursor } from './bridges/cursor_install.js'
import { installZed, isZedInstalled, uninstallZed } from './bridges/zed_install.js'
import { installVisualStudio, isVisualStudioInstalled, uninstallVisualStudio, visualStudioDuplicateNote, visualStudioMcpStatus, visualStudioOtherScopeHasManagedServer } from './bridges/visualstudio_install.js'
import { installJetbrains, isJetbrainsInstalled, uninstallJetbrains } from './bridges/jetbrains_install.js'
import { installNeovim, isNeovimInstalled, uninstallNeovim } from './bridges/neovim_install.js'
import { detectEcosystems } from './bridges/detect_ecosystems.js'
import { VSCODE_DOUBLE_FIRE_NOTE, VSCODE_PROJECT_SCOPE_COVERAGE_NOTE, VSCODE_USER_SCOPE_MIGRATED_NOTE, VSCODE_USER_SCOPE_MULTIROOT_NOTE } from './cli_doctor_platforms.js'
import { isWorkerRunning } from './worker_lifecycle.js'
import { queryServers } from './hook_client.js'
import { installVerificationNotice } from './bridges_status.js'
import type { HarnessName } from './bridges/types.js'
import { ensureDirSync } from './util.js'
import { contentHash, extractCompactFromMarker, storeCompact, skillOutputsDir } from './skill_cache.js'
import { formatBytes, purgeDataDirectories } from './purge.js'
import { recordStat } from './stats.js'
import { CLAUDE_HOOKS_UNINSTALLED_KIND } from './hook_latency.js'
import { err, out } from './cli.js'
import { formatInstallIndexResult, queueInstallIndex } from './install_index.js'

/** Print the "how well is this bridge actually verified" caveat, if the bridge has one. Routed through {@link installVerificationNotice} rather than spelled out per branch: a caveat enumerated at nine callsites is a caveat that goes missing from the tenth, which is precisely the whitelist-drops-a-field shape that has shipped dead features from this codebase before. */
function printBridgeVerificationNotice(harness: HarnessName): void {
  const notice = installVerificationNotice(harness)
  if (notice !== null) out(notice)
}

/** One-line warning for a project-scope install whose files hold absolute paths on this machine and so must not be committed for a team: VS Code runs the hooks file for everyone who opens the repository. */
// Escaped inside this helper rather than at its call sites. Both callers pass paths built from the project root, so a repository cloned into a marker-named directory puts the marker into a note token-goat speaks in its own voice; doing it in the one place covers both callers and any later one. The guard's NEUTRALIZERS lists this function for that reason, and pins the shape below so it cannot quietly stop escaping while still exempting its callers.
function projectHooksCommitNote(pathFiles: readonly string[], hooksConfigPath?: string): string {
  const shim = hooksConfigPath === undefined ? '' : ` (${displaySafePath(path.join(path.dirname(hooksConfigPath), HOOKS_SCRIPT_FILE))} is generated with them)`
  return `Note: ${pathFiles.map((p) => displaySafePath(p)).join(', ')} ${pathFiles.length === 1 ? 'holds' : 'hold'} absolute paths to node and token-goat on this machine${shim}, so do not commit them: list them in .git/info/exclude or .gitignore.`
}

/** What install --visualstudio prints after writing: Visual Studio needs two manual switches before the agent sees anything. */
export function visualStudioManualSteps(scope: 'project' | 'user'): string[] {
  return [
    'Visual Studio runs no token-goat hooks: it gets the MCP tools and the routing guidance only (no read dedup, hints, image shrink or output folding). It needs Visual Studio 2022 17.14 or later, or Visual Studio 2026, and two steps there:',
    '  1. Tools > Options: turn on "Enable custom instructions to be loaded from .github/copilot-instructions.md files and added to requests".',
    '  2. In Copilot Chat agent mode, open the Tools picker and tick the token-goat tools: new MCP tools start disabled. If Visual Studio asks whether to trust the token-goat server, it is asking because the command or its arguments changed.',
    ...(scope === 'user' ? ['The user-level instructions file is read by Visual Studio 2026; on Visual Studio 2022, run this with -p/--project to put the guidance in the solution\'s .github/copilot-instructions.md.'] : []),
  ]
}

/** Whether an `install`/`uninstall` invocation should touch the base Claude Code integration: the `~/.claude/settings.json` (or project `.claude/settings.json`) hooks, the user's own `~/.claude/CLAUDE.md` routing block, and `~/.claude/skills/token-goat`. A bare `install`/`uninstall` with no other harness flag always means Claude Code, so it runs. Any *other* harness flag (`--vscode`, `--codex`, `--gemini`, ...) asks for that harness's own scope only -- none of them read or write anything under `~/.claude/`, confirmed by reading each bridge's install writer (e.g. `installVscode` writes only its own `mcp.json`, an instructions file, and the shared `~/.copilot/hooks` file). Wanting both is what running the command twice, or passing both flags in one invocation, is for -- not a silent side effect of asking for one. `--hermes` is the one exception: its CLI delegates to `claude -p`, which loads these same Claude Code hooks, so its branches below genuinely depend on this base having run. */
function wantsClaudeCodeBase(opts: {
  all?: boolean
  auto?: boolean
  claudecode?: boolean
  codex?: boolean
  gemini?: boolean
  qwen?: boolean
  kimi?: boolean
  pi?: boolean
  opencode?: boolean
  openclaw?: boolean
  copilot?: boolean
  grok?: boolean
  antigravity?: boolean
  vscode?: boolean
  visualstudio?: boolean
  zed?: boolean
  cursor?: boolean
  jetbrains?: boolean
  neovim?: boolean
  detect?: boolean
  hermes?: boolean
}): boolean {
  if (opts.detect === true) return false
  if (opts.all === true || opts.claudecode === true) return true
  if (opts.auto === true) return false
  const otherHarnessRequested = [
    opts.codex,
    opts.gemini,
    opts.qwen,
    opts.kimi,
    opts.pi,
    opts.opencode,
    opts.openclaw,
    opts.copilot,
    opts.grok,
    opts.antigravity,
    opts.vscode,
    opts.visualstudio,
    opts.zed,
    opts.cursor,
    opts.jetbrains,
    opts.neovim,
  ].some((v) => v === true)
  return !otherHarnessRequested || opts.hermes === true
}

/** Harnesses whose config lives only under the user's home: they have no project-scope form, so a project-scope uninstall must never remove them as part of `--all`. */
const USER_ONLY_HARNESSES = ['codex', 'gemini', 'qwen', 'kimi', 'openclaw', 'opencode', 'grok', 'antigravity', 'zed'] as const

export async function cmdInstall(opts: {
  project?: boolean
  codex?: boolean
  gemini?: boolean
  qwen?: boolean
  kimi?: boolean
  pi?: boolean
  opencode?: boolean
  hermes?: boolean
  openclaw?: boolean
  copilot?: boolean
  grok?: boolean
  antigravity?: boolean
  vscode?: boolean
  visualstudio?: boolean
  zed?: boolean
  cursor?: boolean
  jetbrains?: boolean
  neovim?: boolean
  detect?: boolean
  auto?: boolean
  all?: boolean
  claudecode?: boolean
  local?: boolean
  user?: boolean
  /** Commander's negation of `--no-index`: false only when the user passed it. */
  index?: boolean
}): Promise<void> {
  // --user is the opt-out from the one harness whose scope default is inverted (see vscodeScopeFromFlags). Passing both scope flags is a contradiction, not a precedence puzzle.
  if (opts.project === true && opts.user === true) {
    throw new Error('install takes either -p/--project or --user, not both.')
  }
  const localScope = opts.local === true || opts.project === true

  if (opts.detect === true) {
    const ecosystems = detectEcosystems({ projectRoot: process.cwd() })
    out('Detected Developer Ecosystems in current workspace:')
    for (const item of ecosystems.items) {
      const status = item.detected ? '✅ DETECTED' : '⚪ Not detected'
      out(`  ${displaySafeText(item.name)} (${displaySafeText(item.flag)}): ${status}`)
      if (item.reasons.length > 0) {
        for (const r of item.reasons) {
          out(`    • ${displaySafeText(r)}`)
        }
      }
    }
    if (ecosystems.detectedFlags.length > 0) {
      out('\nRun "token-goat install --auto" to automatically install token-goat across all detected environments.')
    }
    if (opts.auto !== true) return
  }

  if (opts.auto === true) {
    const detected = detectEcosystems({ projectRoot: process.cwd() })
    let anyDetected = false
    for (const item of detected.items) {
      if (item.detected) {
        anyDetected = true
        if (item.id === 'vscode') opts.vscode = true
        if (item.id === 'visualstudio') opts.visualstudio = true
        if (item.id === 'copilot') opts.copilot = true
        if (item.id === 'jetbrains') opts.jetbrains = true
        if (item.id === 'neovim') opts.neovim = true
        if (item.id === 'cursor') opts.cursor = true
        if (item.id === 'codex') opts.codex = true
        if (item.id === 'zed') opts.zed = true
        if (item.id === 'opencode') opts.opencode = true
        if (item.id === 'gemini') opts.gemini = true
        if (item.id === 'claudecode' || item.id === 'claude') opts.claudecode = true
      }
    }
    const hasExplicitHarness =
      opts.all === true ||
      opts.vscode === true ||
      opts.visualstudio === true ||
      opts.copilot === true ||
      opts.jetbrains === true ||
      opts.neovim === true ||
      opts.cursor === true ||
      opts.codex === true ||
      opts.zed === true ||
      opts.opencode === true ||
      opts.gemini === true ||
      opts.claudecode === true
    if (!anyDetected && !hasExplicitHarness) {
      out('No developer ecosystems detected in current workspace.')
      return
    }
  }

  if (opts.all === true) {
    opts.vscode = true
    opts.visualstudio = true
    opts.copilot = true
    opts.jetbrains = true
    opts.neovim = true
    opts.cursor = true
    opts.codex = true
    opts.zed = true
    opts.opencode = true
    opts.gemini = true
    opts.qwen = true
    opts.kimi = true
    opts.pi = true
    opts.openclaw = true
    opts.grok = true
    opts.antigravity = true
    opts.claudecode = true
  }
  // Imported here, not at module scope, for the same startup-cost reason cmdHook does it: relay.ts side-effect-imports every hook handler module to populate the registry toolMatcherFor (hook_registry.ts) narrows PreToolUse/PostToolUse matchers against. Without this, installHooks below narrows against whichever hook modules the CLI's static imports happen to reach for unrelated commands (neither this file nor cli.ts imports one directly: hooks_read.ts, with the image_shrink.ts and hint_stats.ts handlers it imports, arrives through hint_target.ts, and hooks_index.ts through read_commands.ts), silently dropping every other tool's hooks (Bash, Write, Edit, Glob, WebFetch, WebSearch, Agent, Skill, ...) from a fresh install, and downgrading an existing catch-all install to that same narrow set on a repeat run -- confirmed against the real built binary, which wrote "^Read$|^Grep$" for PreToolUse and "^Read$" for PostToolUse before this fix.
  await import('./relay.js')
  const scope: HookScope = opts.project === true ? 'project' : 'user'

  // Base install: the Claude Code hooks, the CLAUDE.md routing block, and the token-goat skill, per README's "What gets installed?" table -- gated behind wantsClaudeCodeBase (see its doc comment) so a scoped harness flag like --vscode never silently rewrites a Claude Code file it does not need.
  if (wantsClaudeCodeBase(opts)) {
    const result = installHooks(scope)
    // Report alreadyInstalled like every other harness branch below does. installHooks has always computed it; the base Claude Code path was the one caller that discarded it and claimed a fresh install on every run.
    out(
      result.alreadyInstalled
        ? `token-goat hooks (${scope}) already up to date → ${result.settingsPath}`
        : `Installed token-goat hooks (${scope}) → ${result.settingsPath}`,
    )

    const claudeMdResult = installClaudeMd()
    out(
      claudeMdResult.alreadyInstalled
        ? `CLAUDE.md block already up to date → ${claudeMdResult.path}`
        : `Updated CLAUDE.md → ${claudeMdResult.path}`,
    )

    // A block relocated into some other markdown file is invisible to install/uninstall, so the write above just created a second copy. Say so rather than leaving a silent duplicate.
    for (const stray of findStrayClaudeMdBlocks()) {
      out(`WARNING: stray token-goat block in ${stray} — not managed by install/uninstall; delete it to avoid duplicate, stale guidance.`)
    }

    const skillResult = installSkill()
    out(
      skillResult.alreadyInstalled
        ? `token-goat skill already up to date → ${skillResult.path}`
        : `Installed token-goat skill → ${skillResult.path}`,
    )
  }

  if (opts.codex === true) {
    const codexResult = installCodex()
    if (codexResult.alreadyInstalled) {
      out(`Codex CLI integration already installed → ${codexResult.configPath}`)
    } else {
      out(`Installed token-goat Codex CLI integration → ${codexResult.configPath}, ${codexResult.agentsPath}`)
    }
    printBridgeVerificationNotice('codex')
  }

  // --gemini is additive, exactly like --codex above.
  if (opts.gemini === true) {
    const geminiResult = installGemini()
    if (geminiResult.alreadyInstalled) {
      out(`Gemini CLI integration already installed → ${geminiResult.settingsPath}`)
    } else {
      out(`Installed token-goat Gemini CLI integration → ${geminiResult.settingsPath}`)
    }
    printBridgeVerificationNotice('gemini')
  }

  // --qwen is additive, exactly like --gemini above.
  if (opts.qwen === true) {
    const qwenResult = installQwen()
    if (qwenResult.alreadyInstalled) {
      out(`Qwen Code integration already installed → ${qwenResult.settingsPath}`)
    } else {
      out(`Installed token-goat Qwen Code integration → ${qwenResult.settingsPath}`)
    }
    printBridgeVerificationNotice('qwen')
  }

  // --kimi is additive, exactly like --qwen above.
  if (opts.kimi === true) {
    const kimiResult = installKimi()
    if (kimiResult.alreadyInstalled) {
      out(`Kimi Code integration already installed → ${kimiResult.configPath}`)
    } else {
      out(`Installed token-goat Kimi Code integration → ${kimiResult.configPath}, ${kimiResult.hookScriptPath}, ${kimiResult.agentsPath}, ${kimiResult.skillPath}`)
    }
    printBridgeVerificationNotice('kimi')
  }

  // --pi is additive on both install and uninstall, exactly like --codex. --local and -p/--project both select the project-local scope for --pi and --copilot; passed without either of those flags they are ignored.
  if (opts.pi === true) {
    const piResult = installPi({ local: opts.local === true || opts.project === true })
    if (piResult.alreadyInstalled) {
      out(`pi extension already installed → ${piResult.extensionPath}`)
    } else {
      out(`Installed token-goat pi extension → ${piResult.extensionPath}`)
    }
    printBridgeVerificationNotice('pi')
  }

  // --openclaw is additive, exactly like --codex above.
  if (opts.openclaw === true) {
    const openclawResult = installOpenclaw()
    if (openclawResult.alreadyInstalled) {
      out(`OpenClaw integration already installed → ${openclawResult.configPath}`)
    } else {
      out(`Installed token-goat OpenClaw integration → ${openclawResult.configPath}, ${openclawResult.pluginPath}`)
    }
    printBridgeVerificationNotice('openclaw')
  }

  // --copilot is additive, exactly like --codex above.
  if (opts.copilot === true) {
    const copilotResult = installCopilotCli({ local: opts.local === true || opts.project === true })
    if (copilotResult.alreadyInstalled) {
      out(`Copilot CLI integration already installed → ${copilotResult.configPath}`)
    } else {
      out(`Installed token-goat Copilot CLI integration → ${[copilotResult.configPath, copilotResult.scriptPath, copilotResult.instructionsPath, ...(copilotResult.mcpConfigPath !== undefined ? [copilotResult.mcpConfigPath] : [])].join(', ')}`)
    }
    if (localScope) out(projectHooksCommitNote([copilotResult.configPath], copilotResult.configPath))
    printBridgeVerificationNotice('copilot_cli')
  }

  // --opencode is additive, exactly like --pi above.
  if (opts.opencode === true) {
    const opencodeResult = installOpencode()
    if (opencodeResult.alreadyInstalled) {
      out(`opencode plugin already installed → ${opencodeResult.pluginPath}`)
    } else {
      out(`Installed token-goat opencode plugin → ${opencodeResult.pluginPath}`)
    }
    printBridgeVerificationNotice('opencode')
  }

  // --grok is additive, exactly like --codex above.
  if (opts.grok === true) {
    const grokResult = installGrok()
    if (grokResult.alreadyInstalled) {
      out(`Grok CLI integration already installed → ${grokResult.configPath}`)
    } else {
      out(`Installed token-goat Grok CLI integration → ${grokResult.configPath}, ${grokResult.hookScriptPath}`)
    }
    printBridgeVerificationNotice('grok')
  }

  // --antigravity is additive, exactly like --grok above.
  if (opts.antigravity === true) {
    const antigravityResult = installAntigravity()
    if (antigravityResult.alreadyInstalled) {
      out(`Antigravity CLI integration already installed → ${antigravityResult.pluginDir}`)
    } else {
      out(`Installed token-goat Antigravity CLI integration → ${antigravityResult.pluginDir}`)
    }
    printBridgeVerificationNotice('antigravity')
  }

  if (opts.vscode === true) {
    const vscodeResult = installVscode(vscodeScopeFromFlags(opts))
    if (vscodeResult.migratedFromUserScope) out(VSCODE_USER_SCOPE_MIGRATED_NOTE)
    out(
      vscodeResult.alreadyInstalled
        ? `VS Code MCP integration (${vscodeResult.scope} scope) already installed → ${displaySafePath(vscodeResult.mcpPath)}`
        : `Installed token-goat VS Code MCP integration and agent hooks (${vscodeResult.scope} scope) → ${displaySafePath(vscodeResult.mcpPath)}, ${displaySafePath(vscodeResult.hooksConfigPath)}, ${displaySafePath(vscodeResult.instructionsPath)}`,
    )
    if (vscodeResult.scope === 'project') {
      out(projectHooksCommitNote([vscodeResult.mcpPath, vscodeResult.hooksConfigPath], vscodeResult.hooksConfigPath))
      out(VSCODE_PROJECT_SCOPE_COVERAGE_NOTE)
    } else {
      out(VSCODE_USER_SCOPE_MULTIROOT_NOTE)
    }
    if (vscodeUsesClaudeHooks()) out(VSCODE_DOUBLE_FIRE_NOTE)
  }

  if (opts.visualstudio === true) {
    const vsResult = installVisualStudio({ project: opts.project === true })
    out(
      vsResult.alreadyInstalled
        ? `Visual Studio MCP integration (${vsResult.scope} scope) already installed → ${displaySafePath(vsResult.mcpPath)}`
        : `Installed token-goat Visual Studio MCP integration (${vsResult.scope} scope) → ${displaySafePath(vsResult.mcpPath)}, ${displaySafePath(vsResult.instructionsPath)}`,
    )
    if (vsResult.scope === 'project') out(projectHooksCommitNote([vsResult.mcpPath]))
    for (const line of visualStudioManualSteps(vsResult.scope)) out(line)
  }

  // --zed is additive and user-scope only: Zed's context_servers has no documented project-local equivalent to VS Code's .vscode/mcp.json, so -p/--project has no effect here.
  if (opts.zed === true) {
    const zedResult = installZed()
    out(
      zedResult.alreadyInstalled
        ? `Zed MCP context-server integration already installed → ${displaySafePath(zedResult.settingsPath)}`
        : `Installed token-goat Zed MCP context-server integration → ${displaySafePath(zedResult.settingsPath)}, ${displaySafePath(zedResult.shimPath)}`,
    )
  }

  // Cursor imports Claude Code's hooks from ~/.claude/settings.json by default (confirmed against the installed 3.19.7 bundle), so token-goat never writes ~/.cursor/hooks.json -- see src/bridges/cursor_install.ts's header. This registers the MCP server only.
  if (opts.cursor === true) {
    const cursorResult = installCursor({ project: opts.project === true })
    out(
      cursorResult.alreadyInstalled
        ? `Cursor MCP integration (${cursorResult.scope} scope) already installed → ${displaySafePath(cursorResult.mcpPath)}`
        : `Installed token-goat Cursor MCP integration (${cursorResult.scope} scope) → ${displaySafePath(cursorResult.mcpPath)}. Cursor runs no token-goat hooks written by this installer: if you have also run "token-goat install" for Claude Code, Cursor already imports those hooks automatically from ~/.claude/settings.json.`,
    )
    if (cursorResult.scope === 'project') out(projectHooksCommitNote([cursorResult.mcpPath]))
  }

  if (opts.jetbrains === true) {
    const jbResult = installJetbrains({ project: opts.project === true })
    out(
      jbResult.alreadyInstalled
        ? `JetBrains MCP integration (${jbResult.scope} scope) already installed → ${displaySafePath(jbResult.mcpPath)}`
        : `Installed token-goat JetBrains MCP integration (${jbResult.scope} scope) → ${displaySafePath(jbResult.mcpPath)}, ${displaySafePath(jbResult.instructionsPath)}`,
    )
    if (jbResult.scope === 'project') out(projectHooksCommitNote([jbResult.mcpPath]))
  }

  if (opts.neovim === true) {
    const nvimResult = installNeovim({ project: opts.project === true })
    out(
      nvimResult.alreadyInstalled
        ? `Neovim Lua integration (${nvimResult.scope} scope) already installed → ${displaySafePath(nvimResult.configPath)}`
        : `Installed token-goat Neovim Lua integration (${nvimResult.scope} scope) → ${displaySafePath(nvimResult.configPath)}`,
    )
    if (nvimResult.scope === 'project') out(projectHooksCommitNote([nvimResult.configPath]))
  }

  // Visual Studio reads the solution's .mcp.json and .vscode/mcp.json both, so project-scope installs for the two hosts overlap there. --vscode is project scope unless --user says otherwise, so it reaches this overlap without -p now; --visualstudio still needs -p.
  if (((opts.vscode === true && opts.user !== true) || (opts.visualstudio === true && opts.project === true))) {
    const duplicateNote = visualStudioDuplicateNote()
    if (duplicateNote !== null) out(duplicateNote)
  }

  // --hermes writes nothing new: Hermes delegates to `claude -p '<task>'`, which loads the same Claude Code settings.json installHooks() just wrote (forced above by wantsClaudeCodeBase, since --hermes genuinely depends on it). There is no separate Hermes config file to patch, so this is a verification-only flag -- run the same isInstalled() check `doctor` uses and report whether the hooks Hermes will inherit are really there.
  if (opts.hermes === true) {
    out(
      isInstalled(scope)
        ? `Hermes integration verified: token-goat hooks are present in ${settingsPath(scope)}.`
        : `Hermes integration NOT verified: token-goat hooks are missing from ${settingsPath(scope)}.`,
    )
  }

  // Pre-generate compacts for all installed skills.
  try {
    const skillDir = path.join(claudeConfigDir(), 'skills')
    if (fs.existsSync(skillDir)) {
      const entries = fs.readdirSync(skillDir, { withFileTypes: true })
      const skillNames: string[] = []
      const sessionId = getSessionId()

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillFile = path.join(skillDir, entry.name, 'SKILL.md')
        if (fs.existsSync(skillFile)) {
          const body = fs.readFileSync(skillFile, 'utf-8')
          const compact = extractCompactFromMarker(body)
          if (compact === null) continue
          const sourceSha = contentHash(body)
          await storeCompact(sessionId, entry.name, compact, sourceSha)
          skillNames.push(entry.name)
        }
      }

      if (skillNames.length > 0) {
        // Write pregen.json with list of pre-generated skills.
        const dir = skillOutputsDir()
        ensureDirSync(dir)
        const pregenPath = path.join(dir, 'pregen.json')
        const pregenData = { ts: Date.now(), names: skillNames }
        await fs.promises.writeFile(pregenPath, JSON.stringify(pregenData, null, 2))
        out(`Pre-generated ${skillNames.length} skill compacts.`)
      }
    }
  } catch {
    // fail-soft: install succeeded even if pre-gen fails
  }

  // Auto-refresh stale hooks and missing instruction gates across all already-installed harnesses
  if (wantsClaudeCodeBase(opts)) {
    try {
      const { repairHarnessHooks } = await import('./cli_doctor_hooks.js')
      const { repairInstructionGates } = await import('./cli_doctor_guidance.js')
      const hookRepair = repairHarnessHooks(process.cwd())
      for (const r of hookRepair.repairs) out(`  • Re-established hook: ${r}`)
      const gateRepair = repairInstructionGates(process.cwd())
      for (const r of gateRepair.repairs) out(`  • Refreshed instruction gate: ${r}`)
    } catch {
      // Non-fatal: base installation already succeeded
    }
  }

  // Last, so every harness above is wired before the worker starts spending CPU on a parse. queueInstallIndex never throws.
  const indexLine = formatInstallIndexResult(queueInstallIndex(process.cwd(), { enabled: opts.index }))
  if (indexLine !== null) out(indexLine)
}

// Backs the VS Code extension's ensureDecoderSetup check -- shelled out to rather than reimplemented in the extension, so the extension and installVscode share one path resolver (vscodeDecoderConfigured) and can never drift on where mcp.json lives or what key name it looks for. --project checks the workspace `.vscode/mcp.json` too (via process.cwd(), set by --cwd above), matching install/uninstall's --project convention. --visualstudio answers the same question for the Visual Studio `.mcp.json` files.
export function cmdMcpStatus(opts: { vscode?: boolean; visualstudio?: boolean; project?: boolean }): void {
  if ((opts.vscode === true) === (opts.visualstudio === true)) {
    throw new Error('mcp-status needs exactly one of --vscode or --visualstudio')
  }
  const scope = opts.project === true ? { projectRoot: process.cwd() } : {}
  out(displaySafeJson(opts.vscode === true ? vscodeDecoderConfigured(scope) : visualStudioMcpStatus(scope), 0))
}

export async function cmdUninstall(opts: {
  project?: boolean
  codex?: boolean
  gemini?: boolean
  qwen?: boolean
  kimi?: boolean
  pi?: boolean
  opencode?: boolean
  hermes?: boolean
  openclaw?: boolean
  copilot?: boolean
  grok?: boolean
  antigravity?: boolean
  vscode?: boolean
  visualstudio?: boolean
  zed?: boolean
  cursor?: boolean
  jetbrains?: boolean
  neovim?: boolean
  all?: boolean
  claudecode?: boolean
  local?: boolean
  user?: boolean
  purge?: boolean
}): Promise<void> {
  if (opts.project === true && opts.user === true) {
    throw new Error('uninstall takes either -p/--project or --user, not both.')
  }
  const localScope = opts.local === true || opts.project === true
  // A project-scope uninstall touches project files only. `--all` therefore leaves the user-only harnesses (and the user CLAUDE.md block and skill below) alone, and one NOTE names what it skipped; an explicit flag such as `--codex` is still honoured.
  const skippedUserOnly: string[] = []
  if (opts.all === true) {
    for (const key of USER_ONLY_HARNESSES) {
      if (opts.project === true && opts[key] !== true) skippedUserOnly.push(key)
      else opts[key] = true
    }
    opts.pi = true
    opts.copilot = true
    opts.vscode = true
    opts.visualstudio = true
    opts.cursor = true
    opts.jetbrains = true
    opts.neovim = true
    opts.claudecode = true
  }
  const scope: HookScope = opts.project === true ? 'project' : 'user'

  // Base uninstall, mirroring the base install's wantsClaudeCodeBase gate: strip the Claude Code hooks, the CLAUDE.md block, and the skill directory only when this invocation actually means Claude Code (bare uninstall, or --hermes, which shares its hook entries). A scoped `uninstall --vscode` must not also silently strip the caller's Claude Code integration.
  if (wantsClaudeCodeBase(opts)) {
    const removed = uninstallHooks(scope)
    out(removed ? `Removed token-goat hooks (${scope}).` : `No token-goat hooks to remove (${scope}).`)
    // Tells doctor's Claude Code hooks check this removal was asked for, so it does not report the hooks as lost.
    if (removed) recordStat(CLAUDE_HOOKS_UNINSTALLED_KIND)

    // Neither the CLAUDE.md block nor the skill has a project-scope form (install writes them under the user config dir whatever the scope), so a project-scope uninstall leaves both and says so.
    if (scope === 'project') {
      out('NOTE: the token-goat CLAUDE.md block and skill are user-scope and were not touched. Run "token-goat uninstall" to remove them.')
    } else {
      const claudeMdRemoved = uninstallClaudeMd()
      out(claudeMdRemoved ? 'Removed token-goat block from CLAUDE.md.' : 'No token-goat block in CLAUDE.md to remove.')

      // Strays live in files token-goat doesn't own, so uninstall reports them rather than deleting: silently editing a user's own markdown is worse than leaving a line behind.
      for (const stray of findStrayClaudeMdBlocks()) {
        out(`NOTE: a token-goat block remains in ${stray} — outside CLAUDE.md, so it was not removed. Delete it manually if unwanted.`)
      }

      const skillRemoved = uninstallSkill()
      out(skillRemoved ? 'Removed token-goat skill.' : 'No token-goat skill to remove.')
    }
  }

  // --codex/--gemini/--pi/--openclaw/--copilot/--opencode are each additive on both install and uninstall (README: "Add --codex ... to also strip those integrations"), so they run on top of the base uninstall above rather than replacing it. --local or -p/--project (pi, copilot) narrows removal to the project-local scope only; without it, the uninstaller cleans up wherever the integration actually is (global and/or local) instead of requiring the caller to remember which scope it was originally installed with.
  const removals: Array<{ flag: boolean; run: () => boolean; label: string }> = [
    { flag: opts.codex === true, run: uninstallCodex, label: 'Codex CLI integration' },
    { flag: opts.gemini === true, run: uninstallGemini, label: 'Gemini CLI integration' },
    { flag: opts.qwen === true, run: uninstallQwen, label: 'Qwen Code integration' },
    { flag: opts.kimi === true, run: uninstallKimi, label: 'Kimi Code integration' },
    { flag: opts.pi === true, run: () => (localScope ? uninstallPi({ local: true }) : uninstallPi()), label: 'pi extension' },
    { flag: opts.openclaw === true, run: uninstallOpenclaw, label: 'OpenClaw integration' },
    { flag: opts.copilot === true, run: () => (localScope ? uninstallCopilotCli({ local: true }) : uninstallCopilotCli()), label: 'Copilot CLI integration' },
    { flag: opts.opencode === true, run: uninstallOpencode, label: 'opencode plugin' },
    { flag: opts.grok === true, run: uninstallGrok, label: 'Grok CLI integration' },
    { flag: opts.antigravity === true, run: uninstallAntigravity, label: 'Antigravity CLI integration' },
    { flag: opts.vscode === true, run: () => uninstallVscode(vscodeScopeFromFlags(opts)), label: 'VS Code MCP integration' },
    { flag: opts.visualstudio === true, run: () => uninstallVisualStudio({ project: opts.project === true }), label: 'Visual Studio MCP integration' },
    { flag: opts.zed === true, run: uninstallZed, label: 'Zed MCP context-server integration' },
    { flag: opts.cursor === true, run: () => uninstallCursor({ project: opts.project === true }), label: 'Cursor MCP integration' },
    { flag: opts.jetbrains === true, run: () => uninstallJetbrains({ project: opts.project === true }), label: 'JetBrains MCP integration' },
    { flag: opts.neovim === true, run: () => uninstallNeovim({ project: opts.project === true }), label: 'Neovim Lua integration' },
  ]
  for (const removal of removals) {
    if (!removal.flag) continue
    const removed = removal.run()
    out(removed ? `Removed token-goat ${removal.label}.` : `No token-goat ${removal.label} to remove.`)
  }
  if (skippedUserOnly.length > 0) {
    out(`NOTE: ${skippedUserOnly.map((key) => `--${key}`).join(', ')} are user-scope only and were not touched by this project-scope uninstall. Run "token-goat uninstall" with those flags (without --project) to remove them.`)
  }

  // An integration whose flag was not passed is left wired and, before this, was left silent: a plain `token-goat uninstall` printed three "Removed" lines while a Codex or Copilot hook still pointed at the binary about to be deleted. That is the offboarding case, and a Copilot preToolUse hook whose target is gone fails closed on every call. So each one that is still present is named here with the exact command that removes it, following the same report-rather-than-delete rule the stray CLAUDE.md blocks above already use: uninstall does not silently undo an integration the caller did not ask about.
  for (const leftover of leftoverIntegrations(opts)) {
    if (skippedUserOnly.includes(leftover.flag.slice(2))) continue
    out(`NOTE: the token-goat ${leftover.label} is still installed. Run "token-goat uninstall ${leftover.flag}" to remove it.`)
  }

  // Cross-scope warning, mirroring installVscode's cross-scope guard (see otherScopeHasManagedServer): uninstall only ever touches the requested scope's mcp.json, so a server registered in the OTHER scope survives silently -- e.g. a project-scope install from before the project->user default flip, uninstalled with a bare `token-goat uninstall --vscode` (which now defaults to user scope). Warn rather than refuse: uninstall is best-effort cleanup (it already reports-not-deletes stray CLAUDE.md blocks above), and refusing here would block a caller who legitimately only wants to strip the requested scope.
  if (opts.vscode === true && otherScopeHasManagedServer(vscodeScopeFromFlags(opts))) {
    const otherScope = opts.user === true ? 'project' : 'user'
    out(`NOTE: token-goat is still registered in VS Code ${otherScope} scope. Run "token-goat uninstall --vscode${otherScope === 'user' ? ' --user' : ''}" to remove it too.`)
  }

  if (opts.visualstudio === true && visualStudioOtherScopeHasManagedServer({ project: opts.project === true })) {
    const otherScope = opts.project === true ? 'user' : 'project'
    out(`NOTE: token-goat is still registered in Visual Studio ${otherScope} scope. Run "token-goat uninstall --visualstudio${otherScope === 'project' ? ' --project' : ''}" to remove it too.`)
  }

  // --hermes removes no files: Hermes shares the Claude Code hook entries uninstallHooks() above already stripped, so this only exists for CLI symmetry with the other harness flags (README's uninstall table lists --hermes alongside the rest).
  if (opts.hermes === true) {
    out('No separate Hermes integration to remove (it shares the Claude Code hook entries).')
  }

  if (opts.purge === true) await runPurge()
}

/** An integration still on disk whose removal flag the caller did not pass, so uninstall can name it rather than leave it wired in silence. */
interface LeftoverIntegration {
  flag: string
  label: string
}

/** Detects, never removes. Each entry pairs the flag that was not passed with a detector that reads the harness's own config, so a caller who only ever installed the Claude Code hooks sees nothing. */
export function leftoverIntegrations(opts: {
  codex?: boolean
  gemini?: boolean
  qwen?: boolean
  kimi?: boolean
  pi?: boolean
  openclaw?: boolean
  copilot?: boolean
  opencode?: boolean
  grok?: boolean
  antigravity?: boolean
  visualstudio?: boolean
  zed?: boolean
  cursor?: boolean
  jetbrains?: boolean
  neovim?: boolean
}): LeftoverIntegration[] {
  const candidates: Array<{ skipped: boolean; present: () => boolean; flag: string; label: string }> = [
    { skipped: opts.codex !== true, present: isCodexInstalled, flag: '--codex', label: 'Codex CLI integration' },
    { skipped: opts.gemini !== true, present: isGeminiInstalled, flag: '--gemini', label: 'Gemini CLI integration' },
    { skipped: opts.qwen !== true, present: isQwenInstalled, flag: '--qwen', label: 'Qwen Code integration' },
    { skipped: opts.kimi !== true, present: isKimiInstalled, flag: '--kimi', label: 'Kimi Code integration' },
    { skipped: opts.pi !== true, present: () => isPiInstalled() || isPiInstalled({ local: true }), flag: '--pi', label: 'pi extension' },
    { skipped: opts.openclaw !== true, present: isOpenclawInstalled, flag: '--openclaw', label: 'OpenClaw integration' },
    {
      skipped: opts.copilot !== true,
      present: () => isCopilotCliInstalled() || isCopilotCliInstalled({ local: true }),
      flag: '--copilot',
      label: 'Copilot CLI integration',
    },
    { skipped: opts.opencode !== true, present: isOpencodeInstalled, flag: '--opencode', label: 'opencode plugin' },
    { skipped: opts.grok !== true, present: isGrokInstalled, flag: '--grok', label: 'Grok CLI integration' },
    { skipped: opts.antigravity !== true, present: isAntigravityInstalled, flag: '--antigravity', label: 'Antigravity CLI integration' },
    {
      skipped: opts.visualstudio !== true,
      present: () => isVisualStudioInstalled() || isVisualStudioInstalled({ project: true }),
      flag: '--visualstudio',
      label: 'Visual Studio MCP integration',
    },
    { skipped: opts.zed !== true, present: isZedInstalled, flag: '--zed', label: 'Zed MCP context-server integration' },
    {
      skipped: opts.cursor !== true,
      present: () => isCursorInstalled() || isCursorInstalled({ project: true }),
      flag: '--cursor',
      label: 'Cursor MCP integration',
    },
    {
      skipped: opts.jetbrains !== true,
      present: () => isJetbrainsInstalled() || isJetbrainsInstalled({ project: true }),
      flag: '--jetbrains',
      label: 'JetBrains MCP integration',
    },
    {
      skipped: opts.neovim !== true,
      present: () => isNeovimInstalled() || isNeovimInstalled({ project: true }),
      flag: '--neovim',
      label: 'Neovim Lua integration',
    },
  ]
  const found: LeftoverIntegration[] = []
  for (const candidate of candidates) {
    if (!candidate.skipped) continue
    // A detector reads someone else's config file; a malformed one must not abort the uninstall.
    try {
      if (candidate.present()) found.push({ flag: candidate.flag, label: candidate.label })
    } catch {
      // Unreadable config: cannot claim it is installed, and cannot claim it is not. Stay quiet.
    }
  }
  return found
}

/** The destructive half of uninstall, opt-in behind --purge. Refuses while the worker is alive: it would rewrite the pid file and re-open the database under the directory being deleted, so the purge would report success over a directory that grows back. */
async function runPurge(): Promise<void> {
  // A resident hook server holds nothing open between requests, but one mid-request would recreate what this deletes.
  await queryServers('stop')
  if (isWorkerRunning()) {
    err('token-goat: the background worker is running, so --purge would delete files it is about to rewrite. Run "token-goat worker stop" first.')
    return
  }
  const result = purgeDataDirectories()
  for (const root of result.absent) out(`Nothing to purge at ${displaySafePath(root)}.`)
  for (const removed of result.removed) out(`Purged ${displaySafePath(removed.path)} (${formatBytes(removed.bytes)} reclaimed).`)
  // The reason is an OS error string, which quotes the offending path back inside it.
  for (const failure of result.failed) err(`token-goat: could not purge ${displaySafePath(failure.path)}: ${displaySafeText(failure.reason)}`)
}
