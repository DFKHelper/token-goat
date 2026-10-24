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

/** The program a segment launches, lowercased and without its directory or `.exe`. */
function headOf(tokens: readonly string[]): string {
  return (tokens[0] ?? '').replace(/^.*[/\\]/, '').replace(/\.exe$/i, '').toLowerCase()
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
  const tokens = psTokens(segment)
  const head = headOf(tokens)
  if (head === 'powershell' || head === 'pwsh') {
    const flag = tokens.findIndex((t) => /^-c(?:ommand)?$/i.test(t))
    if (flag >= 0) scan(tokens.slice(flag + 1).join(' '))
    return into
  }
  scan(segment)
  return into
}

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
  for (const segment of splitShellSegments(cmd)) {
    const named = extractPowerShellWriteTargets(segment)
    for (const f of named.written) written.add(resolveIndexPath(f, runDir))
    for (const f of named.removed) removed.add(resolveIndexPath(f, runDir))
    if (!handled.has(segment) && named.written.length === 0 && named.removed.length === 0 && segmentMayWriteFiles(segment)) unnamed = true
  }
  written.forEach(enqueue.written)
  removed.forEach(enqueue.removed)
  if (unnamed && !reconcileAlreadyPending(runDir)) requestReconcileSafe(runDir)
}

/** Programs whose only effect is to read or report; anything not listed may write files. */
const READ_ONLY_HEADS: ReadonlySet<string> = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'fd', 'find', 'pwd', 'echo', 'cd', 'pushd', 'popd', 'which', 'where', 'whereis', 'tree', 'stat', 'file', 'du', 'df', 'diff', 'cmp', 'less', 'more', 'true', 'false', 'date', 'whoami', 'basename', 'dirname', 'realpath', 'readlink', 'test', 'cls', 'clear', 'sleep',
  'get-content', 'gc', 'get-childitem', 'gci', 'get-item', 'gi', 'get-location', 'gl', 'select-string', 'sls', 'test-path', 'resolve-path', 'get-command', 'gcm', 'get-process', 'write-output', 'write-host', 'measure-object', 'select-object', 'select', 'where-object', 'start-sleep', 'get-date', 'get-help', 'get-filehash',
])

/** `git` subcommands that never change the working tree or the index's files. */
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'grep', 'blame', 'describe', 'shortlog', 'cat-file', 'name-rev', 'merge-base', 'rev-list', 'diff-tree', 'show-ref', 'for-each-ref'])

/** A write hiding inside an otherwise read-only program: a write cmdlet in a script block, `find -delete`, `git diff --output`. */
const WRITE_MARK_RE = /Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|Remove-Item|Clear-Content|WriteAll|AppendAll|\.Delete\(|\s-(?:delete|exec|execdir|ok|okdir|fprint\w*)\b|--output\b/i

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
  if (WRITE_MARK_RE.test(segment)) return true
  if (head === 'git') {
    const sub = gitSubcommand(tokens)
    return sub === null || !READ_ONLY_GIT.has(sub)
  }
  return !READ_ONLY_HEADS.has(head)
}
