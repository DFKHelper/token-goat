/**
 * pre_tool_use hook for the Bash tool.
 *
 * When a build tool command (cargo, go, mvn, make, etc.) is about to run and
 * its output is already cached in the session bash-output store, inject a recall
 * hint so the model can inspect cached output instead of re-running the command.
 */

import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { contextOutput, denyOutput, passOutput } from './hooks_common.js'
import type { HookOutput } from './types.js'
import { getBashOutputId, recordBashOutput } from './session.js'
import { fingerprintContent } from './fingerprint.js'
import { isBuildCommand, getMonitoringRecallHint } from './hints/lang_patterns.js'
import { storeBashOutput, getBashOutput } from './bash_output_cache.js'
import { recordStat } from './stats.js'

/** Extract the command string from a Bash tool_input. */
function extractCommand(event: HookEvent): string | undefined {
  const cmd = event.toolInput['command']
  return typeof cmd === 'string' && cmd.trim() !== '' ? cmd.trim() : undefined
}

/** True when the path is a temp file (not indexed by token-goat). */
function isTempPath(fp: string): boolean {
  const norm = fp.replace(/\\/g, '/')
  return (
    /^\/tmp\//i.test(norm) ||
    /\/var\/folders\//i.test(norm) ||
    /AppData\/Local\/Temp\//i.test(norm) ||
    (norm.startsWith('/c/Users/') && norm.includes('/AppData/Local/Temp/'))
  )
}

/** Extract the source file path from `cat <path>.<ext>`, or null if not that pattern. */
function extractCatSourceFile(cmd: string): string | null {
  const m = /^cat\s+(\S+\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj))\s*$/.exec(cmd)
  return m?.[1] ?? null
}

/** Extracts the file path from a simple `cat <path>` command (quoted or unquoted), returning it and whether it is a doc or env file. Returns null for multi-file cat, piped cat, etc. */
function extractCatFile(cmd: string): { filePath: string; isDoc: boolean; isEnv: boolean } | null {
  const m = /^cat\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd)
  if (!m) return null
  const filePath = m[1] ?? m[2] ?? m[3]
  if (filePath === undefined) return null
  if (isTempPath(filePath)) return null
  const basename = filePath.includes('/') ? filePath.split('/').at(-1)! : filePath.split('\\').at(-1) ?? filePath
  const isEnvFile = /^\.env(\.\w+)?$/i.test(basename)
  const hasKnownExt = /\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties|sql|env)$/i.test(filePath)
  if (!hasKnownExt && !isEnvFile) return null
  const isDoc = /\.(?:md|mdx|rst|txt|sql)$/i.test(filePath)
  const isEnv = isEnvFile || /\.env$/i.test(filePath)
  return { filePath, isDoc, isEnv }
}

/** Returns the file path if the bash command is a Python snippet that reads a known-extension file via open(). Returns null otherwise. */
function extractPythonFileRead(cmd: string): { filePath: string; isDoc: boolean } | null {
  if (!/python3?/.test(cmd)) return null
  const EXT = /\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties)/i
  // Direct: open('path.ext') or open("path.ext")
  const direct = /open\(['"]([^'"]+\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties))['"]/i.exec(cmd)
  if (direct) {
    const filePath = direct[1] ?? ''
    if (!filePath) return null
    const isDoc = /\.(?:md|mdx|rst|txt)$/i.test(filePath)
    return { filePath, isDoc }
  }
  // Indirect: open(var, ...) where a string literal with a known extension appears elsewhere in the cmd
  if (/open\s*\(/.test(cmd)) {
    const literal = /['"]([^'"]+\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties))['"]/i.exec(cmd)
    if (literal) {
      const filePath = literal[1] ?? ''
      if (filePath && EXT.test(filePath)) {
        const isDoc = /\.(?:md|mdx|rst|txt)$/i.test(filePath)
        return { filePath, isDoc }
      }
    }
  }
  return null
}

/** Extracts file path from `head -n X <path>` or `head -X <path>` commands. Returns null for unrecognized patterns or temp files. */
function extractHeadFile(cmd: string): { filePath: string; isDoc: boolean } | null {
  const m = /^head(?:\s+-n\s+\d+|\s+-\d+)?\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd)
  if (!m) return null
  const filePath = m[1] ?? m[2] ?? m[3]
  if (filePath === undefined) return null
  if (isTempPath(filePath)) return null
  if (!/\.(?:ts|tsx|js|jsx|py|go|java|rs|rb|cs|md|mdx|rst|txt|json|yaml|yml|toml|sql|sh)$/i.test(filePath)) return null
  const isDoc = /\.(?:md|mdx|rst|txt|sql)$/i.test(filePath)
  return { filePath, isDoc }
}

/** True when the command is a TypeScript compiler invocation. */
function isTscCommand(cmd: string): boolean {
  return /^\s*tsc(\s|$)/i.test(cmd)
}

/** True when the command is a JS/TS dev server (vite dev, next dev, nuxt dev). */
function isDevServerCommand(cmd: string): boolean {
  return /^\s*(vite\s+dev|next\s+dev|nuxt\s+dev)\b/i.test(cmd)
}

/**
 * Build the recall hint text for a cached build command output.
 *
 * Returns a hint tailored to the command type (tsc, dev server, or generic).
 */
function buildRecallHint(cmd: string, outputId: string): string {
  const cmdPreview = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
  if (isTscCommand(cmd)) {
    return (
      'Output from a prior `' + cmdPreview + '` run is cached. ' +
      'Use `token-goat bash-output ' + outputId + ' --grep "error TS"` to filter TypeScript errors, ' +
      'or `--grep "Cannot find"` for missing module errors.'
    )
  }
  if (isDevServerCommand(cmd)) {
    return (
      'Dev server output cached (`' + cmdPreview + '`). ' +
      'Use `token-goat bash-output ' + outputId + ' --tail 20` to see the latest output, ' +
      'or `--grep "error\\|warn"` to filter issues.'
    )
  }
  return (
    'Output from a prior `' + cmdPreview + '` run is cached. ' +
    'Use `token-goat bash-output ' + outputId + '` (or `--tail 50`, `--grep ERROR`) ' +
    'to re-inspect it without re-running.'
  )
}

/**
 * pre_tool_use handler for the Bash tool.
 *
 * Emits a recall hint when the command is a known build tool and its output
 * was already captured this session. Passes through for all other commands.
 */
export function preBashHandler(event: HookEvent): HookOutput {
  const cmd = extractCommand(event)
  if (cmd === undefined) return passOutput()

  const catResult = extractCatFile(cmd)
  if (catResult !== null) {
    const { filePath, isDoc, isEnv } = catResult
    const hint = isEnv
      ? 'Use `token-goat config-get "' + filePath + '" KEY_NAME` to read a specific variable.'
      : isDoc
        ? 'Use `token-goat section "' + filePath + '::SectionHeading"` to read one section.'
        : 'Use `token-goat read "' + filePath + '::SymbolName"` to read one function or class.'
    recordStat('session_hint', 0, 0)
    return denyOutput('`cat` loads the entire file into context. ' + hint)
  }

  const pyRead = extractPythonFileRead(cmd)
  if (pyRead !== null) {
    const { filePath, isDoc } = pyRead
    const hint = isDoc
      ? 'Use `token-goat section "' + filePath + '::SectionHeading"` to read one section.'
      : 'Use `token-goat read "' + filePath + '::SymbolName"` to extract a specific symbol.'
    recordStat('session_hint', 0, 0)
    return denyOutput('Python `open()` file reads bypass read hooks. ' + hint)
  }

  const headResult = extractHeadFile(cmd)
  if (headResult !== null) {
    const { filePath, isDoc } = headResult
    const hint = isDoc
      ? 'Use `token-goat section "' + filePath + '::SectionHeading"` to read one section.'
      : 'Use `token-goat read "' + filePath + '::SymbolName"` or `token-goat skeleton "' + filePath + '"` to see the file structure.'
    recordStat('session_hint', 0, 0)
    return contextOutput('`head` bypasses read hooks. ' + hint)
  }

  // Monitoring commands: always suggest recall if cached, even on a single prior run.
  const monitoringHint = getMonitoringRecallHint(cmd)
  if (monitoringHint !== null) {
    const monCmdHash = fingerprintContent(cmd).slice(0, 16)
    const monOutputId = getBashOutputId(monCmdHash)
    if (monOutputId !== null) {
      const monEntry = getBashOutput(monOutputId)
      const monBytes = monEntry?.sizeBytes ?? 0
      const catFile = extractCatSourceFile(cmd)
      if (catFile !== null) {
        recordStat('bash_compress:recall', monBytes, Math.round(monBytes / 4))
        return contextOutput(
          'Prior output from `' + cmd + '` is cached. ' +
          'Use `token-goat bash-output ' + monOutputId + '` to recall the full file, or ' +
          '`token-goat read \'' + catFile + '::SymbolName\'` to extract only the symbol you need.'
        )
      }
      const cmdSummary = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
      recordStat('bash_compress:recall', monBytes, Math.round(monBytes / 4))
      return contextOutput(
        'Prior output from `' + cmdSummary + '` is cached.\n' +
        'Use `token-goat bash-output ' + monOutputId + ' ' + monitoringHint + '` to re-inspect without re-running.'
      )
    }
  }

  if (!isBuildCommand(cmd)) return passOutput()

  // Derive the same command hash used by the session store.
  const cmdHash = fingerprintContent(cmd).slice(0, 16)
  const outputId = getBashOutputId(cmdHash)
  if (outputId === null) return passOutput()

  const entry = getBashOutput(outputId)
  const bytes = entry?.sizeBytes ?? 0
  recordStat('bash_compress:recall', bytes, Math.round(bytes / 4))
  return contextOutput(buildRecallHint(cmd, outputId))
}

registerHook('pre_tool_use', preBashHandler, { toolName: 'Bash' })

/** Minimum output size (bytes) worth caching; smaller outputs aren't worth the overhead. */
const MIN_CACHE_BYTES = 512

/**
 * Extract the tool response text from a post_tool_use event.
 * Claude Code may send a string or an object with an output/content field.
 */
function extractBashOutput(raw: Record<string, unknown>): string {
  const resp = raw['tool_response']
  if (typeof resp === 'string') return resp
  if (resp !== null && typeof resp === 'object') {
    const r = resp as Record<string, unknown>
    for (const key of ['output', 'content', 'text', 'body']) {
      if (typeof r[key] === 'string') return r[key] as string
    }
  }
  return ''
}

/**
 * post_tool_use handler for the Bash tool.
 *
 * Caches the output of monitoring and build commands so that `preBashHandler`
 * can emit a recall hint the next time the same command is run, avoiding a
 * redundant re-execution and the token cost of re-reading the output.
 */
export async function postBashHandler(event: HookEvent): Promise<HookOutput> {
  try {
    const cmd = extractCommand(event)
    if (cmd === undefined) return passOutput()

    // Only cache monitoring and build commands — not generic shell commands.
    const isMonitoring = getMonitoringRecallHint(cmd) !== null
    if (!isMonitoring && !isBuildCommand(cmd)) return passOutput()

    const output = extractBashOutput(event.raw)
    if (Buffer.byteLength(output, 'utf-8') < MIN_CACHE_BYTES) return passOutput()

    const cwd = typeof event.raw['cwd'] === 'string' ? event.raw['cwd'] : null
    const simpleHash = fingerprintContent(cmd).slice(0, 16)
    const id = await storeBashOutput(cmd, output, 0, cwd)
    recordBashOutput(simpleHash, id, Buffer.byteLength(output, 'utf-8'))
  } catch {
    // Never block — hook failures must be silent.
  }
  return passOutput()
}

registerHook('post_tool_use', postBashHandler, { toolName: 'Bash' })
