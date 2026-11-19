/** Root paths, command words and option tables for the unbounded-walk guard, split out of unbounded_walk.ts. */
import { type Segment, type Word, type WalkContext } from './unbounded_walk_scan.js'

/** True for a filesystem root or the home directory as a start path. A wildcard directly under a drive root (`C:\*.log`) counts when `glob` is set, because `dir /s` and `findstr /s` take it as a search spec. A lone `/x` is a Windows option, not an MSYS drive root, when `winOptions` is set. */
export function isRoot(text: string, glob = false, winOptions = false): boolean {
  if (winOptions && /^\/[A-Za-z]$/.test(text)) return false
  return isRootSpelling(text, glob) || (hasDotSegment(text) && isRootAfterDots(text, glob))
}

const hasDotSegment = (text: string): boolean => /(^|[\\/])\.\.?([\\/]|$)/.test(text)

const HOME_PREFIX =
  String.raw`~[A-Za-z0-9_.-]*|~[+]|\$\{?HOME\}?|\$(?:env:)?(?:USERPROFILE|HOME)|%USERPROFILE%|` +
  String.raw`%HOME(?:DRIVE|PATH)%(?:%HOMEPATH%)?|\$(?:env:)?HOME(?:DRIVE|PATH)(?:\$(?:env:)?HOMEPATH)?|` +
  String.raw`[A-Za-z]:`
const DOTTED_PATH = new RegExp(String.raw`^(?:(/)(.*)|(${HOME_PREFIX})(?:[\\/](.*))?)$`, 'i')

/** A path naming a root once `.` and `..` are resolved (`/.`, `/usr/..`, `~/..`); `..` above home counts. */
function isRootAfterDots(text: string, glob: boolean): boolean {
  const m = DOTTED_PATH.exec(text)
  if (m === null) return false
  const prefix = m[1] ?? m[3]!
  const kept: string[] = []
  for (const part of (m[2] ?? m[4] ?? '').split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    if (part !== '..') kept.push(part)
    else if (kept.length > 0) kept.pop()
    else if (prefix !== '/' && !/^[A-Za-z]:$/.test(prefix)) return true
  }
  return isRootSpelling(prefix === '/' ? '/' + kept.join('/') : prefix + '/' + kept.join('/'), glob)
}

function isRootSpelling(text: string, glob: boolean): boolean {
  if (/^\/+\*?$/.test(text) || /^\/[A-Za-z]\/*$/.test(text)) return true
  if (/^\/(mnt|cygdrive)\/+[A-Za-z]\/*$/i.test(text)) return true
  // `/mnt` and `/cygdrive` hold every drive; a UNC share and `//?/C:/` name a volume; `C:.` is a drive dir.
  if (/^\/(mnt|cygdrive)\/*$/i.test(text) || /^[\\/]{2}[?.][\\/]+[A-Za-z]:[\\/]*$/.test(text)) return true
  if (/^[\\/]{2}[^\\/?.][^\\/]*[\\/]+[^\\/]+[\\/]*$/.test(text) || /^[A-Za-z]:(\.{1,2})?[\\/]*$/.test(text)) {
    return true
  }
  // `/proc/<pid>/root` is the root itself, `//?/UNC/host/share` a share, `/mnt/wsl` and `/Volumes` mounts.
  if (/^\/proc\/+(self|thread-self|[0-9]+)\/+root\/*$/i.test(text)) return true
  if (/^\/mnt\/+wsl\/*$/i.test(text)) return true
  if (/^\/Volumes(\/+[^/]+)?\/*$/i.test(text)) return true
  // `/home` and `/Users` (also under a drive) hold every user's home directory.
  if (/^\/+(home|Users)\/*$/i.test(text)) return true
  const drive = String.raw`(?:[A-Za-z]:|\/(?:mnt|cygdrive)\/+[A-Za-z]|\/[A-Za-z])`
  if (new RegExp(drive + String.raw`[\\/]+(home|Users)[\\/]*$`, 'i').test(text)) return true
  return /^[\\/]{2}[?.][\\/]+UNC[\\/]+[^\\/]+[\\/]+[^\\/]+[\\/]*$/i.test(text) || isHomeOrGlobRoot(text, glob)
}

function isHomeOrGlobRoot(text: string, glob: boolean): boolean {
  // `~` is home and `~name` is that user's home, which the shell expands before the tool sees it.
  if (/^~[A-Za-z0-9_.-]*[\\/]*$/.test(text) || /^\$\{?HOME\}?[\\/]*$/.test(text)) return true
  if (/^\$(env:)?(USERPROFILE|HOME)[\\/]*$/i.test(text) || /^%USERPROFILE%[\\/]*$/i.test(text)) return true
  // The system drive, the profile path, and the two together.
  if (/^%HOME(DRIVE|PATH)%(%HOMEPATH%)?[\\/]*$/i.test(text)) return true
  if (/^\$(env:)?HOME(DRIVE|PATH)(\$(env:)?HOMEPATH)?[\\/]*$/i.test(text)) return true
  return glob && /^[A-Za-z]:[\\/]+[^\\/*?]*[*?][^\\/]*$/.test(text)
}

/** The file name of a command word without its directory or `.exe`, lower-cased, and the directory it came from. */
export function commandName(text: string): { name: string; dir: string } {
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1
  return { name: text.slice(cut).toLowerCase().replace(/\.exe$/, ''), dir: text.slice(0, cut) }
}

export const SKIPPED_KEYWORDS = new Set([
  '{', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until',
  'time', 'command', 'builtin', 'exec', 'nohup', 'setsid', 'call', 'stdbuf', 'busybox',
])
/** The options a wrapper keyword takes before its command: each name lists those with a separate value. */
const KEYWORD_OPTIONS = new Map<string, readonly string[]>([
  ['time', ['-f', '-o', '--format', '--output']], ['command', []], ['exec', ['-a']], ['setsid', []],
  ['stdbuf', ['-i', '-o', '-e', '--input', '--output', '--error']],
])
const ENV_VALUED = ['-u', '-C', '-S', '-P', '-a', '--unset', '--chdir', '--split-string', '--argv0']
const SUDO_VALUED = [
  '-u', '-g', '-C', '-h', '-p', '-U', '-D', '-R', '-T', '--user', '--group', '--host', '--prompt',
  '--chdir', '--chroot', '--role', '--type', '--other-user', '--close-from', '--command-timeout']

/** The index of the command a segment runs, past the words that only prefix it: assignments, keywords, and wrappers such as `sudo`, `env`, `nice`, `timeout` and `wsl`. */
export function commandIndex(words: readonly Word[]): number {
  let i = 0
  const skipOptions = (valued: readonly string[]): void => {
    while (i < words.length && words[i]!.text.startsWith('-')) i += valued.includes(words[i]!.text) ? 2 : 1
  }
  while (i < words.length) {
    const text = words[i]!.text
    const { name } = commandName(text)
    if (/^[A-Za-z_]\w*=/.test(text) || SKIPPED_KEYWORDS.has(name)) {
      i++
      if (KEYWORD_OPTIONS.has(name)) skipOptions(KEYWORD_OPTIONS.get(name)!)
    } else if (/^\$\{?[\w:]+\}?[-+*/%]?=$/.test(text)) {
      // A PowerShell assignment, `$x= cmd`, runs the command that follows it.
      i++
    } else if (/^\$\{?[\w:]+\}?$/.test(text) && /^[-+*/%]?=$/.test(words[i + 1]?.text ?? '')) {
      // A PowerShell assignment, `$x = cmd`.
      i += 2
    } else if (name === 'sudo' || name === 'doas') {
      i++
      skipOptions(SUDO_VALUED)
    } else if (name === 'env') {
      i++
      while (i < words.length && (words[i]!.text.startsWith('-') || words[i]!.text.includes('='))) {
        i += ENV_VALUED.includes(words[i]!.text) ? 2 : 1
      }
    } else if (name === 'nice') {
      i++
      skipOptions(['-n', '--adjustment'])
    } else if (name === 'ionice') {
      i++
      skipOptions(['-c', '-n', '-p', '-P', '-u'])
    } else if (name === 'timeout') {
      i++
      skipOptions(['-s', '-k', '--signal', '--kill-after'])
      if (/^\d/.test(words[i]?.text ?? '')) i++
    } else if (name === 'wsl') {
      i++
      skipOptions(['-d', '--distribution', '-u', '--user', '--cd'])
      if (words[i]?.text === '--') i++
    } else {
      break
    }
  }
  return i
}

/** The arguments that are not options, skipping the value of each option that takes one in its separate-word form. */
export function positionals(args: readonly Word[], valued: ReadonlySet<string>, slashOptions = false): Word[] {
  const out: Word[] = []
  let literal = false
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text
    if (!literal && t === '--') {
      literal = true
      continue
    }
    if (!literal && t.length > 1 && t.startsWith('-')) {
      if (valued.has(t)) i++
      continue
    }
    if (!literal && slashOptions && /^\/[A-Za-z?]+(:.*)?$/.test(t)) continue
    out.push(args[i]!)
  }
  return out
}

const CD_COMMANDS = new Set(['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl'])

/** Whether a directory-changing command leaves the shell in a filesystem root or the home directory (`wasRoot` is where it started, which `cd ..` keeps), or null when the segment changes no directory. `cd -`, `popd` and anything else that lands somewhere unknown count as not a root, so only a visible root target is refused. */
export function cdLandsAtRoot(seg: Segment, wasRoot: boolean, ctx: WalkContext): boolean | null {
  const at = commandIndex(seg.words)
  const head = seg.words[at]
  if (head === undefined) return null
  const { name } = commandName(head.text)
  if (!CD_COMMANDS.has(name)) return null
  const target = positionals(seg.words.slice(at + 1), new Set<string>())[0]
  // A bare `cd` goes home in a POSIX shell, but PowerShell 5.1 only prints the location.
  if (target === undefined) return !ctx.powershell && name !== 'popd' && name !== 'pushd'
  return isRoot(target.text) || (wasRoot && /^\.\.([\\/]\.\.)*[\\/]*$/.test(target.text))
}

/** A find start that is the working directory itself or only steps up from it (`.`, `./`, `..`, `../..`), as opposed to a subdirectory of it. */
export const isRelativeStart = (start: string): boolean => {
  if (/^[\\/~$%]|^[A-Za-z]:/.test(start)) return false
  const kept: string[] = []
  let segments = 0
  for (const part of start.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    segments++
    if (part !== '..') kept.push(part)
    else if (kept.length > 0) kept.pop()
  }
  // Lexical only: the start names the working directory or an ancestor when no named directory is left.
  return kept.length === 0 && (segments > 0 || /^\.[\\/]*$/.test(start))
}

export const texts = (words: readonly Word[]): string[] => words.map((w) => w.text)
export const anyRoot = (words: readonly Word[], glob = false, winOptions = false): boolean => words.some((w) => isRoot(w.text, glob, winOptions))

export const FD_VALUED = new Set(['-d', '--max-depth', '--min-depth', '--exact-depth', '-e', '--extension', '-E', '--exclude', '-t', '--type', '-x', '--exec', '-X', '--exec-batch', '-S', '--size', '-c', '--color', '-j', '--threads', '-o', '--owner', '--changed-within', '--changed-before', '--ignore-file', '--base-directory', '--search-path', '--format', '--max-results'])
export const RG_VALUED = new Set(['-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '--type-add', '--type-clear', '-m', '--max-count', '-A', '-B', '-C', '--after-context', '--before-context', '--context', '-e', '--regexp', '-f', '--file', '-j', '--threads', '-M', '--max-columns', '-d', '--max-depth', '--maxdepth', '-E', '--encoding', '--ignore-file', '-r', '--replace', '--sort', '--sortr', '--pre', '--pre-glob', '--path-separator', '--color', '--colors', '--max-filesize', '--context-separator', '--field-context-separator', '--field-match-separator', '--engine', '--dfa-size-limit', '--regex-size-limit', '--hostname-bin', '--hyperlink-format'])
export const GREP_VALUED = new Set(['-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '-B', '-C', '--after-context', '--before-context', '--context', '-d', '--directories', '-D', '--devices', '--include', '--exclude', '--exclude-dir', '--exclude-from', '--label', '--binary-files'])
export const DU_VALUED = new Set(['-d', '--max-depth', '-B', '--block-size', '-t', '--threshold', '--exclude', '-X', '--exclude-from', '--files0-from', '--time-style', '--time'])
export const TREE_VALUED = new Set(['-L', '-P', '-I', '-o', '--charset', '--filelimit', '--timefmt', '--sort', '--fromfile'])
export const LS_VALUED = new Set(['-I', '--ignore', '-w', '--width', '-T', '--tabsize', '--block-size', '--time', '--time-style', '--sort', '--format', '--color', '--hide', '--indicator-style', '--quoting-style'])
export const PS_LISTING_VALUED = new Set<string>()

/** True when the word is a short-option cluster (`-rn`, `-lR`) holding one of `letters`. */
export function clusterHas(t: string, letters: string): boolean {
  return /^-[A-Za-z0-9]+$/.test(t) && !t.startsWith('--') && [...t.slice(1)].some((c) => letters.includes(c))
}

/** The primaries that take a value, so a `-maxdepth` right after one is that value and no bound. */
export const VALUED_PRIMARY = new RegExp(
  '^-(i?(name|path|wholename|regex|lname)|x?type|newer.*|[acm](time|min)|user|group|perm|size|links|' +
    'inum|fstype|printf|samefile|uid|gid|used|context)$',
)
export const EXEC_PRIMARY = /^-(exec|execdir|ok|okdir)$/
/** Words that end a `-exec` payload: `;`, an escaped `;` (a lone backslash word when read literally), `+`. */
export const EXEC_END = new Set([';', '\\;', '+', '\\'])
