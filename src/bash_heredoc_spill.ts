/** Moves the bodies of a long Bash command's quoted heredocs into files, for Claude Code's Bash tool on Windows, which fails a command of about 7,300 characters or more before any of it runs: each `<<'TAG'` and its body become `< '<file>'`, so the command that reaches Git Bash is short and feeds the same bytes. Measured over Claude Code 2.1.220-2.1.296 session transcripts: 63 commands of 6,500 characters or more, all heredocs; every one of 7,963 characters or more failed with "unexpected EOF while looking for matching" a quote (exit 2), but for two that only seemed to run (one wrote its heredoc cut short, one never spawned), the first failure came at 7,236, and some between 7,212 and 7,625 ran. Under it sits Git Bash's own limit: spawned from Node with `bash -c` (Git for Windows 2.54.0, bash 5.3.9), a heredoc command of any length past about 8,190 characters wrote its body cut at the same byte, warned "here-document at line 1 delimited by end-of-file" and exited 0. That Claude Code fails sooner fits the wrapper and quoting it puts around a command, which is inferred, not measured. The heredocs are found by the lexer powershell_compat.ts adapts them with. */

import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { shellQuoteSingle } from './bash_extractors.js'
import { tokenGoatHome } from './constants.js'
import { ensureDirSync } from './util.js'
import { shortFingerprint } from './fingerprint.js'
import { topLevelHeredocs } from './powershell_compat.js'
import { redactSecrets } from './secret_redact.js'

/** Estimated length at or above which a heredoc command is spilled, below the 7,236 characters the first measured failure had: how long a command may be depends on its quoting as well as its length, so {@link effectiveCommandLength} counts that in. */
export const HEREDOC_SPILL_EFFECTIVE_CHARS = 6_500

/** Length past which every measured heredoc command failed, whatever its quoting: one that cannot be spilled is refused rather than run. */
export const HEREDOC_CERTAIN_FAILURE_CHARS = 8_000

/** How long a spilled body is kept. It is read once, by the command run right after the hook approved it, so an hour is room for a slow start rather than a cache; older ones are removed whenever another spill is written. */
export const SPILL_MAX_AGE_MS = 60 * 60 * 1000

/** A spilled body's file name: the body's fingerprint and a random part, so two spills of one body never share a path. */
const SPILL_FILE_RE = /^[0-9a-f]{16}-[0-9a-f]{12}\.txt$/

/** `command`'s length with the room escaping takes when a command is quoted for a shell: three more for each `'`, which closes, escapes and reopens a single-quoted argument, and one more for each `"` and backslash. */
export function effectiveCommandLength(command: string): number {
  let extra = 0
  for (const ch of command) {
    if (ch === "'") extra += 3
    else if (ch === '"' || ch === '\\') extra += 1
  }
  return command.length + extra
}

/** True when `command` opens a heredoc of any form, quoted or not, `<<-` included; a `<<<` here-string and an arithmetic shift are not. */
export function hasHeredocOpener(command: string): boolean {
  return /(?<!<)<<(?!<)-?[ \t]*(?:['"]|\\)?[A-Za-z_]/.test(command)
}

/** What the lexer behind topLevelHeredocs reads differently from bash outside a heredoc body (see its doc comment), plus any `<<` left once the heredocs it placed are taken out: one it could not place, a `<<<` here-string, or an operator inside a string. Any of them leaves the command as written. */
const LEXERS_DIVERGE_RE = /[`\\‘-„]|@['"]|<#|<<|\(\(|\$\{[^}]*['"]|[{},=<>]#/

/** What may follow a heredoc's delimiter word. Bash's word runs on to the next blank or operator, so `<<'EOF'x` closes on `EOFx` where the lexer reads `EOF`, and a body line `EOF` would end the spilled body early and leave the lines after it to run as commands. */
const DELIMITER_END_RE = /^[ \t\n;|&<>]/

/** The directory spilled bodies are written to: token-goat's own home, owner-only, rather than the system temp directory, where another account could plant the predictable path first. */
export function heredocSpillDir(): string {
  return path.join(tokenGoatHome(), 'heredoc_spill')
}

/** One body to write: the file the rewritten command reads, as the command names it, and the bytes bash would have fed from the heredoc. */
export interface SpilledBody {
  readonly path: string
  readonly body: string
}

/** The rewritten command and the bodies it reads, or why the command has to stay as written. */
export type HeredocSpill = { readonly command: string; readonly files: readonly SpilledBody[] } | { readonly refused: string }

/** `command` with every heredoc's operator and delimiter word replaced by `< '<file>'` and its body and closing line taken out, the rest of the operator's line and everything after the closing line left as written. Each body goes to a new file under `dir`, holding each body line and its newline, which is what bash feeds from a quoted heredoc. Refused for a heredoc bash would expand (an unquoted delimiter) or strip tabs from (`<<-`), for a delimiter bash would read as a longer word, for a body holding a credential, and for anything the lexer and bash could read differently. */
export function spillQuotedHeredocs(command: string, dir: string): HeredocSpill {
  const sites = topLevelHeredocs(command)
  if (sites.length === 0) return { refused: 'no heredoc in it could be read with certainty' }
  if (sites.some((s) => s.quote === '')) return { refused: 'a heredoc in it is unquoted, so the shell expands its body' }
  if (sites.some((s) => s.stripTabs)) return { refused: 'a heredoc in it is a `<<-` one, whose tabs the shell strips' }
  if (sites.some((s) => command[s.bodyStart - 1] !== '\n')) return { refused: 'no heredoc in it could be read with certainty' }
  if (sites.some((s) => !DELIMITER_END_RE.test(command.slice(s.headEnd, s.headEnd + 1)))) return { refused: 'a heredoc delimiter in it runs on past its quotes, so the shell reads a longer word than the one its body ends on' }
  const bodies = sites.map((s) => command.slice(s.bodyStart, s.termStart))
  // A body is written byte for byte, so it cannot be redacted on the way to disk; one holding anything redactSecrets would redact is not written at all. That is every pattern, the recall-tuned one hasPreciseSecret skips included, since a false match here costs only the spill.
  if (bodies.some((body) => redactSecrets(body).count > 0)) return { refused: 'a heredoc body in it holds a credential, which token-goat does not write to disk' }
  const shownDir = dir.replace(/\\/g, '/')
  const files = bodies.map((body): SpilledBody => ({ path: shownDir + '/' + shortFingerprint(body) + '-' + randomBytes(6).toString('hex') + '.txt', body }))
  // The operator line's own newline stays and the closing line's goes, so the command keeps its line breaks; a second heredoc opened on the same line has its body after the first one's closing line, so every edit is cut in index order.
  const edits = sites.flatMap((s, i) => [
    { from: s.op, to: s.headEnd, text: '< ' + shellQuoteSingle(files[i]!.path) },
    { from: s.bodyStart - 1, to: s.end, text: '' },
  ]).sort((a, b) => a.from - b.from)
  let outside = ''
  let rewritten = ''
  let at = 0
  for (const e of edits) {
    outside += command.slice(at, e.from) + ' '
    rewritten += command.slice(at, e.from) + e.text
    at = e.to
  }
  if (LEXERS_DIVERGE_RE.test(outside + command.slice(at))) return { refused: 'its quoting outside the heredoc bodies could not be read with certainty' }
  return { command: rewritten + command.slice(at), files }
}

/** Removes spilled bodies in `dir` older than {@link SPILL_MAX_AGE_MS}. Best-effort: a file another process removed first, or one that cannot be removed, is left to the next spill. */
function pruneSpilledBodies(dir: string, now: number): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!SPILL_FILE_RE.test(name)) continue
    const file = path.join(dir, name)
    try {
      const st = lstatSync(file)
      if (st.isFile() && now - st.mtimeMs > SPILL_MAX_AGE_MS) unlinkSync(file)
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/** Writes each spilled body to its own new file in `dir` (created owner-only), after removing spills past their age. A path that already exists, as a file, a link or anything else, is never written through: each file is created exclusively, and the spill fails instead. False when any write fails, with the files this call did write removed, so the caller keeps the command as written. */
export function writeSpilledBodies(dir: string, files: readonly SpilledBody[]): boolean {
  const written: string[] = []
  try {
    // ensureDirSync creates token-goat's home 0700 first, which already closes the directory to other accounts; the directory itself is tightened as well, on the platforms that have modes.
    ensureDirSync(dir)
    if (process.platform !== 'win32') chmodSync(dir, 0o700)
    pruneSpilledBodies(dir, Date.now())
    for (const f of files) {
      writeFileSync(f.path, f.body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      written.push(f.path)
    }
    return true
  } catch {
    for (const p of written) {
      try {
        unlinkSync(p)
      } catch {
        // Left for the age-based prune.
      }
    }
    return false
  }
}
