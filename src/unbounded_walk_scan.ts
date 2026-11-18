/** Shell scanner and refusal messages for the unbounded-walk guard, split out of unbounded_walk.ts. */

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

export interface Word {
  readonly text: string
  readonly quoted: boolean
}

export interface Segment {
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

export const MAX_NESTING = 3

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

export function refuse(form: Form): WalkRefusal {
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
export function scan(command: string, posix: boolean, psEscape: boolean): { segments: Segment[]; open: boolean } {
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
