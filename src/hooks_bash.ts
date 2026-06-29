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
import { getBashOutputId, recordBashOutput, recordCurlDownload, getCurlDownloadPath } from './session.js'
import { shortFingerprint } from './fingerprint.js'
import { isBuildCommand, getMonitoringRecallHint } from './hints/lang_patterns.js'
import { storeBashOutput, getBashOutput } from './bash_output_cache.js'
import { recordStat } from './stats.js'

/** Strip one or more `cd <dir> &&` prefixes so interceptors match the actual command. */
function stripCdPrefix(cmd: string): string {
  // Handles: `cd /path && CMD`, `cd "path with spaces" && CMD`, `cd 'path' && CMD`
  const stripped = cmd.replace(/^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/, '')
  return stripped.trim() || cmd
}

/**
 * Strips a command's downstream pipeline and trailing redirections, returning the
 * base command. Used to key the bash-output cache so that the same build/test
 * command run with different downstream filters (`| tail -40` vs `| grep ERROR`)
 * or redirects (`2>&1`) shares a single cache entry — mirroring how curl GET
 * commands are keyed on their URL.
 *
 * Splits on the first top-level pipe operator (`|`), ignoring `|` inside single
 * or double quotes and the `||` logical-OR operator, then removes trailing stream
 * redirections (`2>&1`, `>/dev/null`, `2> file`, `&> file`, etc.).
 */
function stripOutputPipeline(cmd: string): string {
  let inSingle = false
  let inDouble = false
  let cut = cmd.length
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (ch === '|' && !inSingle && !inDouble) {
      if (cmd[i + 1] === '|') {
        i++ // skip the `||` logical-OR operator; keep scanning
        continue
      }
      cut = i // first real pipe operator — base command ends here
      break
    }
  }
  let base = cmd.slice(0, cut)
  // Strip trailing stream redirections (possibly chained), honoring quotes.
  // Mask quoted content with same-length spaces so the redirect regex cannot
  // match characters inside a string literal (e.g. 'pytest -k "value > 0"').
  // String length is preserved, so slicing back to newMasked.length is exact.
  let prev: string
  do {
    prev = base
    const masked = base
      .replace(/"((?:[^"\\]|\\.)*)"/g, (_m, inner: string) => '"' + ' '.repeat(inner.length) + '"')
      .replace(/'([^']*)'/g, (_m, inner: string) => "'" + ' '.repeat(inner.length) + "'")
    const newMasked = masked.replace(/\s*(?:[0-9]*>&[0-9]+|[0-9&]*>>?\s*(?:"[^"]*"|'[^']*'|[^\s|]+))\s*$/, '')
    if (newMasked.length < masked.length) {
      base = base.slice(0, newMasked.length)
    }
  } while (base !== prev)
  return base.trim()
}

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

/** Extracts the file path from a simple `cat [flags] <path>` command (quoted or unquoted), returning it and whether it is a doc, env, config, or sql file. Returns null for multi-file cat, piped cat, etc. */
function extractCatFile(cmd: string): { filePath: string; isDoc: boolean; isEnv: boolean; isConfig: boolean; isSql: boolean } | null {
  const m = /^cat(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+))*\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd)
  if (!m) return null
  const filePath = m[1] ?? m[2] ?? m[3]
  if (filePath === undefined) return null
  if (isTempPath(filePath)) return null
  const basename = (filePath.includes('/') ? filePath.split('/').at(-1) : filePath.split('\\').at(-1)) ?? filePath
  const isEnvFile = /^\.env(\.\w+)?$/i.test(basename)
  const hasKnownExt = /\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|css|scss|sass|less|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties|sql|env)$/i.test(filePath)
  if (!hasKnownExt && !isEnvFile) return null
  const isSql = /\.sql$/i.test(filePath)
  const isDoc = /\.(?:md|mdx|rst|txt)$/i.test(filePath)
  const isEnv = isEnvFile || /\.env$/i.test(filePath)
  const isConfig = /\.(?:json|yaml|yml|toml|conf|cfg|ini|properties)$/i.test(filePath)
  return { filePath, isDoc, isEnv, isConfig, isSql }
}

/**
 * Returns identifier info when command is `rg`/`grep` with `-n` flag targeting a pure identifier
 * (or `|`-joined identifiers) against exactly one source file. Used to suggest
 * `token-goat symbol` as a cheaper alternative to scanning the file.
 */
export function extractRgSymbolSearch(cmd: string): { filePath: string; identifier: string } | null {
  if (!/^(?:rg|grep)\s+/.test(cmd)) return null
  if (!/-n\b/.test(cmd)) return null

  // Extract the quoted or unquoted pattern (first string-like argument)
  const patternMatch = /["']([^"']+)["']/.exec(cmd)
  const pattern = patternMatch?.[1]
  if (!pattern) return null

  // Validate: pure identifier or |-joined identifiers only — no regex metacharacters
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\|[A-Za-z_][A-Za-z0-9_]*)*$/.test(pattern)) return null

  // Must target exactly one file with a known source extension (not a directory).
  // The file may be followed by whitespace (then more flags), a pipe, or end-of-string.
  const fileMatch = /(?:^|\s)(?:"([^"]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|php|swift|kt|cpp|cc|cxx|c|h))"|'([^']+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|php|swift|kt|cpp|cc|cxx|c|h))'|([^\s"'|<>]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|php|swift|kt|cpp|cc|cxx|c|h)))(?:\s|$|\|)/i.exec(cmd)
  if (!fileMatch) return null

  const filePath = fileMatch[1] ?? fileMatch[2] ?? fileMatch[3]
  if (!filePath) return null
  if (isTempPath(filePath)) return null

  // Exclude recursive flags — those search directories, not a single file
  if (/-[a-zA-Z]*r[a-zA-Z]*\b/.test(cmd) || /--recursive\b/.test(cmd)) return null

  return { filePath, identifier: pattern }
}

/** Extracts the file path from `cat <file> | jq` commands restricted to structured config files. Returns null for non-config extensions, temp paths, or non-jq pipes. Emits a CONTEXT hint (not deny) so the jq pipeline still runs if the agent proceeds. */
function extractCatJsonPipe(cmd: string): { filePath: string } | null {
  const m = /^cat\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*\|\s*jq\b/.exec(cmd)
  if (!m) return null
  const filePath = m[1] ?? m[2] ?? m[3]
  if (!filePath) return null
  if (isTempPath(filePath)) return null
  if (!/\.(?:json|yaml|yml|toml)$/i.test(filePath)) return null
  return { filePath }
}

/** Extracts the file path from a WSL-proxied cat command like `wsl bash -c "cat /mnt/c/..."` or `wsl -d Ubuntu bash -c "cat /mnt/c/..."`. Converts /mnt/X/ paths to X:/ and applies the same filtering as extractCatFile. */
function extractWslCatFile(cmd: string): { filePath: string; isDoc: boolean; isEnv: boolean; isConfig: boolean; isSql: boolean } | null {
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
  const isSql = /\.sql$/i.test(filePath)
  const isDoc = /\.(?:md|mdx|rst|txt)$/i.test(filePath)
  const isEnv = isEnvFile || /\.env$/i.test(filePath)
  const isConfig = /\.(?:json|yaml|yml|toml|conf|cfg|ini|properties)$/i.test(filePath)
  return { filePath, isDoc, isEnv, isConfig, isSql }
}

/** Returns the file path if the bash command is a Python snippet that reads a known-extension file via open(). Returns null otherwise. */
function extractPythonFileRead(cmd: string): { filePath: string; isDoc: boolean } | null {
  if (!/python3?/.test(cmd)) return null
  // Return null when the command shows write intent — these are edits, not reads
  if (/open\s*\([^)]*,\s*['"][wa]/i.test(cmd) || /\.write\s*\(/.test(cmd)) return null

  const OPEN_EXT = /\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties)/i

  // Heredoc form: python3 - << 'PYEOF'\n...\nPYEOF
  const heredocMatch = /^python3?\s+-\s+<<\s*'?(\w+)'?\s*\n([\s\S]*?)\n\1\s*$/.exec(cmd)
  if (heredocMatch) {
    const body = heredocMatch[2] ?? ''
    // Write-mode exclusion in the heredoc body
    if (
      /open\s*\([^)]*,\s*['"][wa]/i.test(body) ||
      /\.write\s*\(/.test(body) ||
      /\.writelines\s*\(/.test(body)
    ) return null
    // Direct: open(r'path.ext') or open("path.ext") in body
    const heredocOpen = /open\s*\(\s*r?['"]([^'"]+\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties))['"]/i.exec(body)
    if (heredocOpen?.[1]) {
      const filePath = heredocOpen[1]
      if (isOrchestratorStateFile(filePath)) return null
      const isDoc = /\.(?:md|mdx|rst|txt)$/i.test(filePath)
      return { filePath, isDoc }
    }
    // Indirect: open(var, ...) where a string literal with known ext appears in the body
    if (/open\s*\(/.test(body)) {
      const literal = /['"]([^'"]+\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties))['"]/i.exec(body)
      if (literal?.[1]) {
        const filePath = literal[1]
        if (isOrchestratorStateFile(filePath)) return null
        if (OPEN_EXT.test(filePath)) {
          const isDoc = /\.(?:md|mdx|rst|txt)$/i.test(filePath)
          return { filePath, isDoc }
        }
      }
    }
    return null
  }

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
        if (OPEN_EXT.test(filePath)) {
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

/** Extracts file path from `node -e "fs.readFileSync(...)"` or `node -e "require('....json')"` patterns. Returns null if not this pattern or if temp file. */
function extractNodeFileRead(cmd: string): { filePath: string; isDoc: boolean; isConfig: boolean } | null {
  if (!/^node\s+-e/.test(cmd)) return null
  const readSync = /readFileSync\(['"]([^'"]+\.(?:ts|tsx|js|jsx|py|go|java|rs|rb|cs|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties|sql))['"]/i.exec(cmd)
  if (readSync?.[1]) {
    const filePath = readSync[1]
    if (isOrchestratorStateFile(filePath)) return null
    if (isTempPath(filePath)) return null
    const isDoc = /\.(?:md|mdx|rst|txt|sql)$/i.test(filePath)
    const isConfig = /\.(?:json|yaml|yml|toml|conf|cfg|ini|properties)$/i.test(filePath)
    return { filePath, isDoc, isConfig }
  }
  // Also catch require('path/to/file.json') — common for one-liner version lookups
  const requireM = /require\(['"]([^'"]+\.json)['"]\)/i.exec(cmd)
  if (requireM?.[1]) {
    const filePath = requireM[1]
    // Only intercept project files — node_modules paths are resolved internally
    if (filePath.includes('node_modules')) return null
    if (isOrchestratorStateFile(filePath)) return null
    if (isTempPath(filePath)) return null
    return { filePath, isDoc: false, isConfig: true }
  }
  return null
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
 * Tasks output files follow the pattern `…/tasks/<id>.output`. They are written
 * to disk by the harness (not through the bash-output cache), so re-reading via
 * cat/tail wastes tokens that `token-goat bash-output --file <path>` returns
 * surgically. The matched path is returned so the recall hint can name a command
 * that actually works (`bash-output <id>` misses, since the task id is not a
 * bash-output cache key).
 */
function extractTasksOutput(cmd: string): { id: string; path: string; n?: number } | null {
  const taskOutputRe = /[/\\]tasks[/\\]([a-z0-9]+)\.output$/

  // cat command (same regex structure as extractCatFile, checked before isTempPath)
  const catM = /^cat(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+))*\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd)
  if (catM) {
    const fp = catM[1] ?? catM[2] ?? catM[3]
    if (fp) {
      const m = taskOutputRe.exec(fp)
      if (m) return { id: m[1]!, path: fp }
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
          return n !== undefined ? { id: m[1]!, path: fp, n } : { id: m[1]!, path: fp }
        }
      }
    }
    // Byte-mode tail: -c N (common in session mining: `tail -c 1500 <id>.output`)
    const byteTailM = /^tail\s+-c\s+\d+\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd)
    if (byteTailM) {
      const fp = byteTailM[1] ?? byteTailM[2] ?? byteTailM[3]
      if (fp) {
        const m = taskOutputRe.exec(fp)
        if (m) return { id: m[1]!, path: fp }
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
    /^eza\s+.*--tree/.test(cmd) ||
    /^tree(\s|$)/.test(cmd) ||
    /^ls\s+.*-[a-zA-Z]*R/.test(cmd) ||
    /^ls\s+(?:-[la]+\s+)?(\S+)\s*[|]\s*head/.test(cmd) ||
    /^ls\s+(?:-[la]+\s+)?(\S+)\s*[|]\s*grep/.test(cmd) ||
    /^ls\s+(?:-[la]+\s+)?(\S+)\s*[|]\s*wc/.test(cmd)
  )
}

/** Detects `for f in FILES; do wc -l $f; done` size-probing idioms. */
function extractForLoopWcL(cmd: string): boolean {
  return /^for\s+\w+\s+in\s+.*;\s*do\s+wc\s+-l/.test(cmd)
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
 * Returns the file path when the command is a grep/rg -n heading-anchor search on a
 * markdown file (`.md` or `.markdown`). These are used as a hand-rolled "show me the
 * table of contents" idiom; `token-goat outline` is cheaper and gives line ranges.
 *
 * Triggers on patterns like: `^#`, `^##`, `^###`, `^#+`, `^## |^### `, `^#\+`.
 * Does NOT trigger for non-markdown files (e.g. `.sh`, `.ts`) or patterns that are
 * not heading anchors.
 */
export function extractMarkdownHeadingGrep(cmd: string): { filePath: string } | null {
  if (!/^(?:rg|grep)\s+/.test(cmd)) return null

  // Must have the -n (line-number) flag
  if (!/-n\b/.test(cmd)) return null

  // Pattern must be a markdown heading anchor: starts with ^# in some form.
  // Allow: "^#", '^##', "^#+" , "^#+", "^## |^### ", /^#/ variants, '^#\+'
  const hasHeadingPattern = (
    /["']?\^#{1,6}["']?/.test(cmd) ||
    /["']?\^#\+["']?/.test(cmd) ||
    /["']?\^#\\+["']?/.test(cmd)
  )
  if (!hasHeadingPattern) return null

  // Target must be a single markdown file (not a directory or non-md extension)
  const fileMatch = /(?:^|\s)(?:"([^"]+\.(?:md|markdown))"|'([^']+\.(?:md|markdown))'|([^\s"'|<>]+\.(?:md|markdown)))\s*(?:\||$)/.exec(cmd)
  if (!fileMatch) return null

  const filePath = fileMatch[1] ?? fileMatch[2] ?? fileMatch[3]
  if (!filePath) return null

  return { filePath }
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
 * Returns true when a command chains two grep/rg stages together (e.g. `grep … | grep …`).
 * Only matches when BOTH pipeline stages are grep or rg — does not fire for `grep | wc`,
 * `grep | head`, `grep | sort`, `grep | awk`, etc.
 */
function extractGrepPipeChain(cmd: string): boolean {
  return /^(?:rg|grep)\b.*\|\s*(?:rg|grep)\b/.test(cmd)
}

/**
 * Returns the first https?:// URL found in a curl command, or null when none is present.
 * Used to key the bash-output cache on the URL rather than the full command string so that
 * `curl -s <url> | jq …` and `curl -s <url> | python3 …` share the same cache entry.
 */
function extractCurlUrl(cmd: string): string | null {
  const m = /(https?:\/\/[^\s'"]+)/.exec(cmd)
  return m?.[1] ?? null
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

/**
 * Extracts {url, outputPath} from a `curl -o <file> <url>` download command.
 * Returns null for non-curl commands, commands without `-o`/`--output`, or
 * commands with auth/POST/body flags that should not be cached.
 */
export function extractCurlDownload(cmd: string): { url: string; outputPath: string } | null {
  if (!/^curl\b/.test(cmd)) return null
  // Must have -o / --output flag
  const outputMatch = /(?:^|\s)(?:-o|--output)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(cmd)
  if (!outputMatch) return null
  const outputPath = outputMatch[1] ?? outputMatch[2] ?? outputMatch[3]
  if (!outputPath) return null
  // Exclude explicit non-GET methods
  if (/-X\s+(?:POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/i.test(cmd)) return null
  if (/--request\s+(?:POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/i.test(cmd)) return null
  // Exclude request body flags
  if (/(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode)?|-F|--form)\b/.test(cmd)) return null
  // Exclude auth credentials
  if (/(?:^|\s)(?:-u|--user)\b/.test(cmd)) return null
  if (/-H\s+['"]?Authorization/i.test(cmd)) return null
  // Extract URL (first https?:// argument)
  const urlMatch = /(https?:\/\/[^\s'"]+)/.exec(cmd)
  if (!urlMatch?.[1]) return null
  return { url: urlMatch[1], outputPath }
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
  const rawCmd = extractCommand(event)
  if (rawCmd === undefined) return passOutput()
  const cmd = stripCdPrefix(rawCmd)
  const cdStripped = cmd !== rawCmd

  // Item 3: task output file — already cached, recall with bash-output
  const taskOutput = extractTasksOutput(cmd)
  if (taskOutput !== null) {
    const { id, path: outPath, n } = taskOutput
    recordStat('session_hint', 0, 0)
    const tail = n ?? 50
    return denyOutput(
      'Task output ' + id + ' is on disk. Use `token-goat bash-output --file "' + outPath + '" --tail ' + tail + '` (or `--grep PATTERN`) to read a slice instead of the whole file.',
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

  // for-loop wc -l size probe — suggest outline instead
  if (extractForLoopWcL(cmd)) {
    recordStat('session_hint', 0, 0)
    return contextOutput(
      'Use `token-goat outline <file>` to see symbol names and line counts without loading files.',
    )
  }

  // Item 4b: sed line-range extraction
  if (extractSedLineRange(cmd)) {
    recordStat('session_hint', 0, 0)
    return contextOutput(
      'Use `token-goat section "<file>::HeadingName"` to read one section instead of a line range.',
    )
  }

  const catJsonPipe = extractCatJsonPipe(cmd)
  if (catJsonPipe !== null) {
    const { filePath } = catJsonPipe
    recordStat('session_hint', 0, 0)
    return contextOutput(
      '`cat | jq` loads the whole file. Use `token-goat config-get "' + filePath + '" KEY_NAME` or `token-goat section "' + filePath + '::sectionName"` to slice one value.',
    )
  }

  const catResult = extractCatFile(cmd)
  if (catResult !== null) {
    const { filePath, isDoc, isEnv, isConfig, isSql } = catResult
    recordStat('session_hint', 0, 0)
    if (isSql) {
      return contextOutput(
        '`cat` loads the entire file into context. Use `token-goat section "' + filePath + '::table_name"` to pull one CREATE TABLE / CREATE TYPE block.',
      )
    }
    const hint = isEnv
      ? 'Use `token-goat config-get "' + filePath + '" KEY_NAME` to read a specific variable.'
      : isConfig
        ? 'Use `token-goat config-get "' + filePath + '" KEY_NAME` or `token-goat section "' + filePath + '::sectionName"` to read a specific value.'
        : isDoc
          ? 'Use `token-goat section "' + filePath + '::SectionHeading"` to read one section.'
          : 'Use `token-goat read "' + filePath + '::SymbolName"` to read one function or class.'
    return cdStripped ? contextOutput('`cat` loads the entire file into context. ' + hint) : denyOutput('`cat` loads the entire file into context. ' + hint)
  }

  const wslCatResult = extractWslCatFile(cmd)
  if (wslCatResult !== null) {
    const { filePath, isDoc, isEnv, isConfig, isSql } = wslCatResult
    recordStat('session_hint', 0, 0)
    if (isSql) {
      return contextOutput(
        '`cat` loads the entire file into context. Use `token-goat section "' + filePath + '::table_name"` to pull one CREATE TABLE / CREATE TYPE block.',
      )
    }
    const hint = isEnv
      ? 'Use `token-goat config-get "' + filePath + '" KEY_NAME` to read a specific variable.'
      : isConfig
        ? 'Use `token-goat config-get "' + filePath + '" KEY_NAME` or `token-goat section "' + filePath + '::sectionName"` to read a specific value.'
        : isDoc
          ? 'Use `token-goat section "' + filePath + '::SectionHeading"` to read one section.'
          : 'Use `token-goat read "' + filePath + '::SymbolName"` to read one function or class.'
    return cdStripped ? contextOutput('`cat` loads the entire file into context. ' + hint) : denyOutput('`cat` loads the entire file into context. ' + hint)
  }

  const pyRead = extractPythonFileRead(cmd)
  if (pyRead !== null) {
    const { filePath, isDoc } = pyRead
    const hint = isDoc
      ? 'Use `token-goat section "' + filePath + '::SectionHeading"` to read one section.'
      : 'Use `token-goat read "' + filePath + '::SymbolName"` to extract a specific symbol.'
    recordStat('session_hint', 0, 0)
    return cdStripped ? contextOutput('Python `open()` file reads bypass read hooks. ' + hint) : denyOutput('Python `open()` file reads bypass read hooks. ' + hint)
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
    const { filePath, isDoc, isConfig } = nodeRead
    const hint = isDoc
      ? 'Use `token-goat section "' + filePath + '::SectionHeading"` to read one section.'
      : isConfig
        ? 'Use `token-goat config-get "' + filePath + '" KEY_NAME` or `token-goat section "' + filePath + '::sectionName"` to read a specific value.'
        : 'Use `token-goat read "' + filePath + '::SymbolName"` to extract a specific symbol.'
    recordStat('session_hint', 0, 0)
    return cdStripped ? contextOutput('Node.js `fs.readFileSync()` bypasses read hooks. ' + hint) : denyOutput('Node.js `fs.readFileSync()` bypasses read hooks. ' + hint)
  }

  if (extractGrepPipeChain(cmd)) {
    recordStat('session_hint', 0, 0)
    return contextOutput(
      'Collapse `grep | grep` into `rg -e PAT1 -e PAT2` (single pass). ' +
      'For symbol discovery: `token-goat refs <symbol>` or `token-goat semantic`.',
    )
  }

  // Markdown heading grep: `grep -n "^#" SKILL.md` → outline hint (before structural search
  // so .md heading patterns don't get misrouted to the symbol-search advice)
  const mdHeadingGrep = extractMarkdownHeadingGrep(cmd)
  if (mdHeadingGrep !== null) {
    const { filePath } = mdHeadingGrep
    recordStat('session_hint', 0, 0)
    return contextOutput(
      'Use `token-goat outline "' + filePath + '"` to get all headings with line ranges — ' +
      'then `token-goat section "' + filePath + '::Heading"` to read one section.',
    )
  }

  // Bare identifier search on a single source file — symbol lookup is cheaper
  const rgSymbol = extractRgSymbolSearch(cmd)
  if (rgSymbol !== null) {
    const { identifier } = rgSymbol
    recordStat('session_hint', 0, 0)
    return contextOutput(
      'Use `token-goat symbol ' + identifier + '` to jump directly to the definition without scanning the file.',
    )
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
    const monCmdHash = shortFingerprint(stripOutputPipeline(cmd))
    const monOutputId = getBashOutputId(monCmdHash)
    // Only emit the recall hint if the content entry is actually present: the
    // session index may name an id whose blob was pruned (age/count), and a hint
    // pointing at a missing id would error instead of saving a re-run.
    const monEntry = monOutputId !== null ? getBashOutput(monOutputId) : null
    if (monOutputId !== null && monEntry !== null) {
      const monBytes = monEntry.sizeBytes
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

  // Item 2: curl -o download recall — keyed by URL so a re-download to a different temp
  // path still gets a recall hint pointing to the previously saved file.
  const curlDl = extractCurlDownload(cmd)
  if (curlDl !== null) {
    const prevPath = getCurlDownloadPath(curlDl.url)
    if (prevPath !== null) {
      recordStat('session_hint', 0, 0)
      return denyOutput(
        'Already downloaded to ' + prevPath + ' earlier this session. ' +
        'Use `rg \'<pattern>\' ' + prevPath + '` to search it, or ' +
        '`token-goat read "' + prevPath + '::SectionName"` to read a part of it.',
      )
    }
  }

  // curl GET recall — emit a hint when the same URL was already fetched this session.
  // Key on URL only (not the full command) so `curl <url> | jq …` and `curl <url> | python3 …`
  // share the same cache entry.
  if (isCurlGetCommand(cmd)) {
    const curlCacheKey = extractCurlUrl(cmd) ?? cmd
    const curlHash = shortFingerprint(curlCacheKey)
    const curlOutputId = getBashOutputId(curlHash)
    // Guard on the content entry, not just the index, so a pruned blob does not
    // produce a recall hint that would error (see the monitoring case above).
    const curlEntry = curlOutputId !== null ? getBashOutput(curlOutputId) : null
    if (curlOutputId !== null && curlEntry !== null) {
      const curlBytes = curlEntry.sizeBytes
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
  const cmdHash = shortFingerprint(stripOutputPipeline(cmd))
  const outputId = getBashOutputId(cmdHash)
  if (outputId === null) return passOutput()

  // The index named an id, but only emit the recall hint if its content blob
  // still exists; a pruned/missing entry would make `bash-output <id>` error.
  const entry = getBashOutput(outputId)
  if (entry === null) return passOutput()
  const bytes = entry.sizeBytes
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

/** Best-effort exit code from a Bash tool_response (absent on many harnesses). */
function extractExitCode(raw: Record<string, unknown>): number | null {
  const resp = raw['tool_response']
  if (resp !== null && typeof resp === 'object') {
    const r = resp as Record<string, unknown>
    for (const key of ['exit_code', 'exitCode', 'returncode', 'code']) {
      if (typeof r[key] === 'number') return r[key] as number
    }
  }
  return null
}

// `gh api` endpoints that require an elevated token scope the default lacks.
const GH_SECURITY_PATHS = ['/security_advisories', '/advisories', 'security_events'] as const
// Phrases GitHub returns when the token lacks the scope/permission for a call.
const GH_SCOPE_PHRASES = ['Must have push access', 'Resource not accessible by integration', 'Must be an admin'] as const

/**
 * Advisory hints for `gh api` commands: a scope/permission nudge when the call hits a permission
 * wall, and a token-savings nudge when the JSON response is wide enough that a `--jq` projection
 * would meaningfully shrink it. Returns the joined hint text, or null when nothing applies.
 *
 * The scope hint is accumulated before the response is parsed, so a non-JSON or malformed body
 * still surfaces it — unlike the original Python, where a `json.loads` failure discarded an
 * already-detected scope hint. Never throws.
 */
function buildGhApiHint(cmd: string, stdout: string, exitCode: number | null): string | null {
  if (stdout === '' || !cmd.startsWith('gh api')) return null
  const hints: string[] = []
  const isSecurityPath = GH_SECURITY_PATHS.some((p) => cmd.includes(p))
  const hasScopePhrase = GH_SCOPE_PHRASES.some((p) => stdout.includes(p))
  const failedSecurityCall = exitCode !== null && exitCode !== 0 && isSecurityPath
  if (hasScopePhrase || failedSecurityCall) {
    hints.push('[token-goat] GitHub API scope issue: try gh auth refresh -s security_events')
  }
  // Large-response nudge: only a JSON object can carry the 15+ boilerplate fields this targets,
  // so skip the parse entirely unless the body looks like one (avoids parsing huge non-JSON logs).
  const trimmed = stdout.trimStart()
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(stdout)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const keyCount = Object.keys(parsed as Record<string, unknown>).length
        if (keyCount >= 15) {
          hints.push(`[token-goat] Large API response (${keyCount} keys). Filter with --jq '.key1,.key2' to reduce tokens.`)
        }
      }
    } catch {
      // Malformed JSON: keep any scope hint already accumulated, skip the large-response nudge.
    }
  }
  return hints.length > 0 ? hints.join(' ') : null
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
    const rawCmd = extractCommand(event)
    if (rawCmd === undefined) return passOutput()
    const cmd = stripCdPrefix(rawCmd)

    // Item 2: record curl -o downloads by URL for cross-command dedup
    const curlDl = extractCurlDownload(cmd)
    if (curlDl !== null) {
      recordCurlDownload(curlDl.url, curlDl.outputPath)
    }

    // `gh api` advisory hints: scope/permission nudge and large-JSON --jq nudge. These commands
    // are not cached (not build/monitoring/curl-GET), so emit the hint and return here.
    const ghHint = buildGhApiHint(cmd, extractBashOutput(event.raw), extractExitCode(event.raw))
    if (ghHint !== null) {
      recordStat('session_hint', 0, 0)
      return contextOutput(ghHint)
    }

    // Only cache monitoring, build, and curl GET commands — not generic shell commands.
    const isMonitoring = getMonitoringRecallHint(cmd) !== null
    if (!isMonitoring && !isBuildCommand(cmd) && !isCurlGetCommand(cmd)) return passOutput()

    const output = extractBashOutput(event.raw)
    if (Buffer.byteLength(output, 'utf-8') < MIN_CACHE_BYTES) return passOutput()

    const cwd = typeof event.raw['cwd'] === 'string' ? event.raw['cwd'] : null
    // For curl GET commands, key the cache on the URL so that the same endpoint fetched
    // with different downstream pipes (| jq vs | python3) shares a single cache entry.
    const cacheKey = isCurlGetCommand(cmd) ? (extractCurlUrl(cmd) ?? cmd) : stripOutputPipeline(cmd)
    const simpleHash = shortFingerprint(cacheKey)
    const id = await storeBashOutput(cmd, output, 0, cwd)
    recordBashOutput(simpleHash, id, Buffer.byteLength(output, 'utf-8'))
  } catch {
    // Never block — hook failures must be silent.
  }
  return passOutput()
}

registerHook('post_tool_use', postBashHandler, { toolName: 'Bash' })
