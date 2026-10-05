/** Harness hook repairs for `token-goat doctor --repair` and `token-goat install`. Inspects all coding agent harnesses supported by token-goat (Claude Code, Copilot CLI, Codex, Grok, Kimi, Gemini, Qwen, Opencode, OpenClaw, Pi, Antigravity). For any harness that is already installed on the current machine or in the current project, checks if its hook shim script, config, or command entries are stale or outdated compared to the running build, and rewrites them in-place. */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { extractErrorMessage } from './util.js'
import { claudeHookScriptPath, hookEventGaps, installHooks, isInstalled, type HookEventGaps } from './install.js'
import { CLAUDECODE_HOOK_SCRIPT } from './bridges/claudecode.js'
import {
  copilotCliConfigPath,
  copilotCliScriptPath,
  installCopilotCli,
  isCopilotCliInstalled,
  wiredCopilotHookWords,
} from './bridges/copilot_cli_install.js'
import { COPILOT_CLI_HOOK_SCRIPT } from './bridges/copilot_cli.js'
import {
  codexConfigPath,
  codexHookScriptPath,
  installCodex,
  isCodexInstalled,
  wiredCodexHookWords,
} from './bridges/codex_install.js'
import { CODEX_HOOK_SCRIPT } from './bridges/codex.js'
import {
  grokConfigPath,
  grokHookScriptPath,
  installGrok,
  isGrokInstalled,
  wiredGrokHookWords,
} from './bridges/grok_install.js'
import { GROK_HOOK_SCRIPT } from './bridges/grok.js'
import {
  installKimi,
  isKimiInstalled,
  kimiConfigPath,
  kimiHookScriptPath,
  wiredKimiHookWords,
} from './bridges/kimi_install.js'
import { installGemini, isGeminiInstalled } from './bridges/gemini_install.js'
import { installQwen, isQwenInstalled } from './bridges/qwen_install.js'
import { installOpencode, isOpencodeInstalled } from './bridges/opencode_install.js'
import { installOpenclaw, isOpenclawInstalled } from './bridges/openclaw_install.js'
import { installPi, isPiInstalled } from './bridges/pi_install.js'
import { installAntigravity, isAntigravityInstalled } from './bridges/antigravity_install.js'
import { disableVscodeClaudeHooks, vscodeHooksInstalled, vscodeUsesClaudeHooks } from './bridges/vscode_install.js'

export function shimIsCurrent(scriptPath: string, expected: string): boolean {
  try {
    return fs.readFileSync(scriptPath, 'utf-8').replace(/\r\n/g, '\n') === expected.replace(/\r\n/g, '\n')
  } catch {
    return false
  }
}

/** Whether a scope's wiring needs rewriting. A fully wired scope still returns an object with three empty lists, so a non-null result alone is not a gap; null means the scope wires no token-goat hook, which is not ours to add. */
function hasHookEventGaps(gaps: HookEventGaps | null): boolean {
  return gaps !== null && (gaps.missing.length > 0 || gaps.outdated.length > 0 || gaps.broken.length > 0)
}

export interface HarnessRepairResult {
  repairs: string[]
  errors: string[]
}

/** Auto-repairs stale hook shims, missing hook events, or outdated hook invocations across all coding agent harnesses currently installed on this machine or in this project. */
export function repairHarnessHooks(rootDir: string = process.cwd()): HarnessRepairResult {
  const repairs: string[] = []
  const errors: string[] = []
  const projectRoot = path.resolve(rootDir ?? process.cwd())

  // 1. Claude Code (user scope)
  try {
    const userShim = claudeHookScriptPath()
    const userInstalled = isInstalled('user') || fs.existsSync(userShim)
    if (userInstalled) {
      const isStaleShim = fs.existsSync(userShim) && !shimIsCurrent(userShim, CLAUDECODE_HOOK_SCRIPT)
      // hookEventGaps compares each entry with the one this build writes, so it also catches an entry left by an older build.
      if (isStaleShim || hasHookEventGaps(hookEventGaps('user'))) {
        installHooks('user')
        repairs.push('Repaired Claude Code (user) hooks and shim')
      }
    }
  } catch (e) {
    errors.push(`Failed to repair Claude Code (user) hooks: ${extractErrorMessage(e)}`)
  }

  // 2. Claude Code (project scope)
  try {
    const projShim = claudeHookScriptPath()
    const projInstalled = isInstalled('project')
    if (projInstalled) {
      const isStaleShim = fs.existsSync(projShim) && !shimIsCurrent(projShim, CLAUDECODE_HOOK_SCRIPT)
      if (isStaleShim || hasHookEventGaps(hookEventGaps('project'))) {
        installHooks('project')
        repairs.push('Repaired Claude Code (project) hooks and shim')
      }
    }
  } catch (e) {
    errors.push(`Failed to repair Claude Code (project) hooks: ${extractErrorMessage(e)}`)
  }

  // 3. Copilot CLI (user scope)
  try {
    const userShim = copilotCliScriptPath()
    const userConfig = copilotCliConfigPath()
    const userInstalled = isCopilotCliInstalled() || fs.existsSync(userConfig) || fs.existsSync(userShim)
    if (userInstalled) {
      const isStaleShim = fs.existsSync(userShim) && !shimIsCurrent(userShim, COPILOT_CLI_HOOK_SCRIPT)
      const hasOutdatedEntries = wiredCopilotHookWords().some((e) => e.current === false)
      if (isStaleShim || hasOutdatedEntries) {
        installCopilotCli()
        repairs.push('Repaired Copilot CLI (user) hooks and shim')
      }
    }
  } catch (e) {
    errors.push(`Failed to repair Copilot CLI (user) hooks: ${extractErrorMessage(e)}`)
  }

  // 4. Copilot CLI (project scope)
  try {
    const copilotLocalOpts = { local: true, projectRoot }
    const projShim = copilotCliScriptPath(copilotLocalOpts)
    const projConfig = copilotCliConfigPath(copilotLocalOpts)
    const projInstalled = isCopilotCliInstalled(copilotLocalOpts) || fs.existsSync(projConfig) || fs.existsSync(projShim)
    if (projInstalled) {
      const isStaleShim = fs.existsSync(projShim) && !shimIsCurrent(projShim, COPILOT_CLI_HOOK_SCRIPT)
      const hasOutdatedEntries = wiredCopilotHookWords(copilotLocalOpts).some((e) => e.current === false)
      if (isStaleShim || hasOutdatedEntries) {
        installCopilotCli(copilotLocalOpts)
        repairs.push('Repaired Copilot CLI (project) hooks and shim')
      }
    }
  } catch (e) {
    errors.push(`Failed to repair Copilot CLI (project) hooks: ${extractErrorMessage(e)}`)
  }

  // 5. Codex
  try {
    const codexShim = codexHookScriptPath()
    const codexCfg = codexConfigPath()
    const codexInstalled = isCodexInstalled() || fs.existsSync(codexCfg) || fs.existsSync(codexShim)
    if (codexInstalled) {
      const isStaleShim = fs.existsSync(codexShim) && !shimIsCurrent(codexShim, CODEX_HOOK_SCRIPT)
      const hasOutdatedEntries = wiredCodexHookWords().some((e) => e.current === false)
      if (isStaleShim || hasOutdatedEntries) {
        installCodex()
        repairs.push('Repaired Codex CLI hooks and shim')
      }
    }
  } catch (e) {
    errors.push(`Failed to repair Codex CLI hooks: ${extractErrorMessage(e)}`)
  }

  // 6. Grok CLI
  try {
    const grokShim = grokHookScriptPath()
    const grokCfg = grokConfigPath()
    const grokInstalled = isGrokInstalled() || fs.existsSync(grokCfg) || fs.existsSync(grokShim)
    if (grokInstalled) {
      const isStaleShim = fs.existsSync(grokShim) && !shimIsCurrent(grokShim, GROK_HOOK_SCRIPT)
      const hasOutdatedEntries = wiredGrokHookWords().some((e) => e.current === false)
      if (isStaleShim || hasOutdatedEntries) {
        installGrok()
        repairs.push('Repaired Grok CLI hooks and shim')
      }
    }
  } catch (e) {
    errors.push(`Failed to repair Grok CLI hooks: ${extractErrorMessage(e)}`)
  }

  // 7. Kimi Code
  try {
    const kimiShim = kimiHookScriptPath()
    const kimiCfg = kimiConfigPath()
    const kimiInstalled = isKimiInstalled() || fs.existsSync(kimiCfg) || fs.existsSync(kimiShim)
    if (kimiInstalled) {
      const hasOutdatedEntries = wiredKimiHookWords().some((e) => e.current === false)
      if (hasOutdatedEntries || (fs.existsSync(kimiShim) && fs.statSync(kimiShim).size === 0)) {
        installKimi()
        repairs.push('Repaired Kimi Code hooks and shim')
      }
    }
  } catch (e) {
    errors.push(`Failed to repair Kimi Code hooks: ${extractErrorMessage(e)}`)
  }

  // 8. Gemini CLI
  try {
    if (isGeminiInstalled()) {
      const res = installGemini()
      if (!res.alreadyInstalled) repairs.push('Repaired Gemini CLI hooks')
    }
  } catch (e) {
    errors.push(`Failed to repair Gemini CLI hooks: ${extractErrorMessage(e)}`)
  }

  // 9. Qwen Code
  try {
    if (isQwenInstalled()) {
      const res = installQwen()
      if (!res.alreadyInstalled) repairs.push('Repaired Qwen Code hooks')
    }
  } catch (e) {
    errors.push(`Failed to repair Qwen Code hooks: ${extractErrorMessage(e)}`)
  }

  // 10. Opencode
  try {
    if (isOpencodeInstalled()) {
      const res = installOpencode()
      if (!res.alreadyInstalled) repairs.push('Repaired opencode plugin')
    }
  } catch (e) {
    errors.push(`Failed to repair opencode plugin: ${extractErrorMessage(e)}`)
  }

  // 11. OpenClaw
  try {
    if (isOpenclawInstalled()) {
      const res = installOpenclaw()
      if (!res.alreadyInstalled) repairs.push('Repaired OpenClaw plugin')
    }
  } catch (e) {
    errors.push(`Failed to repair OpenClaw plugin: ${extractErrorMessage(e)}`)
  }

  // 12. Pi
  try {
    if (isPiInstalled()) {
      const res = installPi()
      if (!res.alreadyInstalled) repairs.push('Repaired pi extension')
    } else if (isPiInstalled({ local: true })) {
      const res = installPi({ local: true })
      if (!res.alreadyInstalled) repairs.push('Repaired pi (project) extension')
    }
  } catch (e) {
    errors.push(`Failed to repair pi extension: ${extractErrorMessage(e)}`)
  }

  // 13. Antigravity CLI
  try {
    if (isAntigravityInstalled()) {
      const res = installAntigravity()
      if (!res.alreadyInstalled) repairs.push('Repaired Antigravity CLI integration')
    }
  } catch (e) {
    errors.push(`Failed to repair Antigravity CLI integration: ${extractErrorMessage(e)}`)
  }

  // 14. VS Code chat.useClaudeHooks duplicate conflict
  try {
    if (vscodeUsesClaudeHooks() && (vscodeHooksInstalled() || vscodeHooksInstalled({ project: true, projectRoot }))) {
      if (disableVscodeClaudeHooks()) {
        repairs.push('Disabled VS Code chat.useClaudeHooks in VS Code settings to prevent duplicate hook execution')
      }
    }
  } catch (e) {
    errors.push(`Failed to repair VS Code chat.useClaudeHooks: ${extractErrorMessage(e)}`)
  }

  return { repairs, errors }
}
