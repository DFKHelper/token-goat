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
import { shortFingerprint } from './fingerprint.js'
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

/** True for ephemeral orchestration state files (improve-skill state, etc.) that are not source files. */
function isOrchestratorStateFile(filePath: string): boolean {
  const basename = (filePath.includes('/') ? filePath.split('/').at(-1) : filePath.split('\\').at(-1)) ?? filePath
  return /^\.improve-state-/.test(basename)
}

/** Extract the source file path from `cat <path>.<ext>`, or null if not that pattern. */
function extractCatSourceFile(cmd: string): string | null {
  const m = /^cat\s+(\S+\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|css|scss|sass|less))\s*$/.exec(cmd)
  return m?.[1] ?? null
}

/** Extracts the file path from a simple `cat [flags] <path>` command (quoted or unquoted), returning it and whether it is a doc, env, or config file. Returns null for multi-file cat, piped cat, etc. */
function extractCatFile(cmd: string): { filePath: string; isDoc: boolean; isEnv: boolean; isConfig: boolean } | null {
  const m = /^cat(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+))*\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd)
  if (!m) return null
  const filePath = m[1] ?? m[2] ?? m[3]
  if (filePath === undefined) return null
  if (isTempPath(filePath)) return null
  const basename = (filePath.includes('/') ? filePath.split('/').at(-1) : filePath.split('\\').at(-1)) ?? filePath
  const isEnvFile = /^\.env(\.\w+)?$/i.test(basename)
  const hasKnownExt = /\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|css|scss|sass|less|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties|sql|env)$/i.test(filePath)
  if (!hasKnownExt && !isEnvFile) return null
  const isDoc = /\.(?:md|mdx|rst|txt|sql)$/i.test(filePath)
  const isEnv = isEnvFile || /\.env$/i.test(filePath)
  const isConfig = /\.(?:json|yaml|yml|toml|conf|cfg|ini|properties)$/i.test(filePath)
  return { filePath, isDoc, isEnv, isConfig }
}

/** Extracts the file path from a WSL-proxied cat command like `wsl bash -c "cat /mnt/c/..."` or `wsl -d Ubuntu bash -c "cat /mnt/c/..."`. Converts /mnt/X/ paths to X:/ and applies the same filtering as extractCatFile. */
function extractWslCatFile(cmd: string): { filePath: string; isDoc: boolean; isEnv: boolean; isConfig: boolean } | null {
  // Match: wsl [optional -d DISTRO] bash -c "cat [flags] /mnt/X/..."
  const wslMatch = /^wsl(?:\s+-d\s+\S+)?\s+bash\s+-c\s+"cat(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+))*\s+\/mnt\/([a-z])\/([^"]*)"/.exec(cmd)
  if (!wslMatch) return null
  const drive = wslMatch[1]?.toUpperCase()
  const pathRest = wslMatch[2]
  if (!drive || !pathRest) return null
  const filePath = drive + ':/' + pathRest
  if (isTempPath(filePath)) return null
  const basename = (filePath.includes('/') ? filePath.split('/').at(-1) : filePath.split('\\').at(-1)) ?? filePath
  const isEnvFile = /^\.env(\.\w+)?$/i.test(basename)
  const hasKnownExt = /\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|css|scss|sass|less|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties|sql|env)$/i.test(filePath)
  if (!hasKnownExt && !isEnvFile) return null
  const isDoc = /\.(?:md|mdx|rst|txt|sql)$/i.test(filePath)
  const isEnv = isEnvFile || /\.env$/i.test(filePath)
  const isConfig = /\.(?:json|yaml|yml|toml|conf|cfg|ini|properties)$/i.test(filePath)
  return { filePath, isDoc, isEnv, isConfig }
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
    if (isOrchestratorStateFile(filePath)) return null
    const isDoc = /\.(?:md|mdx|rst|txt)$/i.test(filePath)
    return { filePath, isDoc }
  }
  // Indirect: open(var, ...) where a string literal with a known extension appears elsewhere in the cmd
  if (/open\s*\(/.test(cmd)) {
    const literal = /['"]([^'"]+\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties))['"]/i.exec(cmd)
    if (literal) {
      const filePath = literal[1] ?? ''
      if (filePath) {
        if (isOrchestratorStateFile(filePath)) return null
        if (EXT.test(filePath)) {
          const isDoc = /\.(?:md|mdx|rst|txt)$/i.test(filePath)
          return { filePath, isDoc }
        }
      }
    }
  }
  return null
}

/** Extracts file path from `head -n X <path>` or `head -X <path>` commands. Returns null for unrecognized patterns or temp files. Also checks N < 10 (already surgical). */
function extractHeadFile(cmd: string): { filePath: string; isDoc: boolean; isConfig: boolean } | null {
  const m = /^head(?:\s+-n\s+(\d+)|\s+-(\d+))?\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd)
  if (!m) return null
  const n = parseInt(m[1] ?? m[2] ?? '0', 10)
  if (n < 10) return null // already surgical, no need to advise (0 means default 10 lines, 1-9 also surgical)
  const filePath = m[3] ?? m[4] ?? m[5]
  if (filePath === undefined) return null
  if (isTempPath(filePath)) return null
  if (!/\.(?:ts|tsx|js|jsx|py|go|java|rs|rb|cs|md|mdx|rst|txt|json|yaml|yml|toml|sql|sh)$/i.test(filePath)) return null
  const isDoc = /\.(?:md|mdx|rst|txt|sql)$/i.test(filePath)
  const isConfig = /\.(?:json|yaml|yml|toml|conf|cfg|ini|properties)$/i.test(filePath)
  return { filePath, isDoc, isConfig }
}

/** Extracts file path from `node -e "fs.readFileSync(...)"` patterns. Returns null if not this pattern or if temp file. */
function extractNodeFileRead(cmd: string): { filePath: string; isDoc: boolean } | null {
  if (!/^node\s+-e/.test(cmd)) return null
  const m = /readFileSync\(['"]([^'"]+\.(?:ts|tsx|js|jsx|py|go|java|rs|rb|cs|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties|sql))['"]/i.exec(cmd)
  if (!m || !m[1]) return null
  const filePath = m[1]
  if (isOrchestratorStateFile(filePath)) return null
  if (isTempPath(filePath)) return null
  const isDoc = /\.(?:md|mdx|rst|txt|sql)$/i.test(filePath)
  return { filePath, isDoc }
}

/** Extracts file path from `tail -n X <path>` or `tail -X <path>` commands on source files. Excludes -f (follow), -c (byte mode), and +N (offset). */
function extractTailFile(cmd: string): { filePath: string; isDoc: boolean } | null {
  if (/-f\b/.test(cmd)) return null // follow mode — legitimate streaming
  if (/-c\b/.test(cmd)) return null // byte mode
  if (/-n\s*\+/.test(cmd)) return null // tail from line N offset — legitimate
  const m = /^tail(?:\s+-n\s+(\d+)|\s+-(\d+))?\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd)
  if (!m) return null
  const n = parseInt(m[1] ?? m[2] ?? '0', 10)
  if (n <= 10) return null // already surgical
  const filePath = m[3] ?? m[4] ?? m[5]
  if (!filePath) return null
  if (isTempPath(filePath)) return null
  if (!/\.(?:ts|tsx|js|jsx|py|go|java|rs|rb|cs|md|mdx|rst|txt|json|yaml|yml|toml|sql|sh)$/i.test(filePath)) return null
  const isDoc = /\.(?:md|mdx|rst|txt|sql)$/i.test(filePath)
  return { filePath, isDoc }
}

/**
 * Detects `cat` or `tail` commands on a tasks output path and returns the task
 * ID so the caller can emit a `token-goat bash-output` recall hint.
 *
 * Tasks output files follow the pattern `…/tasks/<id>.output`. They are
 * already cached by the bash-output cache so re-reading via cat/tail wastes
 * tokens that `token-goat bash-output` returns surgically.
 */
function extractTasksOutput(cmd: string): { id: string; n?: number } | null {
  const taskOutputRe = /[/\\]tasks[/\\]([a-z0-9]+)\.output$/

  // cat command (same regex structure as extractCatFile, checked before isTempPath)
  const catM = /^cat(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+))*\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd)
  if (catM) {
    const fp = catM[1] ?? catM[2] ?? catM[3]
    if (fp) {
      const m = taskOutputRe.exec(fp)
      if (m) return { id: m[1]! }
    }
  }

  // tail command — handles -n (line-count) and -c (byte-count) modes; excludes -f follow and +N offset
  if (!/-f\b/.test(cmd) && !/-n\s*\+/.test(cmd)) {
    // Standard line-count tail: -n N or -N or no count
    const tailM = /^tail(?:\s+-n\s+(\d+)|\s+-(\d+))?\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd)
    if (tailM) {
      const fp = tailM[3] ?? tailM[4] ?? tailM[5]
      if (fp) {
        const m = taskOutputRe.exec(fp)
        if (m) {
          const nStr = tailM[1] ?? tailM[2]
          const n = nStr !== undefined ? parseInt(nStr, 10) : undefined
          return n !== undefined ? { id: m[1]!, n } : { id: m[1]! }
        }
      }
    }
    // Byte-mode tail: -c N (common in session mining: `tail -c 1500 <id>.output`)
    const byteTailM = /^tail\s+-c\s+\d+\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd)
    if (byteTailM) {
      const fp = byteTailM[1] ?? byteTailM[2] ?? byteTailM[3]
      if (fp) {
        const m = taskOutputRe.exec(fp)
        if (m) return { id: m[1]! }
      }
    }
  }

  return null
}

/**
 * Returns true when the command is a sed line-range extraction (`sed -n 'N,Mp'`).
 * These are typically used as a substitute for `token-goat section`, which is cheaper.
 */
function extractSedLineRange(cmd: string): boolean {
  return /^sed\s+-n\s+['"]?\d+,\d+p['"]?/.test(cmd)
}

/**
 * Returns true when the command is a directory listing (eza --long or ls … | head)
 * for which `token-goat map --compact` is a cheaper alternative.
 */
function extractDirectoryListing(cmd: string): boolean {
  return (
    /^eza\s+.*--long\s+\S+/.test(cmd) ||
    /^ls\s+(?:-[la]+\s+)?(\S+)\s*[|]\s*head/.test(cmd)
  )
}

/**
 * Returns a parsed find command descriptor when the command is a `find` invocation.
 * - `extGlob`: the glob pattern from `-name "*.ext"`, or null when absent.
 * - `isXargsGrepL`: true when the pipeline ends with `| xargs grep -l` (symbol search anti-pattern).
 * Returns null when the command does not start with `find`.
 */
function extractFindCommand(cmd: string): { extGlob: string | null; isXargsGrepL: boolean } | null {
  if (!/^find\b/.test(cmd)) return null
  const isXargsGrepL = /[|]\s*xargs\s+(?:grep|rg)\s+.*-l\b/.test(cmd) || /[|]\s*xargs\s+grep\s+-l\b/.test(cmd)
  const nameMatch = /-name\s+['"]([^'"]+)['"]/i.exec(cmd)
  const extGlob = nameMatch ? (nameMatch[1] ?? null) : null
  return { extGlob, isXargsGrepL }
}

/**
 * Returns the file path when the command is an rg/grep structural definition search
 * on a single source file. Structural patterns are those that find function/class/import
 * definitions (^def, ^class, ^function, ^import, etc.) — the common "show me the structure
 * of this file" idiom that token-goat skeleton does better.
 */
function extractRgStructuralSearch(cmd: string): { filePath: string } | null {
  if (!/^(?:rg|grep)\s+/.test(cmd)) return null

  // Must be a structural/definition search pattern (including indented Python methods)
  const hasStructural = (
    /["']?\^?(?:def\s|class\s|function\s|func\s|fn\s|pub fn\s|import\s|from\s)/.test(cmd) ||
    /["']\^(?:def|class|function|func|import|from)["']/.test(cmd) ||
    /\\bdef\\b|\\bclass\\b/.test(cmd) ||
    /["']?\^[ \t]+def\b/.test(cmd)
  )
  if (!hasStructural) return null

  // Must end with a single source file (has a known code extension) — not a directory
  const fileMatch = /(?:^|\s)(?:"([^"]+\.(?:py|ts|tsx|js|jsx|go|rs|rb|cs|java|cpp|cc|cxx|c|h|sh|bash))"|('([^']+\.(?:py|ts|tsx|js|jsx|go|rs|rb|cs|java|cpp|cc|cxx|c|h|sh|bash))')|([^\s"']+\.(?:py|ts|tsx|js|jsx|go|rs|rb|cs|java|cpp|cc|cxx|c|h|sh|bash)))\s*$/.exec(cmd)
  if (!fileMatch) return null

  const filePath = fileMatch[1] ?? fileMatch[3] ?? fileMatch[4]
  if (!filePath) return null
  if (isTempPath(filePath)) return null

  return { filePath }
}

/**
 * Returns true when the command is a `curl` GET request whose response is safe
 * to cache (no -X POST/PUT/PATCH/DELETE, no request body flags, no auth credentials).
 */
function isCurlGetCommand(cmd: string): boolean {
  if (!/^curl\b/.test(cmd)) return false
  // Explicit non-GET method
  if (/-X\s+(?:POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/i.test(cmd)) return false
  if (/--request\s+(?:POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/i.test(cmd)) return false
  // Request body (implies non-GET)
  if (/\s(?:-d|--data(?:-raw|-binary|-urlencode)?|-F|--form)\b/.test(cmd)) return false
  // Auth credentials — skip caching to avoid leaking tokens into the output store
  if (/\s(?:-u|--user)\b/.test(cmd)) return false
  if (/-H\s+['"]?Authorization/i.test(cmd)) return false
  return true
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

  // Item 3: task output file — already cached, recall with bash-output
  const taskOutput = extractTasksOutput(cmd)
  if (taskOutput !== null) {
    const { id } = taskOutput
    recordStat('session_hint', 0, 0)
    return denyOutput(
      'Use `token-goat bash-output ' + id + '` to recall this task output (already cached). ' +
      'Append `--tail <n>` or `--grep PATTERN` to slice it.',
    )
  }

  // find interception — fd is faster and .gitignore-aware; xargs grep -l is a symbol-search anti-pattern
  const findResult = extractFindCommand(cmd)
  if (findResult !== null) {
    const { extGlob, isXargsGrepL } = findResult
    recordStat('session_hint', 0, 0)
    if (isXargsGrepL) {
      return denyOutput(
        '`find | xargs grep -l` is a slow symbol search. ' +
        'Use `token-goat refs <symbol>` or `rg -l <symbol>` for faster symbol-file discovery.',
      )
    }
    const fdHint = extGlob
      ? 'Use `fd \'' + extGlob + '\'` for faster file discovery (respects .gitignore).'
      : 'Use `fd` for faster file discovery (respects .gitignore).'
    return contextOutput(
      '`find` is slow and ignores .gitignore. ' + fdHint +
      ' For symbol definitions, use `token-goat symbol <Name>`.',
    )
  }

  // Item 7: directory listing — token-goat map is cheaper
  if (extractDirectoryListing(cmd)) {
    recordStat('session_hint', 0, 0)
    return contextOutput(
      'Use `token-goat map --compact` (~300 tokens) for a repo overview, or `token-goat map <dir>` for a subdirectory.',
    )
  }

  // Item 4b: sed line-range extraction
  if (extractSedLineRange(cmd)) {
    recordStat('session_hint', 0, 0)
    return contextOutput(
      'Use `token-goat section "<file>::HeadingName"` to read one section instead of a line range.',
    )
  }

  const catResult = extractCatFile(cmd)
  if (catResult !== null) {
    const { filePath, isDoc, isEnv, isConfig } = catResult
    const hint = isEnv
      ? 'Use `token-goat config-get "' + filePath + '" KEY_NAME` to read a specific variable.'
      : isConfig
        ? 'Use `token-goat config-get "' + filePath + '" KEY_NAME` or `token-goat section "' + filePath + '::sectionName"` to read a specific value.'
        : isDoc
          ? 'Use `token-goat section "' + filePath + '::SectionHeading"` to read one section.'
          : 'Use `token-goat read "' + filePath + '::SymbolName"` to read one function or class.'
    recordStat('session_hint', 0, 0)
    return denyOutput('`cat` loads the entire file into context. ' + hint)
  }

  const wslCatResult = extractWslCatFile(cmd)
  if (wslCatResult !== null) {
    const { filePath, isDoc, isEnv, isConfig } = wslCatResult
    const hint = isEnv
      ? 'Use `token-goat config-get "' + filePath + '" KEY_NAME` to read a specific variable.'
      : isConfig
        ? 'Use `token-goat config-get "' + filePath + '" KEY_NAME` or `token-goat section "' + filePath + '::sectionName"` to read a specific value.'
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

  const tailResult = extractTailFile(cmd)
  if (tailResult !== null) {
    const { filePath, isDoc } = tailResult
    const hint = isDoc
      ? 'Use `token-goat section "' + filePath + '::SectionHeading"` to read one section.'
      : 'Use `token-goat read "' + filePath + '::SymbolName"` or `token-goat skeleton "' + filePath + '"` to see the file structure.'
    recordStat('session_hint', 0, 0)
    return contextOutput('`tail` bypasses read hooks. ' + hint)
  }

  const headResult = extractHeadFile(cmd)
  if (headResult !== null) {
    const { filePath, isDoc, isConfig } = headResult
    const hint = isConfig
      ? 'Use `token-goat config-get "' + filePath + '" KEY_NAME` or `token-goat section "' + filePath + '::sectionName"` to read a specific value.'
      : isDoc
        ? 'Use `token-goat section "' + filePath + '::SectionHeading"` to read one section.'
        : 'Use `token-goat read "' + filePath + '::SymbolName"` or `token-goat skeleton "' + filePath + '"` to see the file structure.'
    recordStat('session_hint', 0, 0)
    return contextOutput('`head` bypasses read hooks. ' + hint)
  }

  const nodeRead = extractNodeFileRead(cmd)
  if (nodeRead !== null) {
    const { filePath, isDoc } = nodeRead
    const hint = isDoc
      ? 'Use `token-goat section "' + filePath + '::SectionHeading"` to read one section.'
      : 'Use `token-goat read "' + filePath + '::SymbolName"` to extract a specific symbol.'
    recordStat('session_hint', 0, 0)
    return denyOutput('Node.js `fs.readFileSync()` bypasses read hooks. ' + hint)
  }

  const rgStructural = extractRgStructuralSearch(cmd)
  if (rgStructural !== null) {
    const { filePath } = rgStructural
    recordStat('session_hint', 0, 0)
    return contextOutput(
      'Searching for code definitions with `rg`/`grep` is slower than surgical reads. ' +
      'Use `token-goat skeleton "' + filePath + '"` to see all symbols with line numbers, ' +
      'or `token-goat outline "' + filePath + '"` for symbols with docstrings and line ranges.'
    )
  }

  // Monitoring commands: always suggest recall if cached, even on a single prior run.
  const monitoringHint = getMonitoringRecallHint(cmd)
  if (monitoringHint !== null) {
    const monCmdHash = shortFingerprint(cmd)
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

  // curl GET recall — emit a hint when the same URL was already fetched this session
  if (isCurlGetCommand(cmd)) {
    const curlHash = shortFingerprint(cmd)
    const curlOutputId = getBashOutputId(curlHash)
    if (curlOutputId !== null) {
      const curlEntry = getBashOutput(curlOutputId)
      const curlBytes = curlEntry?.sizeBytes ?? 0
      recordStat('bash_compress:recall', curlBytes, Math.round(curlBytes / 4))
      const curlPreview = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
      return contextOutput(
        'curl response cached (`' + curlPreview + '`). ' +
        'Use `token-goat bash-output ' + curlOutputId + '` to recall it. ' +
        'Append `--grep PATTERN` to filter or `--section HeadingName` for a markdown section.',
      )
    }
  }

  if (!isBuildCommand(cmd)) return passOutput()

  // Derive the same command hash used by the session store.
  const cmdHash = shortFingerprint(cmd)
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

    // Only cache monitoring, build, and curl GET commands — not generic shell commands.
    const isMonitoring = getMonitoringRecallHint(cmd) !== null
    if (!isMonitoring && !isBuildCommand(cmd) && !isCurlGetCommand(cmd)) return passOutput()

    const output = extractBashOutput(event.raw)
    if (Buffer.byteLength(output, 'utf-8') < MIN_CACHE_BYTES) return passOutput()

    const cwd = typeof event.raw['cwd'] === 'string' ? event.raw['cwd'] : null
    const simpleHash = shortFingerprint(cmd)
    const id = await storeBashOutput(cmd, output, 0, cwd)
    recordBashOutput(simpleHash, id, Buffer.byteLength(output, 'utf-8'))
  } catch {
    // Never block — hook failures must be silent.
  }
  return passOutput()
}

registerHook('post_tool_use', postBashHandler, { toolName: 'Bash' })
