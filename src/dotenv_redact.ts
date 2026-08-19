/**
 * Value redaction for dotenv files.
 *
 * `src/walk_index.ts` refuses to index `.env` and `.env.*` on the directory-walk path, and says
 * why in its own words: they hold secrets, and it is re-adding "the safety that matters" because
 * a bare walk has "none of git's exclusions". That reasoning has a false premise. It assumes git
 * would have ignored these files, and git only ignores what `.gitignore` says to ignore. A
 * tracked `.env` happens constantly, by accident and on purpose: `.env.example`, `.env.sample`
 * and `.env.test` are committed deliberately, and a real `.env` gets committed by mistake often
 * enough that it is one of the most common secret-leak shapes there is. On the git path -- the
 * default for essentially every real project -- no exclusion applied at all, so the file was
 * chunked and embedded verbatim. `token-goat semantic "database connection string"` returned the
 * whole file, password and all, as its top hit, straight into model context.
 *
 * The symbol indexer was already clean here and shows the intended shape: `extractEnv` in
 * `languages/ini_idx.ts` calls `makeLineSymbol` with no `sig`, so it stores the key name and an
 * empty body. Keys are the useful part and are not secret; values are secret by the file's
 * nature. This module extends that same rule to the two places that never got it -- the chunk
 * table that `semantic` searches, and the live disk reads that `read`, `section` and `symbol`
 * print -- so all three agree with the symbol table instead of contradicting it.
 *
 * Pattern-matching redaction (`secret_redact.ts`) is not enough on its own here and is not used
 * for this. It keys off names like `password` and `api_key`, and in a dotenv file every value is
 * sensitive regardless of its key: `DATABASE_URL=postgres://user:pw@host/db` and a bare
 * `DEBUG=true` match none of its patterns. The rule for this file type is "redact every value",
 * not "redact the values that look like secrets".
 *
 * Every variant is redacted, `.env.example` included. That is the same file set `walk_index.ts`
 * already drops, and an example file is a routine place to find a real key someone pasted while
 * filling it in.
 */
import { _detectOpenQuote, _lineClosesQuote } from './languages/ini_idx.js'
import { detectLanguage } from './parser_types.js'

/** Replacement text for a redacted value. Matches the `[REDACTED:<kind>]` shape secret_redact.ts uses. */
export const DOTENV_VALUE_PLACEHOLDER = '[REDACTED:dotenv_value]'

/**
 * Key/separator prefix of an assignment line. Based on `ENV_KEYVALUE_HEADER_RE` in
 * `section_reader.ts` and `KEYVALUE_RE` in `languages/ini_idx.ts`, so a redacted line's key is the
 * key those two index and resolve. The `:(?!\/\/)` guard is theirs too: it keeps a bare
 * `https://example.com` line from reading as a key named `https`.
 *
 * `+=` is accepted on top of what those two match. `.env` and especially `.envrc` are sourced by a
 * shell, where `KEY+=more` is an ordinary append, and matching only `=` left the appended half in
 * the clear while the first half was redacted. Recognising it here keeps the key name visible;
 * even if it were not recognised, the deny-by-default rule below would now redact the line
 * outright rather than print it.
 */
const ASSIGNMENT_RE = /^(\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*(?:\+?=|:(?!\/\/)))/

/** A blank line or a whole-line comment. The only content in a dotenv file that is never a value. */
const SAFE_LINE_RE = /^\s*(?:[#;].*)?$/

/** Is this path one of the dotenv variants? Routed through `detectLanguage` rather than a second
 * filename pattern, so this can never cover a different file set than the indexer's own. */
export function isDotenvPath(filePath: string): boolean {
  return detectLanguage(filePath) === 'env_file'
}

/**
 * Replace every dotenv value with a placeholder, keeping key names, comments and blank lines.
 *
 * Line count is preserved exactly. Callers slice this text by line number against ranges that
 * came from the symbol table, which was built from the unredacted file, so dropping or merging a
 * line would silently shift every range after it.
 *
 * A quoted value may span physical lines. The open-quote tracking is the same pair of helpers
 * `extractEnv` and the live section reader already share, so a continuation line is never
 * mistaken for a new key here either -- which matters twice over: the continuation of a multi-line
 * value is exactly the secret material, so passing it through unredacted would defeat the whole
 * point for PEM blocks and wrapped tokens.
 */
export function redactDotenvValues(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let openQuote: string | null = null

  for (const raw of lines) {
    // A CRLF file arrives here with a trailing `\r` on every line. Hold it aside and put it back,
    // so redacting does not quietly convert the file to mixed line endings in the output.
    const hasCr = raw.endsWith('\r')
    const line = hasCr ? raw.slice(0, -1) : raw
    const eol = hasCr ? '\r' : ''
    const emit = (s: string): void => {
      out.push(`${s}${eol}`)
    }

    if (openQuote !== null) {
      // Inside a value that opened on an earlier line: the whole line is value material.
      if (_lineClosesQuote(line, openQuote)) openQuote = null
      emit(DOTENV_VALUE_PLACEHOLDER)
      continue
    }
    if (SAFE_LINE_RE.test(line)) {
      emit(line)
      continue
    }
    const m = ASSIGNMENT_RE.exec(line)
    if (m === null || m[1] === undefined) {
      // Deny by default. Anything in a dotenv file that is neither blank, a comment, nor an
      // assignment this recognises is unread syntax in a file whose whole content is secret --
      // an unquoted `KEY=head\` shell continuation, a form no parser here models yet, or simply a
      // typo. Printing it because it was not recognised is how a redaction ends up partial, which
      // reads as handled and is not. Redact the line and keep the line count.
      emit(DOTENV_VALUE_PLACEHOLDER)
      continue
    }
    const prefix = m[1]
    openQuote = _detectOpenQuote(line.slice(prefix.length))
    emit(`${prefix}${DOTENV_VALUE_PLACEHOLDER}`)
  }
  return out.join('\n')
}

/** `redactDotenvValues` when `filePath` is a dotenv variant, and the text unchanged otherwise. */
export function redactIfDotenv(filePath: string, text: string): string {
  return isDotenvPath(filePath) ? redactDotenvValues(text) : text
}
