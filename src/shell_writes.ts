/** What a shell command line writes, for the post-shell hook that keeps the index fresh: the files PowerShell's own write cmdlets and .NET file writers name on the command line, and whether a segment could write files at all. A command that writes through some other program (`python -c`, a build step, a script) names nothing here, so the caller asks the worker to reconcile the project instead of guessing at every interpreter. */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { splitShellSegments } from './bash_extractors.js'
import { dataDir } from './constants.js'
import { reconcileRequestPathFor } from './dirty_queue.js'
import { requestReconcileSafe } from './hooks_index.js'
import { resolveIndexPath } from './paths.js'

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

/** Split `text` on whitespace the way PowerShell reads a command line: single and double quotes group, and a backslash is an ordinary character, so a Windows path keeps its separators. */
function psTokens(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let started = false
  for (const ch of text) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) out.push(cur)
      cur = ''
      started = false
      continue
    }
    cur += ch
    started = true
  }
  if (started) out.push(cur)
  return out
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

interface CmdletArgs {
  path: string | null
  destination: string | null
  newName: string | null
  name: string | null
  positional: string[]
  directory: boolean
}

/** Read one cmdlet's arguments (the tokens after its name): the named path parameters, and the positional values in order. */
function readCmdletArgs(args: readonly string[]): CmdletArgs {
  const result: CmdletArgs = { path: null, destination: null, newName: null, name: null, positional: [], directory: false }
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!
    if (!/^-[A-Za-z]/.test(token)) {
      result.positional.push(token)
      continue
    }
    const colon = token.indexOf(':')
    const param = (colon > 0 ? token.slice(1, colon) : token.slice(1)).toLowerCase()
    const inline = colon > 0 ? token.slice(colon + 1) : null
    const next = (): string | null => inline ?? (i + 1 < args.length ? args[++i]! : null)
    if (paramIs(param, PATH_PARAMS)) result.path = next()
    else if (paramIs(param, DEST_PARAMS)) result.destination = next()
    else if (paramIs(param, NEWNAME_PARAMS)) result.newName = next()
    else if (paramIs(param, NAME_PARAMS)) result.name = next()
    else if (paramIs(param, OTHER_VALUE_PARAMS)) {
      const value = next()
      if (param.startsWith('it') && value !== null && /^dir/i.test(value)) result.directory = true
    }
  }
  return result
}

/** The files one PowerShell cmdlet call writes, from its tokens (the cmdlet name first); nothing when a path is not statically known. */
function cmdletTargets(kind: WriteKind, args: readonly string[], into: ShellWriteTargets): void {
  const a = readCmdletArgs(args)
  const first = a.path ?? a.positional[0] ?? null
  const second = a.positional[a.path === null ? 1 : 0] ?? null
  if (kind === 'set') {
    if (a.directory || first === null || !isStaticPath(first)) return
    if (a.name !== null) {
      if (isStaticPath(a.name)) into.written.push(path.join(first, a.name))
    } else into.written.push(first)
    return
  }
  if (kind === 'remove') {
    if (first !== null && isStaticPath(first)) into.removed.push(first)
    return
  }
  if (kind === 'rename') {
    const newName = a.newName ?? second
    if (first === null || newName === null || !isStaticPath(first) || !isStaticPath(newName)) return
    into.removed.push(first)
    into.written.push(path.join(path.dirname(first), newName))
    return
  }
  const dest = a.destination ?? second
  if (first === null || dest === null || !isStaticPath(first) || !isStaticPath(dest)) return
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

/** The body of a `powershell`/`pwsh -Command` segment, or null when the segment is not one. */
function wrapperBody(segment: string): string | null {
  const tokens = psTokens(segment)
  const name = shellNameOf(tokens)
  if (name !== 'powershell' && name !== 'pwsh') return null
  const flag = tokens.findIndex((t) => /^-c(?:ommand)?$/i.test(t))
  return flag >= 0 ? tokens.slice(flag + 1).join(' ') : null
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

/** The segments to judge for `segment`: a `-Command` wrapper stands for the segments of its body, and a script block's own segments are judged beside the segment holding it (those starting with a variable are expressions, not programs). `opaque` is set when the nesting ran past {@link MAX_WRAPPER_DEPTH}. */
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
    for (const inner of splitShellSegments(block)) if (!inner.trimStart().startsWith('$')) segments.push(inner)
  }
  return { segments, opaque: false }
}

/** The files a PowerShell write cmdlet or .NET file writer in `segment` names, a `powershell -Command "..."` wrapper looked into one level. */
export function extractPowerShellWriteTargets(segment: string): ShellWriteTargets {
  const into: ShellWriteTargets = { written: [], removed: [] }
  const scan = (text: string): void => {
    const tokens = psTokens(text)
    tokens.forEach((token, i) => {
      const kind = CMDLET_KINDS.get(token.toLowerCase())
      if (kind !== undefined) cmdletTargets(kind, tokens.slice(i + 1), into)
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

/** Targets of `>` / `>>` output redirection in one segment. `2>&1`-style fd duplications name no file and are excluded by the target pattern, and the null devices are never a file. */
function extractRedirectTargets(segment: string): string[] {
  const targets: string[] = []
  const re = /(?:^|\s)[0-9]?>>?\s*("[^"]*"|'[^']*'|[^\s|&<>]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(segment)) !== null) {
    const raw = m[1]!
    const target = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") ? raw.slice(1, -1) : raw
    if (!/^(?:\/dev\/null|nul|\$null)$/i.test(target)) targets.push(target)
  }
  return targets
}

/** A recursive switch on a remove: `-r`, `-R`, `-rf`, `-fr`, `-Recurse` (not `-Force`, which merely contains an r). */
const RECURSIVE_FLAG_RE = /\s-(?:[fvi]*r[fvi]*|recurse)(?=\s|$|:)/i

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
    const named = extractPowerShellWriteTargets(segment)
    for (const f of named.written) written.add(resolveIndexPath(f, runDir))
    for (const f of named.removed) removed.add(resolveIndexPath(f, runDir))
    // A redirect says where the output went, not what the program behind it wrote, so the segment still goes to the may-write check below.
    for (const f of extractRedirectTargets(segment)) written.add(resolveIndexPath(f, runDir))
    if (!handled.has(segment) && named.written.length === 0 && named.removed.length === 0 && segmentMayWriteFiles(segment)) unnamed = true
    // The drain prunes only the exact path it is given, so a deleted directory leaves its children indexed until the sweep's deletion pass stats their rows: a recursive remove, or a target with no extension (already gone, so a directory cannot be told from a file), asks for that sweep.
    if (named.removed.length > 0 && (RECURSIVE_FLAG_RE.test(segment) || named.removed.some((f) => path.extname(f) === ''))) unnamed = true
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
const WRITE_MARK_RE = /Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|Remove-Item|Clear-Content|WriteAll|AppendAll|\.Delete\(|\s-(?:delete|exec|execdir|ok|okdir|fprint\w*)\b|--output\b/i

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

/** True unless `segment` is a program known only to read: the check a post-shell hook makes to decide a command may have changed files it could not name. */
export function segmentMayWriteFiles(segment: string): boolean {
  const tokens = psTokens(segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ''))
  const head = headOf(tokens)
  if (head === '') return false
  if (WRITE_MARK_RE.test(segment) || WRITE_FLAG_BY_HEAD.get(head)?.test(segment) === true) return true
  if (head === 'git') {
    const sub = gitSubcommand(tokens)
    return sub === null || !READ_ONLY_GIT.has(sub)
  }
  return !READ_ONLY_HEADS.has(head)
}
