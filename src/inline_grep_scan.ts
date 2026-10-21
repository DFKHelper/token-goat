/** The lines of a file as ripgrep, run the way Claude Code runs it, would test a pattern against them, for the inlined Grep answer's proof that a pattern matches only what the answer shows. Kept apart from inline_symbol_answer.ts so the directory scope and the bare-identifier listing share one definition of "a line". */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { withProbeIndex } from './db.js'
import { isInsideRoot } from './path_containment.js'
import { resolveIndexPath } from './paths.js'
import { fileRowByIndexKey } from './sql_path.js'
import { runGit } from './util.js'

/** The text of `bytes` split into the lines ripgrep searches, or null when ripgrep and this reading could disagree about them, so the caller passes the Grep through. Lines end at `\n` only and keep a trailing `\r`: ripgrep without `--crlf` ends a line at `\n` alone, so `$` does not match before a `\r` (`rg --help` 15.1.0 on `--crlf`; `rg -n 'foo$'` on "foo\r\n" prints nothing and exits 1). A NUL byte (ripgrep's binary detection, and the mark of a UTF-16 file), bytes that are not UTF-8, and a CR that is not part of CRLF (ripgrep sees one long line where the index sees many) all return null. A leading byte-order mark is dropped, as ripgrep drops it. */
export function ripgrepLines(bytes: Buffer): string[] | null {
  if (bytes.includes(0)) return null
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  if (/\r(?!\n)/.test(text)) return null
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** The most files a directory-scoped answer reads, and the most bytes of them. Chosen for the deny's own size: the answer delivers at most INLINE_SYMBOL_MAX_BYTES (12,000), so a scope past a few hundred files is one where a pattern is unlikely to match once, and reading two megabytes in a hook is the most a pre-tool-use check should spend. Both are counts of the files git lists, before any is opened, and a scope over either passes the Grep through. */
export const SCOPE_MAX_FILES = 200
export const SCOPE_MAX_BYTES = 2_000_000
/** The bound on each git call the listing makes; a call that hits it fails the answer open. A safety stop for a huge repository, never a condition the answer relies on. */
const SCOPE_GIT_TIMEOUT_MS = 5_000

/** A file the Grep would have searched, with its lines as ripgrep sees them and its index key. */
export interface ScopeFile {
  readonly abs: string
  readonly key: string
  readonly lines: readonly string[]
}

export type ScopeRead = { readonly files: readonly ScopeFile[] } | { readonly passReason: string }

/** One line a pattern matched. */
export interface ScopeMatch {
  readonly file: ScopeFile
  readonly line: number
  readonly text: string
}

/** True when the index holds a row for `key`, whether or not the file has symbols; false also when the index cannot be read, since an unreadable index proves nothing. */
function isIndexed(key: string): boolean {
  return withProbeIndex((db) => fileRowByIndexKey<{ path: string }>(db, key, 'path') !== undefined) === true
}

/** Read one regular file into a {@link ScopeFile}, or return why not. A symlink, a non-file, a file past the byte allowance, bytes ripgrep reads differently from the index, or a file outside `dir` fails the read. `used` is the bytes already read in this scope. */
function readScopeFile(abs: string, base: string, used: number): { file: ScopeFile; bytes: number } | string {
  let st: fs.Stats
  try {
    st = fs.lstatSync(abs)
  } catch {
    return 'a listed file cannot be stat-ed'
  }
  if (!st.isFile()) return 'a listed entry is a link, a directory or not a regular file'
  if (used + st.size > SCOPE_MAX_BYTES) return 'the files exceed the byte allowance'
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(abs)
  } catch {
    return 'a listed file cannot be read'
  }
  const lines = ripgrepLines(bytes)
  if (lines === null) return 'a listed file is binary, not UTF-8 or has a lone CR'
  return { file: { abs, key: resolveIndexPath(abs, base), lines }, bytes: bytes.length }
}

/** The single file a file-scoped Grep searches (ripgrep searches an explicitly named file whatever the ignore rules say). */
export function readScopeSingleFile(abs: string, base: string): ScopeRead {
  const one = readScopeFile(abs, base, 0)
  return typeof one === 'string' ? { passReason: one } : { files: [one.file] }
}

/** Every file a recursive Grep of `dir` could search, read, or the reason the answer must not be given. The set is git's list of tracked and untracked-not-ignored files under `dir` (`git ls-files -co --exclude-standard`), which is a superset of what ripgrep searches: Claude Code runs ripgrep with `--hidden` and a `--glob` that drops only `.git`, `.svn`, `.hg`, `.bzr`, `.jj` and `.sl`, and no `--no-ignore`, so `.gitignore`, `.ignore` and the global ignore file apply (strings in claude.exe 2.1.306, read this run; ripgrep's own default ignore rules). A file git lists that ripgrep skips only adds a possible extra match, which passes the Grep through; no file ripgrep searches is left out unless `dir` itself is ignored (checked first), the tree is not a git work tree, or ripgrep reads a config file (`RIPGREP_CONFIG_PATH` set), and each of those passes. A directory entry (a submodule or a nested repository), a symlink, an unindexed file, or a file ripgrep and the index would read differently also pass. */
export function readScopeDir(dir: string, root: string): ScopeRead {
  if (process.env['RIPGREP_CONFIG_PATH'] !== undefined) return { passReason: 'ripgrep reads a config file' }
  // Exit 1 is "not ignored"; 0 means the scope is inside an ignored directory, where ripgrep may search files git does not list; 128 means no work tree.
  const ignored = runGit(['check-ignore', '-q', '--', '.'], { cwd: dir, timeoutMs: SCOPE_GIT_TIMEOUT_MS })
  if (ignored.exitCode !== 1) return { passReason: 'the scope is ignored or not in a git work tree' }
  const listed = runGit(['ls-files', '-z', '-co', '--exclude-standard', '--', '.'], { cwd: dir, timeoutMs: SCOPE_GIT_TIMEOUT_MS })
  if (listed.exitCode !== 0) return { passReason: 'git could not list the scope' }
  const entries = [...new Set(listed.stdout.split('\0').filter((e) => e !== ''))]
  if (entries.length === 0) return { passReason: 'the scope lists no files' }
  if (entries.length > SCOPE_MAX_FILES) return { passReason: 'the scope holds more than ' + SCOPE_MAX_FILES + ' files' }
  const files: ScopeFile[] = []
  let used = 0
  for (const entry of entries) {
    if (entry.endsWith('/')) return { passReason: 'the scope holds a nested repository' }
    const abs = path.resolve(dir, entry)
    const rel = path.relative(dir, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel) || !isInsideRoot(abs, root)) return { passReason: 'a listed file lies outside the scope' }
    const one = readScopeFile(abs, dir, used)
    if (typeof one === 'string') return { passReason: one }
    if (!isIndexed(one.file.key)) return { passReason: 'a listed file is not indexed' }
    used += one.bytes
    files.push(one.file)
  }
  return { files }
}

/** Every line of `files` that `re` matches, ordered by file then line. */
export function matchScopeLines(re: RegExp, files: readonly ScopeFile[]): ScopeMatch[] {
  const out: ScopeMatch[] = []
  for (const file of [...files].sort((a, b) => (a.abs < b.abs ? -1 : a.abs > b.abs ? 1 : 0))) {
    file.lines.forEach((text, i) => {
      if (re.test(text)) out.push({ file, line: i + 1, text })
    })
  }
  return out
}
