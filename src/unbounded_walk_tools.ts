/** Per-tool inspectors and nested-script readers for the unbounded-walk guard, split out of unbounded_walk.ts. */
import { refuse, type Segment, type Word, type WalkContext, type WalkRefusal } from './unbounded_walk_scan.js'
import {
  anyRoot, clusterHas, commandIndex, commandName, DU_VALUED, FD_VALUED, GREP_VALUED, isRelativeStart, isRoot,
  LS_VALUED, positionals, PS_LISTING_VALUED, RG_VALUED, texts, TREE_VALUED,
} from './unbounded_walk_words.js'

/** A path operand that starts a walk at a root or home, or none (or `.`) after a `cd` to a root. */
const rootIn = (pos: readonly Word[], fromRoot: boolean, glob = false, winOptions = false): boolean =>
  anyRoot(pos, glob, winOptions) || (fromRoot && pos.some((w) => isRelativeStart(w.text)))
const rootOperand = (pos: readonly Word[], fromRoot: boolean, glob = false, winOptions = false): boolean =>
  rootIn(pos, fromRoot, glob, winOptions) || (fromRoot && pos.length === 0)

// A depth bound is `-d N`, `--max-depth N`, `-LN` or `-Depth N` with ASCII digits; other values are no bound.
export const DIGITS = /^[0-9]+$/
// fd 10.5.0 and rg 15.2.0 (real runs): `-d N`, `-dN`, `-d=N`, `--max-depth`, `--maxdepth`; no abbreviations.
const FD_DEPTH = /^(?:-d(?:=?([0-9]+))?|--(?:max-?depth|exact-depth)(?:=(.*))?)$/
// A long value is never attached without `=`, and only fd has `--exact-depth`.
const RG_DEPTH = /^(?:-d(?:=?([0-9]+))?|--max-?depth(?:=(.*))?)$/
const TREE_DEPTH = /^-[A-Za-z]*L([0-9]+)?$/
const PS_DEPTH = /^-de(?:p(?:t(?:h)?)?)?(?::(.*))?$/i
/** Valued options minus the depth ones: with no valid bound, a depth flag's value is a path operand. */
const withoutDepth = (valued: ReadonlySet<string>): Set<string> =>
  new Set([...valued].filter((x) => !['-d', '--max-depth', '--maxdepth', '--exact-depth', '-L'].includes(x)))
const FD_FREE = withoutDepth(FD_VALUED)
const RG_FREE = withoutDepth(RG_VALUED)
const TREE_FREE = withoutDepth(TREE_VALUED)
function depthBounded(args: readonly Word[], flag: RegExp): boolean {
  return args.some((w, i) => {
    const m = flag.exec(w.text)
    const value = m === null ? undefined : m[1] ?? m[2] ?? args[i + 1]?.text
    return value !== undefined && DIGITS.test(value)
  })
}

export function inspectFd(args: readonly Word[], fromRoot: boolean): WalkRefusal | null {
  if (depthBounded(args, FD_DEPTH)) return null
  const searchPaths = args.filter((w, i) => ['--search-path', '--base-directory'].includes(args[i - 1]?.text ?? '') || /^--(search-path|base-directory)=/.test(w.text)).map((w) => ({ text: w.text.replace(/^--[a-z-]+=/, ''), quoted: w.quoted }))
  const rest = positionals(args, FD_FREE).slice(1)
  return rootOperand(rest, fromRoot) || anyRoot(searchPaths) ? refuse('fd') : null
}

export function inspectRg(args: readonly Word[], fromRoot: boolean): WalkRefusal | null {
  // Policy: `--pre` and `--pre-glob` run a command on every file that this check cannot read; refused.
  if (args.some((w) => /^--pre(-glob)?(=|$)/.test(w.text))) return refuse('rg-pre')
  if (depthBounded(args, RG_DEPTH)) return null
  const t = texts(args)
  const patternGiven = t.some((x) => x === '--files' || x === '-e' || x === '--regexp' || x === '-f' || x === '--file' || /^--(regexp|file)=/.test(x))
  const pos = positionals(args, RG_FREE)
  return rootOperand(patternGiven ? pos : pos.slice(1), fromRoot) ? refuse('rg') : null
}

/** GNU getopt takes any unique prefix of a long option; a word of `min` or more characters that is one. */
const abbreviates = (word: string, full: string, min: number): boolean => {
  const name = word.includes('=') ? word.slice(0, word.indexOf('=')) : word
  return name.length >= min && full.startsWith(name)
}

/** The `-d` / `--directories` action `recurse`, or any abbreviation of it, which GNU grep accepts. */
const RECURSE_ACTION = /^r(e(c(u(r(se?)?)?)?)?)?$/

/** Whether GNU grep recurses: `-r`, `-R`, an abbreviated `--recursive`, or `-d recurse` in any spelling. */
function grepRecurses(t: readonly string[]): boolean {
  return t.some((x, i) => {
    if (x === '--recursive' || x === '--dereference-recursive' || clusterHas(x, 'rR')) return true
    if (abbreviates(x, '--recursive', 3) || abbreviates(x, '--dereference-recursive', 4)) return true
    const next = t[i + 1] ?? ''
    if (abbreviates(x, '--directories', 3)) {
      return RECURSE_ACTION.test(x.includes('=') ? x.slice(x.indexOf('=') + 1) : next)
    }
    const dAt = x.startsWith('-') && !x.startsWith('--') ? x.indexOf('d') : -1
    if (dAt < 1) return false
    const attached = x.slice(dAt + 1).replace(/^=/, '')
    return RECURSE_ACTION.test(attached === '' ? next : attached)
  })
}

export function inspectGrep(args: readonly Word[], fromRoot: boolean): WalkRefusal | null {
  const t = texts(args)
  if (!grepRecurses(t)) return null
  const patternGiven = t.some((x) => x === '-e' || x === '-f' || /^-[A-Za-z]*[ef]$/.test(x)
    || abbreviates(x, '--regexp', 4) || abbreviates(x, '--file', 4))
  const pos = positionals(args, GREP_VALUED)
  return rootOperand(patternGiven ? pos : pos.slice(1), fromRoot) ? refuse('grep') : null
}

// Policy: du reads everything below a root or home operand whatever `-s`, `-d` or `--max-depth` says; refused.
export function inspectDu(args: readonly Word[], fromRoot: boolean): WalkRefusal | null {
  return rootOperand(positionals(args, DU_VALUED), fromRoot, true) ? refuse('du') : null
}

export function inspectTree(args: readonly Word[], ctx: WalkContext, fromRoot: boolean): WalkRefusal | null {
  if (depthBounded(args, TREE_DEPTH)) return null
  const operands = positionals(args, TREE_FREE, ctx.windows)
  return rootOperand(operands, fromRoot, false, ctx.windows) ? refuse('tree') : null
}

/** `ls`, `dir`, `gci` and `Get-ChildItem`: recursive with `-R` (POSIX), `/s` (cmd `dir`) or `-Recurse` and its abbreviations (PowerShell). */
export function inspectListing(
  name: string,
  args: readonly Word[],
  ctx: WalkContext,
  fromRoot: boolean,
): WalkRefusal | null {
  const t = texts(args)
  const psFlavor = name === 'gci' || name === 'get-childitem' || (ctx.powershell && (name === 'ls' || name === 'dir'))
  const psRecurse = psFlavor && t.some((x) => /^-r(e(c(u(r(se?)?)?)?)?)?(:.*)?$/i.test(x))
  const posixRecurse = (name === 'ls' || name === 'dir')
    && t.some((x) => abbreviates(x, '--recursive', 3) || clusterHas(x, 'R'))
  const cmdRecurse = name === 'dir' && ctx.windows && t.some((x) => /^\/s$/i.test(x))
  if (!psRecurse && !posixRecurse && !cmdRecurse) return null
  if (psRecurse && depthBounded(args, PS_DEPTH)) return null
  const pos = positionals(args, name === 'ls' || name === 'dir' ? LS_VALUED : PS_LISTING_VALUED, name === 'dir')
  if (!rootOperand(pos, fromRoot, true, name === 'dir')) return null
  return refuse(psRecurse ? 'gci' : name === 'dir' && cmdRecurse ? 'dir' : 'ls')
}

export function inspectFindstr(args: readonly Word[]): WalkRefusal | null {
  const t = texts(args)
  if (!t.some((x) => /^\/s$/i.test(x))) return null
  const dirList = args.filter((w) => /^\/d:/i.test(w.text)).flatMap((w) => w.text.slice(3).split(';')).map((x) => ({ text: x, quoted: false }))
  const bySearchString = t.some((x) => /^\/[cg]:/i.test(x))
  const pos = positionals(args, new Set(), true)
  return anyRoot(bySearchString ? pos : pos.slice(1), true, true) || anyRoot(dirList, true, true) ? refuse('findstr') : null
}

const POSIX_SHELLS = new Set(['sh', 'ash', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish'])
export const SHELLS = new Set([...POSIX_SHELLS, 'cmd', 'pwsh', 'powershell'])

/** The script a shell wrapper runs (`bash -c`, `cmd /c`, `powershell -Command`), or null when the command is not one. */
export function nestedScript(name: string, args: readonly Word[]): string | null {
  if (POSIX_SHELLS.has(name)) {
    const at = args.findIndex((w) => /^-[A-Za-z]+$/.test(w.text) && w.text.includes('c'))
    if (at < 0 || args[at + 1] === undefined) return null
    // The words after the script are `$0`, `$1`, ...: `sh -c 'find "$1"' _ /` runs `find "/"`.
    const [script, ...params] = args.slice(at + 1).map((w) => w.text)
    return script!.replace(/\$\{?([0-9])\}?|\$[@*]/g, (m, d?: string) =>
      d === undefined ? params.slice(1).join(' ') : (params[Number(d)] ?? m),
    )
  }
  if (name === 'eval') return args.length > 0 ? args.map((w) => w.text).join(' ') : null
  if (name === 'cmd') {
    const at = args.findIndex((w) => /^\/[ck]$/i.test(w.text))
    return at >= 0 ? args.slice(at + 1).map((w) => w.text).join(' ') : null
  }
  if (name === 'powershell' || name === 'pwsh') {
    // `-c` or a prefix of `-Command`; `-e`, `-ec` or a prefix of `-EncodedCommand` carry UTF-16LE base64.
    const psFlag = (t: string, full: string): boolean =>
      /^-[A-Za-z]+$/.test(t) && full.startsWith(t.slice(1).toLowerCase())
    const at = args.findIndex(
      (w) => psFlag(w.text, 'command') || psFlag(w.text, 'encodedcommand') || /^-ec$/i.test(w.text),
    )
    if (at < 0) return null
    const rest = args.slice(at + 1).map((w) => w.text)
    if (psFlag(args[at]!.text, 'command')) return rest.join(' ')
    // A value that is not base64 returns an unterminated quote, which the caller refuses as unparsed.
    const b64 = rest[0] ?? ''
    const valid = /^[A-Za-z0-9+/]+={0,2}$/.test(b64) && b64.length % 4 === 0
    return valid ? Buffer.from(b64, 'base64').toString('utf16le') : "'"
  }
  return null
}

export const WALKER_WORD = new RegExp(
  '(^|[^A-Za-z0-9_-])(fd(find)?|find(str)?|rg|[ef]?grep|du|tree|ls|dir|gci|get-childitem|' +
    'xargs|eval|[zdk]?a?sh|cmd|p(owershell|wsh))(?![A-Za-z0-9_-])',
  'i',
)

/** Past `MAX_NESTING` refuse if quote-stripped text names a walker or shell, or has an expansion. */
export function atNestingLimit(script: string): WalkRefusal | null {
  return /[$`]/.test(script) || WALKER_WORD.test(script.replace(/[\\'"]/g, '')) ? refuse('nesting') : null
}

/** What a command writes to a pipe that a shell on the other end reads as a script. */
export function fedText(prev: Segment, ctx: WalkContext): string[] {
  const at = commandIndex(prev.words, ctx)
  const rest = prev.words.slice(at + 1).map((w) => w.text)
  switch (commandName(prev.words[at]?.text ?? '').name) {
    case 'cat':
      return prev.stdin.map((s) => s.text)
    case 'echo':
      return [rest.filter((x) => !/^-[neE]+$/.test(x)).join(' ')]
    case 'printf':
      return [(rest.length > 1 ? rest.slice(1) : rest).join(' ')]
    default:
      return []
  }
}

/** An `env`'s `-C` / `--chdir` directory and `-S` / `--split-string` script before the command at `end`. */
export function envOptions(
  words: readonly Word[],
  end: number,
): { chdir?: string | undefined; split?: string | undefined } {
  const out: { chdir?: string | undefined; split?: string | undefined } = {}
  const from = words.slice(0, end).findIndex((w) => commandName(w.text).name === 'env')
  for (let i = from + 1; from >= 0 && i < end; i++) {
    const m = /^(-C|--chdir|-S|--split-string)(?:=(.*))?$/.exec(words[i]!.text)
    if (m === null) continue
    if (m[1] === '-C' || m[1] === '--chdir') out.chdir = m[2] ?? words[i + 1]?.text
    else out.split = m[2] ?? words[i + 1]?.text
  }
  return out
}

/** Commands beyond the search tools that read or change all below a root or home operand; depth is no bound. */
export const EXTRA_WALKERS = new Set([
  'where', 'forfiles', 'chmod', 'chown', 'chgrp', 'cp', 'ag', 'ack', 'dust', 'ncdu', 'eza', 'exa',
])
const AG_VALUED = [
  '-G', '--depth', '-A', '-B', '-C', '-m', '--max-count',
  '--ignore', '--ignore-dir', '--pager', '--workers', '-g',
]

export function inspectRecursive(name: string, args: readonly Word[], fromRoot: boolean): WalkRefusal | null {
  const t = texts(args)
  const clusterFlags = name === 'cp' ? 'rRa' : 'R'
  const recursive = t.some(
    (x) => x === '--recursive' || abbreviates(x, '--recursive', 3) || clusterHas(x, clusterFlags),
  )
  const agLike = name === 'ag' || name === 'ack'
  const valued = name === 'cp' ? ['-t', '--target-directory', '-S', '--suffix'] : agLike ? AG_VALUED : []
  const pos = positionals(args, new Set(valued))
  let hit: boolean
  if (name === 'where') {
    const at = t.findIndex((x) => /^\/r$/i.test(x))
    hit = at >= 0 && isRoot(t[at + 1] ?? '', true, true)
  } else if (name === 'forfiles') {
    const at = t.findIndex((x) => /^\/p(:|$)/i.test(x))
    const path = at < 0 ? undefined : t[at]!.length > 2 ? t[at]!.slice(3) : t[at + 1]
    hit = t.some((x) => /^\/s$/i.test(x)) && (path === undefined ? fromRoot : isRoot(path, true, true))
  } else if (name === 'chmod' || name === 'chown' || name === 'chgrp') {
    hit = recursive && rootIn(pos.slice(1), fromRoot)
  } else if (name === 'cp') {
    const targeted = t.some((x) => /^(-t|--target-directory)/.test(x))
    hit = recursive && rootIn(targeted ? pos : pos.slice(0, -1), fromRoot)
  } else if (name === 'ag' || name === 'ack') {
    const noPattern = t.includes('-g') || (name === 'ack' && t.includes('-f'))
    hit = rootOperand(noPattern ? pos : pos.slice(1), fromRoot)
  } else if (name === 'eza' || name === 'exa') {
    const recurses = t.some(
      (x) => clusterHas(x, 'RT') || abbreviates(x, '--recurse', 3) || abbreviates(x, '--tree', 3),
    )
    hit = recurses && rootIn(pos, fromRoot)
  } else hit = rootOperand(pos, fromRoot)
  return hit ? refuse('recurse') : null
}
