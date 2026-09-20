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
import { detectFromCommand } from './tool_filters/index.js'
import { pathStem } from './tool_filters/helpers.js'
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

// A value is safe to emit unquoted, in a POSIX shell and PowerShell 5.1 alike, when it contains
// none of either dialect's metacharacters. Quoting only helps beyond that when the value also
// avoids every character whose meaning *inside* quotes differs between the two: `$` and a
// backtick start expansion inside a double-quoted string in both dialects, but a raw double quote
// or backslash does not close/escape the same way in each, so a value containing either has no
// form both shells parse identically and must be refused rather than escaped for only one of them.
const SHELL_SAFE_UNQUOTED_RE = /^[A-Za-z0-9_.:/+,=@^-]+$/
const SHELL_UNSAFE_IN_EITHER_QUOTING_RE = /[$`"\\\r\n]/

/**
 * Formats `s` as a single shell argument that a POSIX shell and PowerShell 5.1 both parse
 * identically, or null when no such form exists. Prefers no quoting at all -- the only form with
 * zero dialect-specific behavior -- and reaches for double quotes, which both dialects treat as a
 * literal-text delimiter, only for the characters (whitespace, parentheses, brackets, ...) that
 * force some form of quoting.
 */
function dualShellArg(s: string): string | null {
  if (SHELL_SAFE_UNQUOTED_RE.test(s)) return s
  if (SHELL_UNSAFE_IN_EITHER_QUOTING_RE.test(s)) return null
  return `"${s}"`
}

/**
 * Returns the substitute command for a recognized structural enumeration, or null when any
 * correctness gate is uncertain (in which case the original command must run unmodified).
 */
export function detectStructuralIndexRewrite(rawCmd: string, cwd: string): StructuralIndexRewrite | null {
  try {
    // No harness guard here: the emitted command below is one `token-goat ...` invocation built
    // entirely from dualShellArg (unquoted, or the double quotes both a POSIX shell and PowerShell
    // 5.1 honor identically), with no `&&` chaining and no POSIX-only single-quote escaping, so it
    // is not tied to a particular shell the way maybeCompressRewrite's wrapping of an arbitrary
    // user command is.
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

    // A path with no shared-safe form (see dualShellArg) cannot be rewritten without either
    // breaking one of the two dialects or reaching for an escape valid in only one of them --
    // pass the original command through rather than guess.
    const pathArg = dualShellArg(rawPath)
    if (pathArg === null) return null
    let target: { command: string; kind: string } | null = null

    // Each `command` below is the subcommand and its arguments only (no leading `token-goat`) --
    // the global `--notice` flag has to precede the subcommand (same convention as `--cwd`), so
    // the binary name is added exactly once, below, once the notice text is known.
    if (DOC_EXT_RE.test(rawPath) && STRUCTURAL_DOC_PATTERN_RE.test(pattern)) {
      target = { command: `outline ${pathArg}`, kind: 'headings' }
    } else {
      const lang = detectLanguage(resolved)
      const trimmedPattern = pattern.trim()
      if (lang === 'python' && languageHasFlag(lang, 'grepSource')) {
        const defMatch = PY_DEF_RE.exec(trimmedPattern)
        const classMatch = defMatch === null ? PY_CLASS_RE.exec(trimmedPattern) : null
        const nameMatch = defMatch ?? classMatch
        if (nameMatch !== null) {
          const name = nameMatch[1]
          if (name) {
            // `name` is already anchored to `[A-Za-z_]\w*` by PY_DEF_RE/PY_CLASS_RE, so this is
            // always representable unquoted -- dualShellArg is called anyway rather than assumed,
            // so a future loosening of that regex fails closed instead of emitting an unsafe arg.
            const grepArg = dualShellArg('^' + name)
            target =
              grepArg === null
                ? null
                : { command: `outline ${pathArg} --grep ${grepArg}`, kind: `symbols named starting with ${name} (functions, classes or any other kind sharing that name)` }
          } else {
            target = { command: `outline ${pathArg}`, kind: 'all symbols in the file (not just functions/classes)' }
          }
        } else if (IMPORT_RE.test(trimmedPattern)) {
          target = { command: `imports ${pathArg}`, kind: 'imports' }
        }
      } else if (lang !== 'unknown' && languageHasFlag(lang, 'grepSource') && IMPORT_RE.test(trimmedPattern)) {
        target = { command: `imports ${pathArg}`, kind: 'imports' }
      }
    }
    if (target === null) return null

    // Printed by token-goat itself (the CLI's own global `--notice` option) as the first line of
    // the one command below, rather than composed with a shell `echo ... &&` -- Windows PowerShell
    // 5.1 has no `&&` at all, so every shell running one plain command is the shared-safe shape.
    const notice = `[token-goat: rewrote this rg/grep search to an indexed answer (${target.kind}) instead of running it -- re-run your original command yourself for a literal text search]`
    const noticeArg = dualShellArg(notice)
    if (noticeArg === null) return null
    return { command: `token-goat --notice ${noticeArg} ${target.command}`, kind: target.kind }
  } catch {
    return null
  }
}
