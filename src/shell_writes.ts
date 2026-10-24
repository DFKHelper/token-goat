/** What a shell command line writes, for the post-shell hook that keeps the index fresh: the files PowerShell's own write cmdlets and .NET file writers name on the command line, and whether a segment could write files at all. The redirects and substitutions of a segment are read here too, because a read-only program with a `>` or a `$(...)` in it writes. A command that writes through some other program (`python -c`, a build step, a script) names nothing here, so the caller asks the worker to reconcile the project instead of guessing at every interpreter. It also holds the pass that queues what a working-tree rewrite that never moves HEAD wrote (`enqueueNonHeadMovingRewrites`, `git restore`, the in-place shell writes, the formatters) and the same pass for a failed call; hooks_bash_commands.ts and hooks_tool_failure.ts load this module on use, since the hook entry's eager set is size-guarded (tests/guards/dist_chunks_deduped.test.ts). */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { splitShellSegments } from './bash_extractors.js'
import { dataDir } from './constants.js'
import { reconcileRequestPathFor } from './dirty_queue.js'
import { gitRepoRootOrNull, hookGitRead, isHeadMovingGitCommand, safeShlexSplit, tokenGoatInvocation } from './hooks_bash_commands.js'
import { enqueueDirtyPathSafe, requestReconcileSafe } from './hooks_index.js'
import { parsePorcelainZ } from './git_porcelain.js'
import { resolveIndexPath } from './paths.js'
import type { GitResult } from './util.js'
import { appendWorkerErrorLog } from './worker_lifecycle.js'

/** Files a command wrote or created (`written`) and files it deleted or moved away (`removed`), as typed on the command line: relative to the directory the command ran in, unresolved. */
export interface ShellWriteTargets {
  written: string[]
  removed: string[]
}

type WriteKind = 'set' | 'copy' | 'move' | 'rename' | 'remove'

/** The PowerShell write cmdlets and their built-in aliases, lowercased, by what they do to their path. */
const CMDLET_KINDS: ReadonlyMap<string, WriteKind> = new Map([
  ['set-content', 'set'], ['sc', 'set'], ['add-content', 'set'], ['ac', 'set'], ['out-file', 'set'], ['new-item', 'set'], ['ni', 'set'],
  ['copy-item', 'copy'], ['cp', 'copy'], ['copy', 'copy'], ['cpi', 'copy'],
  ['move-item', 'move'], ['mv', 'move'], ['move', 'move'], ['mi', 'move'],
  ['rename-item', 'rename'], ['ren', 'rename'], ['rni', 'rename'],
  ['remove-item', 'remove'], ['rm', 'remove'], ['del', 'remove'], ['erase', 'remove'], ['ri', 'remove'], ['rmdir', 'remove'],
])

/** Parameter names (lowercased, without the dash) that take the path being written, matched by unambiguous prefix as PowerShell does. */
const PATH_PARAMS = ['path', 'filepath', 'literalpath']
const DEST_PARAMS = ['destination']
const NEWNAME_PARAMS = ['newname']
const NAME_PARAMS = ['name']
/** Parameters that take a value this extractor must step over rather than read as a path. */
const OTHER_VALUE_PARAMS = ['value', 'encoding', 'itemtype', 'type', 'width', 'inputobject', 'filter', 'include', 'exclude', 'stream', 'credential', 'relativepath']

/** One command-line word: its text with the quotes removed, whether any quote held it, and whether a comma outside quotes makes it a list PowerShell reads as several values. */
interface PsWord {
  text: string
  quoted: boolean
  unquotedComma: boolean
}

/** Split `text` on whitespace the way PowerShell reads a command line: single and double quotes group, a doubled single quote inside single quotes is one quote, and a backslash is an ordinary character, so a Windows path keeps its separators. */
function psWords(text: string): PsWord[] {
  const out: PsWord[] = []
  let cur = ''
  let quote: string | null = null
  let started = false
  let quoted = false
  let comma = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote !== null) {
      if (ch !== quote) cur += ch
      else if (text[i + 1] === quote) {
        cur += quote
        i++
      } else quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      quoted = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) out.push({ text: cur, quoted, unquotedComma: comma })
      cur = ''
      started = false
      quoted = false
      comma = false
      continue
    }
    if (ch === ',') comma = true
    cur += ch
    started = true
  }
  if (started) out.push({ text: cur, quoted, unquotedComma: comma })
  return out
}

/** The text of each word {@link psWords} reads from `text`. */
function psTokens(text: string): string[] {
  return psWords(text).map((w) => w.text)
}

/** True when `name` (a parameter written without its dash, any case) is a prefix of one of `full`, which is how PowerShell resolves an abbreviated parameter. */
function paramIs(name: string, full: readonly string[]): boolean {
  const lower = name.toLowerCase()
  return lower.length > 0 && full.some((f) => f.startsWith(lower))
}

/** A path token this extractor can trust to name one file: no variable, subexpression, wildcard or splat, which only the shell could resolve. */
function isStaticPath(token: string): boolean {
  return token !== '' && !/[$()@*?[\]{}`]/.test(token)
}

/** A path token that names one file by itself: {@link isStaticPath} and no leading `~`, which the shell expands to the home directory. */
function isConcretePath(token: string): boolean {
  return isStaticPath(token) && !token.startsWith('~')
}

interface CmdletArgs {
  path: PsWord | null
  destination: PsWord | null
  newName: PsWord | null
  name: PsWord | null
  positional: PsWord[]
  directory: boolean
}

/** Read one cmdlet's arguments (the words after its name): the named path parameters, and the positional values in order. A long option (`--recursive`) is an option, never a path. */
function readCmdletArgs(args: readonly PsWord[]): CmdletArgs {
  const result: CmdletArgs = { path: null, destination: null, newName: null, name: null, positional: [], directory: false }
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!
    const token = word.text
    if (!/^--?[A-Za-z]/.test(token)) {
      result.positional.push(word)
      continue
    }
    const colon = token.indexOf(':')
    const param = (colon > 0 ? token.slice(1, colon) : token.slice(1)).toLowerCase()
    const inline = colon > 0 ? { ...word, text: token.slice(colon + 1) } : null
    const next = (): PsWord | null => inline ?? (i + 1 < args.length ? args[++i]! : null)
    if (paramIs(param, PATH_PARAMS)) result.path = next()
    else if (paramIs(param, DEST_PARAMS)) result.destination = next()
    else if (paramIs(param, NEWNAME_PARAMS)) result.newName = next()
    else if (paramIs(param, NAME_PARAMS)) result.name = next()
    else if (paramIs(param, OTHER_VALUE_PARAMS)) {
      const value = next()
      if (param.startsWith('it') && value !== null && /^dir/i.test(value.text)) result.directory = true
    }
  }
  return result
}

/** The text of a cmdlet argument that names one file: a concrete path, and not a comma list PowerShell reads as several names. A null here leaves the call unnamed, so the caller asks for a reconcile. */
function oneFile(word: PsWord | null): string | null {
  return word !== null && !word.unquotedComma && isConcretePath(word.text) ? word.text : null
}

/** The files one PowerShell cmdlet call writes, from its words (the cmdlet name first); nothing when a path is not statically known. */
function cmdletTargets(kind: WriteKind, args: readonly PsWord[], into: ShellWriteTargets): void {
  const a = readCmdletArgs(args)
  const first = oneFile(a.path ?? a.positional[0] ?? null)
  const second = a.positional[a.path === null ? 1 : 0] ?? null
  if (kind === 'set') {
    if (a.directory || first === null) return
    if (a.name !== null) {
      const name = oneFile(a.name)
      if (name !== null) into.written.push(path.join(first, name))
    } else into.written.push(first)
    return
  }
  if (kind === 'remove') {
    if (first !== null) into.removed.push(first)
    return
  }
  if (kind === 'rename') {
    const newName = oneFile(a.newName ?? second)
    if (first === null || newName === null) return
    into.removed.push(first)
    into.written.push(path.join(path.dirname(first), newName))
    return
  }
  const dest = oneFile(a.destination ?? second)
  if (first === null || dest === null) return
  // A destination that is a directory receives the source's own name, which only the disk can tell; the caller's isFile filter drops a path that is not a file, and the join below covers the common typed spelling.
  into.written.push(dest, path.join(dest, path.basename(first)))
  if (kind === 'move') into.removed.push(first)
}

/** The .NET static file writers PowerShell scripts call, with the argument holding the path. */
const DOTNET_WRITE_RE = /\[(?:System\.)?IO\.File\]::(?:WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText|AppendAllLines|Create|CreateText|AppendText)\(\s*(?:'([^']+)'|"([^"$]+)")/gi
const DOTNET_DELETE_RE = /\[(?:System\.)?IO\.File\]::Delete\(\s*(?:'([^']+)'|"([^"$]+)")/gi

/** The program a segment launches, lowercased and without `.exe`, directory kept: `./cat` and `C:/tools/cat.exe` are some other program than the `cat` on the path, so they are not the read-only one. */
function headOf(tokens: readonly string[]): string {
  return (tokens[0] ?? '').replace(/\.exe$/i, '').toLowerCase()
}

/** The shell a segment launches by its bare name, directory dropped, for recognising `powershell` and `pwsh` wherever they are installed. */
function shellNameOf(tokens: readonly string[]): string {
  return headOf(tokens).replace(/^.*[/\\]/, '')
}

/** How deep a `powershell -Command "..."` inside another is read; past it the segment is opaque and counts as a possible writer. */
const MAX_WRAPPER_DEPTH = 3

const SINGLE_QUOTE = "'"

/** The body of a `powershell`/`pwsh -Command` segment, or null when the segment is not one. */
function wrapperBody(segment: string): string | null {
  const words = psWords(segment)
  const tokens = words.map((w) => w.text)
  const name = shellNameOf(tokens)
  if (name !== 'powershell' && name !== 'pwsh') return null
  const flag = tokens.findIndex((t) => /^-c(?:ommand)?$/i.test(t))
  if (flag < 0) return null
  const rest = words.slice(flag + 1)
  // One word is the whole script in quotes. Several are the script written bare, where psTokens dropped the quotes that grouped a word holding spaces, and joining without them split a path like `my file.txt` into two words.
  return rest.length === 1 ? rest[0]!.text : rest.map((w) => (w.text === '' || w.quoted || /\s/.test(w.text) ? SINGLE_QUOTE + w.text.split(SINGLE_QUOTE).join(SINGLE_QUOTE + SINGLE_QUOTE) + SINGLE_QUOTE : w.text)).join(' ')
}

/** The bodies of the outermost `{ ... }` script blocks in `segment` that sit outside quotes, for a segment with a cmdlet in it (a brace in `rg '{x}'` or `awk '{print}'` is not a PowerShell block). */
function scriptBlocks(segment: string): string[] {
  if (!/(?:^|\s)(?:%|\?|[A-Za-z]+-[A-Za-z]+)(?=\s|$)/.test(segment)) return []
  const blocks: string[] = []
  let quote: string | null = null
  let depth = 0
  let start = 0
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (quote !== null) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '{') {
      if (depth++ === 0) start = i + 1
    } else if (ch === '}' && depth > 0 && --depth === 0) blocks.push(segment.slice(start, i))
  }
  return blocks
}

/** The command a script-block segment launches: an assignment (`$o = npm run gen`) stands for its right-hand side, a bare variable expression (`$_.Length`) launches nothing and gives null, and any other segment is judged as it stands. */
function valueSegment(segment: string): string | null {
  const text = segment.trimStart()
  if (!text.startsWith('$')) return segment
  const assigned = /^\$[\w:.{}]+\s*(?:[-+*/%]|\?\?)?=([\s\S]*)$/.exec(text)
  const value = assigned?.[1]?.trim() ?? ''
  return value !== '' ? value : null
}

/** The segments to judge for `segment`: a `-Command` wrapper stands for the segments of its body, and a script block's own segments are judged beside the segment holding it (an assignment by its right-hand side, a bare variable expression not at all). `opaque` is set when the nesting ran past {@link MAX_WRAPPER_DEPTH}. */
function judgedSegments(segment: string, depth = 0): { segments: string[]; opaque: boolean } {
  const body = wrapperBody(segment)
  if (body !== null) {
    if (depth >= MAX_WRAPPER_DEPTH) return { segments: [], opaque: true }
    const out = { segments: [] as string[], opaque: false }
    for (const inner of splitShellSegments(body)) {
      const sub = judgedSegments(inner, depth + 1)
      out.segments.push(...sub.segments)
      out.opaque ||= sub.opaque
    }
    return out
  }
  const segments = [segment]
  for (const block of scriptBlocks(segment)) {
    for (const inner of splitShellSegments(block)) {
      const value = valueSegment(inner)
      if (value !== null) segments.push(value)
    }
  }
  return { segments, opaque: false }
}

/** The files a PowerShell write cmdlet or .NET file writer in `segment` names, a `powershell -Command "..."` wrapper looked into one level. */
export function extractPowerShellWriteTargets(segment: string): ShellWriteTargets {
  const into: ShellWriteTargets = { written: [], removed: [] }
  const scan = (text: string): void => {
    const words = psWords(text)
    words.forEach((word, i) => {
      const kind = CMDLET_KINDS.get(word.text.toLowerCase())
      if (kind !== undefined) cmdletTargets(kind, words.slice(i + 1), into)
    })
    for (const m of text.matchAll(DOTNET_WRITE_RE)) into.written.push(m[1] ?? m[2]!)
    for (const m of text.matchAll(DOTNET_DELETE_RE)) into.removed.push(m[1] ?? m[2]!)
  }
  const body = wrapperBody(segment)
  if (body !== null) {
    scan(body)
    return into
  }
  scan(segment)
  return into
}

/** What {@link scanShellSyntax} found in a segment. */
export interface ShellSyntax {
  /** The target word of each file redirect, quotes removed, `''` when no word follows. File-descriptor duplications (`2>&1`, `>&2`, `>&-`) and the null devices name no file and are left out. */
  redirects: string[]
  /** The text inside each `$(...)`, backtick pair, `<(...)`, `>(...)` and bare `(...)` group (PowerShell's `(cmd)` and `@(cmd)` run their contents too), outside single quotes. */
  substitutions: string[]
  /** True when a quote, backtick or parenthesis is left open or closed without an opener. */
  unparseable: boolean
}

const NULL_DEVICE_RE = /^(?:\/dev\/null|nul|\$null)$/i

/** The index of the `)` closing the `(` at `open`, or -1. Quotes hide parentheses, `$(` nests, and a backslash-escaped parenthesis is a plain character. */
function matchParen(text: string, open: number): number {
  let quote = ''
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i]!
    if (quote === "'") {
      if (ch === "'") quote = ''
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      const inner = matchParen(text, i + 1)
      if (inner < 0) return -1
      i = inner
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = ''
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '\\' && (text[i + 1] === '(' || text[i + 1] === ')')) i++
    else if (ch === '(') {
      const inner = matchParen(text, i)
      if (inner < 0) return -1
      i = inner
    } else if (ch === ')') return i
  }
  return -1
}

/** The word starting at `from` the way a redirect target reads it: up to unquoted whitespace or `| & < > ;`, a `$(...)` kept whole. Returns the raw text and the index after it, or null when a quote or substitution is left open. */
function readTargetWord(text: string, from: number): { raw: string; end: number } | null {
  let quote = ''
  let i = from
  for (; i < text.length; i++) {
    const ch = text[i]!
    if (quote !== '') {
      if (ch === quote) quote = ''
      else if (quote === '"' && ch === '$' && text[i + 1] === '(') {
        const close = matchParen(text, i + 1)
        if (close < 0) return null
        i = close
      }
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '$' && text[i + 1] === '(') {
      const close = matchParen(text, i + 1)
      if (close < 0) return null
      i = close
    } else if (/[\s|&<>;]/.test(ch)) break
  }
  return quote === '' ? { raw: text.slice(from, i), end: i } : null
}

/** Scan `text` for its redirects and substitutions. Single quotes hide everything; double quotes hide redirects and process substitutions but not `$(...)` or backticks, as in both shells. A backslash escapes only a parenthesis, because PowerShell reads it as an ordinary character and a path such as `"C:\dir\"` must still close its quote. */
export function scanShellSyntax(text: string): ShellSyntax {
  const out: ShellSyntax = { redirects: [], substitutions: [], unparseable: false }
  let quote = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (quote === "'") {
      if (ch === "'") quote = ''
      i++
      continue
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      if (end < 0) {
        out.unparseable = true
        return out
      }
      out.substitutions.push(text.slice(i + 1, end))
      i = end + 1
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      const close = matchParen(text, i + 1)
      if (close < 0) {
        out.unparseable = true
        return out
      }
      const inner = text.slice(i + 2, close)
      if (inner.startsWith('(') && inner.endsWith(')')) {
        const arithmetic = scanShellSyntax(inner.slice(1, -1))
        out.substitutions.push(...arithmetic.substitutions)
        out.unparseable ||= arithmetic.unparseable
      } else out.substitutions.push(inner)
      i = close + 1
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = ''
      i++
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      i++
      continue
    }
    if (ch === '\\' && (text[i + 1] === '(' || text[i + 1] === ')')) {
      i += 2
      continue
    }
    if (ch === '(' || ((ch === '<' || ch === '>') && text[i + 1] === '(')) {
      const open = ch === '(' ? i : i + 1
      const close = matchParen(text, open)
      if (close < 0) {
        out.unparseable = true
        return out
      }
      out.substitutions.push(text.slice(open + 1, close))
      i = close + 1
      continue
    }
    if (ch === ')') {
      out.unparseable = true
      return out
    }
    if (ch === '>') {
      let j = i + 1
      while (text[j] === '>') j++
      if (text[j] === '&') {
        const dup = /^(?:\d+|-)(?=[\s|&;<>)]|$)/.exec(text.slice(j + 1))
        if (dup !== null) {
          i = j + 1 + dup[0].length
          continue
        }
        j++
      } else if (text[j] === '|') j++
      while (text[j] === ' ' || text[j] === '\t') j++
      const word = readTargetWord(text, j)
      if (word === null) {
        out.unparseable = true
        return out
      }
      const target = word.raw.replace(/["']/g, '')
      if (!NULL_DEVICE_RE.test(target)) out.redirects.push(target)
      i = j
      continue
    }
    i++
  }
  if (quote !== '') out.unparseable = true
  return out
}

/** Files one segment redirects output to, wherever the redirect sits (`a>b`, `&> f`, `*> f`, `>>`), when the target is a path this extractor can trust to name one file. `2>&1`-style fd duplications and the null devices name no file, and a target the shell must expand is left to {@link syntaxMayWrite}. */
function extractRedirectTargets(segment: string): string[] {
  return scanShellSyntax(segment).redirects.filter(isConcretePath)
}

/** A recursive switch on a remove: `-r`, `-R`, `-rf`, `-fr`, `--recursive`, `-Recurse` and its abbreviations (not `-Force`, which merely contains an r). */
const RECURSIVE_FLAG_RE = /\s(?:-(?:[fviId]*r[fviId]*|rec(?:u(?:r(?:s(?:e)?)?)?)?)|--recursive)(?=[\s:=]|$)/i

/** True when a request for `projectDir` already waits in the reconcile-request file, so a burst of shell calls leaves one line per directory instead of one per call. A claim renames the file away, so a request made after a sweep began is recorded again. */
function reconcileAlreadyPending(projectDir: string): boolean {
  try {
    const line = JSON.stringify(projectDir)
    return fs.readFileSync(reconcileRequestPathFor(dataDir()), 'utf8').split('\n').some((l) => l.trim() === line)
  } catch {
    return false
  }
}

/** Queue what a shell command wrote: each file its PowerShell write cmdlets and .NET writers name goes to `enqueue` (`written` to reindex, `removed` for a file that is gone), and a segment that may have written files it does not name asks the worker to reconcile `runDir`'s project, once while that request is pending. `handled` holds the segments another extractor already named files for, or that are token-goat's own command, which queues its own writes. */
export function enqueueShellWrites(cmd: string, runDir: string, handled: ReadonlySet<string>, enqueue: { written: (absPath: string) => void; removed: (absPath: string) => void }): void {
  const written = new Set<string>()
  const removed = new Set<string>()
  let unnamed = false
  const judged: string[] = []
  for (const top of splitShellSegments(cmd)) {
    const expanded = judgedSegments(top)
    if (expanded.opaque) unnamed = true
    judged.push(...expanded.segments)
  }
  for (const segment of judged) {
    const found = extractPowerShellWriteTargets(segment)
    for (const f of found.written) written.add(resolveIndexPath(f, runDir))
    for (const f of found.removed) removed.add(resolveIndexPath(f, runDir))
    // A redirect says where the output went, not what the program behind it wrote: a target this extractor can name is queued here, and the segment still goes through the may-write checks below.
    for (const f of extractRedirectTargets(segment)) written.add(resolveIndexPath(f, runDir))
    // A segment that names its files is trusted only when it is the write cmdlet itself: `docker cp a b` holds the token `cp` in an argument and still writes somewhere unnamed.
    const named = namesItsFiles(segment, found)
    if (syntaxMayWrite(segment) || (!handled.has(segment) && !named && headMayWrite(segment))) unnamed = true
    // The drain prunes only the exact path it is given, so a deleted directory leaves its children indexed until the sweep's deletion pass stats their rows: a recursive remove, or a target with no extension (already gone, so a directory cannot be told from a file), asks for that sweep.
    if (found.removed.length > 0 && (RECURSIVE_FLAG_RE.test(segment) || found.removed.some((f) => path.extname(f) === ''))) unnamed = true
  }
  written.forEach(enqueue.written)
  removed.forEach(enqueue.removed)
  if (unnamed && !reconcileAlreadyPending(runDir)) requestReconcileSafe(runDir)
}

/** Programs whose only effect is to read or report; anything not listed may write files. */
const READ_ONLY_HEADS: ReadonlySet<string> = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'fd', 'find', 'pwd', 'echo', 'cd', 'pushd', 'popd', 'which', 'where', 'whereis', 'tree', 'stat', 'file', 'du', 'df', 'diff', 'cmp', 'less', 'more', 'true', 'false', 'date', 'whoami', 'basename', 'dirname', 'realpath', 'readlink', 'test', 'cls', 'clear', 'sleep', 'printf',
  'get-content', 'gc', 'get-childitem', 'gci', 'get-item', 'gi', 'get-location', 'gl', 'select-string', 'sls', 'test-path', 'resolve-path', 'get-command', 'gcm', 'get-process', 'write-output', 'write-host', 'measure-object', 'select-object', 'select', 'where-object', 'foreach-object', '%', '?', 'sort-object', 'start-sleep', 'get-date', 'get-help', 'get-filehash',
])

/** `git` subcommands that never change the working tree or the index's files. */
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'grep', 'blame', 'describe', 'shortlog', 'cat-file', 'name-rev', 'merge-base', 'rev-list', 'diff-tree', 'show-ref', 'for-each-ref'])

/** A write hiding inside an otherwise read-only program: a write cmdlet in a script block, `find -delete`, `git diff --output`. */
const WRITE_MARK_RE = /Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|Remove-Item|Clear-Content|WriteAll|AppendAll|\.Delete\(|\s-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)\b|--output\b/i

/** Flags that make an otherwise read-only program write or run a command, by program: `tree -o file`, `fd -x/-X/--exec/--exec-batch`, `rg --pre cmd`. A flag is only a writer for its own program (`rg -o` and `ls -x` are reads). */
const WRITE_FLAG_BY_HEAD: ReadonlyMap<string, RegExp> = new Map([
  ['tree', /\s-[A-Za-z]*o(?=\s|$)|\s--output\b/],
  ['fd', /\s(?:-[A-Za-z]*[xX]|--exec|--exec-batch)(?=[\s=]|$)/],
  ['fdfind', /\s(?:-[A-Za-z]*[xX]|--exec|--exec-batch)(?=[\s=]|$)/],
  ['rg', /\s--pre(?=[\s=]|$)/],
])

/** The subcommand of a `git` invocation, past its global options. */
function gitSubcommand(tokens: readonly string[]): string | null {
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree') i++
    else if (!t.startsWith('-')) return t
  }
  return null
}

/** True unless `segment` is a program known only to read, with no redirect to an unnamed target and no substitution that may write: the check a post-shell hook makes to decide a command may have changed files it could not name. A redirect to a static path is not counted here, since the hook queues that file itself. */
export function segmentMayWriteFiles(segment: string): boolean {
  return headMayWrite(segment) || syntaxMayWrite(segment)
}

/** True when `segment` is itself a PowerShell write cmdlet or .NET writer and `found` holds the files it names, so a reconcile for what it did not name is not needed. */
function namesItsFiles(segment: string, found: ShellWriteTargets): boolean {
  if (found.written.length === 0 && found.removed.length === 0) return false
  const text = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').trimStart()
  return text.startsWith('[') || CMDLET_KINDS.has(headOf(psTokens(text)))
}

/** True when `segment` writes through its own syntax whatever its head is: a redirect to a target no static path names, any redirect inside a substitution, a substitution that runs something that may write, or text the scan cannot parse. A redirect to a static path is not this: the caller queues that path. `depth` counts substitutions nested in substitutions, past which the segment is opaque. */
function syntaxMayWrite(segment: string, depth = 0, insideSubstitution = false): boolean {
  const syntax = scanShellSyntax(segment)
  if (syntax.unparseable) return true
  if (syntax.redirects.some((target) => insideSubstitution || !isConcretePath(target))) return true
  if (syntax.substitutions.length > 0 && depth >= MAX_WRAPPER_DEPTH) return true
  return syntax.substitutions.some((inner) => splitShellSegments(inner).some((part) => headMayWrite(part) || syntaxMayWrite(part, depth + 1, true)))
}

/** True when the head of `segment` is not a program known only to read, or carries a flag that makes one write. Redirects and substitutions are {@link syntaxMayWrite}'s. */
/** True for the `git stash` forms that only list, show or print help: `list`, `show`, and any `-h` or `--help`. Every other stash form (`push`, `pop`, `apply`, `drop`, `branch`, bare `stash`) can write. */
function gitStashReadsOnly(tokens: string[]): boolean {
  const args = tokens.slice(tokens.indexOf('stash') + 1)
  return args[0] === 'list' || args[0] === 'show' || args.includes('-h') || args.includes('--help')
}

function headMayWrite(segment: string): boolean {
  const tokens = psTokens(segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ''))
  const head = headOf(tokens)
  if (head === '') return false
  if (WRITE_MARK_RE.test(segment) || WRITE_FLAG_BY_HEAD.get(head)?.test(segment) === true) return true
  if (head === 'git') {
    const sub = gitSubcommand(tokens)
    if (sub === 'stash') return !gitStashReadsOnly(tokens)
    return sub === null || !READ_ONLY_GIT.has(sub)
  }
  return !READ_ONLY_HEADS.has(head)
}

/** Matches `git restore`, which rewrites paths without moving HEAD. */
const GIT_RESTORE_RE = /^\s*git\s+restore\b/i

/** The options of a `git restore` segment: the tokens before its `--`, so a pathspec after the separator is never read as a flag. */
function restoreOptions(segment: string): string[] {
  const m = /^\s*git\s+restore\b(.*)$/i.exec(segment)
  if (m === null) return []
  const tokens = safeShlexSplit(m[1] ?? '') ?? []
  const dashDash = tokens.indexOf('--')
  return dashDash === -1 ? tokens : tokens.slice(0, dashDash)
}

/** True when `options` carries `longName`, or a short-option cluster holding `letter` (`-S`, `-SW`). */
function hasRestoreFlag(options: readonly string[], letter: string, longName: string): boolean {
  return options.some((t) => t === longName || (/^-[A-Za-z]+$/.test(t) && t.includes(letter)))
}

/** `git restore --staged <file>` only rewrites the index, leaving working-tree content untouched; a worktree flag (`--worktree`, `-W`, or a cluster holding W) makes it rewrite the working tree as well. */
function restoreIsStagedOnly(segment: string): boolean {
  const options = restoreOptions(segment)
  return hasRestoreFlag(options, 'S', '--staged') && !hasRestoreFlag(options, 'W', '--worktree')
}

/** The `git stash` subcommands that rewrite the working tree: `pop` and `apply` put changes back, `branch` checks out a branch and applies the stash onto it, and `push` or `save` put files back to their committed content, as a bare `git stash` or one taking only options does. `list`, `show`, `drop`, `clear`, `create` and `store` touch no file. */
const GIT_STASH_REWRITE_SUBCOMMANDS = new Set(['pop', 'apply', 'branch', 'push', 'save'])

/** Git's own leading options that take their value as the next argument, per git(1): `-C <path>`, `-c <name>=<value>`, and the long forms that also accept `--opt=<value>`. */
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])

/** The directory whose working tree a `git stash` segment rewrites, or null when the segment is not one that rewrites it. Environment assignments ahead of `git` and git's own leading options are skipped, and each `-C <path>` moves the directory as git does, relative to the one before it (an empty path leaves it unchanged). `-h` or `--help` anywhere after `stash` prints usage and touches nothing. */
function gitStashRewriteDir(segment: string, runDir: string): string | null {
  const tokens = safeShlexSplit(segment)
  if (tokens === null) return null
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++
  const head = tokens[i]
  if (head === undefined || path.basename(head.replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase() !== 'git') return null
  let dir = runDir
  for (i++; i < tokens.length && tokens[i]!.startsWith('-'); i++) {
    const t = tokens[i]!
    if (!GIT_OPTIONS_WITH_VALUE.has(t)) continue
    const value = tokens[++i]
    if (t === '-C' && value !== undefined && value !== '') dir = path.resolve(dir, value)
  }
  if (tokens[i] !== 'stash') return null
  const rest = tokens.slice(i + 1)
  if (rest.some((t) => t === '-h' || t === '--help')) return null
  const sub = rest[0]
  return sub === undefined || sub.startsWith('-') || GIT_STASH_REWRITE_SUBCOMMANDS.has(sub) ? dir : null
}

/** Matches working-tree rewriters whose changed paths are determined by patch contents. */
const PATCH_APPLY_SEGMENT_RE = /^\s*(?:\S*[/\\])?(?:git\s+apply|patch)\b/i

/** Matches patch inspection flags without writes (`--check`, `--stat`, `--dry-run`, etc.). */
const PATCH_APPLY_INSPECT_ONLY_RE = /(?:^|\s)--(?:check|stat|numstat|summary|dry-run)(?:\s|=|$)/i

/** True for a formatter run that rewrites files in place. The file set can come from a glob, a config-driven include list, or `.` -- not parseable from the command line -- so these join the status-sweep fallback rather than growing a second, weaker path-guessing mechanism. */
function isFormatterWriteSegment(segment: string): boolean {
  return /(?:^|\s|[/\\])(?:prettier|eslint)\b/i.test(segment) && /(?:^|\s)--(?:write|fix)(?:\s|$)/i.test(segment)
}


/** True when `token` is the leading command of the segment, allowing for a path prefix (`/usr/bin/sed`). */
function segmentCommandIs(segment: string, name: string): boolean {
  return new RegExp('^\\s*(?:\\S*[/\\\\])?' + name + '(?:\\.exe)?\\b', 'i').test(segment)
}

/** Files rewritten in place by `sed -i`, or `[]` when this segment is not an in-place sed. Handles the three spellings that actually appear: GNU `sed -i 's/a/b/' f`, GNU with a backup suffix `sed -i.bak ... f`, and BSD/macOS `sed -i '' 's/a/b/' f` where the empty suffix is its own argv entry. The first non-option token is the script unless `-e`/`-f` already supplied one. */
function extractSedInPlaceFiles(segment: string): string[] {
  if (!segmentCommandIs(segment, 'sed')) return []
  const tokens = safeShlexSplit(segment)
  if (tokens === null) return []
  const rest = tokens.slice(1)
  const inPlaceIdx = rest.findIndex((t) => t === '--in-place' || t.startsWith('--in-place=') || /^-[a-zA-Z]*i/.test(t))
  if (inPlaceIdx === -1) return []
  const files: string[] = []
  let scriptTaken = rest.some((t) => t === '-e' || t === '-f' || t.startsWith('--expression') || t.startsWith('--file'))
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!
    if (i === inPlaceIdx) {
      // BSD sed spells the no-backup form `-i ''`; the empty suffix is a separate argv entry and must not be mistaken for the script.
      if (t === '-i' && rest[i + 1] === '') i++
      continue
    }
    if (t === '-e' || t === '-f' || t === '--expression' || t === '--file') {
      i++
      continue
    }
    if (t.length > 1 && t.startsWith('-')) continue
    if (!scriptTaken) {
      scriptTaken = true
      continue
    }
    files.push(t)
  }
  return files
}

/** Files written by `tee [-a] <file>...`, or `[]` when this segment is not a tee. */
function extractTeeFiles(segment: string): string[] {
  if (!segmentCommandIs(segment, 'tee')) return []
  const tokens = safeShlexSplit(segment)
  if (tokens === null) return []
  return tokens.slice(1).filter((t) => t.length > 0 && !t.startsWith('-'))
}

/** Pathspecs named on a `git restore` command line: everything after `--`, or every non-option token once `-s`/`--source`'s separate value is skipped. */
function extractGitRestorePathspecs(cmd: string): string[] {
  const m = /^\s*git\s+restore\b(.*)$/i.exec(cmd)
  if (m === null) return []
  const tokens = safeShlexSplit(m[1] ?? '')
  if (tokens === null) return []
  const dashDash = tokens.indexOf('--')
  if (dashDash !== -1) return tokens.slice(dashDash + 1)
  const specs: string[] = []
  let skipNext = false
  for (const t of tokens) {
    if (skipNext) {
      skipNext = false
      continue
    }
    if (t === '-s' || t === '--source') {
      skipNext = true
      continue
    }
    if (t.startsWith('-')) continue
    specs.push(t)
  }
  return specs
}

/** A git read that ran past the hook's 5 s budget names no files, which would leave the index on the pre-rewrite content with nothing in any log; the worker can sweep the project without that budget, so hand it the project and record that. Git that never started (missing, or a working directory that is gone) gets no request, since the worker needs git to sweep too, and a nonzero exit is git saying this is not a repository, which has nothing to reconcile. */
function reconcileIfGitTimedOut(result: GitResult, gitDir: string, what: string, gitCommand: string): void {
  if (result.timedOut !== true) return
  const recorded = requestReconcileSafe(gitDir)
  appendWorkerErrorLog(dataDir(), `${new Date().toISOString()} post-bash ${what} in ${gitDir}: ${gitCommand} did not answer in time (${result.stderr.trim().slice(0, 200)}); ${recorded ? 'asked the worker to reconcile the project' : 'could not record a reconcile request, so the index may stay stale until the next index run'}\n`)
}

/** Expand `git restore` pathspecs (which may be `.`, a directory, or a glob) into the concrete tracked files git itself matches, repo-root-relative. */
async function expandGitPathspecs(specs: string[], gitDir: string): Promise<string[]> {
  if (specs.length === 0) return []
  // `-z` names each path as written; without it a non-ASCII name comes back octal-quoted and names no file.
  const listed = await hookGitRead(gitDir, ['ls-files', '-z', '--full-name', '--', ...specs])
  reconcileIfGitTimedOut(listed, gitDir, 'git restore', 'git ls-files')
  if (listed.exitCode !== 0) return []
  const repoRoot = await gitRepoRootOrNull(gitDir)
  if (repoRoot === null) {
    requestReconcileSafe(gitDir)
    return []
  }
  return listed.stdout
    .split('\x00')
    .filter((rel) => rel.length > 0)
    .map((rel) => resolveIndexPath(rel, repoRoot))
}

/** The most paths one status sweep enqueues; past it the worker's reconcile, requested on every sweep, finds the rest of the tracked files. */
const STATUS_SWEEP_CAP = 2000

/** Every path git currently reports as changed or untracked, plus the source of each rename, absolute. The fallback for rewrites whose file set is not on the command line (stash, patch application, formatter runs). Read with `-z`, which names each path as written: plain porcelain octal-quotes a non-ASCII name and joins a rename as `old -> new`, which a name holding ` -> ` makes ambiguous. Untracked files are listed one by one, since plain porcelain folds a new directory into `dir/`, which names no file the index can take. A file the rewrite put back to its committed content is on no listing at all, so every sweep also asks the worker to reconcile the project. */
async function workingTreeStatusPaths(gitDir: string): Promise<string[]> {
  const status = await hookGitRead(gitDir, ['status', '--porcelain', '-z', '--untracked-files=all'])
  reconcileIfGitTimedOut(status, gitDir, 'status sweep', 'git status')
  const stamp = `${new Date().toISOString()} post-bash status sweep in ${gitDir}`
  if (status.exitCode === -1 && status.timedOut !== true && /ENOBUFS/.test(status.stderr)) {
    // Git ran but listed more than runGitAsync's output buffer holds, so this sweep names no file; the worker's reconcile, which reads the index rather than this listing, can still find the changed ones.
    const recorded = requestReconcileSafe(gitDir)
    appendWorkerErrorLog(dataDir(), `${stamp}: git status listed more than the output buffer holds; ${recorded ? 'asked the worker to reconcile the project' : 'could not record a reconcile request, so the index may stay stale until the next index run'}\n`)
  }
  if (status.exitCode !== 0) return []
  const recorded = requestReconcileSafe(gitDir)
  const repoRoot = await gitRepoRootOrNull(gitDir)
  if (repoRoot === null) return []
  const entries = parsePorcelainZ(status.stdout)
  // Untracked paths first: the worker's reconcile finds every tracked file this cap leaves out, but it never lists a new untracked file, so the sweep is the only thing that queues one.
  const rels = [...entries.filter((e) => e.untracked === true), ...entries.filter((e) => e.untracked !== true)].flatMap((e) => (e.origPath === undefined ? [e.path] : [e.path, e.origPath]))
  if (!recorded && rels.length <= STATUS_SWEEP_CAP) {
    appendWorkerErrorLog(dataDir(), `${stamp}: could not record a reconcile request, so a file this sweep could not see may stay stale until the next index run\n`)
  }
  if (rels.length > STATUS_SWEEP_CAP) {
    const untrackedDropped = Math.max(0, entries.filter((e) => e.untracked === true).length - STATUS_SWEEP_CAP)
    appendWorkerErrorLog(dataDir(), `${stamp}: git listed ${rels.length} paths, so only the first ${STATUS_SWEEP_CAP} were queued, untracked ones first; ${untrackedDropped > 0 ? `${untrackedDropped} untracked ${untrackedDropped === 1 ? 'file was' : 'files were'} left out, which no reconcile finds, and ` : ''}${recorded ? 'asked the worker to reconcile the project for the rest of the tracked files' : 'could not record a reconcile request, so the index may stay stale until the next index run'}\n`)
  }
  return rels.slice(0, STATUS_SWEEP_CAP).map((rel) => resolveIndexPath(rel, repoRoot))
}

/** Enqueue one rewritten path, filtering the shapes that must never reach the queue: a discard sink, a directory, and anything not actually on disk (a redirect whose target never materialized, or a path parsed out of a command that ran somewhere else). A path under the OS temp dir is refused by enqueueDirtyPathSafe itself, for this detector and the git-mutation one alike. */
function enqueueRewrittenPath(absPath: string): void {
  if (/(?:^|[/\\])(?:NUL|nul)$/.test(absPath) || absPath.replace(/\\/g, '/').endsWith('/dev/null')) return
  try {
    if (!fs.statSync(absPath).isFile()) return
  } catch {
    return
  }
  enqueueDirtyPathSafe(absPath, { alreadyResolved: true })
}

/** Options that make `checkout`, `switch` or `reset` discard working-tree changes, which no commit diff lists. */
const WORKTREE_DISCARD_FLAGS = new Set(['-f', '--force', '--hard', '--merge', '--discard-changes'])

/** The `git` subcommands that rewrite working-tree files when they name a path or a discard flag. */
const WORKTREE_GIT_SUBCOMMANDS = new Set(['checkout', 'switch', 'reset'])

/** True when `segment` is a `git` command that may rewrite working-tree files a commit diff cannot list: `restore` unless it is staged-only, and `checkout`, `switch` or `reset` that names a path (`--`, a name on disk under `runDir`, or any name that is not a local branch) or discards changes (`-f`, `--hard`). Such a command asks for a reconcile whatever its exit code. */
function gitMayRewriteWorktree(segment: string, runDir: string): boolean {
  const tokens = safeShlexSplit(segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ''))
  if (tokens === null || headOf(tokens) !== 'git') return false
  const sub = gitSubcommand(tokens)
  if (sub === 'restore') return !restoreIsStagedOnly(segment)
  if (sub === null || !WORKTREE_GIT_SUBCOMMANDS.has(sub)) return false
  const args = tokens.slice(tokens.indexOf(sub) + 1)
  if (args.includes('--') || args.some((t) => WORKTREE_DISCARD_FLAGS.has(t))) return true
  // A name that is not on disk is either a branch (HEAD moves, and the head-moving diff covers it) or a tracked file deleted from disk, which checkout restores without moving HEAD. Only a local branch is told apart here, from the ref files, so no git process is spawned; any other name reconciles.
  return args.some((t) => !t.startsWith('-') && (fs.existsSync(resolveIndexPath(t, runDir)) || !localBranchExists(runDir, t)))
}

/** True when `name` is a local branch of the repository above `runDir`: a loose ref file, or a line of packed-refs. A `.git` file (a linked worktree) or no repository above `runDir` answers false, so the caller reconciles, the cheap direction. */
function localBranchExists(runDir: string, name: string): boolean {
  if (name === '' || name.includes('..')) return false
  for (let dir = path.resolve(runDir); ; dir = path.dirname(dir)) {
    const gitDir = path.join(dir, '.git')
    if (fs.existsSync(gitDir)) {
      if (!fs.statSync(gitDir).isDirectory()) return false
      if (fs.existsSync(path.join(gitDir, 'refs', 'heads', name))) return true
      const packed = path.join(gitDir, 'packed-refs')
      return fs.existsSync(packed) && fs.readFileSync(packed, 'utf8').split('\n').some((line) => line.endsWith(` refs/heads/${name}`))
    }
    if (path.dirname(dir) === dir) return false
  }
}

/** Where a command's writes land: `runDir`, the directory its leading `cd` leaves the shell in, and `startDir`, where it began. `cdTrusted` is false when that leading `cd` names a directory the text cannot resolve (`cd $X`, `cd -`, `cd ~`): then no write is named, and `startDir` is reconciled instead. */
export interface WriteScope {
  readonly runDir: string
  readonly startDir: string
  readonly cdTrusted: boolean
}

/** The `cd`-family commands that move the directory later writes run in, by name and alias. */
const DIR_CHANGE_HEADS: ReadonlySet<string> = new Set(['cd', 'chdir', 'sl', 'pushd', 'popd', 'pushl', 'popl', 'set-location', 'push-location', 'pop-location'])

/** A directory-change word in command position: after the start, a separator, or a quote or bracket. A quoted `"cd"` in an argument also matches; that only splits the text earlier, which names fewer files and requests more reconciles. */
const DIR_CHANGE_RE = new RegExp(`(?:^|[\\s(){}&|;"'\`])(?:${[...DIR_CHANGE_HEADS].join('|')})(?=[\\s;|&(){}"'\`]|$)`, 'i')

/** Split `cmd` where its text stops resolving against the run directory: at the first top-level segment holding a directory change, since the leading `cd` was consumed before the text got here. Returns the text before that segment, and from it on. */
function splitAtDirChange(cmd: string): { head: string; tail: string } {
  const tops = splitShellSegments(cmd)
  const k = tops.findIndex((segment) => DIR_CHANGE_RE.test(segment))
  if (k < 0) return { head: cmd, tail: '' }
  let at = 0
  for (let i = 0; i < k; i++) at = cmd.indexOf(tops[i]!, at) + tops[i]!.length
  at = cmd.indexOf(tops[k]!, at)
  return { head: cmd.slice(0, at), tail: cmd.slice(at) }
}

/** True when a segment may change a file: a program that may write (see {@link segmentMayWriteFiles}), or any redirect, named target or not. */
function segmentMayChangeFiles(segment: string): boolean {
  return segmentMayWriteFiles(segment) || scanShellSyntax(segment).redirects.length > 0
}

/** True when the text after a directory change may change a file, apart from the directory change itself. */
function tailMayChangeFiles(tail: string): boolean {
  return splitShellSegments(tail).some((segment) => !DIR_CHANGE_HEADS.has(headOf(psTokens(segment))) && segmentMayChangeFiles(segment))
}

/** Enqueue every file rewritten by a working-tree mutation that does NOT move HEAD, so the index does not silently keep serving pre-mutation symbols. The sibling {@link isHeadMovingGitCommand} block covers the reflog-diffable git commands. This covers the rest: `git restore` and `git stash pop|apply` (git, but HEAD never moves, so no reflog base exists) and the plain shell in-place writes that never touch git at all -- `sed -i`, `>`/`>>` redirection, `tee`, `git apply`, `patch`, `prettier --write`, `eslint --fix`. None of these go through Claude Code's Edit tool, so none of them reached `queue/dirty.txt` before. `exitCode` is the command's exit status when the harness reports one, and a non-zero one drops the named files (a failed `sed -i` or `git restore` changed nothing) but keeps the shell-write pass and the sweeps. Paths that ARE on the command line are taken from it; the rest fall back to the working-tree status sweep rather than a second guessing mechanism. Every path resolves against `runDir`, the directory the command ran in, which a stripped `cd sub && ...` prefix moves: there `sed -i ... f`, a redirect into `f` and `git restore f` all name `sub/f`, and resolved from anywhere else each names a file that is not on disk and silently enqueues nothing. */
export async function enqueueNonHeadMovingRewrites(cmd: string, scope: WriteScope, exitCode?: number | null): Promise<void> {
  if (!scope.cdTrusted) {
    if (splitShellSegments(cmd).some((segment) => segmentMayChangeFiles(segment)) && !reconcileAlreadyPending(scope.startDir)) requestReconcileSafe(scope.startDir)
    return
  }
  const { runDir } = scope
  const { head, tail } = splitAtDirChange(cmd)
  const atRunDir = (f: string): string => resolveIndexPath(f, runDir)
  const paths: string[] = []
  // Each directory whose working tree needs a status sweep: the run directory for a patch or formatter, or wherever `git -C` pointed a stash.
  const sweepDirs = new Set<string>()
  // Segments whose files this pass named or swept, or that another pass owns, which the shell-write pass leaves alone.
  const handled = new Set<string>()
  // Set when a command that can rewrite files it does not name ran, or a command that writes failed: the files it reached are queued above, and the rest is the worker's reconcile.
  let reconcile = false
  const failed = Boolean(exitCode)
  for (const segment of splitShellSegments(head)) {
    let swept = false
    if (PATCH_APPLY_SEGMENT_RE.test(segment) && !PATCH_APPLY_INSPECT_ONLY_RE.test(segment)) { sweepDirs.add(runDir); swept = true }
    if (isFormatterWriteSegment(segment)) { sweepDirs.add(runDir); swept = true }
    const stashDir = gitStashRewriteDir(segment, runDir)
    if (stashDir !== null) { sweepDirs.add(stashDir); swept = true }
    // A named file is queued whatever the exit code: a `sed -i` that fails on one of its files has already edited the others.
    const named: string[] = [...extractSedInPlaceFiles(segment), ...extractTeeFiles(segment)]
    const concrete = named.filter(isConcretePath)
    for (const f of concrete) paths.push(atRunDir(f))
    let namesEveryFile = named.length > 0 && concrete.length === named.length
    const restores = GIT_RESTORE_RE.test(segment) && !restoreIsStagedOnly(segment)
    if (GIT_RESTORE_RE.test(segment)) {
      if (!restores) namesEveryFile = true
      else {
        const specs = extractGitRestorePathspecs(segment)
        // A glob, a variable or a `~` names nothing this hook can resolve, so that restore stays unhandled and the reconcile covers it.
        namesEveryFile = specs.length > 0 && specs.every((spec) => spec === '.' || isConcretePath(spec))
        if (namesEveryFile) {
          paths.push(...(await expandGitPathspecs(specs, runDir)))
          // `ls-files` lists only what the index holds, so a file `--source` brought back that the index lacks is found by its literal name instead; `.` names nothing literally.
          for (const spec of specs) if (spec !== '.' && !spec.startsWith(':')) paths.push(atRunDir(spec))
        }
      }
    }
    const writesFiles = swept || named.length > 0 || restores || isHeadMovingGitCommand(segment)
    if (gitMayRewriteWorktree(segment, runDir) || (failed && writesFiles)) reconcile = true
    if (swept || namesEveryFile || tokenGoatInvocation(segment) !== null || isHeadMovingGitCommand(segment)) handled.add(segment)
  }
  // Loaded on use: the hook entry's eager set is size-guarded (tests/guards/dist_chunks_deduped.test.ts), and this pass is the part of it that grows with the shells it knows.
  if (tailMayChangeFiles(tail)) reconcile = true
  enqueueShellWrites(head, runDir, handled, { written: enqueueRewrittenPath, removed: enqueueSweptPath })
  if (reconcile && !reconcileAlreadyPending(runDir)) requestReconcileSafe(runDir)
  for (const p of new Set(paths)) enqueueRewrittenPath(p)
  // A sweep also runs after a non-zero exit: a formatter or patch that fails part-way has already written files, and every sweep asks the worker to reconcile the project.
  for (const dir of sweepDirs) for (const p of await workingTreeStatusPaths(dir)) enqueueSweptPath(p)
}

/** Enqueue a path the status sweep listed: a file to reindex, or a path that is no longer on disk (deleted, or the source of a rename) so the drain drops its rows. Anything else, such as a submodule directory, names nothing the index holds. */
function enqueueSweptPath(absPath: string): void {
  try {
    if (!fs.statSync(absPath).isFile()) return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return
  }
  enqueueDirtyPathSafe(absPath, { alreadyResolved: true })
}

