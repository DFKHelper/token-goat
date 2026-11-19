/** Lister and xargs rule tables for the unbounded-walk guard, split out of unbounded_walk.ts. */
import type { Segment, Word } from './unbounded_walk_scan.js'
import { commandIndex } from './unbounded_walk_words.js'
import { DIGITS } from './unbounded_walk_tools.js'

export const XARGS_VALUED = /^(-[A-Za-z0-9]*[aIdELnPs]|--(arg-file|delimiter|max-args|max-procs))$/
export const STDIN_ROOT: Word = { text: '/', quoted: false }

/** A relative path under the working directory: no leading `/`, `~`, `.` or `-`, no `..` segment, no `:`. */
const PLAIN_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*(\/[A-Za-z0-9_][A-Za-z0-9_.+-]*)*\/?$/
const PLAIN_VALUE = /^[A-Za-z0-9_+][A-Za-z0-9_.+-]*$/
const TYPE_LETTER = /^[a-z]$/
const NAME_VALUE = /^[A-Za-z0-9_.+-]+$/
/** An extension glob (`*.ts`): it expands only to names in the working directory. */
const GLOB_WORD = /^\*\.[A-Za-z0-9]+$/
const GLOB_NAME = /^(?:[A-Za-z0-9_.+-]+|\*\.[A-Za-z0-9]+)$/

/** The flags a bounded lister may carry: exact words, none naming a directory; values match a pattern. */
interface ListerSpec {
  readonly bare: readonly string[]
  readonly valued: ReadonlyMap<string, RegExp>
  /** Whether a lone `.` (the project directory) is a path. */
  readonly dot: boolean
  /** Whether an unquoted glob word (`*.ts`) is a path; it expands to names in the working directory. */
  readonly glob?: boolean
}

const LISTERS: ReadonlyMap<string, ListerSpec> = new Map<string, ListerSpec>([
  ['fd', {
    bare: ['-0', '-H'],
    valued: new Map([['-e', NAME_VALUE], ['-t', TYPE_LETTER], ['-d', DIGITS]]),
    dot: true,
  }],
  ['rg', {
    bare: ['--files', '-0', '-l', '--files-with-matches'],
    valued: new Map([['--max-depth', DIGITS]]),
    dot: true,
  }],
  ['find', {
    bare: ['-print', '-print0'],
    valued: new Map([['-maxdepth', DIGITS], ['-type', TYPE_LETTER], ['-name', GLOB_NAME]]),
    dot: true,
  }],
  ['ls', { bare: ['-1', '-A', '-d'], valued: new Map(), dot: true, glob: true }],
  ['echo', { bare: [], valued: new Map(), dot: false }],
])

const GIT_LS_FILES_FLAGS = ['-z', '-c', '--cached', '-m', '--modified', '-d', '--deleted']
const GIT_DIFF_FLAGS = ['--name-only', '--cached', '--staged', '-z']
const GIT_REVISION = /^[A-Za-z0-9_][A-Za-z0-9_.+/-]*([~^][0-9]*)?$/

/** Whether every word of a lister is a flag from its exact set (with its value) or a plain relative path. */
function listerWordsOk(args: readonly Word[], spec: ListerSpec): boolean {
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text
    if (t.startsWith('-')) {
      const value = spec.valued.get(t)
      if (value !== undefined) {
        const v = args[++i]?.text
        if (v === undefined || !value.test(v)) return false
      } else if (!spec.bare.includes(t)) return false
    } else if (PLAIN_PATH.test(t) || (spec.dot && t === '.') || (spec.glob === true && GLOB_WORD.test(t))) {
      continue
    } else return false
  }
  return true
}

/** Rule 1: the whole left side of the pipe is one plain command from a short list, with nothing unreadable. */
function isBoundedLister(left: Segment): boolean {
  const head = left.words[0]
  if (head === undefined || left.redirectedIn || left.pipedIn || left.endOp !== '|') return false
  if (commandIndex(left.words) !== 0) return false
  const args = left.words.slice(1)
  // The one backslash allowed is the printf format `%s\n`, checked below as a whole word.
  const read = head.text === 'printf' ? args.slice(1) : args
  // A glob is read only as an unquoted `ls` word or a quoted `find -name` value, where it names no root.
  const globOk = (i: number): boolean => head.text === 'ls'
    ? !read[i]!.quoted && GLOB_WORD.test(read[i]!.text)
    : head.text === 'find' && read[i]!.quoted && read[i - 1]?.text === '-name' && GLOB_NAME.test(read[i]!.text)
  if (read.some((w, i) => /[$`*?[\]{}\\<>&|;()]/.test(w.text) && !globOk(i))) return false
  switch (head.text) {
    case 'git': {
      if (args[0]?.text === 'ls-files') return args.slice(1).every((w) => GIT_LS_FILES_FLAGS.includes(w.text))
      if (args[0]?.text !== 'diff' || !args.some((w) => w.text === '--name-only')) return false
      return args.slice(1).every(
        (w) => GIT_DIFF_FLAGS.includes(w.text) || (!w.text.startsWith('-') && GIT_REVISION.test(w.text)),
      )
    }
    case 'printf': {
      const format = args[0]?.text
      return (format === '%s\\n' || format === '%s\\0') && args.slice(1).every((w) => PLAIN_PATH.test(w.text))
    }
    case 'rg':
      return args.some((w) => ['--files', '-l', '--files-with-matches'].includes(w.text))
        && listerWordsOk(args, LISTERS.get('rg')!)
    default: {
      const spec = LISTERS.get(head.text)
      return spec !== undefined && listerWordsOk(args, spec)
    }
  }
}

/** Rule 3: only an exact set of short xargs options; the words from the first non-option on are the command. */
export function xargsCommand(args: readonly Word[]): { words: readonly Word[]; replace: string | null } | null {
  let i = 0
  let replace: string | null = null
  while (i < args.length && args[i]!.text.startsWith('-')) {
    const t = args[i]!.text
    const value = args[i + 1]?.text ?? ''
    const attached = /^(?:-I|--replace=)(.+)$/.exec(t)?.[1]
    const flagOnly = new RegExp(
      '^(-0|-r|-t|--null|--no-run-if-empty|--verbose|-[nPL][0-9]+|--max-(args|procs|lines)=[0-9]+)$',
    )
    if (flagOnly.test(t)) i += 1
    else if ((t === '-n' || t === '-P' || t === '-L') && DIGITS.test(value)) i += 2
    else if (t === '-d' && /^(\\[n0]|[A-Za-z0-9,;])$/.test(value)) i += 2
    else if (attached !== undefined && XARGS_REPLACE.test(attached)) {
      replace = attached
      i += 1
    } else if (t === '-I' && XARGS_REPLACE.test(value)) {
      replace = value
      i += 2
    } else return null
  }
  return { words: args.slice(i), replace }
}

/** The replace string of `-I`: plain characters and braces, which stands for one name from the lister. */
const XARGS_REPLACE = /^[A-Za-z0-9_{}@%+-]+$/

/** The command names the direct-form guard (`inspectWalker`) treats as a walker, plus `vdir`. */
export const WALKER_NAMES = [
  'find', 'fd', 'fdfind', 'du', 'tree', 'ls', 'dir', 'vdir', 'gci', 'get-childitem', 'findstr',
  'rg', 'grep', 'egrep', 'fgrep',
]
/** Shells and wrappers that run another command, so a walker can hide behind them, whatever the script says. */
export const WRAPPER_NAMES = [
  'sh', 'ash', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'pwsh', 'powershell', 'cmd', 'env',
  'nice', 'time', 'command', 'busybox', 'sudo', 'doas', 'nohup', 'timeout', 'xargs', 'eval', 'exec',
  'builtin', 'setsid', 'stdbuf', 'ionice', 'wsl', 'call',
]
export const WALKER_FAMILY: ReadonlySet<string> = new Set([...WALKER_NAMES, ...WRAPPER_NAMES])
export const XARGS_SHELL_NAMES = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'eval', 'cmd', 'powershell', 'pwsh'])
/** An xargs option that reads the list from a file: `-a`, `-a<file>`, a cluster with it, or any `--a...`. */
export const XARGS_FILE_OPTION = /^(-[A-Za-z0-9]*a|-a.*|--a.*)$/
export const PLAIN_COMMAND = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/
export const PLAIN_COMMAND_DIR = /^[A-Za-z0-9_.+/:~-]*$/

/** What a walker may carry under xargs behind a proven lister: exact flags, valued flags, cluster letters. */
interface WalkerSpec {
  readonly bare: readonly string[]
  readonly valued: ReadonlyMap<string, RegExp>
  /** A short cluster (`-rn`) is allowed when every letter is one of these. */
  readonly letters: string
  /** Pattern words allowed when no `--files` or `-e` already gives the pattern. */
  readonly words: number
}

const PATTERN_WORD = /^[A-Za-z0-9_.+](?:[A-Za-z0-9_. +-]|\\[|()])*$/
const CONTEXT_FLAGS: ReadonlyArray<readonly [string, RegExp]> = [
  ['-m', DIGITS], ['-A', DIGITS], ['-B', DIGITS], ['-C', DIGITS], ['-e', PATTERN_WORD],
]
const GREP_SPEC: WalkerSpec = {
  bare: ['--recursive'], valued: new Map(CONTEXT_FLAGS), letters: 'rRnilwFvcHhIEsq', words: 1,
}

export const XARGS_WALKERS: ReadonlyMap<string, WalkerSpec> = new Map<string, WalkerSpec>([
  ['find', {
    bare: ['-print', '-print0', '-empty'],
    valued: new Map([
      ['-maxdepth', DIGITS], ['-mindepth', DIGITS], ['-type', TYPE_LETTER], ['-name', NAME_VALUE],
      ['-iname', NAME_VALUE],
    ]),
    letters: '',
    words: 0,
  }],
  ['du', {
    bare: ['--summarize', '--human-readable', '--total', '--all', '--apparent-size', '--si', '--bytes'],
    valued: new Map([
      ['-d', DIGITS], ['--max-depth', DIGITS], ['-B', PLAIN_VALUE], ['--block-size', PLAIN_VALUE],
      ['-t', PLAIN_VALUE], ['--threshold', PLAIN_VALUE],
    ]),
    letters: 'shcakmbxS0',
    words: 0,
  }],
  ['tree', {
    bare: ['--noreport', '--dirsfirst'],
    valued: new Map([['-L', DIGITS], ['--filelimit', DIGITS]]),
    letters: 'adfipsughDFQrtvxnC',
    words: 0,
  }],
  ['ls', {
    bare: ['--all', '--almost-all', '--human-readable', '--directory', '--recursive'],
    valued: new Map(),
    letters: 'laA1dhtSFRrsin',
    words: 0,
  }],
  ['rg', {
    bare: ['--files', '-0', '--no-heading'],
    valued: new Map([...CONTEXT_FLAGS, ['--max-depth', DIGITS], ['-t', NAME_VALUE]]),
    letters: 'lniwFcHIsSvq',
    words: 1,
  }],
  ['grep', GREP_SPEC],
  ['egrep', GREP_SPEC],
  ['fgrep', GREP_SPEC],
])

/** Whether a short cluster (`-rn`) is made only of the given single letters. */
const clusterOf = (t: string, letters: string): boolean =>
  /^-[A-Za-z0-9]+$/.test(t) && [...t.slice(1)].every((c) => letters.includes(c))

/** Rule 4: a bare walker name with exact flags (and their values) only: no path, no placeholder. */
export function walkerWithFlagsOnly(command: readonly Word[], spec: WalkerSpec, replace: string | null): boolean {
  let words = 0
  let patternGiven = false
  for (let i = 1; i < command.length; i++) {
    const t = command[i]!.text
    // The `-I` replace string stands for one plain name from the proven lister.
    if (t === replace) continue
    const eq = t.startsWith('--') ? t.indexOf('=') : -1
    const key = eq > 0 ? t.slice(0, eq) : t
    const value = spec.valued.get(key)
    if (value !== undefined) {
      const v = eq > 0 ? t.slice(eq + 1) : command[++i]?.text
      if (v === undefined || !value.test(v)) return false
      if (key === '-e') patternGiven = true
    } else if (spec.bare.includes(t)) patternGiven ||= t === '--files'
    else if (t.startsWith('-')) {
      if (!clusterOf(t, spec.letters)) return false
    } else if (!PATTERN_WORD.test(t) || ++words > spec.words) return false
  }
  return !(patternGiven && words > 0)
}

const GREP_SAFE_LETTERS = 'nilcHhvwEFqso'
const LS_SAFE_LETTERS = 'laA1dhtSF'

/** The two walker-family commands that stay allowed with an unproven lister, since neither can recurse. */
export function nonRecursiveUnderUnprovenLister(command: readonly Word[]): boolean {
  const name = command[0]!.text
  if (name === 'ls') return command.slice(1).every((w) => clusterOf(w.text, LS_SAFE_LETTERS))
  if (name !== 'grep' && name !== 'egrep' && name !== 'fgrep') return false
  let words = 0
  let patternGiven = false
  for (let i = 1; i < command.length; i++) {
    const t = command[i]!.text
    if (t === '-e') {
      const v = command[++i]?.text
      if (v === undefined || !PATTERN_WORD.test(v) || patternGiven) return false
      patternGiven = true
    } else if (t.startsWith('-')) {
      if (!clusterOf(t, GREP_SAFE_LETTERS)) return false
    } else if (!PATTERN_WORD.test(t) || ++words > 1) return false
  }
  return patternGiven ? words === 0 : words === 1
}

/** Rules 1, 2 and 5: stdin is one plain bounded lister of this group, the shell is not at a root, no `<`. */
export function listerProven(
  seg: Segment,
  prev: Segment | undefined,
  fromRoot: boolean,
  bareCommand = false,
): boolean {
  if (!seg.pipedIn || fromRoot || seg.redirectedIn) return false
  if (prev === undefined || prev.group !== seg.group) return false
  if (bareCommand && isNameLister(prev)) return false
  return !seg.words.some((w) => !w.quoted && /</.test(w.text)) && isBoundedLister(prev)
}

/** A lister naming files by glob or content (`ls *.ts`, `rg -l`); a walker with no operand stays refused. */
function isNameLister(left: Segment): boolean {
  const listsByName = (t: string): boolean => /[*?]/.test(t) || t === '-l' || t === '--files-with-matches'
  return left.words.slice(1).some((w) => listsByName(w.text))
}
