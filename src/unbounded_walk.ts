/** Refuses a shell command that walks a whole filesystem root or the home directory with no depth bound, or that starts the Windows `find.exe` text search with nothing to read, because both outlive a timed-out shell and keep burning CPU. The scanner here is its own because the shared ones lose what this rule reads: `shlexSplit` consumes backslashes (so `C:\` and `C:\Windows\System32\find.exe` stop being paths) and `splitShellSegments` drops which operator joined two commands (a piped `find "x"` reads stdin, a chained one waits on it forever) and does not split a subshell. */

/** Where the command runs: `windows` is a win32 host, `powershell` a harness whose shell tool is PowerShell there (Codex, Copilot CLI), where a bare `find` is the Windows `find.exe` rather than Git's. */
export interface WalkContext {
  readonly windows: boolean
  readonly powershell: boolean
}

export interface WalkRefusal {
  /** Which rule fired, for tests and stats: the command that was refused. */
  readonly form: string
  readonly message: string
}

interface Word {
  readonly text: string
  readonly quoted: boolean
}

interface Segment {
  readonly words: readonly Word[]
  /** The operator before this command was a single `|`. */
  readonly pipedIn: boolean
  /** The command redirects its input with `<`, `<<` or `<<<`. */
  readonly redirectedIn: boolean
  /** The `( ... )` group that encloses the command (0 outside any), and the group around that one, so a `cd` inside a subshell can be told from one that changes the directory of what follows. */
  readonly group: number
  readonly parentGroup: number
  /** The operator that ended this command when a `cd` before it cannot change the directory of what follows: `|` or a single `&` (its own process) or `||` (what follows runs only if the `cd` failed); otherwise an empty string. */
  readonly endOp: '' | '|' | '&' | '||'
}

const MAX_NESTING = 3

/** The cheap way out, appended to every refusal. The last sentence is what stops the retry loop that started this rule: six reworded `find /` runs, each a fresh full-disk walk. */
const ALTERNATIVES =
  " Search the project or a bounded directory instead: `rg --files --max-depth N -g '*name*' <dir>` (in PowerShell also `Get-ChildItem <dir> -Recurse -Depth N`), or `token-goat search \"<query>\"`. If a search timed out with no output, narrow the scope or change the tool; do not rerun a reworded variant."

function walkMessage(tool: string, bound: string, hint: string): string {
  return '`' + tool + '` ' + bound + ', so it walks the whole disk from there. A walk like that keeps running after a timed-out shell is killed and burns CPU for hours, starving every other shell.' + (hint === '' ? '' : ' ' + hint) + ALTERNATIVES
}

const FORMS = {
  find: walkMessage('find', 'starts at a filesystem root or the home directory with no `-maxdepth`', 'Add `-maxdepth N`, or start in the project directory.'),
  fd: walkMessage('fd', 'starts at a filesystem root or the home directory with no `-d`/`--max-depth`', 'Add `-d N`, or start in the project directory.'),
  rg: walkMessage('rg', 'starts at a filesystem root or the home directory with no `--max-depth`', 'Add `--max-depth N`, or start in the project directory.'),
  grep: walkMessage('grep -r', 'starts at a filesystem root or the home directory, and grep has no depth limit', ''),
  ls: walkMessage('ls -R', 'starts at a filesystem root or the home directory, and a recursive listing has no depth limit', 'List one directory, or use `rg --files --max-depth N <dir>`.'),
  du: walkMessage('du', 'starts at a filesystem root or the home directory with no `-d`/`--max-depth`', 'Add `-d N`, or measure a project directory.'),
  tree: walkMessage('tree', 'starts at a filesystem root or the home directory with no `-L`', 'Add `-L N`, or start in the project directory.'),
  dir: walkMessage('dir /s', 'starts at a drive root or the home directory, and has no depth limit', 'List one directory, or use `rg --files --max-depth N <dir>`.'),
  findstr: walkMessage('findstr /s', 'starts at a drive root or the home directory, and has no depth limit', ''),
  gci: walkMessage('Get-ChildItem -Recurse', 'starts at a drive root or the home directory with no `-Depth`', 'Add `-Depth N`, or start in the project directory.'),
  'find-stdin':
    "This is the Windows `find.exe` text search, and with no file argument and no piped input it waits on standard input forever. A hung `find` is left running when its shell is killed, starving every other shell. Give it a file (`find \"text\" file.txt`), pipe text into it (`type file.txt | find \"text\"`), or use `rg \"text\" file.txt`. If a search timed out with no output, narrow the scope or change the tool; do not rerun a reworded variant.",
} as const

type Form = keyof typeof FORMS

function refuse(form: Form): WalkRefusal {
  return { form, message: FORMS[form] }
}

interface Heredoc {
  readonly delim: string
  readonly stripTabs: boolean
}

/** The delimiter of the heredoc whose `<<` ends just before `from`, and the index after it. */
function readHeredocMarker(command: string, from: number): { delim: string; stripTabs: boolean; end: number } {
  let j = from
  let stripTabs = false
  if (command[j] === '-') {
    stripTabs = true
    j++
  }
  while (command[j] === ' ' || command[j] === '\t') j++
  let delim = ''
  let quote: string | null = null
  while (j < command.length) {
    const c = command[j]!
    if (quote !== null) {
      if (c === quote) quote = null
      else delim += c
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c !== '\\') {
      if (/[\s;|&<>()]/.test(c)) break
      delim += c
    }
    j++
  }
  return { delim, stripTabs, end: j }
}

/** The index of the line after the last heredoc terminator, reading each body from `from`. */
function skipHeredocBodies(command: string, from: number, heredocs: readonly Heredoc[]): number {
  let pos = from
  for (const { delim, stripTabs } of heredocs) {
    while (pos < command.length) {
      let eol = command.indexOf('\n', pos)
      if (eol === -1) eol = command.length
      let line = command.slice(pos, eol)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      pos = Math.min(eol + 1, command.length)
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === delim) break
    }
  }
  return pos
}

/** Splits a command on the operators that start a new command, keeping each word's text with backslashes literal, and whether the word was quoted. A redirection (`> f`, `2>&1`, `< f`) is dropped from the words and remembered as redirected input. */
function scan(command: string): Segment[] {
  const segments: Segment[] = []
  let words: Word[] = []
  let text = ''
  let has = false
  let quoted = false
  let quote: string | null = null
  let subshells = 0
  let piped = false
  const groups = [0]
  let groupCount = 0
  const heredocs: Heredoc[] = []
  const quotedHeredocs: Heredoc[] = []
  const endWord = (): void => {
    if (!has) return
    words.push({ text, quoted })
    text = ''
    has = false
    quoted = false
  }
  const endSegment = (nextPiped: boolean, endOp: '' | '|' | '&' | '||' = ''): void => {
    endWord()
    if (words.length > 0) {
      const redirectedIn = words.some((w) => !w.quoted && /^\d*</.test(w.text))
      segments.push({ words: withoutRedirects(words), pipedIn: piped, redirectedIn, group: groups[groups.length - 1]!, parentGroup: groups[groups.length - 2] ?? 0, endOp })
    }
    words = []
    piped = nextPiped
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote !== null) {
      if (quote === '"') {
        // A heredoc inside `"$(cat <<'EOF' ... )"` carries its own quotes as data, so its body is skipped rather than read as quote delimiters.
        if (ch === '$' && command[i + 1] === '(') subshells++
        else if (ch === ')' && subshells > 0) subshells--
        else if (subshells > 0 && ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<' && command[i - 1] !== '<') {
          const marker = readHeredocMarker(command, i + 2)
          if (marker.delim !== '') quotedHeredocs.push({ delim: marker.delim, stripTabs: marker.stripTabs })
          i = marker.end - 1
          continue
        } else if (subshells > 0 && ch === '\n' && quotedHeredocs.length > 0) {
          i = skipHeredocBodies(command, i + 1, quotedHeredocs) - 1
          quotedHeredocs.length = 0
          continue
        }
      }
      if (ch === quote) {
        quote = null
        subshells = 0
        quotedHeredocs.length = 0
      } else text += ch
      continue
    }
    if (ch === '#' && !has) {
      // A word that starts with `#` opens a comment that runs to the end of the line.
      const eol = command.indexOf('\n', i)
      i = (eol === -1 ? command.length : eol) - 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
      quoted = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord()
      continue
    }
    if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<' && command[i - 1] !== '<') {
      const marker = readHeredocMarker(command, i + 2)
      if (marker.delim !== '') heredocs.push({ delim: marker.delim, stripTabs: marker.stripTabs })
      endWord()
      text = '<<H'
      has = true
      endWord()
      i = marker.end - 1
      continue
    }
    if (ch === '\n') {
      endSegment(false)
      // A heredoc body is data for the command that opened it, so a `find /` written inside one is text, not a command.
      if (heredocs.length > 0) {
        i = skipHeredocBodies(command, i + 1, heredocs) - 1
        heredocs.length = 0
      }
      continue
    }
    if (ch === ';' || ch === '`') {
      endSegment(false)
      continue
    }
    if (ch === '(' || ch === ')') {
      endSegment(false)
      if (ch === '(') groups.push(++groupCount)
      else if (groups.length > 1) groups.pop()
      continue
    }
    if (ch === '|') {
      const logicalOr = command[i + 1] === '|'
      endSegment(!logicalOr, logicalOr ? '||' : '|')
      if (logicalOr) i++
      continue
    }
    if (ch === '&') {
      // A redirection's `&` (`2>&1`, `>&2`, `&>f`) belongs to its word; any other starts a new command.
      if (command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>') {
        text += ch
        has = true
        continue
      }
      const andIf = command[i + 1] === '&'
      endSegment(false, andIf ? '' : '&')
      if (andIf) i++
      continue
    }
    text += ch
    has = true
  }
  endSegment(false)
  return segments
}

function withoutRedirects(words: readonly Word[]): Word[] {
  const kept: Word[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (!w.quoted && /^\d*(>>?|<|>&|&>)$/.test(w.text)) {
      i++
      continue
    }
    if (!w.quoted && /^\d*[<>&]/.test(w.text) && /[<>]/.test(w.text)) continue
    kept.push(w)
  }
  return kept
}

/** True for a filesystem root or the home directory as a start path. A wildcard directly under a drive root (`C:\*.log`) counts when `glob` is set, because `dir /s` and `findstr /s` take it as a search spec. A lone `/x` is a Windows option, not an MSYS drive root, when `winOptions` is set. */
function isRoot(text: string, glob = false, winOptions = false): boolean {
  if (winOptions && /^\/[A-Za-z]$/.test(text)) return false
  if (/^\/+\*?$/.test(text) || /^\/[A-Za-z]\/*$/.test(text) || /^\/mnt\/[A-Za-z]\/*$/i.test(text)) return true
  if (/^[A-Za-z]:[\\/]*$/.test(text)) return true
  if (/^~[\\/]*$/.test(text) || /^\$\{?HOME\}?[\\/]*$/.test(text)) return true
  if (/^\$(env:)?(USERPROFILE|HOME)[\\/]*$/i.test(text) || /^%USERPROFILE%[\\/]*$/i.test(text)) return true
  return glob && /^[A-Za-z]:[\\/]+[^\\/*?]*[*?][^\\/]*$/.test(text)
}

/** The file name of a command word without its directory or `.exe`, lower-cased, and the directory it came from. */
function commandName(text: string): { name: string; dir: string } {
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1
  return { name: text.slice(cut).toLowerCase().replace(/\.exe$/, ''), dir: text.slice(0, cut) }
}

const SKIPPED_KEYWORDS = new Set(['{', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time', 'command', 'builtin', 'exec', 'nohup', 'setsid', 'call', 'stdbuf'])

/** The index of the command a segment runs, past the words that only prefix it: assignments, keywords, and wrappers such as `sudo`, `env`, `nice`, `timeout` and `wsl`. */
function commandIndex(words: readonly Word[]): number {
  let i = 0
  const skipOptions = (valued: readonly string[]): void => {
    while (i < words.length && words[i]!.text.startsWith('-')) i += valued.includes(words[i]!.text) ? 2 : 1
  }
  while (i < words.length) {
    const text = words[i]!.text
    const { name } = commandName(text)
    if (/^[A-Za-z_]\w*=/.test(text) || SKIPPED_KEYWORDS.has(name)) {
      i++
      if (name === 'stdbuf') skipOptions([])
    } else if (/^\$\{?[\w:]+\}?[-+*/%]?=$/.test(text)) {
      // A PowerShell assignment, `$x= cmd`, runs the command that follows it.
      i++
    } else if (/^\$\{?[\w:]+\}?$/.test(text) && /^[-+*/%]?=$/.test(words[i + 1]?.text ?? '')) {
      // A PowerShell assignment, `$x = cmd`.
      i += 2
    } else if (name === 'sudo' || name === 'doas') {
      i++
      skipOptions(['-u', '-g', '-C', '-h', '-p', '-U', '-D', '-R', '-T'])
    } else if (name === 'env') {
      i++
      while (i < words.length && (words[i]!.text.startsWith('-') || words[i]!.text.includes('='))) i += words[i]!.text === '-u' ? 2 : 1
    } else if (name === 'nice') {
      i++
      if (words[i]?.text === '-n') i += 2
      else if (/^-\d+$/.test(words[i]?.text ?? '')) i++
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
function positionals(args: readonly Word[], valued: ReadonlySet<string>, slashOptions = false): Word[] {
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
function cdLandsAtRoot(seg: Segment, wasRoot: boolean, ctx: WalkContext): boolean | null {
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
const isRelativeStart = (start: string): boolean => /^\.\.?([\\/]+\.\.?)*[\\/]*$/.test(start)

const texts = (words: readonly Word[]): string[] => words.map((w) => w.text)
const anyRoot = (words: readonly Word[], glob = false, winOptions = false): boolean => words.some((w) => isRoot(w.text, glob, winOptions))

const FD_VALUED = new Set(['-d', '--max-depth', '--min-depth', '--exact-depth', '-e', '--extension', '-E', '--exclude', '-t', '--type', '-x', '--exec', '-X', '--exec-batch', '-S', '--size', '-c', '--color', '-j', '--threads', '-o', '--owner', '--changed-within', '--changed-before', '--ignore-file', '--base-directory', '--search-path', '--format', '--max-results'])
const RG_VALUED = new Set(['-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '--type-add', '--type-clear', '-m', '--max-count', '-A', '-B', '-C', '--after-context', '--before-context', '--context', '-e', '--regexp', '-f', '--file', '-j', '--threads', '-M', '--max-columns', '-d', '--max-depth', '--maxdepth', '-E', '--encoding', '--ignore-file', '-r', '--replace', '--sort', '--sortr', '--pre', '--pre-glob', '--path-separator', '--color', '--colors', '--max-filesize', '--context-separator', '--field-context-separator', '--field-match-separator', '--engine', '--dfa-size-limit', '--regex-size-limit', '--hostname-bin', '--hyperlink-format'])
const GREP_VALUED = new Set(['-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '-B', '-C', '--after-context', '--before-context', '--context', '-d', '--directories', '-D', '--devices', '--include', '--exclude', '--exclude-dir', '--exclude-from', '--label', '--binary-files'])
const DU_VALUED = new Set(['-d', '--max-depth', '-B', '--block-size', '-t', '--threshold', '--exclude', '-X', '--exclude-from', '--files0-from', '--time-style', '--time'])
const TREE_VALUED = new Set(['-L', '-P', '-I', '-o', '--charset', '--filelimit', '--timefmt', '--sort', '--fromfile'])
const LS_VALUED = new Set(['-I', '--ignore', '-w', '--width', '-T', '--tabsize', '--block-size', '--time', '--time-style', '--sort', '--format', '--color', '--hide', '--indicator-style', '--quoting-style'])
const PS_LISTING_VALUED = new Set<string>()

/** True when the word is a short-option cluster (`-rn`, `-lR`) holding one of `letters`. */
function clusterHas(t: string, letters: string): boolean {
  return /^-[A-Za-z0-9]+$/.test(t) && !t.startsWith('--') && [...t.slice(1)].some((c) => letters.includes(c))
}

function inspectFind(args: readonly Word[], dir: string, seg: Segment, ctx: WalkContext, fromRoot: boolean): WalkRefusal | null {
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
  for (let i = 0; i < t.length; i++) {
    const x = t[i]!
    if (x === '-H' || x === '-L' || x === '-P' || /^-O\d$/.test(x)) continue
    if (x === '-D') {
      i++
      continue
    }
    if (x.startsWith('-') || x === '!' || x.startsWith('\\(')) break
    starts.push(x)
  }
  // After `cd /` a find with no path, or a `.`-relative one, starts at that root.
  if ((starts.some((s) => isRoot(s)) || (fromRoot && (starts.length === 0 || starts.some(isRelativeStart)))) && !t.includes('-maxdepth')) return refuse('find')
  // PowerShell runs a bare `find "text"` as the Windows find.exe, which reads standard input when it is given no file.
  const sole = args.length === 1 ? args[0]! : null
  if (ctx.powershell && !primary && !winOption && !qualified && sole !== null && sole.quoted && !seg.pipedIn && !seg.redirectedIn) return refuse('find-stdin')
  return null
}

function inspectFd(args: readonly Word[]): WalkRefusal | null {
  if (args.some((w) => /^(-d\d*|--max-depth(=.*)?|--maxdepth(=.*)?|--exact-depth(=.*)?)$/.test(w.text))) return null
  const searchPaths = args.filter((w, i) => ['--search-path', '--base-directory'].includes(args[i - 1]?.text ?? '') || /^--(search-path|base-directory)=/.test(w.text)).map((w) => ({ text: w.text.replace(/^--[a-z-]+=/, ''), quoted: w.quoted }))
  const rest = positionals(args, FD_VALUED).slice(1)
  return anyRoot(rest) || anyRoot(searchPaths) ? refuse('fd') : null
}

function inspectRg(args: readonly Word[]): WalkRefusal | null {
  if (args.some((w) => /^(--max-?depth(=.*)?|-d\d*)$/.test(w.text))) return null
  const t = texts(args)
  const patternGiven = t.some((x) => x === '--files' || x === '-e' || x === '--regexp' || x === '-f' || x === '--file' || /^--(regexp|file)=/.test(x))
  const pos = positionals(args, RG_VALUED)
  return anyRoot(patternGiven ? pos : pos.slice(1)) ? refuse('rg') : null
}

function inspectGrep(args: readonly Word[]): WalkRefusal | null {
  const t = texts(args)
  const recursive = t.some((x) => x === '--recursive' || x === '--dereference-recursive' || clusterHas(x, 'rR'))
  if (!recursive) return null
  const patternGiven = t.some((x) => x === '-e' || x === '--regexp' || x === '-f' || x === '--file' || /^--(regexp|file)=/.test(x) || /^-[A-Za-z]*[ef]$/.test(x))
  const pos = positionals(args, GREP_VALUED)
  return anyRoot(patternGiven ? pos : pos.slice(1)) ? refuse('grep') : null
}

function inspectDu(args: readonly Word[]): WalkRefusal | null {
  const t = texts(args)
  if (t.some((x) => x === '--summarize' || /^--max-depth(=.*)?$/.test(x) || (/^-[A-Za-z0-9]+$/.test(x) && /^-[A-Za-z]*[ds]/.test(x)))) return null
  return anyRoot(positionals(args, DU_VALUED)) ? refuse('du') : null
}

function inspectTree(args: readonly Word[], ctx: WalkContext): WalkRefusal | null {
  if (texts(args).some((x) => /^-[A-Za-z]*L\d*$/.test(x))) return null
  return anyRoot(positionals(args, TREE_VALUED, ctx.windows), false, ctx.windows) ? refuse('tree') : null
}

/** `ls`, `dir`, `gci` and `Get-ChildItem`: recursive with `-R` (POSIX), `/s` (cmd `dir`) or `-Recurse` and its abbreviations (PowerShell). */
function inspectListing(name: string, args: readonly Word[], ctx: WalkContext): WalkRefusal | null {
  const t = texts(args)
  const psFlavor = name === 'gci' || name === 'get-childitem' || (ctx.powershell && (name === 'ls' || name === 'dir'))
  const psRecurse = psFlavor && t.some((x) => /^-r(e(c(u(r(se?)?)?)?)?)?(:.*)?$/i.test(x))
  const posixRecurse = (name === 'ls' || name === 'dir') && t.some((x) => x === '--recursive' || clusterHas(x, 'R'))
  const cmdRecurse = name === 'dir' && ctx.windows && t.some((x) => /^\/s$/i.test(x))
  if (!psRecurse && !posixRecurse && !cmdRecurse) return null
  if (psRecurse && t.some((x) => /^-de(p(t(h)?)?)?(:.*)?$/i.test(x))) return null
  const pos = positionals(args, name === 'ls' || name === 'dir' ? LS_VALUED : PS_LISTING_VALUED, name === 'dir')
  if (!anyRoot(pos, true, name === 'dir')) return null
  return refuse(psRecurse ? 'gci' : name === 'dir' && cmdRecurse ? 'dir' : 'ls')
}

function inspectFindstr(args: readonly Word[]): WalkRefusal | null {
  const t = texts(args)
  if (!t.some((x) => /^\/s$/i.test(x))) return null
  const dirList = args.filter((w) => /^\/d:/i.test(w.text)).flatMap((w) => w.text.slice(3).split(';')).map((x) => ({ text: x, quoted: false }))
  const bySearchString = t.some((x) => /^\/[cg]:/i.test(x))
  const pos = positionals(args, new Set(), true)
  return anyRoot(bySearchString ? pos : pos.slice(1), true, true) || anyRoot(dirList, true, true) ? refuse('findstr') : null
}

/** The script a shell wrapper runs (`bash -c`, `cmd /c`, `powershell -Command`), or null when the command is not one. */
function nestedScript(name: string, args: readonly Word[]): string | null {
  if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(name)) {
    const at = args.findIndex((w) => /^-[A-Za-z]+$/.test(w.text) && w.text.includes('c'))
    return at >= 0 && args[at + 1] !== undefined ? args[at + 1]!.text : null
  }
  if (name === 'cmd') {
    const at = args.findIndex((w) => /^\/[ck]$/i.test(w.text))
    return at >= 0 ? args.slice(at + 1).map((w) => w.text).join(' ') : null
  }
  if (name === 'powershell' || name === 'pwsh') {
    const at = args.findIndex((w) => /^-(c|command)$/i.test(w.text))
    return at >= 0 ? args.slice(at + 1).map((w) => w.text).join(' ') : null
  }
  return null
}

function inspectSegment(seg: Segment, ctx: WalkContext, depth: number, fromRoot: boolean): WalkRefusal | null {
  const at = commandIndex(seg.words)
  const head = seg.words[at]
  if (head === undefined) return null
  const { name, dir } = commandName(head.text)
  const args = seg.words.slice(at + 1)
  const script = nestedScript(name, args)
  if (script !== null) return depth < MAX_NESTING ? detectUnboundedWalk(script, ctx, depth + 1, fromRoot) : null
  switch (name) {
    case 'find':
      return inspectFind(args, dir, seg, ctx, fromRoot)
    case 'fd':
    case 'fdfind':
      return inspectFd(args)
    case 'rg':
      return inspectRg(args)
    case 'grep':
    case 'egrep':
    case 'fgrep':
      return inspectGrep(args)
    case 'du':
      return inspectDu(args)
    case 'tree':
      return inspectTree(args, ctx)
    case 'ls':
    case 'dir':
    case 'gci':
    case 'get-childitem':
      return inspectListing(name, args, ctx)
    case 'findstr':
      return inspectFindstr(args)
    default:
      return null
  }
}

/** The refusal for a command that starts an unbounded walk of a filesystem root or the home directory, in any pipeline stage, chain or subshell, or null when it does not. A `find` with no path or a `.`-relative one is refused after a `cd` to a root or the home directory; `startsAtRoot` carries that state into a nested `bash -c` script. */
export function detectUnboundedWalk(command: string, ctx: WalkContext, depth = 0, startsAtRoot = false): WalkRefusal | null {
  // Whether the shell sits in a root or the home directory, per `( ... )` group: a subshell starts from its parent's state and its `cd` does not reach the commands after it.
  const atRoot = new Map<number, boolean>([[0, startsAtRoot]])
  for (const seg of scan(command)) {
    if (!atRoot.has(seg.group)) atRoot.set(seg.group, atRoot.get(seg.parentGroup) ?? startsAtRoot)
    const fromRoot = atRoot.get(seg.group)!
    const hit = inspectSegment(seg, ctx, depth, fromRoot)
    if (hit !== null) return hit
    // A `cd` piped to or from another command, or sent to the background, runs in its own process and leaves the shell where it was; one followed by `||` leaves what follows to run only after it failed.
    const landed = seg.pipedIn || seg.endOp !== '' ? null : cdLandsAtRoot(seg, fromRoot, ctx)
    if (landed !== null) atRoot.set(seg.group, landed)
  }
  return null
}
