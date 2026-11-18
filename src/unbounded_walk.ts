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
  /** Standard-input text from a heredoc body or a `<<<` string; `literal` marks it unexpanded. */
  readonly stdin: { text: string; literal: boolean }[]
  /** Scripts run to build a word or heredoc body: the inside of `$(...)` and backticks in double quotes. */
  readonly subs: string[]
}

const MAX_NESTING = 3

/** The cheap way out, appended to every refusal. The last sentence is what stops the retry loop that started this rule: six reworded `find /` runs, each a fresh full-disk walk. */
const ALTERNATIVES =
  " Search the project or a bounded directory instead: `rg --files --max-depth N -g '*name*' <dir>` (in PowerShell also `Get-ChildItem <dir> -Recurse -Depth N`), or `token-goat search \"<query>\"`. If a search timed out with no output, narrow the scope or change the tool; do not rerun a reworded variant."

function walkMessage(tool: string, bound: string, hint: string): string {
  return '`' + tool + '` ' + bound + ', so it walks the whole disk from there. A walk like that keeps running after a timed-out shell is killed and burns CPU for hours, starving every other shell.' + (hint === '' ? '' : ' ' + hint) + ALTERNATIVES
}

function unreadable(why: string, fix: string): string {
  return why + ', so it may walk a filesystem root or the home directory with no depth bound, ' +
    'which burns CPU for hours after a timed-out shell is killed. ' + fix +
    ', with a depth bound.' + ALTERNATIVES
}

const FORMS = {
  find: walkMessage('find', 'starts at a filesystem root or the home directory with no `-maxdepth`', 'Add `-maxdepth N`, or start in the project directory.'),
  fd: walkMessage('fd', 'starts at a filesystem root or the home directory with no `-d`/`--max-depth`', 'Add `-d N`, or start in the project directory.'),
  rg: walkMessage('rg', 'starts at a filesystem root or the home directory with no `--max-depth`', 'Add `--max-depth N`, or start in the project directory.'),
  grep: walkMessage('grep -r', 'starts at a filesystem root or the home directory, and grep has no depth limit', ''),
  ls: walkMessage('ls -R', 'starts at a filesystem root or the home directory, and a recursive listing has no depth limit', 'List one directory, or use `rg --files --max-depth N <dir>`.'),
  du: walkMessage(
    'du',
    'starts at a filesystem root or the home directory and reads everything below it, ' +
      'whatever `-s` or `-d` says',
    'Measure a project directory.',
  ),
  tree: walkMessage('tree', 'starts at a filesystem root or the home directory with no `-L`', 'Add `-L N`, or start in the project directory.'),
  dir: walkMessage('dir /s', 'starts at a drive root or the home directory, and has no depth limit', 'List one directory, or use `rg --files --max-depth N <dir>`.'),
  findstr: walkMessage('findstr /s', 'starts at a drive root or the home directory, and has no depth limit', ''),
  gci: walkMessage('Get-ChildItem -Recurse', 'starts at a drive root or the home directory with no `-Depth`', 'Add `-Depth N`, or start in the project directory.'),
  nesting: unreadable('Shells are nested deeper than the walk check follows', 'Run the inner command directly'),
  obscured: unreadable('The command word is a variable or expansion', 'Write the command name out'),
  unparsed: unreadable('The inner command of a shell wrapper does not parse', 'Write it so it parses'),
  'rg-pre': unreadable(
    '`rg --pre` and `--pre-glob` run a command the check cannot read on every file',
    'Drop the option',
  ),
  recurse: walkMessage(
    'This recursive command',
    'starts at a filesystem root or the home directory and reads everything below it',
    'Name a project directory instead.',
  ),
  xargs: walkMessage(
    'xargs',
    'takes its start paths from standard input, which can be a filesystem root, with no depth bound',
    'Name the directory and add a depth bound, or pipe a bounded lister in (`git ls-files | xargs du -h`).',
  ),
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
  /** The delimiter was quoted or escaped, so the body is plain text: the shell expands nothing in it. */
  readonly literal: boolean
}

/** The delimiter of the heredoc whose `<<` ends just before `from`, and the index after it. */
function readHeredocMarker(
  command: string,
  from: number,
): { delim: string; stripTabs: boolean; end: number; literal: boolean } {
  let j = from
  let literal = false
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
      literal = true
    } else if (c !== '\\') {
      if (/[\s;|&<>()]/.test(c)) break
      delim += c
    } else literal = true
    j++
  }
  return { delim, stripTabs, end: j, literal }
}

/** The index of the line after the last heredoc terminator, reading each body from `from`. */
function skipHeredocBodies(
  command: string,
  from: number,
  heredocs: readonly Heredoc[],
  bodies: string[] = [],
): number {
  let pos = from
  for (const { delim, stripTabs } of heredocs) {
    const start = pos
    while (pos < command.length) {
      let eol = command.indexOf('\n', pos)
      if (eol === -1) eol = command.length
      let line = command.slice(pos, eol)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      pos = Math.min(eol + 1, command.length)
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === delim) break
    }
    bodies.push(command.slice(start, pos))
  }
  return pos
}

/** The scripts of the command substitutions (`$(...)` and backticks) in text a shell expands. */
function substitutions(text: string): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      out.push(text.slice(i + 1, end < 0 ? undefined : end))
      i = end < 0 ? text.length : end
    } else if (text[i] === '$' && text[i + 1] === '(') {
      let open = 1
      let j = i + 2
      for (; j < text.length && open > 0; j++) open += text[j] === '(' ? 1 : text[j] === ')' ? -1 : 0
      out.push(text.slice(i + 2, open === 0 ? j - 1 : j))
      i = j - 1
    }
  }
  return out
}

/** Split into statements of words; `posix` decodes backslash escapes, else literal (Windows paths). */
function scan(command: string, posix: boolean, psEscape: boolean): { segments: Segment[]; open: boolean } {
  const segments: Segment[] = []
  const owners: Segment[] = []
  let subs: string[] = []
  let dqFrom = 0
  let ansi = false
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
      const stdin: Segment['stdin'] = []
      words.forEach((w, k) => {
        if (w.quoted) return
        const here =
          w.text === '<<<' ? words[k + 1]?.text : w.text.startsWith('<<<') ? w.text.slice(3) : undefined
        if (here !== undefined) stdin.push({ text: here, literal: false })
      })
      const seg: Segment = {
        words: withoutRedirects(words),
        pipedIn: piped,
        redirectedIn,
        group: groups[groups.length - 1]!,
        parentGroup: groups[groups.length - 2] ?? 0,
        endOp,
        stdin,
        subs,
      }
      subs = []
      segments.push(seg)
      for (const w of words) if (!w.quoted && w.text === '<<H') owners.push(seg)
    }
    words = []
    piped = nextPiped
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote !== null) {
      if (psEscape && quote === '"' && ch === '`' && i + 1 < command.length) {
        text += command[++i]!
        continue
      }
      if (posix && ch === '\\' && i + 1 < command.length
        && (ansi || (quote === '"' && '$`"\\'.includes(command[i + 1]!)))) {
        // `$'...'` escapes are not decoded: the word is unknown, which a `$` in a command word reports.
        text += ansi ? '$' : command[i + 1]!
        i++
        continue
      }
      if (quote === '"') {
        // A heredoc inside `"$(cat <<'EOF' ... )"` carries its own quotes as data, so its body is skipped rather than read as quote delimiters.
        if (ch === '$' && command[i + 1] === '(') subshells++
        else if (ch === ')' && subshells > 0) subshells--
        else if (subshells > 0 && ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<' && command[i - 1] !== '<') {
          const marker = readHeredocMarker(command, i + 2)
          if (marker.delim !== '') {
            quotedHeredocs.push({ delim: marker.delim, stripTabs: marker.stripTabs, literal: marker.literal })
          }
          i = marker.end - 1
          continue
        } else if (subshells > 0 && ch === '\n' && quotedHeredocs.length > 0) {
          i = skipHeredocBodies(command, i + 1, quotedHeredocs) - 1
          quotedHeredocs.length = 0
          continue
        }
      }
      if (ch === quote) {
        if (quote === '"') subs.push(...substitutions(text.slice(dqFrom)))
        quote = null
        ansi = false
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
    if (posix && ch === '\\' && i + 1 < command.length) {
      // An escaped character is a plain one in the word, and an escaped newline joins the lines.
      i++
      if (command[i] !== '\n') text += command[i]!
      has = true
      continue
    }
    if (ch === '$' && (command[i + 1] === "'" || command[i + 1] === '"')) {
      quote = command[i + 1]!
      ansi = posix && quote === "'"
      dqFrom = text.length
      i++
      has = true
      quoted = true
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      dqFrom = text.length
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
      if (marker.delim !== '') {
        heredocs.push({ delim: marker.delim, stripTabs: marker.stripTabs, literal: marker.literal })
      }
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
        const bodies: string[] = []
        i = skipHeredocBodies(command, i + 1, heredocs, bodies) - 1
        heredocs.forEach((h, k) => {
          owners[k]?.stdin.push({ text: bodies[k]!, literal: h.literal })
          if (!h.literal) owners[k]?.subs.push(...substitutions(bodies[k]!))
        })
        heredocs.length = 0
        owners.length = 0
      }
      continue
    }
    if (psEscape && ch === '`' && i + 1 < command.length) {
      // In PowerShell a backtick escapes the next character or line break; it never splits or ends a word.
      i++
      if (command[i] === '\r' && command[i + 1] === '\n') i++
      else if (command[i] !== '\n') text += command[i]!
      has ||= command[i] !== '\n'
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
  if (quote === '"') subs.push(...substitutions(text.slice(dqFrom)))
  endSegment(false)
  return { segments, open: quote !== null }
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
  return isRootSpelling(text, glob) || (hasDotSegment(text) && isRootAfterDots(text, glob))
}

const hasDotSegment = (text: string): boolean => /(^|[\\/])\.\.?([\\/]|$)/.test(text)

const HOME_PREFIX =
  String.raw`~[A-Za-z0-9_.-]*|~[+]|\$\{?HOME\}?|\$(?:env:)?(?:USERPROFILE|HOME)|%USERPROFILE%|[A-Za-z]:`
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
  return /^[\\/]{2}[?.][\\/]+UNC[\\/]+[^\\/]+[\\/]+[^\\/]+[\\/]*$/i.test(text) || isHomeOrGlobRoot(text, glob)
}

function isHomeOrGlobRoot(text: string, glob: boolean): boolean {
  // `~` is home and `~name` is that user's home, which the shell expands before the tool sees it.
  if (/^~[A-Za-z0-9_.-]*[\\/]*$/.test(text) || /^\$\{?HOME\}?[\\/]*$/.test(text)) return true
  if (/^\$(env:)?(USERPROFILE|HOME)[\\/]*$/i.test(text) || /^%USERPROFILE%[\\/]*$/i.test(text)) return true
  return glob && /^[A-Za-z]:[\\/]+[^\\/*?]*[*?][^\\/]*$/.test(text)
}

/** The file name of a command word without its directory or `.exe`, lower-cased, and the directory it came from. */
function commandName(text: string): { name: string; dir: string } {
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1
  return { name: text.slice(cut).toLowerCase().replace(/\.exe$/, ''), dir: text.slice(0, cut) }
}

const SKIPPED_KEYWORDS = new Set([
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

/** The primaries that take a value, so a `-maxdepth` right after one is that value and no bound. */
const VALUED_PRIMARY = new RegExp(
  '^-(i?(name|path|wholename|regex|lname)|x?type|newer.*|[acm](time|min)|user|group|perm|size|links|' +
    'inum|fstype|printf|samefile|uid|gid|used|context)$',
)
const EXEC_PRIMARY = /^-(exec|execdir|ok|okdir)$/
/** Words that end a `-exec` payload: `;`, an escaped `;` (a lone backslash word when read literally), `+`. */
const EXEC_END = new Set([';', '\\;', '+', '\\'])

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

/** A path operand that starts a walk at a root or home, or none (or `.`) after a `cd` to a root. */
const rootIn = (pos: readonly Word[], fromRoot: boolean, glob = false, winOptions = false): boolean =>
  anyRoot(pos, glob, winOptions) || (fromRoot && pos.some((w) => isRelativeStart(w.text)))
const rootOperand = (pos: readonly Word[], fromRoot: boolean, glob = false, winOptions = false): boolean =>
  rootIn(pos, fromRoot, glob, winOptions) || (fromRoot && pos.length === 0)

const DIGITS = /^[0-9]+$/
// A depth bound is `-d N`, `--max-depth N`, `-LN` or `-Depth N` with ASCII digits; other values are no bound.
const FD_DEPTH = /^(?:-d|--max-?depth|--exact-depth)(?:=(.*)|([0-9]+))?$/
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

function inspectFd(args: readonly Word[], fromRoot: boolean): WalkRefusal | null {
  if (depthBounded(args, FD_DEPTH)) return null
  const searchPaths = args.filter((w, i) => ['--search-path', '--base-directory'].includes(args[i - 1]?.text ?? '') || /^--(search-path|base-directory)=/.test(w.text)).map((w) => ({ text: w.text.replace(/^--[a-z-]+=/, ''), quoted: w.quoted }))
  const rest = positionals(args, FD_FREE).slice(1)
  return rootOperand(rest, fromRoot) || anyRoot(searchPaths) ? refuse('fd') : null
}

function inspectRg(args: readonly Word[], fromRoot: boolean): WalkRefusal | null {
  // Policy: `--pre` and `--pre-glob` run a command on every file that this check cannot read; refused.
  if (args.some((w) => /^--pre(-glob)?(=|$)/.test(w.text))) return refuse('rg-pre')
  if (depthBounded(args, FD_DEPTH)) return null
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

function inspectGrep(args: readonly Word[], fromRoot: boolean): WalkRefusal | null {
  const t = texts(args)
  if (!grepRecurses(t)) return null
  const patternGiven = t.some((x) => x === '-e' || x === '-f' || /^-[A-Za-z]*[ef]$/.test(x)
    || abbreviates(x, '--regexp', 4) || abbreviates(x, '--file', 4))
  const pos = positionals(args, GREP_VALUED)
  return rootOperand(patternGiven ? pos : pos.slice(1), fromRoot) ? refuse('grep') : null
}

// Policy: du reads everything below a root or home operand whatever `-s`, `-d` or `--max-depth` says; refused.
function inspectDu(args: readonly Word[], fromRoot: boolean): WalkRefusal | null {
  return rootOperand(positionals(args, DU_VALUED), fromRoot, true) ? refuse('du') : null
}

function inspectTree(args: readonly Word[], ctx: WalkContext, fromRoot: boolean): WalkRefusal | null {
  if (depthBounded(args, TREE_DEPTH)) return null
  const operands = positionals(args, TREE_FREE, ctx.windows)
  return rootOperand(operands, fromRoot, false, ctx.windows) ? refuse('tree') : null
}

/** `ls`, `dir`, `gci` and `Get-ChildItem`: recursive with `-R` (POSIX), `/s` (cmd `dir`) or `-Recurse` and its abbreviations (PowerShell). */
function inspectListing(
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

function inspectFindstr(args: readonly Word[]): WalkRefusal | null {
  const t = texts(args)
  if (!t.some((x) => /^\/s$/i.test(x))) return null
  const dirList = args.filter((w) => /^\/d:/i.test(w.text)).flatMap((w) => w.text.slice(3).split(';')).map((x) => ({ text: x, quoted: false }))
  const bySearchString = t.some((x) => /^\/[cg]:/i.test(x))
  const pos = positionals(args, new Set(), true)
  return anyRoot(bySearchString ? pos : pos.slice(1), true, true) || anyRoot(dirList, true, true) ? refuse('findstr') : null
}

const POSIX_SHELLS = new Set(['sh', 'ash', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish'])
const SHELLS = new Set([...POSIX_SHELLS, 'cmd', 'pwsh', 'powershell'])

/** The script a shell wrapper runs (`bash -c`, `cmd /c`, `powershell -Command`), or null when the command is not one. */
function nestedScript(name: string, args: readonly Word[]): string | null {
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

const WALKER_WORD = new RegExp(
  '(^|[^A-Za-z0-9_-])(fd(find)?|find(str)?|rg|[ef]?grep|du|tree|ls|dir|gci|get-childitem|' +
    'xargs|eval|[zdk]?a?sh|cmd|p(owershell|wsh))(?![A-Za-z0-9_-])',
  'i',
)

/** Past `MAX_NESTING` refuse if quote-stripped text names a walker or shell, or has an expansion. */
function atNestingLimit(script: string): WalkRefusal | null {
  return /[$`]/.test(script) || WALKER_WORD.test(script.replace(/[\\'"]/g, '')) ? refuse('nesting') : null
}

const XARGS_VALUED = /^(-[A-Za-z0-9]*[aIdELnPs]|--(arg-file|delimiter|max-args|max-procs))$/
const STDIN_ROOT: Word = { text: '/', quoted: false }

/** A relative path under the working directory: no leading `/`, `~`, `.` or `-`, no `..` segment, no `:`. */
const PLAIN_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*(\/[A-Za-z0-9_][A-Za-z0-9_.+-]*)*\/?$/
const PLAIN_VALUE = /^[A-Za-z0-9_+][A-Za-z0-9_.+-]*$/
const TYPE_LETTER = /^[a-z]$/
const NAME_VALUE = /^[A-Za-z0-9_.+-]+$/

/** The flags a bounded lister may carry: exact words, none naming a directory; values match a pattern. */
interface ListerSpec {
  readonly bare: readonly string[]
  readonly valued: ReadonlyMap<string, RegExp>
  /** Whether a lone `.` (the project directory) is a path. */
  readonly dot: boolean
}

const LISTERS: ReadonlyMap<string, ListerSpec> = new Map<string, ListerSpec>([
  ['fd', {
    bare: ['-0', '-H'],
    valued: new Map([['-e', NAME_VALUE], ['-t', TYPE_LETTER], ['-d', DIGITS]]),
    dot: true,
  }],
  ['rg', { bare: ['--files', '-0'], valued: new Map([['--max-depth', DIGITS]]), dot: true }],
  ['find', {
    bare: ['-print', '-print0'],
    valued: new Map([['-maxdepth', DIGITS], ['-type', TYPE_LETTER], ['-name', NAME_VALUE]]),
    dot: true,
  }],
  ['ls', { bare: ['-1', '-A', '-d'], valued: new Map(), dot: true }],
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
    } else if (!PLAIN_PATH.test(t) && !(spec.dot && t === '.')) return false
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
  if (read.some((w) => /[$`*?[\]{}\\<>&|;()]/.test(w.text))) return false
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
      return args.some((w) => w.text === '--files') && listerWordsOk(args, LISTERS.get('rg')!)
    default: {
      const spec = LISTERS.get(head.text)
      return spec !== undefined && listerWordsOk(args, spec)
    }
  }
}

/** Rule 3: only an exact set of short xargs options; the words from the first non-option on are the command. */
function xargsCommand(args: readonly Word[]): { words: readonly Word[]; replace: string | null } | null {
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
const WALKER_NAMES = [
  'find', 'fd', 'fdfind', 'du', 'tree', 'ls', 'dir', 'vdir', 'gci', 'get-childitem', 'findstr',
  'rg', 'grep', 'egrep', 'fgrep',
]
/** Shells and wrappers that run another command, so a walker can hide behind them, whatever the script says. */
const WRAPPER_NAMES = [
  'sh', 'ash', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'pwsh', 'powershell', 'cmd', 'env',
  'nice', 'time', 'command', 'busybox', 'sudo', 'doas', 'nohup', 'timeout', 'xargs', 'eval', 'exec',
  'builtin', 'setsid', 'stdbuf', 'ionice', 'wsl', 'call',
]
const WALKER_FAMILY: ReadonlySet<string> = new Set([...WALKER_NAMES, ...WRAPPER_NAMES])
const XARGS_SHELL_NAMES = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'eval', 'cmd', 'powershell', 'pwsh'])
/** An xargs option that reads the list from a file: `-a`, `-a<file>`, a cluster with it, or any `--a...`. */
const XARGS_FILE_OPTION = /^(-[A-Za-z0-9]*a|-a.*|--a.*)$/
const PLAIN_COMMAND = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/
const PLAIN_COMMAND_DIR = /^[A-Za-z0-9_.+/:~-]*$/

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

const XARGS_WALKERS: ReadonlyMap<string, WalkerSpec> = new Map<string, WalkerSpec>([
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
function walkerWithFlagsOnly(command: readonly Word[], spec: WalkerSpec, replace: string | null): boolean {
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
function nonRecursiveUnderUnprovenLister(command: readonly Word[]): boolean {
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
function listerProven(seg: Segment, prev: Segment | undefined, fromRoot: boolean): boolean {
  if (!seg.pipedIn || fromRoot || seg.redirectedIn) return false
  if (prev === undefined || prev.group !== seg.group) return false
  return !seg.words.some((w) => !w.quoted && /</.test(w.text)) && isBoundedLister(prev)
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
  if (name === 'xargs') return inspectXargs(args, seg, ctx, depth, root, prev)
  return inspectWalker(name, dir, args, seg, ctx, root, depth)
}

/** What a command writes to a pipe that a shell on the other end reads as a script. */
function fedText(prev: Segment): string[] {
  const at = commandIndex(prev.words)
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
function envOptions(
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
const EXTRA_WALKERS = new Set([
  'where', 'forfiles', 'chmod', 'chown', 'chgrp', 'cp', 'ag', 'ack', 'dust', 'ncdu', 'eza', 'exa',
])
const AG_VALUED = [
  '-G', '--depth', '-A', '-B', '-C', '-m', '--max-count',
  '--ignore', '--ignore-dir', '--pager', '--workers', '-g',
]

function inspectRecursive(name: string, args: readonly Word[], fromRoot: boolean): WalkRefusal | null {
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

/** An xargs stage holding a backtick or `$(`, refused whatever the lister. */
const XARGS_SUBSTITUTION = /(?:^|[\s;&|(])xargs(?=\s)[^|;&\n]*(?:`|\$\()/

/** The refusal for a command that starts an unbounded walk of a filesystem root or the home directory, in any pipeline stage, chain or subshell, or null when it does not. A `find` with no path or a `.`-relative one is refused after a `cd` to a root or the home directory; `startsAtRoot` carries that state into a nested `bash -c` script. */
export function detectUnboundedWalk(command: string, ctx: WalkContext, depth = 0, startsAtRoot = false): WalkRefusal | null {
  // The scanner cuts a segment at a backtick or `$(`, so a substituted xargs command word is only visible here.
  if (XARGS_SUBSTITUTION.test(command)) return refuse('xargs')
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
