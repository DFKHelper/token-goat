/** Refuses a shell command that walks a whole filesystem root or the home directory with no depth bound, or that starts the Windows `find.exe` text search with nothing to read, because both outlive a timed-out shell and keep burning CPU. The scanner here is its own because the shared ones lose what this rule reads: `shlexSplit` consumes backslashes (so `C:\` and `C:\Windows\System32\find.exe` stop being paths) and `splitShellSegments` drops which operator joined two commands (a piped `find "x"` reads stdin, a chained one waits on it forever) and does not split a subshell. */
import { refuse, scan, MAX_NESTING, type Segment, type Word, type WalkContext, type WalkRefusal } from './unbounded_walk_scan.js'
import { anyRoot, cdLandsAtRoot, commandIndex, commandName, EXEC_END, EXEC_PRIMARY, isRelativeStart, isRoot, SKIPPED_KEYWORDS, texts, VALUED_PRIMARY } from './unbounded_walk_words.js'
import {
  atNestingLimit, DIGITS, envOptions, EXTRA_WALKERS, fedText, inspectDu, inspectFd, inspectFindstr, inspectGrep,
  inspectListing, inspectRecursive, inspectRg, inspectTree, nestedScript, SHELLS, WALKER_WORD,
} from './unbounded_walk_tools.js'
import {
  listerProven, nonRecursiveUnderUnprovenLister, PLAIN_COMMAND, PLAIN_COMMAND_DIR, STDIN_ROOT, walkerWithFlagsOnly,
  WALKER_FAMILY, WALKER_NAMES, WRAPPER_NAMES, XARGS_FILE_OPTION, XARGS_SHELL_NAMES, XARGS_VALUED, XARGS_WALKERS,
  xargsCommand,
} from './unbounded_walk_xargs.js'

export type { WalkContext, WalkRefusal } from './unbounded_walk_scan.js'

function inspectFind(
  args: readonly Word[],
  dir: string,
  seg: Segment,
  ctx: WalkContext,
  fromRoot: boolean,
  depth: number,
): WalkRefusal | null {
  const t = texts(args)
  const system32 = /[\\/](system32|syswow64|windows)[\\/]$/i.test(dir)
  const qualified = dir !== '' && !system32
  // Windows `find.exe` takes only slash options, so a `-name`-style primary (or `!`) is how POSIX find shows itself.
  const primary = t.some((x) => /^-[A-Za-z_]{2,}$/.test(x) || x === '!')
  const winOption = t.some((x) => /^\/(v|c|n|i|off|offline)$/i.test(x))
  // A slash option beside a quoted search string is the Windows tool; the same words in Git Bash may be Git find, so only PowerShell (where a bare `find` is find.exe) or an explicit System32 path is refused for it.
  if (system32 || (ctx.windows && winOption && !primary && !qualified && args.some((w) => w.quoted))) {
    if (!ctx.windows || (!system32 && !ctx.powershell)) return null
    const given = args.filter((w) => !/^\/[A-Za-z]+$/.test(w.text))
    return given.length <= 1 && !seg.pipedIn && !seg.redirectedIn ? refuse('find-stdin') : null
  }
  const starts: string[] = []
  let at = 0
  for (; at < t.length; at++) {
    const x = t[at]!
    // BSD find: `-E -s -X -x -d` are flags before the paths, and `-f path` names one.
    if (/^-([HLPEXsxd]|O\d)$/.test(x)) continue
    if (x === '-D' || x === '-f') {
      if (x === '-f' && t[at + 1] !== undefined) starts.push(t[++at]!)
      else at++
      continue
    }
    if (x.startsWith('-') || x === '!' || x.startsWith('\\(')) break
    starts.push(x)
  }
  // A bound is `-maxdepth` with digits, outside an `-exec` payload and not another primary's value.
  let bounded = false
  const payloads: Word[][] = []
  for (let i = at; i < t.length; i++) {
    if (EXEC_PRIMARY.test(t[i]!)) {
      let end = i + 1
      while (end < t.length && !EXEC_END.has(t[end]!)) end++
      payloads.push(args.slice(i + 1, end))
      i = end
    } else if (t[i] === '-maxdepth' && !VALUED_PRIMARY.test(t[i - 1] ?? '') && DIGITS.test(t[i + 1] ?? '')) {
      bounded = true
    }
  }
  // After `cd /` a find with no path, or a `.`-relative one, starts at that root.
  const atRoot = starts.some((s) => isRoot(s))
  const afterCd = fromRoot && (starts.length === 0 || starts.some(isRelativeStart))
  if ((atRoot || afterCd) && !bounded) return refuse('find')
  // The `-exec` command runs once per start path in the walk, with `{}` standing for it.
  for (const payload of payloads) {
    for (const target of starts.length > 0 ? starts : ['.']) {
      const words = payload.map((w) => ({ text: w.text.split('{}').join(target), quoted: w.quoted }))
      const hit = inspectSegment({ ...seg, words, pipedIn: false, stdin: [], subs: [] }, ctx, depth, fromRoot)
      if (hit !== null) return hit
    }
  }
  // PowerShell runs a bare `find "text"` as the Windows find.exe, which reads standard input when it is given no file.
  const sole = args.length === 1 ? args[0]! : null
  if (ctx.powershell && !primary && !winOption && !qualified && sole !== null && sole.quoted && !seg.pipedIn && !seg.redirectedIn) return refuse('find-stdin')
  return null
}

/** Class C only: whether a walker word among the xargs words would walk a root on stdin; each is tried. */
function xargsStdinWalks(
  args: readonly Word[],
  seg: Segment,
  ctx: WalkContext,
  proven: boolean,
  depth: number,
): boolean {
  for (let j = 0; j < args.length; j++) {
    const { name } = commandName(args[j]!.text)
    const own = args.slice(j + 1)
    const script = own.map((w) => w.text).join(' ').replace(/[\\'"]/g, '')
    if (XARGS_SHELL_NAMES.has(name) && WALKER_WORD.test(script)) return true
    // The other recursive commands are tried only when no proven lister vouches for what they are given.
    if (!WALKER_NAMES.includes(name) && !(EXTRA_WALKERS.has(name) && !proven)) continue
    // A `find` and an `rg` always count: an own start path is no proof, stdin words may add start paths.
    if (name === 'find' || name === 'rg') return true
    if (inspectWalker(name, '', [...own, STDIN_ROOT, STDIN_ROOT], seg, ctx, false, depth) !== null) return true
  }
  return false
}

/** `xargs <command>`: A obscured or unknown word, B walker family, C any other plain word; see Ruling 50. */
function inspectXargs(
  args: readonly Word[],
  seg: Segment,
  ctx: WalkContext,
  depth: number,
  fromRoot: boolean,
  prev: Segment | undefined,
): WalkRefusal | null {
  let i = 0
  while (i < args.length && args[i]!.text.startsWith('-')) {
    if (args[i]!.text === '--') {
      i++
      break
    }
    i += XARGS_VALUED.test(args[i]!.text) ? 2 : 1
  }
  const rest = args.slice(i)
  // No command word: a bare `xargs` runs echo, but the scanner also splits a backtick command off its segment.
  if (rest.length === 0) return listerProven(seg, prev, fromRoot) ? null : refuse('xargs')
  // A list read from a file is not the lister's output, so no lister can vouch for it.
  if (args.slice(0, i).some((w) => XARGS_FILE_OPTION.test(w.text))) return refuse('xargs')
  const inner: Segment = { ...seg, words: rest, pipedIn: true, stdin: [], subs: [] }
  const hit = inspectSegment(inner, ctx, depth + 1, false)
  if (hit !== null) return hit
  const proven = listerProven(seg, prev, fromRoot)
  const parsed = xargsCommand(args)
  // A replace string (`-I{}`) is understood only for grep behind a proven lister; otherwise it is unparsed.
  const replaceOk = parsed?.replace == null
    || (proven && ['grep', 'egrep', 'fgrep'].includes(commandName(parsed.words[0]?.text ?? '').name))
  const command = replaceOk ? parsed?.words ?? null : null
  if (command === null || command.length === 0) {
    // The options do not parse, so the command word is unknown: refuse when any word names the family.
    if (args.some((w) => WALKER_FAMILY.has(commandName(w.text).name))) return refuse('xargs')
    return proven ? null : refuse('xargs')
  }
  const head = command[0]!
  const { name, dir } = commandName(head.text)
  if (WALKER_FAMILY.has(name)) {
    const spec = head.text === name && !head.quoted ? XARGS_WALKERS.get(name) : undefined
    if (spec === undefined) return refuse('xargs')
    const allowed = proven
      ? walkerWithFlagsOnly(command, spec, parsed!.replace)
      : nonRecursiveUnderUnprovenLister(command)
    return allowed
      ? null
      : refuse('xargs')
  }
  const plain = !head.quoted && PLAIN_COMMAND.test(name) && PLAIN_COMMAND_DIR.test(dir)
  if (!plain) return proven ? null : refuse('xargs')
  return xargsStdinWalks(args, seg, ctx, proven, depth) ? refuse('xargs') : null
}

function inspectSegment(
  seg: Segment,
  ctx: WalkContext,
  depth: number,
  fromRoot: boolean,
  next?: Segment,
  prev?: Segment,
): WalkRefusal | null {
  const at = commandIndex(seg.words)
  const env = envOptions(seg.words, at)
  const root = fromRoot || (env.chdir !== undefined && isRoot(env.chdir))
  const sub = (script: string): WalkRefusal | null =>
    depth < MAX_NESTING ? detectUnboundedWalk(script, ctx, depth + 1, root) : atNestingLimit(script)
  // Scripts from `$(...)`, backticks in double quotes, heredocs and `env -S` run whatever the command is.
  for (const script of [...seg.subs, ...(env.split === undefined ? [] : [env.split])]) {
    const hit = sub(script)
    if (hit !== null) return hit
  }
  const head = seg.words[at]
  if (head === undefined) return null
  const { name, dir } = commandName(head.text)
  const args = seg.words.slice(at + 1)
  const script = nestedScript(name, args)
  // A shell reads a script from a heredoc, a `<<<` string or a pipe from `echo`, `printf` or `cat`.
  if (SHELLS.has(name) && script === null) {
    const fed = seg.pipedIn && prev !== undefined ? fedText(prev) : []
    for (const text of [...seg.stdin.map((s) => s.text), ...fed]) {
      const hit = sub(text)
      if (hit !== null) return hit
    }
  }
  // A variable command word (`$F /`) cannot be read statically; refused when its args could walk.
  const headVariable = name.includes('$') && name !== '$'
    && !(ctx.powershell && (seg.group !== 0 || /[.[(]/.test(name) || args.every((w) => w.text === '}')))
    && !(args.length === 0 && seg.endOp === '|'
      && /^([%?]|[A-Z][A-Za-z]+-[A-Z][A-Za-z]+)$/.test(next?.words[commandIndex(next.words)]?.text ?? ''))
  if (headVariable && (args.length === 0 || anyRoot(args)
    || (root && args.some((w) => isRelativeStart(w.text))))) return refuse('obscured')
  if (script !== null) {
    const hit = sub(script)
    if (hit !== null) return hit
    // A script that leaves a quote open in both readings is not one the check can vouch for.
    const open = scan(script, true, ctx.powershell).open && scan(script, false, ctx.powershell).open
    return open ? refuse('unparsed') : null
  }
  // An xargs command word with a substitution is refused whatever the lister; quoted xargs never gets here.
  if (name === 'xargs' && (seg.substituted || seg.subs.length > 0)) return refuse('xargs')
  if (name === 'xargs') return inspectXargs(args, seg, ctx, depth, root, prev)
  return inspectWalker(name, dir, args, seg, ctx, root, depth)
}

function inspectWalker(
  name: string,
  dir: string,
  args: readonly Word[],
  seg: Segment,
  ctx: WalkContext,
  fromRoot: boolean,
  depth: number,
): WalkRefusal | null {
  switch (name) {
    case 'find':
      return inspectFind(args, dir, seg, ctx, fromRoot, depth)
    case 'fd':
    case 'fdfind':
      return inspectFd(args, fromRoot)
    case 'rg':
      return inspectRg(args, fromRoot)
    case 'grep':
    case 'egrep':
    case 'fgrep':
      return inspectGrep(args, fromRoot)
    case 'du':
      return inspectDu(args, fromRoot)
    case 'tree':
      return inspectTree(args, ctx, fromRoot)
    case 'ls':
    case 'dir':
    case 'gci':
    case 'get-childitem':
      return inspectListing(name, args, ctx, fromRoot)
    case 'findstr':
      return inspectFindstr(args)
    default:
      return EXTRA_WALKERS.has(name) ? inspectRecursive(name, args, fromRoot) : null
  }
}

/** The refusal for a command that starts an unbounded walk of a filesystem root or the home directory, in any pipeline stage, chain or subshell, or null when it does not. A `find` with no path or a `.`-relative one is refused after a `cd` to a root or the home directory; `startsAtRoot` carries that state into a nested `bash -c` script. */
export function detectUnboundedWalk(command: string, ctx: WalkContext, depth = 0, startsAtRoot = false): WalkRefusal | null {
  // Literal backslashes, POSIX escapes (`f\ind`) and, in PowerShell, backticks are all read; any walk refuses.
  const readings: [boolean, boolean][] = [[false, false], [true, false]]
  if (ctx.powershell) readings.push([false, true], [true, true])
  for (const [posix, psEscape] of readings) {
    const hit = walkScan(command, ctx, depth, startsAtRoot, posix, psEscape)
    if (hit !== null) return hit
  }
  return null
}

function walkScan(
  command: string,
  ctx: WalkContext,
  depth: number,
  startsAtRoot: boolean,
  posix: boolean,
  psEscape: boolean,
): WalkRefusal | null {
  // Whether the shell sits in a root or the home directory, per `( ... )` group: a subshell starts from its parent's state and its `cd` does not reach the commands after it.
  const atRoot = new Map<number, boolean>([[0, startsAtRoot]])
  const { segments } = scan(command, posix, psEscape)
  for (const [n, seg] of segments.entries()) {
    if (!atRoot.has(seg.group)) atRoot.set(seg.group, atRoot.get(seg.parentGroup) ?? startsAtRoot)
    const fromRoot = atRoot.get(seg.group)!
    const hit = inspectSegment(seg, ctx, depth, fromRoot, segments[n + 1], segments[n - 1])
    if (hit !== null) return hit
    // A `cd` piped to or from another command, or sent to the background, runs in its own process and leaves the shell where it was; one followed by `||` leaves what follows to run only after it failed.
    const landed = seg.pipedIn || seg.endOp !== '' ? null : cdLandsAtRoot(seg, fromRoot, ctx)
    if (landed !== null) atRoot.set(seg.group, landed)
  }
  return null
}

/** Every command name the guard acts on, so a test can hold hooks_bash.ts's load prefilter to it. */
export const WALK_TRIGGER_NAMES: readonly string[] = [
  ...WALKER_NAMES,
  ...WRAPPER_NAMES,
  ...XARGS_WALKERS.keys(),
  ...EXTRA_WALKERS,
  ...[...SKIPPED_KEYWORDS].filter((k) => !/^(if|then|do|else|elif|while|until)$/.test(k)),
  ...SHELLS,
]
