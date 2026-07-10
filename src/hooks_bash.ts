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
import { getBashOutputId, recordBashOutput, recordCurlDownload, getCurlDownloadPath, clearCurlDownload, getFileLineRanges, recordFileLineRange, wasHintShown, markHintShown, wasCliReadThisSession, recordCliRead, recordSymbolRead, wasFileReadThisSession, takePendingLargeFileHint } from './session.js'
import { resolveIndexPath } from './paths.js'
import { shortFingerprint } from './fingerprint.js'
import { isBuildCommand, getMonitoringRecallHint } from './hints/lang_patterns.js'
import { storeBashOutput, getBashOutput, isBashEntryStale, isScopedGitStatusOrDiffStatCommand } from './bash_output_cache.js'
import { recordStat } from './stats.js'
import { loadConfig } from './config.js'
import { detectFromCommand, shlexSplit } from './tool_filters/index.js'
import { canRunWrappedShell } from './shell.js'
import { detectLanguage, type Language } from './parser_types.js'
import { statSync, existsSync } from 'node:fs'

/** Strip one or more `cd <dir> &&` prefixes so interceptors match the actual command. */
function stripCdPrefix(cmd: string): string {
  // Handles: `cd /path && CMD`, `cd "path with spaces" && CMD`, `cd 'path' && CMD`
  const stripped = cmd.replace(/^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/, '')
  return stripped.trim() || cmd
}

/**
 * Extracts each `cd <dir>` target from a leading `cd <dir> && cd <dir2> && ...` prefix, in the
 * order stripCdPrefix consumes them. Used to resolve a relative filePath extracted from the
 * remaining command against the directory the shell would actually land in — not this hook's
 * own cwd — before that path is embedded in a suggested follow-up command.
 */
function extractCdPrefixDirs(rawCmd: string): string[] {
  const prefixMatch = rawCmd.match(/^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/)
  if (prefixMatch === null) return []
  const dirs: string[] = []
  const segmentPattern = /cd\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*&&/g
  let match: RegExpExecArray | null
  while ((match = segmentPattern.exec(prefixMatch[0])) !== null) {
    const dir = match[1] ?? match[2] ?? match[3]
    if (dir !== undefined) dirs.push(dir)
  }
  return dirs
}

/**
 * Resolves filePath against the directory a stripped `cd DIR && ...` prefix leaves the shell in
 * (each cd resolved in turn — relative ones against the previous directory, starting from cwd —
 * mirroring real shell semantics), so a hint naming filePath is resolvable from the hook's actual
 * cwd rather than silently relative to a directory the model never navigated to. Falls back to
 * filePath unchanged if the prefix can't be parsed into at least one directory.
 */
function resolveCdHintPath(rawCmd: string, filePath: string, cwd: string): string {
  const dirs = extractCdPrefixDirs(rawCmd)
  if (dirs.length === 0) return filePath
  let targetDir = cwd
  for (const dir of dirs) {
    targetDir = resolveIndexPath(dir, targetDir)
  }
  return resolveIndexPath(filePath, targetDir)
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
  let backslashes = 0
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === '\\') {
      backslashes++
      continue
    }
    // A quote is escaped only when preceded by an odd number of consecutive
    // backslashes (\" is escaped, \\" is a literal backslash then a real quote).
    const escaped = backslashes % 2 === 1
    backslashes = 0
    if (ch === "'" && !inDouble) {
      if (!escaped) inSingle = !inSingle
    } else if (ch === '"' && !inSingle) {
      if (!escaped) inDouble = !inDouble
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
  // Strip trailing stream redirections (possibly chained), honoring quotes. Mask quoted content with same-length spaces so the redirect regex cannot match characters inside a string literal (e.g. 'pytest -k "value > 0"'). String length is preserved, so slicing back to newMasked.length is exact.
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

// A cache entry keyed on the base command (stripOutputPipeline) or a curl URL is intentionally
// shared across different downstream pipes/redirects on the same underlying command — see
// stripOutputPipeline's docstring. But the stored *content* is whatever that one run's pipe
// produced, so a differently-piped recall (`| jq '.a'` vs `| jq '.b'`) can silently serve the
// wrong value. Rather than break the intentional sharing (and the tests that pin it), surface
// the command that actually produced the cached content whenever it differs from the one being
// run now, so the caller can judge whether the recall still covers what they need.
function pipelineDivergenceNote(cmd: string, entryCommand: string): string {
  if (entryCommand === cmd) return ''
  const preview = entryCommand.length > 60 ? entryCommand.slice(0, 57) + '...' : entryCommand
  return ' (cached from a differently-piped run, `' + preview + '` — verify it covers what you need before trusting it)'
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
// Classify a single candidate `cat`/`bat`/`type`/`Get-Content` path: returns the
// per-path flags used by the deny/hint logic, or null if the path is a temp scratch
// file or lacks a known source/doc/config extension. Shared by the single-path
// extractCatFile and the multi-path extractCatFilesMulti so both apply identical rules.
function classifyCatPath(
  filePath: string,
  cmd0: string,
): { filePath: string; isDoc: boolean; isEnv: boolean; isConfig: boolean; isSql: boolean; cmd0: string } | null {
  if (isTempPath(filePath)) return null
  const basename = (filePath.includes('/') ? filePath.split('/').at(-1) : filePath.split('\\').at(-1)) ?? filePath
  const isEnvFile = /^\.env(\.\w+)?$/i.test(basename)
  const hasKnownExt = /\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|css|scss|sass|less|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties|sql|ps1|psm1|env)$/i.test(filePath)
  if (!hasKnownExt && !isEnvFile) return null
  const isSql = /\.sql$/i.test(filePath)
  const isDoc = /\.(?:md|mdx|rst|txt)$/i.test(filePath)
  const isEnv = isEnvFile || /\.env$/i.test(filePath)
  const isConfig = /\.(?:json|yaml|yml|toml|conf|cfg|ini|properties)$/i.test(filePath)
  return { filePath, isDoc, isEnv, isConfig, isSql, cmd0 }
}

export function extractCatFile(cmd: string): { filePath: string; isDoc: boolean; isEnv: boolean; isConfig: boolean; isSql: boolean; cmd0: string } | null {
  const m = /^(cat|bat|type|Get-Content|gc)(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+))*\s+(?:"([^"]+)"|'([^']+)'|(\S+?))(?:\s+-[a-zA-Z].*)?\s*$/i.exec(cmd)
  if (!m) return null
  const cmd0 = m[1]!
  const filePath = m[2] ?? m[3] ?? m[4]
  if (filePath === undefined) return null
  return classifyCatPath(filePath, cmd0)
}

// Multi-file variant: `cat a.ts b.ts` (2+ path args) slips past the single-path
// extractCatFile (its `$` anchor rejects a trailing second path), so a multi-file cat
// used to bypass the deny entirely. Tokenizes every path argument and returns the
// qualifying ones so the same per-path deny/hint fires. Returns null unless the command
// is a bare cat/bat/type/Get-Content with 2+ arguments and at least one qualifying path.
export function extractCatFilesMulti(
  cmd: string,
): Array<{ filePath: string; isDoc: boolean; isEnv: boolean; isConfig: boolean; isSql: boolean; cmd0: string }> | null {
  // Only a bare `cat a b c`: bail on any pipe/redirect/chain/substitution so a piped
  // single read (`cat -n f | jq`, `cat f | grep`) still passes through untouched, the
  // same way the `$`-anchored single-path extractCatFile never matched those.
  if (/[|<>;&`]/.test(cmd) || cmd.includes('$(')) return null
  const m = /^(cat|bat|type|Get-Content|gc)\s+(.+?)\s*$/i.exec(cmd)
  if (!m) return null
  const cmd0 = m[1]!
  const tokens = m[2]!.match(/"[^"]+"|'[^']+'|\S+/g) ?? []
  const paths = tokens.filter((t) => !/^-/.test(t)).map((t) => t.replace(/^["']|["']$/g, ''))
  if (paths.length < 2) return null
  const out = paths.map((p) => classifyCatPath(p, cmd0)).filter((r): r is NonNullable<typeof r> => r !== null)
  // Require 2+ qualifying source paths: a single path with flag VALUES (e.g.
  // `Get-Content -Tail 50 src/auth.ts`, where `50` is the -Tail argument) is a
  // flagged single-file read that the tail/head/single-cat handlers own -- firing
  // here would preempt them with a hard deny.
  return out.length >= 2 ? out : null
}

const POWERSHELL_WRAP_RE = /^(?:powershell|pwsh)(?:\.exe)?(?:\s+-[a-zA-Z]+(?:\s+\S+)?)*\s+(?:-Command|-c|-EncodedCommand)\s+(?:"([^"]*)"|'([^']*)')\s*$/i
const PS_GETCONTENT_INNER_RE = /^(?:Get-Content|gc|cat|type)(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+))*\s+(?:"([^"]+)"|'([^']+)'|(\S+?))(?:\s+-[a-zA-Z].*)?\s*$/i
// A temp-path read only floods context when the file is large; a small scratch read stays silent.
const PS_TEMP_READ_FLOOD_BYTES = 16 * 1024

function isLargeFileOnDisk(filePath: string, floor: number): boolean {
  try {
    return statSync(filePath).size >= floor
  } catch {
    return false
  }
}

/** Extracts the read path from a `powershell -Command "Get-Content '<path>' -Raw"` (or pwsh/cat/type) wrapper, which otherwise bypasses every Get-Content/cat extractor because the command token is `powershell`. Tolerates a trailing `-Raw`/`-Encoding` that bare extractCatFile rejects. Temp paths are size-gated: a small scratch read stays silent, a large one still earns a recall hint. */
export function extractPowerShellWrappedGetContent(cmd: string): { filePath: string; isDoc: boolean; isEnv: boolean; isConfig: boolean; isSql: boolean } | null {
  const w = POWERSHELL_WRAP_RE.exec(cmd)
  if (!w) return null
  const inner = (w[1] ?? w[2] ?? '').trim()
  if (!inner) return null
  const m = PS_GETCONTENT_INNER_RE.exec(inner)
  if (!m) return null
  const filePath = m[1] ?? m[2] ?? m[3]
  if (filePath === undefined) return null
  const basename = (filePath.includes('/') ? filePath.split('/').at(-1) : filePath.split('\\').at(-1)) ?? filePath
  const isEnvFile = /^\.env(\.\w+)?$/i.test(basename)
  const hasKnownExt = /\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|css|scss|sass|less|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties|sql|ps1|psm1|env)$/i.test(filePath)
  if (!hasKnownExt && !isEnvFile) return null
  // Temp reads are normally scratch and skipped, but a large one still floods context; gate on size rather than excluding unconditionally.
  if (isTempPath(filePath) && !isLargeFileOnDisk(filePath, PS_TEMP_READ_FLOOD_BYTES)) return null
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

  // Must target exactly one file with a known source extension (not a directory). The file may be followed by whitespace (then more flags), a pipe, or end-of-string.
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
  const hasKnownExt = /\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|css|scss|sass|less|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties|sql|ps1|psm1|env)$/i.test(filePath)
  if (!hasKnownExt && !isEnvFile) return null
  const isSql = /\.sql$/i.test(filePath)
  const isDoc = /\.(?:md|mdx|rst|txt)$/i.test(filePath)
  const isEnv = isEnvFile || /\.env$/i.test(filePath)
  const isConfig = /\.(?:json|yaml|yml|toml|conf|cfg|ini|properties)$/i.test(filePath)
  return { filePath, isDoc, isEnv, isConfig, isSql }
}

/** Returns the file path if the bash command is a Python snippet that reads a known-extension file via open(). Returns null otherwise. */
function extractPythonFileRead(cmd: string): { filePath: string; isDoc: boolean; isTranscript: boolean } | null {
  if (!/^python3?\b/.test(cmd)) return null
  // Return null when the command shows write intent — these are edits, not reads
  if (/open\s*\([^)]*,\s*['"][wa]/i.test(cmd) || /\.write\s*\(/.test(cmd)) return null

  // .output files are subagent/task JSONL transcripts, not source — route to the transcript-recall command rather than a symbol read
  const outputOpen = /open\s*\(\s*r?['"]([^'"]+\.output)['"]/i.exec(cmd)
  if (outputOpen?.[1]) {
    const filePath = outputOpen[1]
    if (isOrchestratorStateFile(filePath)) return null
    return { filePath, isDoc: false, isTranscript: true }
  }

  const OPEN_EXT = /\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties|ps1|psm1)/i

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
      return { filePath, isDoc, isTranscript: false }
    }
    // Indirect: open(var, ...) where a string literal with known ext appears in the body
    if (/open\s*\(/.test(body)) {
      const literal = /['"]([^'"]+\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties))['"]/i.exec(body)
      if (literal?.[1]) {
        const filePath = literal[1]
        if (isOrchestratorStateFile(filePath)) return null
        if (OPEN_EXT.test(filePath)) {
          const isDoc = /\.(?:md|mdx|rst|txt)$/i.test(filePath)
          return { filePath, isDoc, isTranscript: false }
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
    return { filePath, isDoc, isTranscript: false }
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
          return { filePath, isDoc, isTranscript: false }
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

function extractSedRange(cmd: string): { filePath: string; ranges: Array<readonly [number, number]> } | null {
  // Multi-range `sed -n 'N,Mp;X,Yp' file` is legal: a semicolon-separated list of `N,Mp` clauses
  // inside a single quoted address block, followed by the same file-path argument and optional
  // `2>/dev/null` suffix as the single-range form. The earlier single-range regex required
  // exactly one range then end-of-string, so any `;`-joined command silently fell through with
  // no hint at all, leaving an agent that grabs N+M ranges in one sed call getting zero
  // guidance. The regex below matches the leading `N,Mp` plus zero or more `;N,Mp`
  // continuations sharing the same surrounding quotes; the range list is reparsed from cmd so
  // each clause is independently validated (start >= 1, end >= start) and empty/malformed
  // inputs are rejected uniformly.
  const m = /^sed\s+-n\s+['"](?:\d+,\d+p)(?:;\d+,\d+p)*['"]\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+2>\/dev\/null)?\s*$/.exec(cmd)
  if (!m) return null
  const quotedAddress = /['"]([^'"]+)['"]/.exec(cmd)
  if (!quotedAddress) return null
  const ranges: Array<readonly [number, number]> = []
  for (const clause of quotedAddress[1]!.split(';')) {
    const cm = /^(\d+),(\d+)p$/.exec(clause ?? '')
    if (!cm) return null
    const start = parseInt(cm[1] as string, 10)
    const end = parseInt(cm[2] as string, 10)
    if (start < 1 || end < start) return null
    ranges.push([start, end])
  }
  if (ranges.length === 0) return null
  const filePath = m[1] ?? m[2] ?? m[3]
  if (filePath === undefined) return null
  if (isTempPath(filePath)) return null
  return { filePath, ranges }
}

// Languages where `token-goat symbol`/`read "file::Symbol"` resolve a named definition, so a line-range read can be upgraded to a shift-robust symbol read.
const SYMBOL_BEARING_LANGUAGES: ReadonlySet<Language> = new Set<Language>([
  'python', 'typescript', 'javascript', 'rust', 'go', 'c', 'cpp', 'ruby', 'java', 'csharp', 'php', 'kotlin', 'sql', 'graphql', 'proto', 'bash', 'powershell',
])

// Builds the recall hint for a `sed -n 'N,Mp' file` read, tailored to the file's language: Markdown -> section by heading; structured config -> config-get/section; source code -> symbol read (robust to line shifts); everything else -> the exact line range.
// Builds the recall hint for a `sed -n 'N,Mp' file` read (or multi-range `sed -n 'N,Mp;X,Yp' file`),
// tailored to the file's language: Markdown -> section by heading; structured config ->
// config-get/section; source code -> symbol read (robust to line shifts); everything else ->
// the exact line range per requested range.
function sedRangeHint(filePath: string, ranges: ReadonlyArray<readonly [number, number]>): string {
  const lang = detectLanguage(filePath)
  // One token-goat read per requested range so the agent can fetch each independently. Combined
  // into one inline list with `and` for two ranges and Oxford-comma for three or more.
  const rangeReads = ranges.map(([s, e]) => '`token-goat read "' + filePath + '@' + s + '-' + e + '"`')
  const allReads = rangeReads.length === 2
    ? rangeReads.join(' and ')
    : rangeReads.length >= 3
      ? rangeReads.slice(0, -1).join(', ') + ', and ' + rangeReads[rangeReads.length - 1]
      : rangeReads[0]!
  const prefix = '`sed -n` line-range reads bypass read hooks. '
  if (lang === 'markdown') {
    return prefix + 'For Markdown, `token-goat section "' + filePath + '::<heading>"` extracts a whole section by name (robust to line shifts); or ' + allReads + ' for exactly those lines.'
  }
  if (lang === 'toml' || lang === 'json' || lang === 'yaml' || lang === 'ini') {
    return prefix + 'For config, `token-goat config-get "' + filePath + '" <key>` or `token-goat section "' + filePath + '::<block>"` extracts one value; or ' + allReads + ' for exactly those lines.'
  }
  if (SYMBOL_BEARING_LANGUAGES.has(lang)) {
    return prefix + 'For a whole function/class, `token-goat symbol <name>` or `token-goat read "' + filePath + '::<Symbol>"` is robust to line shifts; or ' + allReads + ' for exactly those lines.'
  }
  return prefix + 'Use ' + allReads + ' to read exactly those lines.'
}

// Returns the previously-served range that overlaps [start, end] the most (by shared line count), or null if none overlap.
function findRangeOverlap(prior: ReadonlyArray<readonly [number, number]>, start: number, end: number): readonly [number, number] | null {
  let best: readonly [number, number] | null = null
  let bestOverlap = 0
  for (const range of prior) {
    const overlap = Math.min(range[1], end) - Math.max(range[0], start) + 1
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = range
    }
  }
  return best
}

// Builds the recall hint when a sed range overlaps one already served this session: name the prior range and point at a `read "file@delta"` for only the not-yet-seen lines.
function sedOverlapHint(filePath: string, prior: readonly [number, number], start: number, end: number): string {
  const base = 'You already read lines ' + prior[0] + '-' + prior[1] + ' of ' + filePath + ' via an earlier `sed` this session; this read (' + start + '-' + end + ') overlaps. '
  // The never-served portion of [start, end] is whatever falls outside [prior[0], prior[1]]: a
  // leading segment when the new request starts before the prior range, a trailing segment when
  // it ends after, or both when the new request straddles the prior range on both sides.
  const segments: Array<readonly [number, number]> = []
  if (start < prior[0]) segments.push([start, Math.min(end, prior[0] - 1)])
  if (end > prior[1]) segments.push([Math.max(start, prior[1] + 1), end])
  if (segments.length === 0) {
    return base + 'These lines were already served - recall them from your earlier output instead of re-reading.'
  }
  const reads = segments.map(([s, e]) => '`token-goat read "' + filePath + '@' + s + '-' + e + '"`').join(' and ')
  return base + 'For only the new lines, ' + reads + '.'
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

// Extracts file path from `Get-Content <path> -Tail N` or `Get-Content -Tail N <path>` (PowerShell).
function extractGetContentTail(cmd: string): { filePath: string; isDoc: boolean } | null {
  // Match: Get-Content <file> -Tail <N> or Get-Content -Tail <N> <file>
  const tailMatch = /-Tail\s+(\d+)/i.exec(cmd)
  if (!tailMatch) return null
  const n = parseInt(tailMatch[1]!, 10)
  if (n <= 10) return null
  const getnMatch = /^(Get-Content|gc)\s+/i.exec(cmd)
  if (!getnMatch) return null
  // Extract filePath: everything between command and -Tail, or between -Tail N and end
  const afterCmd = cmd.slice(getnMatch[0].length)
  const beforeTail = afterCmd.split(/-Tail/i)[0]?.trim() ?? ''
  const afterTail = afterCmd.split(/-Tail\s+\d+/i)[1]?.trim() ?? ''
  const filePath = beforeTail || afterTail
  if (!filePath) return null
  if (isTempPath(filePath)) return null
  if (!/\.(?:ts|tsx|js|jsx|py|go|java|rs|rb|cs|md|mdx|rst|txt|json|yaml|yml|toml|sql|sh|ps1|psm1)$/i.test(filePath)) return null
  const isDoc = /\.(?:md|mdx|rst|txt|sql)$/i.test(filePath)
  return { filePath, isDoc }
}

// Extracts file path from `Get-Content <path> | Select-Object -First N` (PowerShell).
function extractGetContentSelectFirst(cmd: string): { filePath: string; isDoc: boolean; isConfig: boolean } | null {
  const m = /^(Get-Content|gc)\s+([^|]+)\s*\|\s*(Select-Object|select)\s+(-First\s+(\d+))/i.exec(cmd)
  if (!m) return null
  const filePath = m[2]?.trim() ?? ''
  const n = parseInt(m[5] ?? '0', 10)
  if (n < 10) return null
  if (!filePath) return null
  if (isTempPath(filePath)) return null
  if (!/\.(?:ts|tsx|js|jsx|py|go|java|rs|rb|cs|md|mdx|rst|txt|json|yaml|yml|toml|sql|sh|ps1|psm1)$/i.test(filePath)) return null
  const isDoc = /\.(?:md|mdx|rst|txt|sql)$/i.test(filePath)
  const isConfig = /\.(?:json|yaml|yml|toml|conf|cfg|ini|properties)$/i.test(filePath)
  return { filePath, isDoc, isConfig }
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

  // Pattern must be a markdown heading anchor: starts with ^# in some form. Allow: "^#", '^##', "^#+" , "^#+", "^## |^### ", /^#/ variants, '^#\+'
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

/** Match a `token-goat symbol|read|section|skill-body|skill-compact <spec>` invocation. `spec` mirrors read_commands.ts's `file::target` split for read/section; skill-body/skill-compact dedup on the raw remainder. `cwd` is the bash command's working directory (from the hook event), used to resolve a relative file path the same way the CLI itself would. */
function extractTgSurgicalRead(cmd: string, cwd: string | null): { sub: string; spec: string; filePath: string | null } | null {
  const m = /^token-goat\s+(symbol|read|section|skill-body|skill-compact)\s+(.+)$/.exec(cmd)
  if (!m) return null
  const sub = m[1]!
  const rest = m[2]!.trim()

  // skill-body/skill-compact take a name (or --path/--all flags), not a file::symbol spec.
  if (sub === 'skill-body' || sub === 'skill-compact') {
    // `--path <file>` takes an actual file path — resolve it the same way read/section do
    // (against cwd, normalized) so relative/differently-cased/slash-direction variants of the
    // same file collide under one dedup key, instead of the raw --path text differing byte-for-
    // byte across equivalent invocations. A plain NAME arg (or --all) isn't a file path, so it
    // still dedups on the raw remainder unchanged.
    const pathFlagMatch = /--path\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(rest)
    if (pathFlagMatch !== null) {
      const rawPathArg = pathFlagMatch[1] ?? pathFlagMatch[2] ?? pathFlagMatch[3] ?? ''
      const resolvedPath = resolveIndexPath(rawPathArg, cwd ?? process.cwd())
      const spec = rest.slice(0, pathFlagMatch.index) + '--path ' + resolvedPath + rest.slice(pathFlagMatch.index + pathFlagMatch[0].length)
      return { sub, spec, filePath: null }
    }
    return { sub, spec: rest, filePath: null }
  }

  const specMatch = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(rest)
  const rawSpec = specMatch?.[1] ?? specMatch?.[2] ?? specMatch?.[3] ?? null
  if (rawSpec === null) return null
  let filePath: string | null = null
  let spec = rawSpec
  if (sub === 'read' || sub === 'section') {
    // A `read` spec may carry a `@N-M`/`@N` line-range suffix (read_commands.ts's own
    // parseLineRange, mirrored here so the split stays in sync) ahead of any `::symbol` split.
    // Strip it before extracting the file path so the dedup/pending-hint key is the bare path a
    // plain-path lookup expects — otherwise a range read's filePath still carries the @N-M
    // suffix and never matches the file it actually reads.
    const rangeMatch = /^(.+)@(\d+)(?:-(\d+))?$/.exec(rawSpec)
    const rangeSuffix = rangeMatch !== null ? '@' + rangeMatch[2] + (rangeMatch[3] !== undefined ? '-' + rangeMatch[3] : '') : ''
    const specWithoutRange = rangeMatch !== null ? rangeMatch[1]! : rawSpec
    const colonIdx = specWithoutRange.indexOf('::')
    const rawFilePath = colonIdx === -1 ? specWithoutRange : specWithoutRange.slice(0, colonIdx)
    // Resolve against the command's cwd (falling back to this hook process's own cwd, which is
    // wrong but the best available signal, when the event carries none) before normalizing: a
    // relative spec run from two different directories must NOT collide under one dedup key, and
    // a relative spec run twice from the SAME directory must — bare normalizePath does neither,
    // since it only canonicalizes drive-letter case and slash direction, never resolves cwd.
    filePath = resolveIndexPath(rawFilePath, cwd ?? process.cwd())
    spec = (colonIdx === -1 ? filePath : filePath + specWithoutRange.slice(colonIdx)) + rangeSuffix
  }
  return { sub, spec, filePath }
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
 * Returns true when the command is a read-only `gh api` GET whose response is
 * safe to cache: not GraphQL (always a POST query), no mutating method, and no
 * request-body/field flags (gh defaults to POST when -f/-F/--field/--raw-field/--input
 * are present). An explicit `--method GET` / `-X GET` is honored even with other
 * flags. An embedded Authorization header is skipped so a credential is never
 * persisted into the cached command string.
 */
function isReadOnlyGhApi(cmd: string): boolean {
  if (!/^gh\s+api\b/.test(cmd)) return false
  if (/\bgraphql\b/.test(cmd)) return false
  if (/-H\s+['"]?Authorization/i.test(cmd)) return false
  if (/(?:-X|--method)\s+GET\b/i.test(cmd)) return true
  if (/(?:-X|--method)\s+(?:POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i.test(cmd)) return false
  if (/\s(?:-f|-F|--field|--raw-field|--input)\b/.test(cmd)) return false
  return true
}

const GH_VIEW_BATCH_HINT_KEY = 'gh-view-field-batch'

const GH_VIEW_RE = /^gh\s+(pr|issue)\s+view\b(.*)$/i

/** Detects a read-only `gh pr view`/`gh issue view` that is NOT already batching fields, returning the subcommand and the positional ref (PR/issue number or branch, undefined for the current-branch form) so a concrete `--json a,b,c` example can be built. Returns null when the command already passes a multi-field `--json a,b` (the model is already batching, so no advisory) or is not a gh view. `gh pr view`/`gh issue view` have no mutating variant, so matching `view` is sufficient for the read-only guard. */
export function extractGhViewForBatchAdvisory(cmd: string): { sub: 'pr' | 'issue'; ref: string | undefined } | null {
  const m = GH_VIEW_RE.exec(cmd)
  if (!m) return null
  const sub = (m[1] ?? '').toLowerCase() === 'issue' ? 'issue' : 'pr'
  const rest = m[2] ?? ''
  // Already batching multiple --json fields (a comma-separated list) means the model is doing the right thing; do not advise.
  if (/--json\s+\S*,/.test(rest)) return null
  // First positional token that is not a flag is the PR/issue ref; its absence means the current-branch form.
  const refMatch = /^\s+(?!-)(\S+)/.exec(rest)
  const ref = refMatch?.[1]
  return { sub, ref }
}

/** Builds the one-time field-batching advisory for a `gh pr view`/`gh issue view`, naming a concrete batched `--json` example tailored to the subcommand and the viewed ref. */
function buildGhViewBatchAdvisory(sub: 'pr' | 'issue', ref: string | undefined): string {
  const target = ref ? ref + ' ' : ''
  const fields = sub === 'pr' ? 'number,title,state,body,labels,reviews,files' : 'number,title,state,body,labels,comments'
  const example = 'gh ' + sub + ' view ' + target + '--json ' + fields
  return '`gh ' + sub + ' view` field queries can be batched: fetch every field you need in one round-trip with `' + example + '` (slice it with `--jq`) instead of querying field-by-field across multiple calls.'
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
/** Single-quote a string as one POSIX shell argument (escapes embedded quotes). */
function shellQuoteSingle(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * True when `cmd` is a single command with no shell control operators — the same
 * shape {@link detectFromCommand} requires. Gates the generic-filter fallback so
 * a pipeline / compound / command-substitution / redirect is never wrapped (its
 * `&&`/`|`/`>` would confuse both the outer shell and the `compress -c` arg).
 */
function isCompressibleSingleCommand(cmd: string): boolean {
  if (!cmd || cmd.length > 65536) return false
  if (['&&', '||', '$(', '`'].some((op) => cmd.includes(op))) return false
  if (cmd.includes('|') || cmd.includes(';')) return false
  if (/[<>]/.test(cmd)) return false
  return true
}

/**
 * Wrap a recognized command in `token-goat compress` so its output is
 * structurally compressed on this run. Returns a `rewriteInput` HookOutput that
 * replaces the Bash tool input wholesale (preserving description/timeout), or
 * null when compression is disabled (`TOKEN_GOAT_BASH_COMPRESS=0` or config),
 * the command is unsuitable, or the chosen filter is disabled.
 *
 * @param event  hook event; its toolInput is preserved verbatim except `command`
 * @param rawCmd original command INCLUDING any `cd … &&` prefix (run by compress)
 * @param cmd    the cd-stripped command, used only to pick the filter
 */
function maybeCompressRewrite(event: HookEvent, rawCmd: string, cmd: string): HookOutput | null {
  if (process.env['TOKEN_GOAT_BASH_COMPRESS'] === '0') return null
  let cfg: { enabled: boolean; disabled_filters: string[]; timeout_seconds: number }
  try {
    cfg = loadConfig().bash_compress
  } catch {
    return null
  }
  if (!cfg.enabled) return null
  // No usable shell to run the wrapper under (Windows with no Git-Bash): leave the command to run normally in the harness bash, uncompressed, rather than wrapping it into a cmd.exe execution.
  if (!canRunWrappedShell()) return null

  // A specific filter (once the framework recognizes the command) wins over the generic catch-all. Either way the command must be a single pipe/redirect-free invocation: detectFromCommand enforces that for specific filters; the generic path requires it explicitly.
  const detected = detectFromCommand(cmd)
  let filterName: string
  if (detected !== null) {
    filterName = detected.filter.name
  } else if (isCompressibleSingleCommand(cmd)) {
    filterName = 'generic'
  } else {
    return null
  }
  if (cfg.disabled_filters.includes(filterName)) return null

  const wrapped = `token-goat compress -f ${filterName} --timeout ${cfg.timeout_seconds} -c ${shellQuoteSingle(rawCmd)}`
  return { hookType: 'rewriteInput', updatedInput: { ...event.toolInput, command: wrapped } }
}

/**
 * Recover the original command from a `token-goat compress … -c <cmd>` wrapper
 * (the rewrite emitted by {@link maybeCompressRewrite}) so the post-hook keys its
 * output cache on the original command — identical to the hash the pre-hook
 * computed before the rewrite. Returns null for any non-wrapper command.
 */
function unwrapCompressCommand(executed: string): string | null {
  const t = executed.trim()
  if (!/^token-goat\s+compress\b/.test(t)) return null
  let argv: string[]
  try {
    argv = shlexSplit(t)
  } catch {
    return null
  }
  for (let i = 0; i + 1 < argv.length; i++) {
    const tok = argv[i]
    if (tok === '-c' || tok === '--cmd') return argv[i + 1] ?? null
  }
  return null
}

/**
 * Detect unbalanced shell quoting or unterminated heredocs in a bash command.
 * Returns a human-readable reason string if a clear syntax error is found,
 * or null if the command appears syntactically valid.
 *
 * Conservative approach: only flags unambiguous errors. Better to miss a false
 * negative (let a broken command run and fail naturally) than to false-positive
 * on valid constructs like `git commit -m "don't do that"` (single quote in
 * double quotes).
 */
function detectUnbalancedShellSyntax(cmd: string): string | null {
  let inSingle = false
  let inDouble = false
  let i = 0

  // State machine: track whether we're inside single or double quotes
  while (i < cmd.length) {
    const ch = cmd[i]

    if (inSingle) {
      // Inside single quotes: only ' can toggle the state (no escaping possible)
      if (ch === "'") {
        inSingle = false
      }
      i++
      continue
    }

    if (inDouble) {
      // Inside double quotes: " toggles unless it's escaped with \
      if (ch === '\\' && i + 1 < cmd.length) {
        // Skip the next character (it's escaped)
        i += 2
        continue
      }
      if (ch === '"') {
        inDouble = false
      }
      i++
      continue
    }

    // Bare code (outside quotes)

    // Backslash-escapes the next character (real bash semantics outside a string): a `\"`
    // or `\'` here is a literal character, not a quote open — skip both without toggling
    // any quote state.
    if (ch === '\\' && i + 1 < cmd.length) {
      i += 2
      continue
    }

    // Arithmetic expansion `$(( ... ))`: skip the whole span as opaque (tracking nested
    // parens) so a shift operator like `<<`/`>>` inside it is never mistaken for a heredoc
    // redirect.
    if (ch === '$' && cmd[i + 1] === '(' && cmd[i + 2] === '(') {
      let depth = 2
      let j = i + 3
      while (j < cmd.length && depth > 0) {
        if (cmd[j] === '(') depth++
        else if (cmd[j] === ')') depth--
        j++
      }
      i = j
      continue
    }

    // A `#` that starts a word (preceded by whitespace, or at the very start of the command)
    // opens a real shell comment running to end of line — quote-like characters in it (e.g.
    // an apostrophe in "don't") are literal text, not shell syntax.
    if (ch === '#' && (i === 0 || /\s/.test(cmd[i - 1] ?? ''))) {
      const nl = cmd.indexOf('\n', i)
      i = nl === -1 ? cmd.length : nl + 1
      continue
    }

    if (ch === "'") {
      inSingle = true
      i++
      continue
    }

    if (ch === '"') {
      inDouble = true
      i++
      continue
    }

    // Check for heredoc syntax: <<[-~]?WORD or <<[-~]?'WORD' or <<[-~]?"WORD"
    if (ch === '<' && i + 1 < cmd.length && cmd[i + 1] === '<') {
      // Check for here-string (<<<) and skip it as bare code
      if (i + 2 < cmd.length && cmd[i + 2] === '<') {
        i += 3
        continue
      }
      let j = i + 2
      // Optional - or ~ modifier for indented heredoc
      let hasIndentModifier = false
      if (j < cmd.length && (cmd[j] === '-' || cmd[j] === '~')) {
        hasIndentModifier = true
        j++
      }
      // Skip whitespace
      while (j < cmd.length && cmd[j] === ' ') {
        j++
      }
      if (j < cmd.length) {
        // Check for optional quotes around the delimiter
        let delimStart = j
        if (cmd[j] === '"' || cmd[j] === "'") {
          delimStart = j + 1
          // Find closing quote
          const quoteChar = cmd[j]
          let delimEnd = delimStart
          while (delimEnd < cmd.length && cmd[delimEnd] !== quoteChar) {
            delimEnd++
          }
          if (delimEnd >= cmd.length) {
            // Unclosed quote in heredoc opener — that's already a syntax error
            return 'an unclosed quote in a heredoc opener'
          }
          j = delimEnd + 1
        } else {
          // Unquoted delimiter: continue until space, newline, or special char
          let delimEnd = delimStart
          while (delimEnd < cmd.length && /\w/.test(cmd.charAt(delimEnd))) {
            delimEnd++
          }
          j = delimEnd
        }
        // Extract the delimiter word
        const delimiter = cmd.slice(delimStart, j).replace(/["']/g, '')
        if (delimiter) {
          // Scan line-by-line from the end of the opener to find the terminator,
          // tracking exact offsets so a match lets us skip the whole heredoc body.
          // The body is literal shell text, not shell syntax — a stray apostrophe
          // in prose like "it's" must not be rescanned as a quote delimiter.
          let scanPos = j
          let terminatorEnd = -1
          while (scanPos <= cmd.length) {
            const nl = cmd.indexOf('\n', scanPos)
            const lineEnd = nl === -1 ? cmd.length : nl
            let line = cmd.slice(scanPos, lineEnd)
            // Strip trailing backslash-r (CRLF line ending) to match closing delimiter
            if (line.endsWith('\r')) {
              line = line.slice(0, -1)
            }
            const isMatch = hasIndentModifier ? line.trim() === delimiter : line === delimiter
            if (isMatch) {
              terminatorEnd = nl === -1 ? cmd.length : nl + 1
              break
            }
            if (nl === -1) break
            scanPos = nl + 1
          }
          if (terminatorEnd === -1) {
            return `an unterminated heredoc (${delimiter} never appears on its own line)`
          }
          // Skip past the entire heredoc body before resuming the scan.
          i = terminatorEnd
          continue
        }
      }
    }

    i++
  }

  // Final check: unbalanced quotes
  if (inSingle) {
    return 'an unclosed single quote'
  }
  if (inDouble) {
    return 'an unclosed double quote'
  }

  return null
}

export function preBashHandler(event: HookEvent): HookOutput {
  const rawCmd = extractCommand(event)
  if (rawCmd === undefined) return passOutput()
  const cmd = stripCdPrefix(rawCmd)
  const cdStripped = cmd !== rawCmd
  // The bash event's cwd, used to resolve any relative file path the same way the CLI/shell
  // itself would — hoisted here (rather than computed right before its first use) so every
  // path-keyed dedup check below (sed line-ranges, CLI surgical reads) shares one resolution.
  const preHookCwd = typeof event.raw['cwd'] === 'string' ? event.raw['cwd'] : null
  // When a cd prefix was stripped, path-based hints below resolve their filePath against the
  // directory that cd would actually leave the shell in, not this hook's own cwd.
  const hintCwd = preHookCwd ?? process.cwd()

  // Check for unbalanced shell quoting or unterminated heredocs
  const cfg = loadConfig()
  if (cfg.hints.warn_unbalanced_shell_quoting) {
    const quoteError = detectUnbalancedShellSyntax(cmd)
    if (quoteError !== null) {
      recordStat('session_hint', 0, 0)
      return contextOutput(
        'This command has ' + quoteError + '. If you\'re writing a multi-line string with embedded quotes or special characters, consider using the Write tool instead — it avoids shell quoting issues entirely.',
      )
    }
  }

  // Item 3: task output file — already cached, recall with bash-output
  const taskOutput = extractTasksOutput(cmd)
  if (taskOutput !== null) {
    const { id, path: outPath, n } = taskOutput
    recordStat('session_hint', 0, 0)
    const tail = n ?? 50
    return denyOutput(
      'Task output ' + id + ' is a JSONL agent transcript on disk. Use `token-goat bash-output --file "' + outPath + '" --transcript` to read the assistant text, then narrow with `--grep PATTERN` or `--tail ' + tail + '`, or read a specific line range (the only way to reach the MIDDLE of a large artifact) with `token-goat read "' + outPath + '@START-END"`, instead of reading the whole file.',
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

  // Item 4b: sed line-range extraction — replaced with extractSedRange to provide specific line range
  const sedRange = extractSedRange(cmd)
  if (sedRange !== null) {
    const { filePath, ranges } = sedRange
    recordStat('session_hint', 0, 0)
    // Dedup on the resolved/normalized path (relative-to-absolute, cwd-anchored, drive-letter-
    // cased) — a relative and an absolute reference to the same file must collide under one
    // key, matching how the CLI surgical-read dedup above already resolves paths. The raw
    // filePath is kept for the hint text itself so existing relative-path hints are unchanged.
    // Multi-range `sed -n 'A,Bp;C,Dp'` commands are checked and recorded per-range (not as one
    // combined min-max span) so a gap between ranges that was already read separately doesn't
    // get misreported as newly-overlapping, and so each range's own history is tracked.
    const sedDedupKey = resolveIndexPath(filePath, preHookCwd ?? process.cwd())
    const overlapHints: string[] = []
    const freshRanges: Array<readonly [number, number]> = []
    for (const [start, end] of ranges) {
      const priorOverlap = findRangeOverlap(getFileLineRanges(sedDedupKey), start, end)
      recordFileLineRange(sedDedupKey, start, end)
      if (priorOverlap !== null) {
        overlapHints.push(sedOverlapHint(filePath, priorOverlap, start, end))
      } else {
        freshRanges.push([start, end])
      }
    }
    const hints = [...overlapHints]
    if (freshRanges.length > 0) hints.push(sedRangeHint(filePath, freshRanges))
    return contextOutput(hints.join(' '))
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
    const { filePath, isDoc, isEnv, isConfig, isSql, cmd0 } = catResult
    const hintPath = cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath
    recordStat('session_hint', 0, 0)
    if (isSql) {
      return contextOutput(
        '`' + cmd0 + '` loads the entire file into context. Use `token-goat section "' + hintPath + '::table_name"` to pull one CREATE TABLE / CREATE TYPE block.',
      )
    }
    const hint = isEnv
      ? 'Use `token-goat config-get "' + hintPath + '" KEY_NAME` to read a specific variable.'
      : isConfig
        ? 'Use `token-goat config-get "' + hintPath + '" KEY_NAME` or `token-goat section "' + hintPath + '::sectionName"` to read a specific value.'
        : isDoc
          ? 'Use `token-goat section "' + hintPath + '::SectionHeading"` to read one section.'
          : 'Use `token-goat read "' + hintPath + '::SymbolName"` to read one function or class.'
    return cdStripped ? contextOutput('`' + cmd0 + '` loads the entire file into context. ' + hint) : denyOutput('`' + cmd0 + '` loads the entire file into context. ' + hint)
  }

  const catMulti = extractCatFilesMulti(cmd)
  if (catMulti !== null) {
    recordStat('session_hint', 0, 0)
    const cmd0 = catMulti[0]!.cmd0
    const perPath = catMulti.map(({ filePath, isDoc, isEnv, isConfig, isSql }) => {
      const hintPath = cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath
      const how = isSql
        ? 'token-goat section "' + hintPath + '::table_name"'
        : isEnv || isConfig
          ? 'token-goat config-get "' + hintPath + '" KEY_NAME'
          : isDoc
            ? 'token-goat section "' + hintPath + '::SectionHeading"'
            : 'token-goat read "' + hintPath + '::SymbolName"'
      return '  ' + hintPath + ' -> `' + how + '`'
    })
    const msg =
      '`' + cmd0 + '` on multiple files loads them all into context. Read each surgically instead:\n' + perPath.join('\n')
    return cdStripped ? contextOutput(msg) : denyOutput(msg)
  }

  const psGetContentResult = extractPowerShellWrappedGetContent(cmd)
  if (psGetContentResult !== null) {
    const { filePath, isDoc, isEnv, isConfig, isSql } = psGetContentResult
    const hintPath = cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath
    recordStat('session_hint', 0, 0)
    const lead = '`Get-Content` via a `powershell -Command` wrapper bypasses read hooks and loads the entire file into context. '
    if (isSql) {
      return cdStripped
        ? contextOutput(lead + 'Use `token-goat section "' + hintPath + '::table_name"` to pull one CREATE TABLE / CREATE TYPE block.')
        : denyOutput(lead + 'Use `token-goat section "' + hintPath + '::table_name"` to pull one CREATE TABLE / CREATE TYPE block.')
    }
    const hint = isEnv
      ? 'Use `token-goat config-get "' + hintPath + '" KEY_NAME` to read a specific variable.'
      : isConfig
        ? 'Use `token-goat config-get "' + hintPath + '" KEY_NAME` or `token-goat section "' + hintPath + '::sectionName"` to read a specific value.'
        : isDoc
          ? 'Use `token-goat section "' + hintPath + '::SectionHeading"` to read one section.'
          : 'Use `token-goat read "' + hintPath + '::SymbolName"` to read one function or class.'
    return cdStripped ? contextOutput(lead + hint) : denyOutput(lead + hint)
  }

  const wslCatResult = extractWslCatFile(cmd)
  if (wslCatResult !== null) {
    const { filePath, isDoc, isEnv, isConfig, isSql } = wslCatResult
    const hintPath = cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath
    recordStat('session_hint', 0, 0)
    if (isSql) {
      return contextOutput(
        '`cat` loads the entire file into context. Use `token-goat section "' + hintPath + '::table_name"` to pull one CREATE TABLE / CREATE TYPE block.',
      )
    }
    const hint = isEnv
      ? 'Use `token-goat config-get "' + hintPath + '" KEY_NAME` to read a specific variable.'
      : isConfig
        ? 'Use `token-goat config-get "' + hintPath + '" KEY_NAME` or `token-goat section "' + hintPath + '::sectionName"` to read a specific value.'
        : isDoc
          ? 'Use `token-goat section "' + hintPath + '::SectionHeading"` to read one section.'
          : 'Use `token-goat read "' + hintPath + '::SymbolName"` to read one function or class.'
    return cdStripped ? contextOutput('`cat` loads the entire file into context. ' + hint) : denyOutput('`cat` loads the entire file into context. ' + hint)
  }

  const pyRead = extractPythonFileRead(cmd)
  if (pyRead !== null) {
    const { filePath, isDoc, isTranscript } = pyRead
    const hintPath = cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath
    recordStat('session_hint', 0, 0)
    if (isTranscript) {
      const tHint = '`.output` files are JSONL agent transcripts. Use `token-goat bash-output --file "' + hintPath + '" --transcript` to read the assistant text, then narrow with `--grep PATTERN` or `--tail N`, instead of hand-parsing the JSONL.'
      return cdStripped ? contextOutput(tHint) : denyOutput(tHint)
    }
    const hint = isDoc
      ? 'Use `token-goat section "' + hintPath + '::SectionHeading"` to read one section.'
      : 'Use `token-goat read "' + hintPath + '::SymbolName"` to extract a specific symbol.'
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

  const gcTailResult = extractGetContentTail(cmd)
  if (gcTailResult !== null) {
    const { filePath, isDoc } = gcTailResult
    const hint = isDoc
      ? 'Use `token-goat section "' + filePath + '::SectionHeading"` to read one section.'
      : 'Use `token-goat read "' + filePath + '::SymbolName"` or `token-goat skeleton "' + filePath + '"` to see the file structure.'
    recordStat('session_hint', 0, 0)
    return contextOutput('`Get-Content -Tail` bypasses read hooks. ' + hint)
  }

  const gcSelectResult = extractGetContentSelectFirst(cmd)
  if (gcSelectResult !== null) {
    const { filePath, isDoc, isConfig } = gcSelectResult
    const hint = isConfig
      ? 'Use `token-goat config-get "' + filePath + '" KEY_NAME` or `token-goat section "' + filePath + '::sectionName"` to read a specific value.'
      : isDoc
        ? 'Use `token-goat section "' + filePath + '::SectionHeading"` to read one section.'
        : 'Use `token-goat read "' + filePath + '::SymbolName"` or `token-goat skeleton "' + filePath + '"` to see the file structure.'
    recordStat('session_hint', 0, 0)
    return contextOutput('`Select-Object -First` bypasses read hooks. ' + hint)
  }

  const nodeRead = extractNodeFileRead(cmd)
  if (nodeRead !== null) {
    const { filePath, isDoc, isConfig } = nodeRead
    const hintPath = cdStripped ? resolveCdHintPath(rawCmd, filePath, hintCwd) : filePath
    const hint = isDoc
      ? 'Use `token-goat section "' + hintPath + '::SectionHeading"` to read one section.'
      : isConfig
        ? 'Use `token-goat config-get "' + hintPath + '" KEY_NAME` or `token-goat section "' + hintPath + '::sectionName"` to read a specific value.'
        : 'Use `token-goat read "' + hintPath + '::SymbolName"` to extract a specific symbol.'
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

  // Markdown heading grep: `grep -n "^#" SKILL.md` → outline hint (before structural search so .md heading patterns don't get misrouted to the symbol-search advice)
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
    // Only emit the recall hint if the content entry is actually present (the session index may name an id whose blob was pruned) and not stale — a matching id whose stored git/dir/lockfile fingerprint no longer matches the current state means the source changed since it was cached, so it must not be recalled as fresh.
    const monEntryRaw = monOutputId !== null ? getBashOutput(monOutputId) : null
    const monEntry = monEntryRaw !== null && !isBashEntryStale(monEntryRaw, cmd, preHookCwd) ? monEntryRaw : null
    if (monOutputId !== null && monEntry !== null) {
      const monBytes = monEntry.sizeBytes
      const catFile = extractCatSourceFile(cmd)
      if (catFile !== null) {
        recordStat('bash_compress:recall', monBytes, Math.round(monBytes / 4))
        return contextOutput(
          'Prior output from `' + cmd + '`' + pipelineDivergenceNote(cmd, monEntry.command) + ' is cached. ' +
          'Use `token-goat bash-output ' + monOutputId + '` to recall the full file, or ' +
          '`token-goat read \'' + catFile + '::SymbolName\'` to extract only the symbol you need.'
        )
      }
      const cmdSummary = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
      recordStat('bash_compress:recall', monBytes, Math.round(monBytes / 4))
      return contextOutput(
        'Prior output from `' + cmdSummary + '`' + pipelineDivergenceNote(cmd, monEntry.command) + ' is cached.\n' +
        'Use `token-goat bash-output ' + monOutputId + ' ' + monitoringHint + '` to re-inspect without re-running.'
      )
    }
  }

  // Item 2: curl -o download recall — keyed by URL so a re-download to a different temp path still gets a recall hint pointing to the previously saved file.
  const curlDl = extractCurlDownload(cmd)
  if (curlDl !== null) {
    const prevPath = getCurlDownloadPath(curlDl.url)
    if (prevPath !== null && !existsSync(resolveIndexPath(prevPath, preHookCwd ?? process.cwd()))) {
      // The previously downloaded file is gone (deleted/moved since). Forget the
      // stale session record and let the re-download proceed instead of denying.
      clearCurlDownload(curlDl.url)
    } else if (prevPath !== null) {
      recordStat('session_hint', 0, 0)
      return denyOutput(
        'Already downloaded to ' + prevPath + ' earlier this session. ' +
        'Use `rg \'<pattern>\' ' + prevPath + '` to search it, or ' +
        '`token-goat read "' + prevPath + '::SectionName"` to read a part of it.',
      )
    }
  }

  // curl GET recall — emit a hint when the same URL was already fetched this session. Key on URL only (not the full command) so `curl <url> | jq …` and `curl <url> | python3 …` share the same cache entry.
  if (isCurlGetCommand(cmd)) {
    const curlCacheKey = extractCurlUrl(cmd) ?? cmd
    const curlHash = shortFingerprint(curlCacheKey)
    const curlOutputId = getBashOutputId(curlHash)
    // Guard on the content entry and its freshness, not just the index (see the monitoring case above).
    const curlEntryRaw = curlOutputId !== null ? getBashOutput(curlOutputId) : null
    const curlEntry = curlEntryRaw !== null && !isBashEntryStale(curlEntryRaw, cmd, preHookCwd) ? curlEntryRaw : null
    if (curlOutputId !== null && curlEntry !== null) {
      const curlBytes = curlEntry.sizeBytes
      recordStat('bash_compress:recall', curlBytes, Math.round(curlBytes / 4))
      const curlPreview = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
      return contextOutput(
        'curl response cached (`' + curlPreview + '`).' + pipelineDivergenceNote(cmd, curlEntry.command) + ' ' +
        'Use `token-goat bash-output ' + curlOutputId + '` to recall it. ' +
        'Append `--grep PATTERN` to filter or `--section HeadingName` for a markdown section.',
      )
    }
  }

  // gh api recall — emit a hint when the same read-only `gh api` GET was already run this session. Key on the command minus output pipes/redirects (endpoint + flags), matching the post-side cache key.
  if (isReadOnlyGhApi(cmd)) {
    const ghHash = shortFingerprint(stripOutputPipeline(cmd))
    const ghOutputId = getBashOutputId(ghHash)
    const ghEntryRaw = ghOutputId !== null ? getBashOutput(ghOutputId) : null
    const ghEntry = ghEntryRaw !== null && !isBashEntryStale(ghEntryRaw, cmd, preHookCwd) ? ghEntryRaw : null
    if (ghOutputId !== null && ghEntry !== null) {
      const ghBytes = ghEntry.sizeBytes
      recordStat('bash_compress:recall', ghBytes, Math.round(ghBytes / 4))
      const ghPreview = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
      return contextOutput(
        'gh api response cached (`' + ghPreview + '`).' + pipelineDivergenceNote(cmd, ghEntry.command) + ' ' +
        'Use `token-goat bash-output ' + ghOutputId + '` to recall it. ' +
        "Append `--jq '.field'` on the original call, or `--grep PATTERN` / `--max-matches N` here, to narrow it.",
      )
    }
  }

  // Scoped git status / git diff --stat recall — `git status --porcelain -- <path>` or
  // `git diff --stat -- <path>` is byte-identical on every rerun until HEAD moves or the
  // working tree changes. The `gitMutable` fingerprint already attached in
  // computeBashFingerprints (HEAD sha + `git status --porcelain` hash) invalidates the
  // instant either happens — including an edit to the scoped path recorded through the
  // normal postEditHandler/dirty-queue flow, since that edit shows up in `git status
  // --porcelain` regardless of whether the reindex queue has drained yet — so this reuses
  // the same staleness check as monitoring/curl/gh-api recall above rather than a bespoke one.
  if (isScopedGitStatusOrDiffStatCommand(cmd)) {
    const gitScopedHash = shortFingerprint(stripOutputPipeline(cmd))
    const gitScopedOutputId = getBashOutputId(gitScopedHash)
    const gitScopedEntryRaw = gitScopedOutputId !== null ? getBashOutput(gitScopedOutputId) : null
    const gitScopedEntry = gitScopedEntryRaw !== null && !isBashEntryStale(gitScopedEntryRaw, cmd, preHookCwd) ? gitScopedEntryRaw : null
    if (gitScopedOutputId !== null && gitScopedEntry !== null) {
      const gitScopedBytes = gitScopedEntry.sizeBytes
      recordStat('bash_compress:recall', gitScopedBytes, Math.round(gitScopedBytes / 4))
      const gitScopedPreview = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
      return contextOutput(
        'Output from `' + gitScopedPreview + '`' + pipelineDivergenceNote(cmd, gitScopedEntry.command) + ' is cached and unchanged (no edits to that path or HEAD since). ' +
        'Use `token-goat bash-output ' + gitScopedOutputId + '` to recall it instead of re-running.',
      )
    }
  }

  // CLI surgical-read dedup: warn on an exact repeat `token-goat symbol|read|section` invocation, and cross-check against the Read-tool ledger (a file already fully Read this session may already cover the same content).
  const tgRead = extractTgSurgicalRead(cmd, preHookCwd)
  if (tgRead !== null) {
    const cliKey = tgRead.sub + '::' + tgRead.spec
    const notes = []
    if (wasCliReadThisSession(cliKey)) {
      notes.push('You already ran this exact `token-goat ' + tgRead.sub + '` query earlier this session — check your context above before re-running it.')
    }
    if (tgRead.filePath !== null && wasFileReadThisSession(tgRead.filePath)) {
      notes.push('`' + tgRead.filePath + '` was already fully read via the Read tool this session — that content may already cover this.')
    }
    if (notes.length > 0) {
      recordStat('session_hint', 0, 0)
      return contextOutput(notes.join(' '))
    }
    return passOutput()
  }

  // Recognized command: recall a cached prior run, else compress this run. detectFromCommand matches a specific filter (none until the filters land); isBuildCommand is the generic-filter gate for build/test tools.
  if (!isBuildCommand(cmd) && detectFromCommand(cmd) === null) return passOutput()

  // Derive the same command hash used by the session store.
  const cmdHash = shortFingerprint(stripOutputPipeline(cmd))
  const outputId = getBashOutputId(cmdHash)
  // A cached prior run wins: recall it instead of re-running (and re-compressing). Guard on the content blob and its freshness — a pruned id would make `bash-output <id>` error, and a stale fingerprint means the source changed since the output was cached.
  const entryRaw = outputId !== null ? getBashOutput(outputId) : null
  const entry = entryRaw !== null && !isBashEntryStale(entryRaw, cmd, preHookCwd) ? entryRaw : null
  if (outputId !== null && entry !== null) {
    const bytes = entry.sizeBytes
    recordStat('bash_compress:recall', bytes, Math.round(bytes / 4))
    return contextOutput(buildRecallHint(cmd, outputId))
  }

  // First run of a recognized command → transparently wrap it in the compressor so its output is structurally compressed before it reaches the model.
  return maybeCompressRewrite(event, rawCmd, cmd) ?? passOutput()
}

registerHook('pre_tool_use', preBashHandler, { toolName: 'Bash' })

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
  // Large-response nudge: only a JSON object can carry the 15+ boilerplate fields this targets, so skip the parse entirely unless the body looks like one (avoids parsing huge non-JSON logs).
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
    const rawCmdRaw = extractCommand(event)
    if (rawCmdRaw === undefined) return passOutput()
    // If the pre-hook rewrote this into a `token-goat compress` wrapper, recover the original command so the cache keys on it (matching the pre-hook hash).
    const rawCmd = unwrapCompressCommand(rawCmdRaw) ?? rawCmdRaw
    const cmd = stripCdPrefix(rawCmd)
    const output = extractBashOutput(event.raw)
    const exitCode = extractExitCode(event.raw)
    const cwd = typeof event.raw['cwd'] === 'string' ? event.raw['cwd'] : null
    // Matches MIN_CACHE_BYTES's old hardcoded value as the config default, so an
    // untouched install sees identical behavior; a configured cache_min_bytes now
    // actually moves the floor instead of being silently ignored.
    const cacheMinBytes = loadConfig().bash_compress.cache_min_bytes

    // Item 2: record curl -o downloads by URL for cross-command dedup — only after confirming
    // the download actually succeeded. Recording it unconditionally (before checking exit code
    // or that the file landed on disk) meant a FAILED curl (network error, 404, ...) still got
    // recorded as if it succeeded, and the recall-deny above would then block the user from
    // ever retrying the same download.
    const curlDl = extractCurlDownload(cmd)
    if (curlDl !== null && (exitCode === null || exitCode === 0)) {
      const resolvedOutputPath = resolveIndexPath(curlDl.outputPath, cwd ?? process.cwd())
      if (existsSync(resolvedOutputPath)) {
        recordCurlDownload(curlDl.url, curlDl.outputPath)
      }
    }

    // `gh api` advisory hints: scope/permission nudge and large-JSON --jq nudge. These commands are not cached (not build/monitoring/curl-GET), so emit the hint and return here.

    // Record a successful `token-goat symbol|read|section` invocation so a later identical call gets the re-read dedup hint from the pre-hook.
    const tgRead = extractTgSurgicalRead(cmd, cwd)
    if (tgRead !== null && (exitCode === null || exitCode === 0)) {
      recordCliRead(tgRead.sub + '::' + tgRead.spec)
      // Record a surgical (symbol/section/range-scoped) read against the file's
      // session entry so compact.ts's symbolsBonus can reward narrowly-engaged
      // files. `spec` for read/section is `filePath` + a narrowing suffix
      // (`::symbol`, `::heading`, and/or `@line-range`); an empty suffix means a
      // whole-file `token-goat read <file>`, which is not symbol-scoped and is
      // left out. `symbol`/`skill-*` subcommands carry no filePath and are skipped.
      if (tgRead.filePath !== null) {
        const narrowing = tgRead.spec.slice(tgRead.filePath.length)
        if (narrowing.length > 0) recordSymbolRead(tgRead.filePath, narrowing.replace(/^::/, ''))
      }
      if (tgRead.filePath !== null && loadConfig().hints.log_large_file_hint_outcomes) {
        const pendingSize = takePendingLargeFileHint(tgRead.filePath)
        if (pendingSize !== null) {
          recordStat('large_file_hint_followed', 0, 0, undefined, `${tgRead.filePath} (${pendingSize} bytes) — hint fired, then followed by a surgical token-goat read`)
        }
      }
    }

    // Cache a successful, read-only `gh api` GET so a later identical call recalls it instead of re-fetching. Done as a side effect before the advisory-hint return below, so a wide-JSON response is both nudged toward --jq and cached. Gated on exit 0 (and the shared size floor) so an error/permission body is never stored as content.
    if (isReadOnlyGhApi(cmd) && (exitCode === null || exitCode === 0) && Buffer.byteLength(output, 'utf-8') >= cacheMinBytes) {
      const ghCacheHash = shortFingerprint(stripOutputPipeline(cmd))
      const ghCacheId = await storeBashOutput(cmd, output, exitCode ?? 0, cwd)
      recordBashOutput(ghCacheHash, ghCacheId, Buffer.byteLength(output, 'utf-8'))
    }

    const ghHint = buildGhApiHint(cmd, output, exitCode)
    if (ghHint !== null) {
      recordStat('session_hint', 0, 0)
      return contextOutput(ghHint)
    }

    // One-time field-batching advisory: on the first successful read-only `gh pr view`/`gh issue view` this session, nudge toward a single batched `--json a,b,c` instead of querying field-by-field across many calls. Cache the output inline first (as the monitoring path would) so a later identical view still recalls, then return the advisory.
    const ghView = extractGhViewForBatchAdvisory(cmd)
    if (ghView !== null && (exitCode === null || exitCode === 0) && !wasHintShown(GH_VIEW_BATCH_HINT_KEY)) {
      markHintShown(GH_VIEW_BATCH_HINT_KEY)
      if (Buffer.byteLength(output, 'utf-8') >= cacheMinBytes) {
        const ghViewId = await storeBashOutput(cmd, output, exitCode ?? 0, cwd)
        recordBashOutput(shortFingerprint(stripOutputPipeline(cmd)), ghViewId, Buffer.byteLength(output, 'utf-8'))
      }
      recordStat('session_hint', 0, 0)
      return contextOutput(buildGhViewBatchAdvisory(ghView.sub, ghView.ref))
    }

    // Cache a successful scoped `git status`/`git diff --stat -- <path>` so a later identical
    // call recalls it instead of re-running (see isScopedGitStatusOrDiffStatCommand above).
    // Gated on exit 0 and the shared size floor, same as the gh-api cache above; staleness is
    // enforced entirely by the `gitMutable` fingerprint recorded via computeBashFingerprints
    // (HEAD sha + `git status --porcelain` hash), not a separate mechanism.
    if (isScopedGitStatusOrDiffStatCommand(cmd) && (exitCode === null || exitCode === 0) && Buffer.byteLength(output, 'utf-8') >= cacheMinBytes) {
      const gitScopedCacheHash = shortFingerprint(stripOutputPipeline(cmd))
      const gitScopedCacheId = await storeBashOutput(cmd, output, exitCode ?? 0, cwd)
      recordBashOutput(gitScopedCacheHash, gitScopedCacheId, Buffer.byteLength(output, 'utf-8'))
    }

    // Only cache monitoring, build, and curl GET commands — not generic shell commands.
    const isMonitoring = getMonitoringRecallHint(cmd) !== null
    if (!isMonitoring && !isBuildCommand(cmd) && !isCurlGetCommand(cmd)) return passOutput()

    if (Buffer.byteLength(output, 'utf-8') < cacheMinBytes) return passOutput()

    // For curl GET commands, key the cache on the URL so that the same endpoint fetched with different downstream pipes (| jq vs | python3) shares a single cache entry.
    const cacheKey = isCurlGetCommand(cmd) ? (extractCurlUrl(cmd) ?? cmd) : stripOutputPipeline(cmd)
    const simpleHash = shortFingerprint(cacheKey)
    const id = await storeBashOutput(cmd, output, exitCode ?? 0, cwd)
    recordBashOutput(simpleHash, id, Buffer.byteLength(output, 'utf-8'))
  } catch {
    // Never block — hook failures must be silent.
  }
  return passOutput()
}

registerHook('post_tool_use', postBashHandler, { toolName: 'Bash' })
