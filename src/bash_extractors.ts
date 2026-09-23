/**
 * Command line extractors, classification, and surgical hint builders for bash hook handlers.
 */
import { statSync, openSync, readSync, closeSync } from 'node:fs'

import { isUnderSystemTemp, escapesOntoNetworkThroughLinks } from './project.js'
import { preToolPathDeclined } from './vscode_path_gate.js'
import { resolveIndexPath, normalizePath, TOOL_RESULTS_ID_CHARS } from './paths.js'
import type { HookEvent } from './hook_registry.js'
import { hasBareBackgroundOrNewline, hasUnquotedOperator, isRedirectAmpersand } from './tool_filters/index.js'
import { getFileLineRanges } from './session.js'
import { escapeRegExp } from './util.js'

// bash_extractors.ts has no index/DB access (adding one pulled index_reader.js's chunk into the eagerly-loaded core bundle, tripping the ceiling tests/guards/core_bundle_stays_split.test.ts enforces), so a whole-file-dump hint built here can never confirm a real symbol name the way hooks_read.ts::realSymbolReadHint can for its own Read-hook deny sites -- `outline` is always true and never claims a specific but possibly-fake `::SymbolName`.
function genericSurgicalFallback(shown: string): string {
  return '`token-goat outline "' + shown + '"`'
}

/**
 * Shared non-SQL surgical-read hint ladder for whole-file dump commands (`cat`, a PowerShell `Get-Content` wrapper, `wsl cat`) -- each caller handles its own SQL-specific hint and lead-in text, then falls through to this for the rest.
 */
// Every caller passes a hintPath already through displaySafePath, because the path here comes out of the shell command's own arguments and so is whatever a repository named its files, while the hint is delivered on the context channel, which unlike the deny channel neither fences its payload nor escapes the markers token-goat speaks in. Sanitizing at the fifteen assignment sites rather than at the thirty interpolations below is what keeps that invariant checkable, and it is the identity function on every path that does not contain a marker or a control character, so the index lookups keyed on the same value are unaffected for any real file.
export function surgicalHintFor(hintPath: string, isEnv: boolean, isConfig: boolean, isDoc: boolean, isXml = false, target: string | null = null): string {
  // The whole-file branches are a hard deny, so the sentence they print is the agent's only next
  // move, and the placeholders it used to print do not run: verified against the built binary on
  // 2026-09-21, `token-goat section "CHANGELOG.md::SectionHeading"` exits 1 with "Section
  // 'SectionHeading' not found" and `token-goat config-get "package.json" KEY_NAME` exits 1 with
  // "Key 'KEY_NAME' not found". `target`, when the caller could resolve one out of the index, is a
  // name that file really holds, so the command runs verbatim. A null target keeps the old
  // wording, which is exactly what shipped before. Resolution lives in bash_surgical_target.ts,
  // not here: this module has no index/DB access on purpose (see genericSurgicalFallback above).
  //
  // The config branch substitutes into the config-get half ONLY. Its `section "file::sectionName"`
  // half takes a section, and the name the index yields for a JSON/YAML file is a property --
  // measured, `token-goat section "package.json::name"` exits 1 while `token-goat config-get
  // "package.json" name` returns the value -- so putting the resolved name there would replace a
  // placeholder the agent knows to substitute with a broken command it has no reason to doubt.
  // With a real key in hand that half has nothing to add, and outline is offered instead: it is
  // always runnable and lists every key with its line range.
  const key = target ?? 'KEY_NAME'
  const section = target ?? 'SectionHeading'
  return isXml
    ? 'Use `token-goat xml-outline "' + hintPath + '"` to inspect structure, or `token-goat xml-query "' + hintPath + '" "<selector>"` to query specific nodes.'
    : isEnv
      ? 'Use `token-goat config-get "' + hintPath + '" ' + key + '` to read a specific variable.'
      : isConfig
        ? target === null
          ? 'Use `token-goat config-get "' + hintPath + '" KEY_NAME` or `token-goat section "' + hintPath + '::sectionName"` to read a specific value.'
          : 'Use `token-goat config-get "' + hintPath + '" ' + key + '` to read a specific value, or ' + genericSurgicalFallback(hintPath) + ' for every key with line ranges.'
        : isDoc
          ? 'Use `token-goat section "' + hintPath + '::' + section + '"` to read one section' + (target === null ? '.' : ', or ' + genericSurgicalFallback(hintPath) + ' for every heading with line ranges.')
          : 'Use ' + genericSurgicalFallback(hintPath) + ' to read one function or class.'
}

/**
 * Shared hint ladder for `tail`/`head`/`Get-Content -Tail`/`Select-Object -First`-style partial-file-read commands, which (unlike the whole-file-dump commands {@link surgicalHintFor} covers) can also point at `token-goat skeleton` for the non-doc, non-config case since the caller already knows the file structure is what's wanted.
 */
export function surgicalHintForConfigDoc(filePath: string, isConfig: boolean, isDoc: boolean, isSql: boolean, isXml = false): string {
  return isXml
    ? 'Use `token-goat xml-outline "' + filePath + '"` to inspect structure, or `token-goat xml-query "' + filePath + '" "<selector>"` to query specific nodes.'
    : isConfig
      ? 'Use `token-goat config-get "' + filePath + '" KEY_NAME` or `token-goat section "' + filePath + '::sectionName"` to read a specific value.'
      : isSql
        ? 'Use `token-goat section "' + filePath + '::table_name"` to pull one CREATE TABLE / CREATE TYPE block.'
        : isDoc
          ? 'Use `token-goat section "' + filePath + '::SectionHeading"` to read one section.'
          : 'Use ' + genericSurgicalFallback(filePath) + ' or `token-goat skeleton "' + filePath + '"` to see the file structure.'
}


/**
 * Split a compound command into the individual simple commands the shell would run, on `|`, `||`, `&&`, `;` and newline.
 *
 * Quote-aware on purpose: a plain `cmd.split(/\|/)` would tear `sed -i 's/a|b/c/' f` apart at the alternation inside the script and lose the file argument entirely -- a silent miss in exactly the case this detection exists for.
 */
export function splitShellSegments(cmd: string): string[] {
  const segments: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!
    if (quote !== null) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '\\' && i + 1 < cmd.length) {
      cur += ch + cmd[i + 1]!
      i++
      continue
    }
    // A redirection's `&` belongs to the token it sits in, not between two commands: splitting `rg -n pat src >&2 | tail -20` here left a bare `2` standing where a command should be.
    if (ch === '&' && isRedirectAmpersand(cmd, i)) {
      cur += ch
      continue
    }
    if (ch === '|' || ch === ';' || ch === '\n' || ch === '&') {
      segments.push(cur)
      cur = ''
      // Consume the second character of a doubled operator (`||`, `&&`) so it does not open an empty segment.
      if ((ch === '|' || ch === '&') && cmd[i + 1] === ch) i++
      continue
    }
    cur += ch
  }
  segments.push(cur)
  return segments.map((s) => s.trim()).filter((s) => s.length > 0)
}


/**
 * True when the path is a temp file (not indexed by token-goat).
 *
 * The literal patterns cover shapes `os.tmpdir()` does not report: the unix `/tmp`, macOS `/var/folders`, and the Git-Bash/MSYS `/c/Users/...` spelling of a Windows path, none of which a plain prefix test against `os.tmpdir()` would catch. `isUnderSystemTemp` then covers the actual system temp directory, whatever it happens to be on this machine -- which the pattern list alone does not: it assumes the per-user `AppData\Local\Temp` shape, so on a machine (or a service account) whose temp is `C:\WINDOWS\TEMP`, every temp-path gate here silently stopped firing. Reusing the canonical helper rather than adding another pattern keeps the two definitions of "temp" from drifting apart again.
 */
export function isTempPath(fp: string): boolean {
  const norm = fp.replace(/\\/g, '/')
  return (
    /^\/tmp\//i.test(norm) ||
    /\/var\/folders\//i.test(norm) ||
    // Anchored to a local drive root on purpose. Unanchored, this clause said yes to `//host/share/AppData/Local/Temp/x.md`, and the caller's answer to yes is to stat the path -- which on Windows opens an SMB session to whatever host a command named. A temp directory is somewhere on a local volume; nothing that starts with two separators is one.
    /^[a-z]:\/(?:[^/]+\/)*AppData\/Local\/Temp\//i.test(norm) ||
    (norm.startsWith('/c/Users/') && norm.includes('/AppData/Local/Temp/')) ||
    isUnderSystemTemp(fp)
  )
}

/** True for ephemeral orchestration state files (improve-skill state, etc.) that are not source files. */
export function isOrchestratorStateFile(filePath: string): boolean {
  const basename = (filePath.includes('/') ? filePath.split('/').at(-1) : filePath.split('\\').at(-1)) ?? filePath
  return /^\.improve-state-/.test(basename)
}

/** Extract the source file path from `cat <path>.<ext>`, or null if not that pattern. */
export function extractCatSourceFile(cmd: string): string | null {
  const m = /^cat\s+(\S+\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|css|scss|sass|less))\s*$/.exec(cmd)
  return m?.[1] ?? null
}

/** Extracts the file path from a simple `cat [flags] <path>` command (quoted or unquoted), returning it and whether it is a doc, env, config, or sql file. Returns null for multi-file cat, piped cat, etc. */
// Classify a single candidate `cat`/`bat`/`type`/`Get-Content` path: returns the per-path flags used by the deny/hint logic, or null if the path is a temp scratch file or lacks a known source/doc/config extension. Shared by the single-path extractCatFile and the multi-path extractCatFilesMulti so both apply identical rules.
/**
 * Classify a file path's extension into the doc/env/config/sql flags shared by every cat-family extractor below. Returns null when the path has neither a known source/doc/config extension nor an `.env`-shaped basename (the "not a file we care about" case). Does NOT apply temp-path filtering -- callers differ on that (some exclude temp paths outright, `extractPowerShellWrappedGetContent` instead size-gates them), so that check stays with each caller.
 */
export function classifyFileExtensions(filePath: string): { isDoc: boolean; isEnv: boolean; isConfig: boolean; isSql: boolean; isXml: boolean } | null {
  const basename = (filePath.includes('/') ? filePath.split('/').at(-1) : filePath.split('\\').at(-1)) ?? filePath
  const isEnvFile = /^\.env(\.\w+)?$/i.test(basename)
  const hasKnownExt = /\.(?:java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|css|scss|sass|less|md|mdx|rst|txt|json|yaml|yml|toml|xml|dtsx|ampkg|xaml|conf|cfg|ini|properties|sql|ps1|psm1|env)$/i.test(filePath)
  if (!hasKnownExt && !isEnvFile) return null
  const isSql = /\.sql$/i.test(filePath)
  const isDoc = /\.(?:md|mdx|rst|txt)$/i.test(filePath)
  const isEnv = isEnvFile || /\.env$/i.test(filePath)
  const isConfig = /\.(?:json|yaml|yml|toml|conf|cfg|ini|properties)$/i.test(filePath)
  const isXml = /\.(?:xml|dtsx|ampkg|xaml)$/i.test(filePath)
  return { isDoc, isEnv, isConfig, isSql, isXml }
}

/** Shared isDoc/isConfig/isSql/isXml classification for the tail/head/Get-Content/node-read extractors, mirroring classifyFileExtensions's flags so all of them can point a .sql or XML read at the appropriate hint. */
export function classifyDocConfig(filePath: string): { isDoc: boolean; isConfig: boolean; isSql: boolean; isXml: boolean } {
  const isDoc = /\.(?:md|mdx|rst|txt)$/i.test(filePath)
  const isConfig = /\.(?:json|yaml|yml|toml|conf|cfg|ini|properties)$/i.test(filePath)
  const isSql = /\.sql$/i.test(filePath)
  const isXml = /\.(?:xml|dtsx|ampkg|xaml)$/i.test(filePath)
  return { isDoc, isConfig, isSql, isXml }
}

export function classifyCatPath(
  filePath: string,
  cmd0: string,
): { filePath: string; isDoc: boolean; isEnv: boolean; isConfig: boolean; isSql: boolean; isXml: boolean; cmd0: string } | null {
  if (isTempPath(filePath)) return null
  const flags = classifyFileExtensions(filePath)
  if (flags === null) return null
  return { filePath, ...flags, cmd0 }
}

export function extractCatFile(cmd: string): { filePath: string; isDoc: boolean; isEnv: boolean; isConfig: boolean; isSql: boolean; isXml: boolean; cmd0: string; advisoryOnly: boolean } | null {
  if (/-(?:TotalCount|Head|First|Tail)\b/i.test(cmd)) return null
  // Loop-46 census (8,179 real cat-headed commands): 144 qualifying reads spelled the identical read with a trailing `2>&1` or `2>/dev/null` and got no hint at all, so the suffix is accepted like extractSedRange already does. The `2>/dev/null` spelling signals an existence-tolerant read (dominated by memory-recall probes of files that may not exist), so it is admitted advisory-only: denying it would push the agent at a possibly missing file.
  const m = /^(cat|bat|type|Get-Content|gc)(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+))*\s+(?:"([^"]+)"|'([^']+)'|(\S+?))(?:\s+-[a-zA-Z].*?)?(?:\s+2>(&1|\/dev\/null))?\s*$/i.exec(cmd)
  if (!m) return null
  const cmd0 = m[1]!
  const filePath = m[2] ?? m[3] ?? m[4]
  if (filePath === undefined) return null
  const r = classifyCatPath(filePath, cmd0)
  if (r === null) return null
  return { ...r, advisoryOnly: m[5] === '/dev/null' }
}

// Multi-file variant: `cat a.ts b.ts` (2+ path args) slips past the single-path extractCatFile (its `$` anchor rejects a trailing second path), so a multi-file cat used to bypass the deny entirely. Tokenizes every path argument and returns the qualifying ones so the same per-path deny/hint fires. Returns null unless the command is a bare cat/bat/type/Get-Content with 2+ arguments and at least one qualifying path.
export function extractCatFilesMulti(
  cmd: string,
): Array<{ filePath: string; isDoc: boolean; isEnv: boolean; isConfig: boolean; isSql: boolean; isXml: boolean; cmd0: string }> | null {
  // Only a bare `cat a b c`: bail on any pipe/redirect/chain/substitution so a piped single read (`cat -n f | jq`, `cat f | grep`) still passes through untouched, the same way the `$`-anchored single-path extractCatFile never matched those.
  if (/[|<>;&`]/.test(cmd) || cmd.includes('$(')) return null
  const m = /^(cat|bat|type|Get-Content|gc)\s+(.+?)\s*$/i.exec(cmd)
  if (!m) return null
  const cmd0 = m[1]!
  const tokens = m[2]!.match(/"[^"]+"|'[^']+'|\S+/g) ?? []
  const paths = tokens.filter((t) => !/^-/.test(t)).map((t) => t.replace(/^["']|["']$/g, ''))
  if (paths.length < 2) return null
  const out = paths.map((p) => classifyCatPath(p, cmd0)).filter((r): r is NonNullable<typeof r> => r !== null)
  // Require 2+ qualifying source paths: a single path with flag VALUES (e.g. `Get-Content -Tail 50 src/auth.ts`, where `50` is the -Tail argument) is a flagged single-file read that the tail/head/single-cat handlers own -- firing here would preempt them with a hard deny.
  return out.length >= 2 ? out : null
}

export const POWERSHELL_WRAP_RE = /^(?:powershell|pwsh)(?:\.exe)?(?:\s+-[a-zA-Z]+(?:\s+\S+)?)*\s+(?:-Command|-c|-EncodedCommand)\s+(?:"([^"]*)"|'([^']*)')\s*$/i
export const PS_GETCONTENT_INNER_RE = /^(?:Get-Content|gc|cat|type)(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+))*\s+(?:"([^"]+)"|'([^']+)'|(\S+?))(?:\s+-[a-zA-Z].*)?\s*$/i
export const PS_FILE_METHOD_RE = /\[(?:System\.)?IO\.File\]::(?:ReadAllText|ReadAllLines|ReadAllBytes|ReadLines|OpenText)\(\s*['"]([^'"]+)['"]/i

/**
 * True when the command writes back the same path it read, making it an in-place edit rather than a read into context.
 *
 * Denying an in-place edit only forces the same script into a file, which then runs unchecked, so the extractors treat this shape as none of their business. The guard is keyed on the WRITE and takes the read's path as an argument, because keying it on the read is what broke twice: it lived inside {@link extractNodeFileRead}'s `readFileSync` branch alone, so `node -e "const p=require('./package.json'); ...writeFileSync('./package.json', ...)"` -- the ordinary version-bump one-liner -- was denied while the byte-identical edit spelled `readFileSync` was allowed, and the denial told the caller that `fs.readFileSync()` bypasses read hooks for a command that never calls it. {@link extractPowerShellFileMethodRead} had no such guard at all, so `[IO.File]::WriteAllText('a.ts', [IO.File]::ReadAllText('a.ts')...)` was denied outright with `token-goat outline` suggested as the substitute, which cannot perform an edit.
 *
 * `methods` is the writing API of the runtime in question, since the two share no spelling: Node writes with `writeFileSync`/`appendFileSync`, .NET with the `WriteAll*`/`AppendAll*` family.
 */
function writesBackSamePath(cmd: string, filePath: string, methods: string): boolean {
  return new RegExp(`(?:${methods})\\(\\s*['"]${escapeRegExp(filePath)}['"]`, 'i').test(cmd)
}

const NODE_WRITE_METHODS = 'writeFileSync|appendFileSync'
const PS_WRITE_METHODS = 'WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText|AppendAllLines'
// A temp-path read only floods context when the file is large; a small scratch read stays silent.
export const PS_TEMP_READ_FLOOD_BYTES = 16 * 1024

export function isLargeFileOnDisk(filePath: string, floor: number): boolean {
  try {
    return statSync(filePath).size >= floor
  } catch {
    return false
  }
}

/**
 * Whether a path this hook parsed OUT OF a command may be touched on disk before the user has approved that command.
 *
 * Every other pre_tool_use handler asks {@link preToolPathDeclined} before its first fs call, because the harness fires the hook before the approval prompt and the path is the model's choice until then -- and on Windows a `statSync` of `\\host\share\...` opens an SMB session, carrying an authentication attempt, to a host a repository named. This handler was outside that discipline for one reason that reads plausible and is wrong: its tool carries a command rather than a path. It carries about twenty paths, extracted from the command, and stats two of them.
 *
 * Answers false rather than throwing: the caller's only use for the size is deciding whether to emit a hint, and declining to measure is the same outcome as measuring and finding nothing. `event === undefined` still refuses a network or device path, including one reached through a link, so a caller that has no event to hand -- a direct unit test of an extractor, or a future one -- loses only the workspace half of the rule, never the network half.
 */
export function commandPathIsTouchable(filePath: string, event: HookEvent | undefined): boolean {
  if (event === undefined) return !escapesOntoNetworkThroughLinks(filePath)
  return !preToolPathDeclined(event, filePath)
}

/** Extracts the read path from a `powershell -Command "Get-Content '<path>' -Raw"` (or pwsh/cat/type) wrapper, which otherwise bypasses every Get-Content/cat extractor because the command token is `powershell`. Tolerates a trailing `-Raw`/`-Encoding` that bare extractCatFile rejects. Temp paths are size-gated: a small scratch read stays silent, a large one still earns a recall hint. */
export function extractPowerShellWrappedGetContent(cmd: string, event?: HookEvent): { filePath: string; isDoc: boolean; isEnv: boolean; isConfig: boolean; isSql: boolean; isXml: boolean } | null {
  const w = POWERSHELL_WRAP_RE.exec(cmd)
  if (!w) return null
  const inner = (w[1] ?? w[2] ?? '').trim()
  if (!inner) return null
  if (/-(?:TotalCount|Head|First|Tail)\b/i.test(inner)) return null
  const m = PS_GETCONTENT_INNER_RE.exec(inner)
  if (!m) return null
  const filePath = m[1] ?? m[2] ?? m[3]
  if (filePath === undefined) return null
  const flags = classifyFileExtensions(filePath)
  if (flags === null) return null
  // Temp reads are normally scratch and skipped, but a large one still floods context; gate on size rather than excluding unconditionally.
  if (isTempPath(filePath)) {
    if (!commandPathIsTouchable(filePath, event)) return null
    if (!isLargeFileOnDisk(filePath, PS_TEMP_READ_FLOOD_BYTES)) return null
  }
  return { filePath, ...flags }
}

/**
 * Extracts file path from PowerShell .NET static file read calls: `[System.IO.File]::ReadAllText(...)`, `[IO.File]::ReadAllLines(...)`, `[IO.File]::ReadAllBytes(...)`, `[IO.File]::ReadLines(...)`, etc.
 */
export function extractPowerShellFileMethodRead(cmd: string, event?: HookEvent): { filePath: string; isDoc: boolean; isEnv: boolean; isConfig: boolean; isSql: boolean; isXml: boolean } | null {
  let inner = cmd.trim()
  const w = POWERSHELL_WRAP_RE.exec(inner)
  if (w) {
    inner = (w[1] ?? w[2] ?? '').trim()
  }
  const m = PS_FILE_METHOD_RE.exec(inner)
  if (!m?.[1]) return null
  const filePath = m[1]
  if (isOrchestratorStateFile(filePath)) return null
  if (writesBackSamePath(inner, filePath, PS_WRITE_METHODS)) return null
  if (isTempPath(filePath)) {
    if (!commandPathIsTouchable(filePath, event)) return null
    if (!isLargeFileOnDisk(filePath, PS_TEMP_READ_FLOOD_BYTES)) return null
  }
  const flags = classifyFileExtensions(filePath)
  if (flags === null) {
    const { isDoc, isConfig, isSql, isXml } = classifyDocConfig(filePath)
    return { filePath, isDoc, isEnv: false, isConfig, isSql, isXml }
  }
  return { filePath, isDoc: flags.isDoc, isEnv: flags.isEnv, isConfig: flags.isConfig, isSql: flags.isSql, isXml: flags.isXml }
}

/**
 * Returns identifier info when command is `rg`/`grep` with `-n` flag targeting a pure identifier (or `|`-joined identifiers) against exactly one source file. Used to suggest `token-goat symbol` as a cheaper alternative to scanning the file.
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

  // Exclude recursive flags — those search directories, not a single file. The flag's leading `-` must be a real token boundary (preceded by whitespace/start-of-string, followed by whitespace/end-of-string): without that anchor, `-[a-zA-Z]*r[a-zA-Z]*\b` also matched deep inside any unrelated long flag that merely contains the letter 'r' anywhere after its OWN second dash (`--color=never`, `--sort=path`, ...), since the regex engine could anchor its leading `-` off that second dash instead of requiring a genuine single-dash flag token — silently suppressing this hint for some of the most common rg/grep flags in real commands.
  if (/(?:^|\s)-[a-zA-Z]*[rR][a-zA-Z]*(?=\s|$)/.test(cmd) || /(?:^|\s)--recursive(?=\s|$)/.test(cmd)) return null

  return { filePath, identifier: pattern }
}

/** Extracts the file path from `cat <file> | jq` or `jq ... <file>` commands restricted to structured config files. Emits a CONTEXT hint (not deny) so the jq pipeline still runs if the agent proceeds. */
export function extractCatJsonPipe(cmd: string): { filePath: string; isDirectJq?: boolean } | null {
  const m = /^cat\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*\|\s*jq\b/.exec(cmd)
  if (m) {
    const filePath = m[1] ?? m[2] ?? m[3]
    if (filePath && !isTempPath(filePath) && /\.(?:json|yaml|yml|toml)$/i.test(filePath)) {
      return { filePath, isDirectJq: false }
    }
  }
  const jqDirect = /^jq(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z0-9-]+(?:=\S+)?))*\s+(?:"[^"]*"|'[^']*'|(?:\.[a-zA-Z0-9_.*[\]]+))\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd)
  if (jqDirect) {
    const filePath = jqDirect[1] ?? jqDirect[2] ?? jqDirect[3]
    if (filePath && !isTempPath(filePath) && /\.(?:json|yaml|yml|toml)$/i.test(filePath)) {
      return { filePath, isDirectJq: true }
    }
  }
  return null
}

/**
 * Extracts info when a command involves PowerShell `ConvertFrom-Json`. Detects pipelines like `Get-Content <file> | ConvertFrom-Json`, `cat <file> | ConvertFrom-Json`, `[IO.File]::ReadAllText(<file>) | ConvertFrom-Json`, or assignment expressions.
 */
export function extractPowerShellJsonPipeline(cmd: string): { filePath: string | null } | null {
  let inner = cmd.trim()
  const w = POWERSHELL_WRAP_RE.exec(inner)
  if (w) {
    inner = (w[1] ?? w[2] ?? '').trim()
  }

  if (!/\bConvertFrom-Json\b/i.test(inner)) return null

  const parseTarget = (segment: string): string | null => {
    const readAll = /\[(?:System\.)?IO\.File\]::ReadAllText\(\s*['"]?([^'")\s]+)['"]?\s*\)/i.exec(segment)
    if (readAll) {
      const p = readAll[1]
      return p && /\.(?:json|txt|log|temp)$/i.test(p) ? p : null
    }

    const tokens = segment.trim().split(/\s+/)
    const cmdlets = new Set(['get-content', 'gc', 'cat', 'type'])
    const idx = tokens.findIndex((t) => cmdlets.has(t.toLowerCase()))
    if (idx === -1) return null

    let argIdx = idx + 1
    while (argIdx < tokens.length) {
      const tok = tokens[argIdx]
      if (!tok) break
      if (tok.startsWith('-')) {
        const flag = tok.toLowerCase()
        if (flag === '-path' && argIdx + 1 < tokens.length) {
          const next = tokens[argIdx + 1]
          if (next && !next.startsWith('-')) {
            const clean = next.replace(/^['"]|['"]$/g, '')
            return /\.(?:json|txt|log|temp)$/i.test(clean) ? clean : null
          }
        }
        if ((flag === '-encoding' || flag === '-totalcount') && argIdx + 1 < tokens.length) {
          argIdx += 2
          continue
        }
        argIdx++
        continue
      }
      const clean = tok.replace(/^['"(]|['")]$/g, '')
      return /\.(?:json|txt|log|temp)$/i.test(clean) ? clean : null
    }
    return null
  }

  const pipeIdx = inner.search(/\|\s*ConvertFrom-Json\b/i)
  if (pipeIdx !== -1) {
    const upstream = inner.slice(0, pipeIdx).trim()
    return { filePath: parseTarget(upstream) }
  }

  const parenMatch = /ConvertFrom-Json\s*\(([^)]+)\)/i.exec(inner)
  if (parenMatch) {
    const inside = parenMatch[1] ?? ''
    return { filePath: parseTarget(inside) }
  }

  if (/ConvertFrom-Json\s*\(/i.test(inner)) {
    return { filePath: null }
  }

  return null
}

/** Extracts the file path from a WSL-proxied cat command like `wsl bash -c "cat /mnt/c/..."` or `wsl -d Ubuntu bash -c "cat /mnt/c/..."`. Converts /mnt/X/ paths to X:/ and applies the same filtering as extractCatFile. */
export function extractWslCatFile(cmd: string): { filePath: string; isDoc: boolean; isEnv: boolean; isConfig: boolean; isSql: boolean; isXml: boolean } | null {
  // Match: wsl [optional -d DISTRO] bash -c "cat [flags] /mnt/X/..."
  const wslMatch = /^wsl(?:\s+-d\s+\S+)?\s+bash\s+-c\s+"cat(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+))*\s+\/mnt\/([a-z])\/([^"]*)"/.exec(cmd)
  if (!wslMatch) return null
  const drive = wslMatch[1]?.toUpperCase()
  const pathRest = wslMatch[2]
  if (!drive || !pathRest) return null
  const filePath = drive + ':/' + pathRest
  if (isTempPath(filePath)) return null
  const flags = classifyFileExtensions(filePath)
  if (flags === null) return null
  return { filePath, ...flags }
}

/**
 * The Python snippet inside `text`, paired with a copy of it that has string contents blanked out.
 *
 * The guards below look for `open(` and `.write(`, and a snippet is free to carry either as ordinary text inside a string, so they scan a masked copy. But masking only makes sense on Python. What arrives here is usually a shell command line with the snippet inside the shell's own quotes, and masking that as it stands treats the shell's opening quote as the start of a Python string and blanks the whole snippet, leaving the guards nothing to find. So the snippet is lifted out of `python -c` first. A command whose snippet cannot be lifted cleanly (a pipeline, a trailing `&&`) is scanned unmasked, which is what these guards did before. A heredoc body is already Python and is masked as it stands. `source` and `masked` always share offsets, so a caller can find an opener in `masked` and read the real arguments out of `source`.
 */
export function pythonScanText(text: string): { source: string; masked: string } {
  const dashC = /^python3?\s+-c\s*(['"])([\s\S]*)\1\s*$/.exec(text)
  if (dashC) {
    const source = dashC[2] ?? ''
    return { source, masked: maskPythonStrings(source) }
  }
  if (/^python3?\b/.test(text)) return { source: text, masked: text }
  return { source: text, masked: maskPythonStrings(text) }
}

/**
 * The same text with the contents of every Python string literal replaced by spaces, quotes and length left alone.
 *
 * The guards below look for `open(` and `.write(` in a one-liner, and a one-liner is free to carry either of those as ordinary text inside a string. Searching the raw command let `print(open('src/cli.ts').read()); note='logger.write('` look like a file write and escape the read check entirely. Offsets are preserved so a caller can find an opener in this masked copy and then read the real arguments, quotes and all, out of the original: the mode a call asks for is itself a string literal, so it cannot be masked away.
 */
export function maskPythonStrings(text: string): string {
  const out = text.split('')
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch !== "'" && ch !== '"') { i += 1; continue }
    const triple = text.slice(i, i + 3)
    const delim = triple === ch + ch + ch ? triple : ch
    let j = i + delim.length
    while (j < text.length) {
      if (text[j] === '\\') { j += 2; continue }
      if (text.slice(j, j + delim.length) === delim) break
      out[j] = ' '
      j += 1
    }
    i = j + delim.length
  }
  return out.join('')
}

/** One `open(...)` call found in a Python snippet. */
export interface PythonOpenCall {
  /** The first argument's string literal, or null when the path is a variable or an expression. */
  pathLiteral: string | null
  /** True when the call passes a mode at all, positionally or as `mode=`. */
  hasMode: boolean
  /** The mode's string literal, or null when a mode is passed but is not written out literally. */
  modeLiteral: string | null
}

/**
 * Every `open(...)` call in `text`, with its path and mode as far as they can be read off.
 *
 * The arguments are walked with a depth counter rather than matched with a regex, because the argument list is not a flat span: the span this replaces was `open\s*\([^)]*,\s*['"][wa]`, and `[^)]*` cannot reach past a nested call, so `open(os.path.join(d, name), 'w')` never looked like a write and a command that only ever created a file was denied as if it were reading one. The walk ignores commas inside quotes and inside a nested call, so the top-level arguments come out whole.
 */
export function pythonOpenCalls(text: string): PythonOpenCall[] {
  const { source, masked } = pythonScanText(text)
  const calls: PythonOpenCall[] = []
  for (const opener of masked.matchAll(/\bopen\s*\(/g)) {
    const start = (opener.index ?? 0) + opener[0].length
    const args: string[] = []
    let current = ''
    let depth = 0
    let quote = ''
    let closed = false
    for (let i = start; i < source.length; i++) {
      const ch = source[i] ?? ''
      if (quote !== '') {
        // A backslash inside a quote escapes the next character, so an escaped quote does not end the string and its commas stay part of this argument.
        if (ch === '\\') { current += ch + (source[i + 1] ?? ''); i += 1; continue }
        if (ch === quote) quote = ''
        current += ch
        continue
      }
      if (ch === "'" || ch === '"') { quote = ch; current += ch; continue }
      if (ch === '(' || ch === '[' || ch === '{') { depth += 1; current += ch; continue }
      if (ch === ')' && depth === 0) { args.push(current); closed = true; break }
      if (ch === ')' || ch === ']' || ch === '}') { depth -= 1; current += ch; continue }
      if (ch === ',' && depth === 0) { args.push(current); current = ''; continue }
      current += ch
    }
    // An unterminated call says nothing either way; skip it rather than guess at its arguments.
    if (!closed) continue
    const literalOf = (arg: string): string | null => {
      const m = /^\s*r?(['"])([^'"]*)\1\s*$/.exec(arg)
      return m?.[2] ?? null
    }
    const keyword = args.find((a) => /^\s*mode\s*=/.test(a))
    // `open(p, encoding='utf-8')` puts a keyword argument in the slot a positional mode would use; reading it as an unreadable mode would call a plain read a write.
    const positional = args[1] !== undefined && /^\s*[A-Za-z_]\w*\s*=[^=]/.test(args[1]) ? undefined : args[1]
    const modeArg = keyword !== undefined ? keyword.replace(/^\s*mode\s*=/, '') : positional
    calls.push({
      pathLiteral: args.length > 0 ? literalOf(args[0] ?? '') : null,
      hasMode: modeArg !== undefined,
      modeLiteral: modeArg === undefined ? null : literalOf(modeArg),
    })
  }
  return calls
}

/**
 * True when any `open(...)` in `text` asks for a mode that creates or modifies a file.
 *
 * A mode that is passed but not written out as a literal (`open(p, m)`, `open(p, mode=m)`) counts as writing. The two mistakes are not equal: denying a write blocks a command outright and hands back advice to extract a symbol from a file that is about to be created, while letting a read past only costs the hint. When the mode cannot be read, the harmless answer is the one to give.
 */
export function pythonOpenWritesAFile(text: string): boolean {
  return pythonOpenCalls(text).some(
    (call) => call.hasMode && (call.modeLiteral === null || /[wax+]/.test(call.modeLiteral)),
  )
}

/**
 * True when `text` writes through a file object, as opposed to a standard stream.
 *
 * `.write(` alone used to be the signal, and it exempted the command from the whole-file-read check. A standard stream has a .write too, so `sys.stdout.write(open('src/cli.ts').read())` put exactly as much of a file into the conversation as the `print` spelling of the same read and only the second one was caught. Writing to a stream is output, not a file write. The receiver is read back off the text rather than required to be a plain name, so a write straight onto the result of a call (`open(p, m).write(...)`) still counts as one.
 */
export function pythonWritesThroughFileObject(text: string): boolean {
  const { masked } = pythonScanText(text)
  for (const call of masked.matchAll(/\.write(?:lines)?\s*\(/g)) {
    const receiver = masked.slice(0, call.index ?? 0)
    // `.buffer` is how the byte-level half of a standard stream is reached; it is the same stream.
    if (/(?:^|[^\w.])(?:sys\s*\.\s*)?(?:stdout|stderr|stdin)(?:\s*\.\s*buffer)?$/.test(receiver)) continue
    return true
  }
  return false
}


/**
 * True when every `open(...)` in `text` names its file with a plain string literal.
 *
 * The indirect branches below exist for `open(path_variable)`, where the file being read can only be guessed at from a literal somewhere else in the command. That guess is wrong whenever the command already says outright what it opens: `path='src/cli.ts'; print(open('notes').read())` opens `notes`, which has no source extension and is not the hook's business, yet the scan found `src/cli.ts` elsewhere in the line and denied the command naming a file it never touched. When every call already names its own path, there is nothing left to infer.
 */
export function pythonOpenPathsAreAllLiteral(text: string): boolean {
  const calls = pythonOpenCalls(text)
  return calls.length > 0 && calls.every((call) => call.pathLiteral !== null)
}

export interface PythonFileReadResult {
  filePath: string
  isDoc: boolean
  isConfig: boolean
  isEnv: boolean
  isSql: boolean
  isXml?: boolean
  isOutputFile: boolean
}

export const KNOWN_PYTHON_EXT_STR = 'java|py|ts|tsx|js|jsx|go|rb|rs|cpp|cc|cxx|c|h|hpp|kt|swift|cs|php|scala|clj|css|scss|sass|less|md|mdx|rst|txt|json|yaml|yml|toml|xml|dtsx|ampkg|xaml|html|htm|conf|cfg|ini|properties|sql|ps1|psm1|env'
export const OPEN_EXT = new RegExp(`\\.(?:${KNOWN_PYTHON_EXT_STR})$`, 'i')

/** Returns the file path and metadata if the bash command is a Python snippet that reads a known-extension file via open(). Returns null otherwise. */
export function extractPythonFileRead(cmd: string): PythonFileReadResult | null {
  let inner = cmd.trim()
  const w = POWERSHELL_WRAP_RE.exec(inner)
  if (w) {
    inner = (w[1] ?? w[2] ?? '').trim()
  }

  // Check for PowerShell here-string piped to Python:
  // @'
  // ... '@ | python -
  const psHereMatch =
    /^@'([\s\S]*?)'@\s*\|\s*(?:python3?|py)(?:\.exe)?(?:\s+-\S*|\s+-)?\s*$/i.exec(inner) ??
    /^@"([\s\S]*?)"@\s*\|\s*(?:python3?|py)(?:\.exe)?(?:\s+-\S*|\s+-)?\s*$/i.exec(inner)
  let pythonBody: string | null = null
  if (psHereMatch) {
    pythonBody = (psHereMatch[1] ?? '').trim()
  } else if (/^(?:python3?|py)(?:\.exe)?\b/i.test(inner)) {
    pythonBody = inner
  }

  if (pythonBody === null) return null

  // Return null when the command shows write intent — these are edits, not reads
  if (pythonOpenWritesAFile(pythonBody) || pythonWritesThroughFileObject(pythonBody)) return null

  // .output files are task artifacts, not source, so neither a symbol read nor a section read fits. Which recall command fits is decided by the caller, which can look at the bytes; the extension alone does not say whether this is an agent transcript or a background command's stdout.
  const outputOpen = /open\s*\(\s*r?['"]([^'"]+\.output)['"]/i.exec(pythonBody)
  if (outputOpen?.[1]) {
    const filePath = outputOpen[1]
    if (isOrchestratorStateFile(filePath)) return null
    return { filePath, isDoc: false, isConfig: false, isEnv: false, isSql: false, isOutputFile: true }
  }

  const classifyResult = (filePath: string): PythonFileReadResult => {
    const flags = classifyFileExtensions(filePath)
    if (flags !== null) {
      return { filePath, isDoc: flags.isDoc, isConfig: flags.isConfig, isEnv: flags.isEnv, isSql: flags.isSql, isXml: flags.isXml, isOutputFile: false }
    }
    const { isDoc, isConfig, isSql, isXml } = classifyDocConfig(filePath)
    const isEnv = /\.env(\.\w+)?$/i.test(filePath)
    return { filePath, isDoc, isConfig, isEnv, isSql, isXml, isOutputFile: false }
  }

  // Heredoc form: python3 - << 'PYEOF'\n...\nPYEOF
  const heredocMatch = /^python3?\s+-\s+<<\s*'?(\w+)'?\s*\n([\s\S]*?)\n\1\s*$/.exec(pythonBody)
  if (heredocMatch) {
    const body = heredocMatch[2] ?? ''
    // Write-mode exclusion in the heredoc body
    if (pythonOpenWritesAFile(body) || pythonWritesThroughFileObject(body)) return null
    // Direct: open(r'path.ext') or open("path.ext") in body
    const heredocOpen = new RegExp(`open\\s*\\(\\s*r?['"]([^'"]+\\.(?:${KNOWN_PYTHON_EXT_STR}))['"]`, 'i').exec(body)
    if (heredocOpen?.[1]) {
      const filePath = heredocOpen[1]
      if (isOrchestratorStateFile(filePath)) return null
      return classifyResult(filePath)
    }
    // Indirect: open(var, ...) where a string literal with known ext appears in the body
    if (/open\s*\(/.test(body) && !pythonOpenPathsAreAllLiteral(body)) {
      const literal = new RegExp(`['"]([^'"]+\\.(?:${KNOWN_PYTHON_EXT_STR}))['"]`, 'i').exec(body)
      if (literal?.[1]) {
        const filePath = literal[1]
        if (isOrchestratorStateFile(filePath)) return null
        if (OPEN_EXT.test(filePath)) {
          return classifyResult(filePath)
        }
      }
    }
    return null
  }

  // Direct: open('path.ext') or open("path.ext")
  const direct = new RegExp(`open\\s*\\(\\s*r?['"]([^'"]+\\.(?:${KNOWN_PYTHON_EXT_STR}))['"]`, 'i').exec(pythonBody)
  if (direct) {
    const filePath = direct[1] ?? ''
    if (!filePath) return null
    if (isOrchestratorStateFile(filePath)) return null
    return classifyResult(filePath)
  }
  // Indirect: open(var, ...) where a string literal with a known extension appears elsewhere in the cmd
  if (/open\s*\(/.test(pythonBody) && !pythonOpenPathsAreAllLiteral(pythonBody)) {
    const literal = new RegExp(`['"]([^'"]+\\.(?:${KNOWN_PYTHON_EXT_STR}))['"]`, 'i').exec(pythonBody)
    if (literal) {
      const filePath = literal[1] ?? ''
      if (filePath) {
        if (isOrchestratorStateFile(filePath)) return null
        if (OPEN_EXT.test(filePath)) {
          return classifyResult(filePath)
        }
      }
    }
  }
  return null
}

/** Extracts file path from `head -n X <path>` or `head -X <path>` commands. Returns null for unrecognized patterns or temp files. Also checks N < 10 (already surgical). */
export function extractHeadFile(cmd: string): { filePath: string; isDoc: boolean; isConfig: boolean; isSql: boolean; isXml: boolean; n: number } | null {
  const direct = /^head(?:\s+-n\s+(\d+)|\s+-(\d+))?\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd)
  // Piped spelling of the same leading-lines read: `cat [flags] FILE [2>&1|2>/dev/null] | head -N`. Loop-46 census (8,179 real cat-headed commands): 284 qualifying reads used this spelling and got no hint, while the direct `head -N FILE` form was already admitted.
  const piped = direct === null ? /^cat(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+))*\s+(?:"([^"]+)"|'([^']+)'|(\S+?))(?:\s+2>(?:&1|\/dev\/null))?\s*\|\s*head(?:\s+-n\s+(\d+)|\s+-(\d+))?\s*$/.exec(cmd) : null
  if (direct === null && piped === null) return null
  const n = parseInt((direct !== null ? (direct[1] ?? direct[2]) : (piped![4] ?? piped![5])) ?? '0', 10)
  if (n <= 10) return null // already surgical, no need to advise (0 means default 10 lines) -- matches extractTailFile's <=10 threshold so `head -n 10`/`tail -n 10` on the same file behave identically
  const filePath = direct !== null ? (direct[3] ?? direct[4] ?? direct[5]) : (piped![1] ?? piped![2] ?? piped![3])
  if (filePath === undefined) return null
  if (isTempPath(filePath)) return null
  if (!/\.(?:ts|tsx|js|jsx|py|go|java|rs|rb|cs|md|mdx|rst|txt|json|yaml|yml|toml|sql|sh|xml|dtsx|ampkg|xaml)$/i.test(filePath)) return null
  const { isDoc, isConfig, isSql, isXml } = classifyDocConfig(filePath)
  return { filePath, isDoc, isConfig, isSql, isXml, n }
}

export function extractSedRange(cmd: string): { filePath: string; ranges: Array<readonly [number, number]> } | null {
  // Multi-range `sed -n 'N,Mp;X,Yp' file` is legal: a semicolon-separated list of `N,Mp` clauses inside a single quoted address block, followed by the same file-path argument and optional `2>/dev/null` suffix as the single-range form. The earlier single-range regex required exactly one range then end-of-string, so any `;`-joined command silently fell through with no hint at all, leaving an agent that grabs N+M ranges in one sed call getting zero guidance. The regex below matches the leading `N,Mp` plus zero or more `;N,Mp` continuations sharing the same surrounding quotes; the range list is reparsed from cmd so each clause is independently validated (start >= 1, end >= start) and empty/malformed inputs are rejected uniformly. Corpus measurement (loop 45, 19,380 real sed commands): the quoted form dominates but 480 commands spell the identical read with no quotes (`sed -n 120,180p file`), and a further slice suffixes `2>&1` instead of `2>/dev/null`. Both are the same read class, so the address block accepts an unquoted single range (an unquoted `;` would be a shell separator, so multi-range stays quoted-only) and the stderr suffix accepts either spelling.
  const m = /^sed\s+-n\s+(?:['"]((?:\d+,\d+p)(?:;\d+,\d+p)*)['"]|(\d+,\d+p))\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+2>(?:\/dev\/null|&1))?\s*$/.exec(cmd)
  if (!m) return null
  const addressList = m[1] ?? m[2]
  if (addressList === undefined) return null
  const ranges: Array<readonly [number, number]> = []
  for (const clause of addressList.split(';')) {
    const cm = /^(\d+),(\d+)p$/.exec(clause ?? '')
    if (!cm) return null
    const start = parseInt(cm[1] as string, 10)
    const end = parseInt(cm[2] as string, 10)
    if (start < 1 || end < start) return null
    ranges.push([start, end])
  }
  if (ranges.length === 0) return null
  const filePath = m[3] ?? m[4] ?? m[5]
  if (filePath === undefined) return null
  if (isTempPath(filePath)) return null
  return { filePath, ranges }
}

/**
 * `awk` spelling of the same line-range read `extractSedRange` handles: `awk 'NR>=A && NR<=B' file` and `awk 'NR==A,NR==B' file` show exactly the lines a `sed -n 'A,Bp' file` would, bypass the read hooks the same way, and cost the same context -- but matched none of the sed patterns, so they drew neither the surgical-read hint nor the overlap dedup the sed spelling has had all along. Recognized here so both spellings of one read reach the same machinery, including sharing a dedup ledger: reading lines 1-40 with `sed` and then with `awk` is one file read twice, not two files.
 */
export function extractAwkRange(cmd: string): { filePath: string; ranges: Array<readonly [number, number]> } | null {
  const m = /^awk\s+(?:'([^']+)'|"([^"]+)")\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+2>(?:\/dev\/null|&1))?\s*$/.exec(cmd)
  if (!m) return null
  const program = m[1] ?? m[2]
  if (program === undefined) return null
  // Two spellings of one range: a program carrying a further condition, or an action that transforms the line (substr/length projections, %.Ns truncation), is doing more than showing a span, so it is left alone rather than described wrongly. But an action that prints each whole line, at most prefixed with its line number (`{print}`, `{print $0}`, `{print NR": "$0}`, `{printf "%d: %s\n", NR, $0}`), emits exactly the span and is the same read respelled — loop-46 census (916 real awk-headed commands): 91 qualifying range reads carried such an action and got no hint, vs 41 genuinely transforming actions which stay unhinted.
  const cmp = /^\s*NR\s*>=\s*(\d+)\s*&&\s*NR\s*<=\s*(\d+)\s*(\{.*\})?\s*$/.exec(program)
  const rng = /^\s*NR\s*==\s*(\d+)\s*,\s*NR\s*==\s*(\d+)\s*(\{.*\})?\s*$/.exec(program)
  const hit = cmp ?? rng
  const action = hit?.[3]
  if (action !== undefined && !/^\{\s*(?:print(?:\s+NR\s*"[^"%]*"\s*\$0|\s+\$0)?|printf\s*"%d[^%"]*%s\\n"\s*,\s*NR\s*,\s*\$0)\s*\}$/.test(action)) return null
  if (!hit) return null
  const start = parseInt(hit[1] as string, 10)
  const end = parseInt(hit[2] as string, 10)
  if (start < 1 || end < start) return null
  const filePath = m[3] ?? m[4] ?? m[5]
  if (filePath === undefined) return null
  if (isTempPath(filePath)) return null
  return { filePath, ranges: [[start, end]] }
}

/** The line-range read this command is, whichever tool spells it, or null when it is neither. */
// `cat FILE [2>&1|2>/dev/null] | sed -n 'N,Mp[;...]'` is the same line-range read as `sed -n 'N,Mp' FILE` with the file fed through stdin (loop-46 census: 35 qualifying commands). Rewrite it into the direct form so extractSedRange's own address validation applies unchanged.
export function normalizeCatSedPipe(cmd: string): string | null {
  const m = /^cat(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+))*\s+(?:"([^"]+)"|'([^']+)'|(\S+?))(?:\s+2>(?:&1|\/dev\/null))?\s*\|\s*sed\s+-n\s+('[^']+'|"[^"]+"|\d+,\d+p)\s*$/.exec(cmd)
  if (!m) return null
  const filePath = m[1] ?? m[2] ?? m[3]
  if (filePath === undefined || filePath.includes('"')) return null
  return 'sed -n ' + m[4]! + ' "' + filePath + '"'
}

export function extractLineRangeRead(cmd: string): { filePath: string; ranges: Array<readonly [number, number]>; tool: 'sed' | 'awk' } | null {
  const catSed = normalizeCatSedPipe(cmd)
  if (catSed !== null) cmd = catSed
  const sed = extractSedRange(cmd)
  if (sed !== null) return { ...sed, tool: 'sed' }
  const awk = extractAwkRange(cmd)
  if (awk !== null) return { ...awk, tool: 'awk' }
  return null
}

// A pipe stage or standalone segment that only reformats or truncates the bytes flowing through it (fold/cut/cat/nl/head/tail with flag or numeric arguments and no file operand): the upstream line-range read is still the same read of the same span, so such stages must not hide it from the hint.
export const FORMATTING_STAGE_RE = /^(?:fold|cut|cat|nl|head|tail)(?:\s+(?:-\S+|[\d,+-]+))*\s*$/

/** Compound spelling of the same line-range read: `sed -n 'A,Bp' f1; echo "=== f2 ==="; sed -n 'C,Dp' f2` (also with `&&` or newline separators), or a single read piped through formatting-only stages (`sed -n 'A,Bp' f | fold -w 160`). Loop-45 corpus measurement: these two families were 1,200+ and 550+ of the 6,438 real sed commands the single-command extractor missed, all of them ordinary reads. Every segment must be a line-range read, a bare echo separator, or a formatting-only stage; any other segment (a redirect into a file, an edit, an unknown command) rejects the whole command so nothing is described wrongly. Returns the per-file reads in first-seen order, ranges merged per file, or null. */
export function extractLineRangeReadsCompound(cmd: string): Array<{ filePath: string; ranges: Array<readonly [number, number]>; tool: 'sed' | 'awk' }> | null {
  // `2>&1` and `2>/dev/null` are stripped up front: splitShellSegments treats a bare `&` as a separator, so an inline `2>&1` would otherwise shear the segment in two.
  const cleaned = cmd.replace(/\s2>(?:&1|\/dev\/null)/g, '')
  const segments = splitShellSegments(cleaned)
  if (segments.length < 2) return null
  const reads: Array<{ filePath: string; ranges: Array<readonly [number, number]>; tool: 'sed' | 'awk' }> = []
  for (const seg of segments) {
    const r = extractLineRangeRead(seg)
    if (r !== null) {
      reads.push(r)
      continue
    }
    if (/^echo\b[^<>]*$/.test(seg)) continue
    if (FORMATTING_STAGE_RE.test(seg)) continue
    return null
  }
  if (reads.length === 0) return null
  const merged = new Map<string, { filePath: string; ranges: Array<readonly [number, number]>; tool: 'sed' | 'awk' }>()
  for (const r of reads) {
    const prev = merged.get(r.filePath)
    if (prev !== undefined) prev.ranges.push(...r.ranges)
    else merged.set(r.filePath, { filePath: r.filePath, ranges: [...r.ranges], tool: r.tool })
  }
  return [...merged.values()]
}

/**
 * Builds the recall hint for a `sed -n 'N,Mp' file` read (or multi-range `sed -n 'N,Mp;X,Yp' file`) that has already been priced and found cheaper than the read it replaces -- see bash_range_savings.ts, which owns that comparison and whose result `sub` is.
 *
 * This used to be a language ladder that named the file and left the agent to supply the heading, key or symbol: `token-goat section "CHANGELOG.md::<heading>"`. Measured, that advice cost more than it saved and could not be followed well even in principle -- the obvious substitution on the largest real case returned 15,150 bytes against the 10,572 the `sed` window asked for, and the heading whose name an agent would guess (`Unreleased`) is not the one the index holds (`[Unreleased]`) -- recoverable, as it happens, because `section` resolves fuzzily and prints "redirected from", but only by a fallback catching it, not because the advice was answerable as written. So the hint now names the exact regions the pricing resolved and the saving it measured, rather than a shape for the agent to fill in.
 */
export function sedRangeHint(
  filePath: string,
  ranges: ReadonlyArray<readonly [number, number]>,
  tool: 'sed' | 'awk',
  sub: RangeSubstituteFigures,
): string {
  return '`' + (tool === 'awk' ? 'awk' : 'sed -n') + '` line-range reads bypass read hooks. ' + substituteSentence(filePath, ranges, sub)
}

/** The figures bash_range_savings.ts's pricing produces, as the hint builders consume them. Declared structurally rather than imported so this module keeps its no-index-access property (see the note above surgicalHintFor). */
export interface RangeSubstituteFigures {
  requestedBytes: number
  replacementBytes: number
  commands: readonly string[]
}

/** The one sentence both range-hint shapes share: what was asked for, what the priced replacement costs instead, and the exact commands that return it. */
function substituteSentence(filePath: string, ranges: ReadonlyArray<readonly [number, number]>, sub: RangeSubstituteFigures): string {
  const spans = ranges.map(([s, e]) => s + '-' + e).join(', ')
  const reads = sub.commands.map((c) => '`' + c + '`')
  const allReads = reads.length === 2
    ? reads.join(' and ')
    : reads.length >= 3
      ? reads.slice(0, -1).join(', ') + ', and ' + reads[reads.length - 1]
      : reads[0]!
  return (
    'Lines ' + spans + ' of ' + filePath + ' cost ' + sub.requestedBytes + ' bytes; ' + allReads +
    ' returns the same content as ' + sub.replacementBytes + ' bytes, resolved to whole regions and robust to line shifts.'
  )
}

// Returns the previously-served range that overlaps [start, end] the most (by shared line count), or null if none overlap.
/**
 * Hint for a leading-lines read (`head -n N file`, `Get-Content file | Select-Object -First N`): the overlap warning when those lines were already served this session, the ordinary surgical hint when they were not.
 *
 * The lead-in plus a language-shaped surgical suggestion used to be the unconditional else-branch here. It is now the priced substitute sentence instead, for the reason recorded on {@link sedRangeHint}: the language ladder named the file and left the agent to supply a heading or symbol, and on the largest measured real case the obvious substitution cost 43% more than the read it objected to.
 *
 * These commands have always *written* to the line-range ledger -- `recordBashFileReadsForSessionCache` records 1..n once the command succeeds, because leading-lines reads are the one truncated shape whose absolute range is known -- but nothing ever read that entry back. So a second `head -30 CHANGELOG.md` produced the same generic advice as the first, and never mentioned that the lines were already in context. A ledger's write half and read half are separately observable, and a guard holding only one of them is indistinguishable from a working guard from the outside.
 *
 * `tail` deliberately stays out of this: its absolute start line depends on the file's total length, which this hook does not know, so it is recorded as truncated rather than as a range and there is no trustworthy range here to compare against.
 *
 * Checks without recording, because for these shapes the recording is the post-hook's job and happens only if the command actually succeeds.
 *
 * Returns null when there is nothing worth saying: the lines were not already served AND the caller's pricing (`substitute`, null when the replacement could not be priced or was not cheaper -- see bash_range_savings.ts) found no saving to offer. The already-served overlap warning is never gated on that pricing: it reports that this content is already in context, which is a saving of the whole read and owes nothing to whatever command replaces it.
 */
export function leadingLinesHint(
  lead: string,
  hintPath: string,
  start: number,
  end: number,
  preHookCwd: string | null,
  substitute: RangeSubstituteFigures | null,
): string | null {
  const key = resolveIndexPath(hintPath, preHookCwd ?? process.cwd())
  const prior = findRangeOverlap(getFileLineRanges(key), start, end)
  if (prior !== null) return sedOverlapHint(hintPath, prior, start, end)
  if (substitute === null) return null
  return lead + substituteSentence(hintPath, [[start, end]], substitute)
}

export function findRangeOverlap(prior: ReadonlyArray<readonly [number, number]>, start: number, end: number): readonly [number, number] | null {
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

// Builds the recall hint when a line range overlaps one already served this session: name the prior range and point at a `read "file@delta"` for only the not-yet-seen lines. Deliberately does not name the tool that served the prior range: the ledger stores ranges, not the command behind each, so an `awk` read followed by a `sed` read of the same span would otherwise be told it had already read them "via an earlier `sed`".
export function sedOverlapHint(filePath: string, prior: readonly [number, number], start: number, end: number): string {
  const base = 'You already read lines ' + prior[0] + '-' + prior[1] + ' of ' + filePath + ' via an earlier line-range read this session; this read (' + start + '-' + end + ') overlaps. '
  // The never-served portion of [start, end] is whatever falls outside [prior[0], prior[1]]: a leading segment when the new request starts before the prior range, a trailing segment when it ends after, or both when the new request straddles the prior range on both sides.
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
export function extractNodeFileRead(cmd: string): { filePath: string; isDoc: boolean; isConfig: boolean; isSql: boolean } | null {
  if (!/^node\s+-e/.test(cmd)) return null
  const readSync = /readFileSync\(['"]([^'"]+\.(?:ts|tsx|js|jsx|py|go|java|rs|rb|cs|md|mdx|rst|txt|json|yaml|yml|toml|xml|conf|cfg|ini|properties|sql))['"]/i.exec(cmd)
  if (readSync?.[1]) {
    const filePath = readSync[1]
    if (isOrchestratorStateFile(filePath)) return null
    if (isTempPath(filePath)) return null
    if (writesBackSamePath(cmd, filePath, NODE_WRITE_METHODS)) return null
    const { isDoc, isConfig, isSql } = classifyDocConfig(filePath)
    return { filePath, isDoc, isConfig, isSql }
  }
  // Also catch require('path/to/file.json') — common for one-liner version lookups
  const requireM = /require\(['"]([^'"]+\.json)['"]\)/i.exec(cmd)
  if (requireM?.[1]) {
    const filePath = requireM[1]
    // Only intercept project files — node_modules paths are resolved internally
    if (filePath.includes('node_modules')) return null
    if (isOrchestratorStateFile(filePath)) return null
    if (isTempPath(filePath)) return null
    if (writesBackSamePath(cmd, filePath, NODE_WRITE_METHODS)) return null
    return { filePath, isDoc: false, isConfig: true, isSql: false }
  }
  return null
}

/** Extracts file path from `tail -n X <path>` or `tail -X <path>` commands on source files. Excludes -f (follow), -c (byte mode), and +N (offset). */
export function extractTailFile(cmd: string): { filePath: string; isDoc: boolean; isConfig: boolean; isSql: boolean; isXml: boolean } | null {
  if (/-f\b/.test(cmd)) return null // follow mode — legitimate streaming
  if (/-c\b/.test(cmd)) return null // byte mode
  if (/-n\s*\+/.test(cmd)) return null // tail from line N offset — legitimate
  const direct = /^tail(?:\s+-n\s+(\d+)|\s+-(\d+))?\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd)
  // Piped spelling of the same trailing-lines read: `cat [flags] FILE [2>&1|2>/dev/null] | tail -N` (loop-46 census: 26 qualifying reads). The -f/-c/-n + guards above already rejected streaming/byte/offset variants on the whole command.
  const piped = direct === null ? /^cat(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+))*\s+(?:"([^"]+)"|'([^']+)'|(\S+?))(?:\s+2>(?:&1|\/dev\/null))?\s*\|\s*tail(?:\s+-n\s+(\d+)|\s+-(\d+))?\s*$/.exec(cmd) : null
  if (direct === null && piped === null) return null
  const n = parseInt((direct !== null ? (direct[1] ?? direct[2]) : (piped![4] ?? piped![5])) ?? '0', 10)
  if (n <= 10) return null // already surgical
  const filePath = direct !== null ? (direct[3] ?? direct[4] ?? direct[5]) : (piped![1] ?? piped![2] ?? piped![3])
  if (!filePath) return null
  if (isTempPath(filePath)) return null
  if (!/\.(?:ts|tsx|js|jsx|py|go|java|rs|rb|cs|md|mdx|rst|txt|json|yaml|yml|toml|sql|sh|xml|dtsx|ampkg|xaml)$/i.test(filePath)) return null
  const { isDoc, isConfig, isSql, isXml } = classifyDocConfig(filePath)
  return { filePath, isDoc, isConfig, isSql, isXml }
}

// Extracts file path from `Get-Content <path> -Tail N` or `Get-Content -Tail N <path>` (PowerShell).
export function extractGetContentTail(cmd: string): { filePath: string; isDoc: boolean; isConfig: boolean; isSql: boolean; isXml: boolean } | null {
  // Match: Get-Content <file> -Tail <N> or Get-Content -Tail <N> <file>
  const tailMatch = /-Tail\s+(\d+)/i.exec(cmd)
  if (!tailMatch) return null
  const n = parseInt(tailMatch[1]!, 10)
  if (n <= 10) return null
  const getnMatch = /^(Get-Content|gc)\s+/i.exec(cmd)
  if (!getnMatch) return null
  // Extract filePath: everything between command and -Tail, or between -Tail N and end. A `-Path` flag is stripped wherever it falls (it names the very positional argument that follows it, e.g. `Get-Content -Path src/auth.ts -Tail 50` or `Get-Content -Tail 50 -Path src/auth.ts`), matching PS_GETCONTENT_INNER_RE and extractCatFile's own leading-flag skip -- without it, "-Path " itself became a permanent prefix of the extracted path.
  const afterCmd = cmd.slice(getnMatch[0].length).replace(/-Path\s+/i, '')
  const beforeTail = afterCmd.split(/-Tail/i)[0]?.trim() ?? ''
  const afterTail = afterCmd.split(/-Tail\s+\d+/i)[1]?.trim() ?? ''
  const filePath = (beforeTail || afterTail).replace(/^["']|["']$/g, '')
  if (!filePath) return null
  if (isTempPath(filePath)) return null
  if (!/\.(?:ts|tsx|js|jsx|py|go|java|rs|rb|cs|md|mdx|rst|txt|json|yaml|yml|toml|sql|sh|ps1|psm1|xml|dtsx|ampkg|xaml)$/i.test(filePath)) return null
  const { isDoc, isConfig, isSql, isXml } = classifyDocConfig(filePath)
  return { filePath, isDoc, isConfig, isSql, isXml }
}

// Extracts file path from `Get-Content <path> | Select-Object -First N` (PowerShell).
export function extractGetContentSelectFirst(cmd: string): { filePath: string; isDoc: boolean; isConfig: boolean; isSql: boolean; isXml: boolean; n: number } | null {
  const m = /^(Get-Content|gc)\s+([^|]+)\s*\|\s*(Select-Object|select)\s+(-First\s+(\d+))/i.exec(cmd)
  if (!m) return null
  // A `-Path` flag names the very positional argument that follows it (e.g. `Get-Content -Path src/auth.ts | ...`); left unstripped it became a permanent prefix of the extracted path, matching the same fix in extractGetContentTail.
  const filePath = (m[2]?.trim() ?? '').replace(/^-Path\s+/i, '').replace(/^["']|["']$/g, '')
  const n = parseInt(m[5] ?? '0', 10)
  if (n <= 10) return null // already surgical -- matches extractGetContentTail's <=10 threshold
  if (!filePath) return null
  if (isTempPath(filePath)) return null
  if (!/\.(?:ts|tsx|js|jsx|py|go|java|rs|rb|cs|md|mdx|rst|txt|json|yaml|yml|toml|sql|sh|ps1|psm1|xml|dtsx|ampkg|xaml)$/i.test(filePath)) return null
  const { isDoc, isConfig, isSql, isXml } = classifyDocConfig(filePath)
  return { filePath, isDoc, isConfig, isSql, isXml, n }
}

// Extracts file path from `Get-Content <path> -TotalCount N` / `-Head N` / `-First N` (PowerShell).
export function extractGetContentHead(cmd: string): { filePath: string; isDoc: boolean; isConfig: boolean; isSql: boolean; isXml: boolean; n: number } | null {
  const headMatch = /-(?:TotalCount|Head|First)\s+(\d+)/i.exec(cmd)
  if (!headMatch) return null
  const n = parseInt(headMatch[1]!, 10)
  if (n <= 10) return null // already surgical -- matches extractHeadFile's <=10 threshold
  const getnMatch = /^(Get-Content|gc)\s+/i.exec(cmd)
  if (!getnMatch) return null
  const afterCmd = cmd.slice(getnMatch[0].length).replace(/-Path\s+/i, '')
  const beforeHead = afterCmd.split(/-(?:TotalCount|Head|First)/i)[0]?.trim() ?? ''
  const afterHead = afterCmd.split(/-(?:TotalCount|Head|First)\s+\d+/i)[1]?.trim() ?? ''
  const cleanedBefore = beforeHead.replace(/-(?:Encoding|Delimiter|Wait)\s+\S+/gi, '').replace(/-[a-zA-Z]+/g, '').trim()
  const cleanedAfter = afterHead.replace(/-(?:Encoding|Delimiter|Wait)\s+\S+/gi, '').replace(/-[a-zA-Z]+/g, '').trim()
  const filePath = (cleanedBefore || cleanedAfter).replace(/^["']|["']$/g, '')
  if (!filePath) return null
  if (isTempPath(filePath)) return null
  if (!/\.(?:ts|tsx|js|jsx|py|go|java|rs|rb|cs|md|mdx|rst|txt|json|yaml|yml|toml|sql|sh|ps1|psm1|xml|dtsx|ampkg|xaml)$/i.test(filePath)) return null
  const { isDoc, isConfig, isSql, isXml } = classifyDocConfig(filePath)
  return { filePath, isDoc, isConfig, isSql, isXml, n }
}

/**
 * Detects `cat` or `tail` commands on a tasks output path and returns the task ID so the caller can emit a `token-goat bash-output` recall hint.
 *
 * Tasks output files follow the pattern `…/tasks/<id>.output`. They are written to disk by the harness (not through the bash-output cache), so re-reading via cat/tail wastes tokens that `token-goat bash-output --file <path>` returns surgically. The matched path is returned so the recall hint can name a command that actually works (`bash-output <id>` misses, since the task id is not a bash-output cache key).
 */
/**
 * Whether a `…/tasks/<id>.output` file holds an agent's JSONL transcript rather than a background command's stdout.
 *
 * Both kinds land in the same directory under the same extension, so the extension answers nothing: an agent task's file is JSONL and worth several hundred kilobytes, while a background bash task's file is whatever the command printed and is meant to be read. The first non-whitespace byte tells them apart, and only that byte is read -- the transcripts this guards against are large enough that pulling the whole file in to look at its first character is the cost the guard exists to avoid. Anything unreadable answers false, so a missing file leaves the command alone.
 *
 * `normalizePath` first: Git Bash yields `/c/Users/...` and WSL `/mnt/c/Users/...`, neither of which Node can resolve on Windows, so an unnormalized read always throws ENOENT and silently turns the guard off for those shells.
 */
export function taskOutputIsJsonlTranscript(outPath: string): boolean {
  let fd: number | null = null
  try {
    fd = openSync(normalizePath(outPath), 'r')
    const buf = Buffer.alloc(64)
    const read = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, read).toString('utf-8').trim().startsWith('{')
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* already closed or never opened cleanly */
      }
    }
  }
}

export function extractTasksOutput(cmd: string): { id: string; path: string; n?: number } | null {
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

/** Extracts file path from `cat`, `tail` commands on tool-results/*.txt. Returns { path } for valid matches. */
export function extractToolResultsFile(cmd: string): { path: string } | null {
  const toolResultsRe = new RegExp('[/\\\\]tool-results[/\\\\](' + TOOL_RESULTS_ID_CHARS + ')\\.txt$', 'i')

  // cat command (same regex structure as extractCatFile, checked before isTempPath)
  const catM = /^cat(?:\s+(?:-[a-zA-Z]+|--[a-zA-Z-]+))*\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd)
  if (catM) {
    const fp = catM[1] ?? catM[2] ?? catM[3]
    if (fp) {
      const m = toolResultsRe.exec(fp)
      if (m) return { path: fp }
    }
  }

  // tail command — handles -n (line-count) and -c (byte-count) modes; excludes -f follow and +N offset
  if (!/-f\b/.test(cmd) && !/-n\s*\+/.test(cmd)) {
    // Standard line-count tail: -n N or -N or no count
    const tailM = /^tail(?:\s+-n\s+(\d+)|\s+-(\d+))?\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd)
    if (tailM) {
      const fp = tailM[3] ?? tailM[4] ?? tailM[5]
      if (fp) {
        const m = toolResultsRe.exec(fp)
        if (m) return { path: fp }
      }
    }
    // Byte-mode tail: -c N
    const byteTailM = /^tail\s+-c\s+\d+\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(cmd)
    if (byteTailM) {
      const fp = byteTailM[1] ?? byteTailM[2] ?? byteTailM[3]
      if (fp) {
        const m = toolResultsRe.exec(fp)
        if (m) return { path: fp }
      }
    }
  }

  return null
}

/**
 * Returns true when the command is a directory listing (eza --long or ls … | head) for which `token-goat map --compact` is a cheaper alternative.
 */
export function extractDirectoryListing(cmd: string): boolean {
  return (
    /^eza\s+.*--long\s+\S+/.test(cmd) ||
    /^eza\s+.*--tree/.test(cmd) ||
    /^tree(\s|$)/.test(cmd) ||
    /^ls\s+(?:\S+\s+)*-[a-zA-Z]*R[a-zA-Z]*(?:\s|$)/.test(cmd) ||
    /^ls\s+(?:-[la]+\s+)?(\S+)\s*[|]\s*head/.test(cmd) ||
    /^ls\s+(?:-[la]+\s+)?(\S+)\s*[|]\s*grep/.test(cmd) ||
    /^ls\s+(?:-[la]+\s+)?(\S+)\s*[|]\s*wc/.test(cmd) ||
    /^(?:Get-ChildItem|gci|dir)\b.*(?:-Recurse|-r\b|\/s\b)/i.test(cmd)
  )
}

/** Detects `for f in FILES; do wc -l $f; done` size-probing idioms. */
export function extractForLoopWcL(cmd: string): boolean {
  return /^for\s+\w+\s+in\s+.*;\s*do\s+wc\s+-l/.test(cmd)
}

/**
 * Returns a parsed find command descriptor when the command is a `find` invocation.
 * - `extGlob`: the glob pattern from `-name "*.ext"`, or null when absent.
 * - `isXargsGrepL`: true when the pipeline ends with `| xargs grep -l` (symbol search anti-pattern). Returns null when the command does not start with `find`.
 */
export function extractFindCommand(cmd: string): { extGlob: string | null; isXargsGrepL: boolean } | null {
  if (!/^find\b/.test(cmd)) return null
  const isXargsGrepL = /[|]\s*xargs\s+(?:grep|rg)\s+.*-l\b/.test(cmd)
  const nameMatch = /-name\s+['"]([^'"]+)['"]/i.exec(cmd)
  const extGlob = nameMatch ? (nameMatch[1] ?? null) : null
  return { extGlob, isXargsGrepL }
}

/**
 * Returns the file path when the command is a grep/rg -n heading-anchor search on a markdown file (`.md` or `.markdown`). These are used as a hand-rolled "show me the table of contents" idiom; `token-goat outline` is cheaper and gives line ranges.
 *
 * Triggers on patterns like: `^#`, `^##`, `^###`, `^#+`, `^## |^### `, `^#\+`. Does NOT trigger for non-markdown files (e.g. `.sh`, `.ts`) or patterns that are not heading anchors.
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
 * Returns the file path when the command is an rg/grep structural definition search on a single source file. Structural patterns are those that find function/class/import definitions (^def, ^class, ^function, ^import, etc.) — the common "show me the structure of this file" idiom that token-goat skeleton does better.
 */
export function extractRgStructuralSearch(cmd: string): { filePath: string } | null {
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
 * Returns true when a command chains two grep/rg stages together (e.g. `grep … | grep …`). Only matches when BOTH pipeline stages are grep or rg — does not fire for `grep | wc`, `grep | head`, `grep | sort`, `grep | awk`, etc.
 */
export function extractGrepPipeChain(cmd: string): boolean {
  return /^(?:rg|grep)\b.*\|\s*(?:rg|grep)\b/.test(cmd)
}

/**
 * Splits a command into shell-ish words, honouring single and double quotes and dropping the quote characters, so a flag value that contains spaces stays one word.
 */
export function splitCommandWords(cmd: string): string[] {
  const words: string[] = []
  let cur = ''
  let quote: string | null = null
  let started = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] as string
    if (quote !== null) {
      // Inside double quotes a backslash still escapes the quote character, so `"X: \" y"` is one word holding a literal `"`. Reading it as the closing quote split the word there and left the rest of the command parsed as if it were positional arguments.
      if (ch === '\\' && quote === '"' && i + 1 < cmd.length) {
        cur += cmd[i + 1] as string
        i++
        continue
      }
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '\\' && i + 1 < cmd.length) {
      cur += cmd[i + 1] as string
      i++
      started = true
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) words.push(cur)
      cur = ''
      started = false
      continue
    }
    cur += ch
    started = true
  }
  if (started) words.push(cur)
  return words
}

/**
 * curl flags whose next word is a value rather than the request target. A URL sitting in one of these is not what curl fetches -- `-H 'Referer: https://cdn…'` and `-A 'Bot https://bot…'` both carry one -- so the target has to be picked by argument position, not by "first URL in the string".
 */
export const CURL_VALUE_FLAGS = new Set([
  '-H', '--header', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-c', '--cookie-jar',
  '-o', '--output', '--output-dir', '-u', '--user', '-U', '--proxy-user', '-x', '--proxy', '-X',
  '--request', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '-F', '--form',
  '-T', '--upload-file', '-K', '--config', '-w', '--write-out', '-m', '--max-time', '--connect-to',
  '--resolve', '--retry', '--cacert', '-E', '--cert', '--key', '--range', '-r', '--interface',
  // Options whose own value is a URL or a host. Leaving these out was the same defect as reading the first URL in the string: `curl --doh-url https://doh/ -o f https://target` answered with the DoH resolver rather than the file being fetched. `--url-query` belongs here too -- it appends query data to the request, it does not name the request target.
  '--url-query', '--doh-url', '--preproxy', '--proxy1.0', '--socks4', '--socks4a', '--socks5',
  '--socks5-hostname', '--proxy-header', '--noproxy', '--dns-servers', '--aws-sigv4', '--proxy-cacert',
  '--proxy-cert', '--proxy-key', '--oauth2-bearer', '--hsts', '--alt-svc', '--etag-save',
  '--etag-compare', '--trace', '--trace-ascii', '--dump-header', '-D',
])

/**
 * The URL curl actually requests: the first bare (non-flag-value) `https?://` argument, or the value of an explicit `--url`. Returns null when none is present.
 *
 * Used to key the bash-output cache and the download-recall map on the URL rather than the full command string, so `curl -s <url> | jq …` and `curl -s <url> | python3 …` share one entry. Reading the first URL anywhere in the string instead made every command carrying a URL in a header collapse onto that header's URL: two genuinely different downloads shared one key, and the second was refused as "already downloaded" to the first one's file.
 */
export function extractCurlUrl(cmd: string): string | null {
  const words = splitCommandWords(cmd)
  let positional: string | null = null
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string
    if (w === '--url') {
      const next = words[i + 1]
      if (next !== undefined && /^https?:\/\//.test(next)) return next
      i++
      continue
    }
    const eq = w.indexOf('=')
    if (w.startsWith('--') && eq > 0) {
      // `--header=...` / `--url=...`: the value rides on the same word.
      if (w.slice(0, eq) === '--url' && /^https?:\/\//.test(w.slice(eq + 1))) return w.slice(eq + 1)
      continue
    }
    if (CURL_VALUE_FLAGS.has(w)) {
      i++
      continue
    }
    // A short flag written glued to its value (`-H'Referer: …'`, `-ohttps://x`) carries no positional argument of its own.
    if (w.startsWith('-') && w !== '-') continue
    if (/^https?:\/\//.test(w)) return w
    // The target written through a substitution or a variable (`"$(printf https://x)"`, `"${BASE}/a"`) is still a positional argument, so the URL inside it is the one being fetched. Only positionals are searched this way: a URL inside a header value was skipped above as a flag value and never reaches here. `)` and `}` end the enclosing substitution rather than belonging to the URL.
    positional ??= /https?:\/\/[^\s'")}`]+/.exec(w)?.[0] ?? null
  }
  if (positional !== null) return positional
  return null
}

/** Match a `token-goat symbol|read|section|skill-body|skill-compact|map <spec>` invocation. `spec` mirrors read_commands.ts's `file::target` split for read/section; skill-body/skill-compact/map dedup on the raw remainder (map's remainder is just an optional `--compact` flag, or empty). `stats` is intentionally excluded -- its output changes as the session progresses, so deduping it would suppress a legitimately different result. `cwd` is the bash command's working directory (from the hook event), used to resolve a relative file path the same way the CLI itself would. */
export function extractTgSurgicalRead(cmd: string, cwd: string | null): { sub: string; spec: string; filePath: string | null } | null {
  const m = /^(?:token-goat|tg)\s+(symbol|read|section|skill-body|skill-compact|map)(?:\s+(.*))?$/.exec(cmd)
  if (!m) return null
  const sub = m[1]!
  const rest = (m[2] ?? '').trim()

  // map takes no file::symbol spec, only an optional --compact flag (or nothing) -- dedup on the raw remainder, same as skill-body/skill-compact without a --path.
  if (sub === 'map') {
    return { sub, spec: rest, filePath: null }
  }

  // skill-body/skill-compact take a name (or --path/--all flags), not a file::symbol spec.
  if (sub === 'skill-body' || sub === 'skill-compact') {
    // `--path <file>` takes an actual file path — resolve it the same way read/section do (against cwd, normalized) so relative/differently-cased/slash-direction variants of the same file collide under one dedup key, instead of the raw --path text differing byte-for-byte across equivalent invocations. A plain NAME arg (or --all) isn't a file path, so it still dedups on the raw remainder unchanged.
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
    // A `read` spec may carry a `@N-M`/`@N` line-range suffix (read_commands.ts's own parseLineRange, mirrored here so the split stays in sync) ahead of any `::symbol` split. Strip it before extracting the file path so the dedup/pending-hint key is the bare path a plain-path lookup expects — otherwise a range read's filePath still carries the @N-M suffix and never matches the file it actually reads.
    const rangeMatch = /^(.+)@(\d+)(?:-(\d+))?$/.exec(rawSpec)
    const rangeSuffix = rangeMatch !== null ? '@' + rangeMatch[2] + (rangeMatch[3] !== undefined ? '-' + rangeMatch[3] : '') : ''
    const specWithoutRange = rangeMatch !== null ? rangeMatch[1]! : rawSpec
    const colonIdx = specWithoutRange.indexOf('::')
    const rawFilePath = colonIdx === -1 ? specWithoutRange : specWithoutRange.slice(0, colonIdx)
    // Resolve against the command's cwd (falling back to this hook process's own cwd, which is wrong but the best available signal, when the event carries none) before normalizing: a relative spec run from two different directories must NOT collide under one dedup key, and a relative spec run twice from the SAME directory must — bare normalizePath does neither, since it only canonicalizes drive-letter case and slash direction, never resolves cwd.
    filePath = resolveIndexPath(rawFilePath, cwd ?? process.cwd())
    spec = (colonIdx === -1 ? filePath : filePath + specWithoutRange.slice(colonIdx)) + rangeSuffix
  }
  return { sub, spec, filePath }
}

/**
 * Returns true when `cmd` carries an explicit non-GET method, a request-body flag, or auth credentials -- the three curl-unsafe-to-cache conditions shared by {@link isCurlGetCommand} and {@link extractCurlDownload}. Callers still check `^curl\b` themselves since only they know whether to return `false` or `null` on mismatch.
 */
export function curlHasUnsafeFlags(cmd: string): boolean {
  // Explicit non-GET method
  if (/-X\s+(?:POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/i.test(cmd)) return true
  if (/--request(?:\s+|=)(?:POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/i.test(cmd)) return true
  // Request body (implies non-GET)
  if (/(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode)?|-F|--form)\b/.test(cmd)) return true
  // Auth credentials — skip caching to avoid leaking tokens into the output store. The header check covers both curl's short (-H) and long (--header) spellings — the long form was previously unmatched, so `curl --header 'Authorization: ...' <url>` slipped past this guard and got cached (and recall-hinted) with the credential embedded in the stored command string. It also allows `=` as well as whitespace between the long flag and its value, since curl accepts both `--header 'Authorization: ...'` and `--header='Authorization: ...'` (and same for --user) -- the space-only form previously let the `=` spelling slip past uncached.
  if (/(?:^|\s)(?:-u|--user)\b/.test(cmd)) return true
  if (/(?:-H|--header)(?:\s+|=)['"]?Authorization/i.test(cmd)) return true
  return false
}

/**
 * Returns true when the command is a `curl` GET request whose response is safe to cache (no -X POST/PUT/PATCH/DELETE, no request body flags, no auth credentials).
 */
export function isCurlGetCommand(cmd: string): boolean {
  if (!/^curl\b/.test(cmd)) return false
  return !curlHasUnsafeFlags(cmd)
}

/**
 * Returns true when the command is a read-only `gh api` GET whose response is safe to cache: not GraphQL (always a POST query), no mutating method, and no request-body/field flags (gh defaults to POST when -f/-F/--field/--raw-field/--input are present). An explicit `--method GET` / `-X GET` is honored even with other flags. An embedded Authorization header is skipped so a credential is never persisted into the cached command string.
 */
export function isReadOnlyGhApi(cmd: string): boolean {
  if (!/^gh\s+api\b/.test(cmd)) return false
  if (/\bgraphql\b/.test(cmd)) return false
  // gh (Go's pflag) accepts `=` as well as whitespace between a long OR short flag and its value (`-X=GET`, `--method=GET`, `-H=...`, `--header=...`), unlike curl's getopt-style short flags -- the space-only form previously let the `=` spelling slip past these guards uncached/miscategorized.
  if (/(?:-H|--header)(?:\s+|=)['"]?Authorization/i.test(cmd)) return false
  if (/(?:-X|--method)(?:\s+|=)GET\b/i.test(cmd)) return true
  if (/(?:-X|--method)(?:\s+|=)(?:POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i.test(cmd)) return false
  if (/\s(?:-f|-F|--field|--raw-field|--input)\b/.test(cmd)) return false
  return true
}

export const GH_VIEW_BATCH_HINT_KEY = 'gh-view-field-batch'

export const GH_VIEW_RE = /^gh\s+(pr|issue)\s+view\b(.*)$/i

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
export function buildGhViewBatchAdvisory(sub: 'pr' | 'issue', ref: string | undefined): string {
  const target = ref ? ref + ' ' : ''
  const fields = sub === 'pr' ? 'number,title,state,body,labels,reviews,files' : 'number,title,state,body,labels,comments'
  const example = 'gh ' + sub + ' view ' + target + '--json ' + fields
  return '`gh ' + sub + ' view` field queries can be batched: fetch every field you need in one round-trip with `' + example + '` (slice it with `--jq`) instead of querying field-by-field across multiple calls.'
}

/**
 * Extracts {url, outputPath} from a `curl -o <file> <url>` download command. Returns null for non-curl commands, commands without `-o`/`--output`, or commands with auth/POST/body flags that should not be cached.
 */
export function extractCurlDownload(cmd: string): { url: string; outputPath: string } | null {
  if (!/^curl\b/.test(cmd)) return null
  // Must have -o / --output flag
  const outputMatch = /(?:^|\s)(?:-o|--output)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(cmd)
  if (!outputMatch) return null
  const outputPath = outputMatch[1] ?? outputMatch[2] ?? outputMatch[3]
  if (!outputPath) return null
  if (curlHasUnsafeFlags(cmd)) return null
  // The request target, picked by argument position -- a URL inside a header or user-agent value is not what is being downloaded, and keying on it made two different downloads collide.
  const url = extractCurlUrl(cmd)
  if (url === null) return null
  return { url, outputPath }
}

/** True when the command is a TypeScript compiler invocation. */
export function isTscCommand(cmd: string): boolean {
  return /^\s*tsc(\s|$)/i.test(cmd)
}

/** True when the command is a JS/TS dev server (vite dev, next dev, nuxt dev). */
export function isDevServerCommand(cmd: string): boolean {
  return /^\s*(vite\s+dev|next\s+dev|nuxt\s+dev)\b/i.test(cmd)
}

/**
 * Build the recall hint text for a cached build command output.
 *
 * Returns a hint tailored to the command type (tsc, dev server, or generic).
 */
export function buildRecallHint(cmd: string, outputId: string): string {
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

/** Single-quote a string as one POSIX shell argument (escapes embedded quotes). */
export function shellQuoteSingle(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * True when `cmd` is a single command with no shell control operators — the same shape {@link detectFromCommand} requires. Gates the generic-filter fallback so a pipeline / compound / command-substitution / redirect is never wrapped (its `&&`/`|`/`>` would confuse both the outer shell and the `compress -c` arg).
 */
export function isCompressibleSingleCommand(cmd: string): boolean {
  if (!cmd || cmd.length > 65536) return false
  if (['$(', '`'].some((op) => cmd.includes(op))) return false
  // Quote-aware, matching detectFromCommand's own gate: a `&&`/`||`/`|`/`;`/`<`/`>` inside a quoted argument (e.g. an environment value like `--environment PATTERN='foo|bar'`) is literal text, not a control operator, and must not disqualify an otherwise-single command from the generic compression fallback. `$(`/backtick stay an unmasked substring check: double quotes do not suppress command substitution, so masking double-quoted spans would wave through `echo "$(rm -rf /)"` (see hasUnquotedOperator's own doc comment).
  if (hasUnquotedOperator(cmd, ['&&', '||', '|', ';', '<', '>'])) return false
  if (hasBareBackgroundOrNewline(cmd)) return false
  return true
}

/** Result from terminal XML parsing command detection. */
export interface TerminalXmlParsingResult {
  filePath?: string | undefined
  toolOrScript: string
}

/**
 * Detects terminal commands attempting to parse XML via PowerShell (Select-Xml, [xml]), Python (xml.etree, BeautifulSoup, minidom, lxml), scratch PowerShell inspect scripts (inspect_*.ps1), or shell XML tools (xmllint, xmlstarlet, xidel).
 */
export function extractTerminalXmlParsing(cmd: string): TerminalXmlParsingResult | null {
  const trimmed = cmd.trim()
  if (!trimmed) return null

  // 1. PowerShell Select-Xml: `Select-Xml ...`
  const selectXmlM = /\bSelect-Xml\b(?:\s+(?:-Path\s+)?["']?([^"'\s|;]+(?:\.xml|\.dtsx|\.ampkg|\.xaml))["']?)?/i.exec(trimmed)
  if (selectXmlM) {
    const rawPath = selectXmlM[1]
    const filePath = rawPath && !rawPath.startsWith('-') ? rawPath : undefined
    return { filePath, toolOrScript: 'Select-Xml' }
  }

  // 2. PowerShell [xml] cast or XmlDocument
  const psXmlCastM = /\[(?:xml|System\.Xml\.XmlDocument)\]/i.exec(trimmed)
  if (psXmlCastM) {
    const fileM = /["']([^"'\r\n]+\.(?:xml|dtsx|ampkg|xaml))["']/i.exec(trimmed) ||
                  /(?:Get-Content|gc|ReadAllText)\s+["']?([^"'\s|;)]+\.(?:xml|dtsx|ampkg|xaml))["']?/i.exec(trimmed)
    const filePath = fileM?.[1]
    return { filePath, toolOrScript: psXmlCastM[0] }
  }

  // 3. Scratch inspect scripts (e.g. inspect_exported*.ps1, inspect_*.ps1)
  const inspectScriptM = /(?:powershell|pwsh|&|\.)?\s*["']?(\.?[/\\]?inspect_[^"'\s|;]+\.ps1)["']/i.exec(trimmed) ||
                         /\b(inspect_[^"'\s|;]+\.ps1)\b/i.exec(trimmed)
  if (inspectScriptM) {
    const fileM = /["']([^"'\r\n]+\.(?:xml|dtsx|ampkg|xaml))["']/i.exec(trimmed)
    const filePath = fileM?.[1]
    return { filePath, toolOrScript: inspectScriptM[1] ?? 'inspect script' }
  }

  // 4. Python XML one-liners: `python ... -c ... (xml.etree|BeautifulSoup|minidom|lxml)`
  const pyXmlM = /\bpython(?:\d+(?:\.\d+)?)?(?:\.exe)?\b.*-c\s+["'].*?\b(xml\.etree|BeautifulSoup|minidom|lxml)\b/i.exec(trimmed)
  if (pyXmlM) {
    const fileM = /["']([^"'\r\n]+\.(?:xml|dtsx|ampkg|xaml))["']/i.exec(trimmed)
    const filePath = fileM?.[1]
    return { filePath, toolOrScript: `python ${pyXmlM[1]}` }
  }

  // 5. Shell XML CLI utilities: xmllint, xmlstarlet, xidel
  const cliXmlM = /\b(xmllint|xmlstarlet|xidel)\b/i.exec(trimmed)
  if (cliXmlM) {
    const fileM = /["']?([^"'\s|;]+\.(?:xml|dtsx|ampkg|xaml))["']?/i.exec(trimmed)
    const rawPath = fileM?.[1]
    const filePath = rawPath && !rawPath.startsWith('-') ? rawPath : undefined
    return { filePath, toolOrScript: cliXmlM[1]! }
  }

  return null
}

