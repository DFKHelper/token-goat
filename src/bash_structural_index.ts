/**
 * Recognizes a plain-enumeration `rg`/`grep` invocation over a single, already-fresh-indexed
 * file whose pattern maps exactly to a token-goat index answer (`outline`/`imports`), and
 * rewrites the Bash command to that answer instead of running the text search. Every check here
 * is a "don't rewrite" gate: any uncertainty returns null and the original command runs
 * unmodified, because a rewrite that isn't equivalent to what the command would have produced is
 * a silent wrong answer -- worse than no feature. The pattern-to-symbol-kind mapping is keyed on
 * the resolved language of the target file, never on the pattern text alone (`^def ` means
 * functions in Python and nothing in a TypeScript file), and the allowlist below accepts exactly
 * one command shape (binary + pattern + file, no flags, no pipe/redirect/chaining) rather than
 * trying to deny the flags it doesn't understand.
 */
import type { HookEvent } from './hook_registry.js'
import { detectFromCommand } from './tool_filters/index.js'
import { pathStem } from './tool_filters/helpers.js'
import { shellQuoteSingle } from './bash_extractors.js'
import { detectLanguage } from './parser_types.js'
import { languageHasFlag } from './language_specs.js'
import { resolveIndexPath } from './paths.js'
import { getFileEntry } from './index_reader.js'
import { fingerprintFile } from './fingerprint.js'
import { DOC_EXT_RE, STRUCTURAL_DOC_PATTERN_RE } from './hooks_grep.js'
import { statSync } from 'node:fs'

export interface StructuralIndexRewrite {
  /** The full replacement Bash command, including the disclosure line. */
  command: string
  /** Plain-language description of what was substituted, for the disclosure notice. */
  kind: string
}

const ALLOWED_BINARIES = new Set(['rg', 'grep', 'egrep', 'fgrep'])

// Anchored optionally (rg's own `^` is part of the pattern text, not a regex flag), keyword, an
// optional bare identifier naming a name filter, nothing else -- a full signature, a paren, or
// any other trailing text means the user wants something more specific than an enumeration, so
// it falls through to null (pass through) rather than guessing at intent. Matched against the
// trimmed pattern (a trailing `rg 'def '` space is not itself meaningful once `\b` already
// disambiguates "def" from "define"), and the separator whitespace lives inside the optional
// name-capture group so there is no second, adjacent `\s`-quantifier for the regex linter's
// backtracking check to flag.
const PY_DEF_RE = /^\^?(?:async\s+)?def\b(?:\s+([A-Za-z_]\w*))?$/
const PY_CLASS_RE = /^\^?class\b(?:\s+([A-Za-z_]\w*))?$/
// Deliberately anchor-only: an unanchored bare "import" is a common English-word substring
// ("unimportant", "reimport") with none of def/class's near-exclusive association with a
// definition site, so treating it as a structural query would need the intent heuristic this
// recognizer is not allowed to use.
const IMPORT_RE = /^\^import\b/

/**
 * Returns the substitute command for a recognized structural enumeration, or null when any
 * correctness gate is uncertain (in which case the original command must run unmodified).
 */
export function detectStructuralIndexRewrite(event: HookEvent, rawCmd: string, cwd: string): StructuralIndexRewrite | null {
  try {
    // Same known quoting hazard maybeCompressRewrite already guards against: VS Code's terminal
    // shell is unknown to this payload, and Codex/Copilot CLI on Windows run the Bash tool
    // through PowerShell rather than the Git-Bash the payload might suggest, so the single-quote
    // escaping shellQuoteSingle produces below is invalid there.
    if (event.raw['_tg_harness'] === 'vscode') return null
    if ((event.raw['_tg_harness'] === 'codex' || event.raw['_tg_harness'] === 'copilot_cli') && process.platform === 'win32') return null

    // detectFromCommand is quote-aware and already rejects pipes, redirects, `&&`/`||`/`;`
    // chaining, backgrounding, command substitution, and a `cd DIR &&` prefix (a compound
    // command) -- reusing it here means this recognizer inherits that safety net instead of
    // re-deriving its own denylist of separators.
    const detected = detectFromCommand(rawCmd, cwd)
    if (detected === null || detected.filter.name !== 'grep') return null
    const argv = detected.argv
    // The whole allowlist: exactly binary + pattern + file, zero flags. Any flag (-A/-C/-o/-c/-l,
    // an invert, a replace) or a second file/glob adds an argv token and is rejected here, which
    // is what makes this an allowlist of one understood shape rather than a denylist of flags.
    if (argv.length !== 3) return null
    const [bin, pattern, rawPath] = argv
    if (bin === undefined || pattern === undefined || rawPath === undefined) return null
    if (!ALLOWED_BINARIES.has(pathStem(bin).toLowerCase())) return null
    if (/[*?[\]{}]/.test(rawPath)) return null

    const resolved = resolveIndexPath(rawPath, cwd)
    let stat
    try {
      stat = statSync(resolved)
    } catch {
      return null
    }
    if (!stat.isFile()) return null

    // Never answer from a file that was never indexed, or one the index believes is stale --
    // pass through instead of trusting the substitute command's own on-demand reparse to catch
    // up before this hook's decision is already made. Same SHA comparison staleWarning() (in
    // read_commands.ts) makes -- reused as the same two primitives rather than through that
    // module directly, because read_commands.ts is CLI-command-tier code and importing it here
    // would pull the full parser/language-adapter graph into the hook's eager bundle (see
    // tests/guards/dist_chunks_deduped.test.ts's size ceiling on that same path).
    const entry = getFileEntry(resolved)
    if (entry === null) return null
    if (entry.sha !== '') {
      const diskSha = fingerprintFile(resolved)
      if (diskSha === null || diskSha !== entry.sha) return null
    }

    const quotedPath = shellQuoteSingle(rawPath)
    let target: { command: string; kind: string } | null = null

    if (DOC_EXT_RE.test(rawPath) && STRUCTURAL_DOC_PATTERN_RE.test(pattern)) {
      target = { command: `token-goat outline ${quotedPath}`, kind: 'headings' }
    } else {
      const lang = detectLanguage(resolved)
      const trimmedPattern = pattern.trim()
      if (lang === 'python' && languageHasFlag(lang, 'grepSource')) {
        const defMatch = PY_DEF_RE.exec(trimmedPattern)
        const classMatch = defMatch === null ? PY_CLASS_RE.exec(trimmedPattern) : null
        const nameMatch = defMatch ?? classMatch
        if (nameMatch !== null) {
          const name = nameMatch[1]
          target = name
            ? { command: `token-goat outline ${quotedPath} --grep ${shellQuoteSingle('^' + name)}`, kind: `symbols named starting with "${name}" (functions, classes or any other kind sharing that name)` }
            : { command: `token-goat outline ${quotedPath}`, kind: 'all symbols in the file (not just functions/classes)' }
        } else if (IMPORT_RE.test(trimmedPattern)) {
          target = { command: `token-goat imports ${quotedPath}`, kind: 'imports' }
        }
      } else if (lang !== 'unknown' && languageHasFlag(lang, 'grepSource') && IMPORT_RE.test(trimmedPattern)) {
        target = { command: `token-goat imports ${quotedPath}`, kind: 'imports' }
      }
    }
    if (target === null) return null

    const notice = `[token-goat: rewrote this rg/grep search to an indexed answer (${target.kind}) instead of running it -- re-run your original command yourself for a literal text search]`
    return { command: `echo ${shellQuoteSingle(notice)} && ${target.command}`, kind: target.kind }
  } catch {
    return null
  }
}
