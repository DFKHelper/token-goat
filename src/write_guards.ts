/** Content checks behind the Write/Edit pre-hook (hooks_write.ts): syntax, safety, and partial-view guards. No file or session state is read here; Python source is parsed with the standard-library AST over stdin. */

import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

import type * as tsType from 'typescript'
import { loadTs } from './ts_compiler.js'
import { splitLines } from './line_diff.js'
import { displaySafePath } from './paths.js'
import { echoedValue, fencedCommand, fileSubject, quotedArg } from './hint_suggestion_guard.js'

const ELLIPSIS = String.raw`(?:\.{3}|…)`
const COMMENT_LEAD = String.raw`(?:/{2,}|#+|/\*+|\*+|<!--|--|;+|%+|"""|''')`
const COMMENT_CLOSE = String.raw`(?:\*+/|-->|"""|''')`
const KEYWORD = String.raw`(?:rest|remainder|remaining|existing|unchanged|omitted|truncated|previous|same as|other)`
const SUBJECT = String.raw`(?:rest of (?:the )?(?:file|code|content|function|class|module|implementation|method)|existing (?:code|content|implementation)|remaining (?:code|content|lines|implementation)|previous (?:code|content))`
// The subjects that name what is still to be filled in. They read as a stub with a location word after them (`// rest of file here`), where `existing code` or `previous content` stays prose.
const REST_SUBJECT = String.raw`(?:rest of (?:the )?(?:file|code|content|function|class|module|implementation|method)|remaining (?:code|content|lines|implementation))`
const TRAILER = String.raw`(?:(?:is |remains |stays |goes )?(?:unchanged|here|omitted|as[- ]is|the same|same as before|as before|above|below))`

const MAX_ELISION_LINE_CHARS = 120

const LEADING_COMMENT = new RegExp(`^${COMMENT_LEAD}`)
const TRAILING_COMMENT = new RegExp(`${COMMENT_CLOSE}$`)
const ANY_ELLIPSIS = new RegExp(ELLIPSIS, 'g')
const HAS_ELLIPSIS = new RegExp(ELLIPSIS)
const STARTS_WITH_ELLIPSIS = new RegExp(`^${ELLIPSIS}`)
const ENDS_WITH_ELLIPSIS = new RegExp(`${ELLIPSIS}$`)
const LEAD_THEN_TRAILER = new RegExp(`^(?:keep )?(?:the )?${KEYWORD}(?: \\S+){0,4}? (?:unchanged|here|omitted|truncated|as[- ]is|the same|as before|above|below)$`, 'i')
const WRAPPED_MARKER = new RegExp(`^(?:the )?${KEYWORD}(?: \\S+){0,3}$`, 'i')
const SUBJECT_ONLY = new RegExp(`^${SUBJECT}(?: ${TRAILER})?$`, 'i')
// Without an ellipsis a subject alone (`// existing code`, `/* remaining content */`) is an ordinary comment, so a qualifier that says the text was left out has to follow it.
const SUBJECT_QUALIFIED = new RegExp(`^${SUBJECT} (?:(?:is |are |remains? |stays? )?(?:unchanged|omitted|truncated|not shown|as[- ]is|as before|same as before)|(?:remains?|stays?|is|are) (?:the )?same)$`, 'i')
// A rest-of or remaining subject followed by a place word (`// rest of the code goes here`, `// remaining code below`), or the bare `rest of implementation` stub, which has no prose reading.
const REST_PLACED = new RegExp(`^(?:${REST_SUBJECT} (?:(?:goes |is |comes )?(?:here|above|below)|follows)|rest of (?:the )?implementation)$`, 'i')
// With an ellipsis the qualifier alone is enough: `// ... same as before`, `// ... 40 more lines omitted`.
const ELLIPSIS_QUALIFIER = new RegExp(`^(?:(?:the )?(?:same as before|as before|unchanged|omitted|truncated|not shown)|\\d+ (?:more )?\\S+ (?:omitted|truncated|not shown|unchanged|hidden|elided))$`, 'i')
const BRACKET_NOTE = new RegExp(`^(?:truncated|omitted|content (?:truncated|omitted)|(?:remaining|rest of)[^\\]]{0,60}(?:omitted|truncated|unchanged)|\\d+ (?:more )?lines? (?:omitted|truncated|folded))$`, 'i')
const FOLD_MARKER = new RegExp(`^${ELLIPSIS}\\s*\\d+\\s+(?:more\\s+)?lines?\\b.*\\bfolded\\b`, 'i')
const TOKEN_GOAT_NOTICE = /^\[token-goat[: ].{0,200}\]$/

/** The text with every ellipsis taken out and runs of whitespace folded to one space, so a pattern can name its words with a single space between them. */
function spaced(text: string): string {
  return text.replace(ANY_ELLIPSIS, ' ').replace(/\s+/g, ' ').trim()
}

/** Lines that say "something was left out here" instead of being the thing: a comment led by an ellipsis and an elision word, a comment that is only "rest of file" / "existing code" (with an optional "unchanged"-style tail), a bracketed `[truncated]` note, a bare `... rest of` line, and token-goat's own fold and notice markers, which a model copying a folded Read into a Write would carry along. Each form is anchored to the whole line and the line length is capped, so a comment that merely uses the words ("existing code path handles X") is not one. */
function isElisionLine(trimmed: string): boolean {
  if (trimmed === '' || trimmed.length > MAX_ELISION_LINE_CHARS) return false
  if (TOKEN_GOAT_NOTICE.test(trimmed) || FOLD_MARKER.test(trimmed)) return true
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return BRACKET_NOTE.test(spaced(trimmed.slice(1, -1)))
  const led = LEADING_COMMENT.test(trimmed)
  if (!led && !STARTS_WITH_ELLIPSIS.test(trimmed)) return false
  const body = led ? trimmed.replace(LEADING_COMMENT, '').replace(TRAILING_COMMENT, '').trim() : trimmed
  const payload = spaced(body).replace(/^[([](.*)[)\]]$/, '$1').trim()
  const hasEllipsis = HAS_ELLIPSIS.test(body)
  if (!hasEllipsis) return SUBJECT_QUALIFIED.test(payload) || REST_PLACED.test(payload)
  if (SUBJECT_ONLY.test(payload) || ELLIPSIS_QUALIFIER.test(payload)) return true
  return LEAD_THEN_TRAILER.test(payload) || (STARTS_WITH_ELLIPSIS.test(body) && ENDS_WITH_ELLIPSIS.test(body) && WRAPPED_MARKER.test(payload))
}

/** The first placeholder line of `newText` whose trimmed text occurs nowhere in `knownText` (the file as it is now, plus an Edit's old_string), or null. A marker the file already carries is the file's own content, not something the model substituted. */
export function findNewElisionLine(newText: string, knownText: string | (() => string)): string | null {
  let known: Set<string> | undefined
  for (const raw of splitLines(newText)) {
    const trimmed = raw.trim()
    if (!isElisionLine(trimmed)) continue
    known ??= new Set(splitLines(typeof knownText === 'function' ? knownText() : knownText).map((l) => l.trim()))
    if (!known.has(trimmed)) return trimmed
  }
  return null
}

/** The lines an `apply_patch` patch adds, per file, in order. V4A marks an added line with a leading `+`, a file with a `*** Add File:` / `*** Update File:` header; a moved file is attributed to its new path. */
export function patchAddedLines(patch: string): Array<{ path: string; added: string[] }> {
  const files: Array<{ path: string; added: string[] }> = []
  let current: { path: string; added: string[] } | undefined
  for (const line of patch.split(/\r\n|\r|\n/)) {
    const header = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line)
    const moved = /^\*\*\* Move to: (.+)$/.exec(line)
    if (header !== null) {
      current = { path: header[1]!.trim(), added: [] }
      files.push(current)
    } else if (moved !== null && current !== undefined) {
      current.path = moved[1]!.trim()
    } else if (line.startsWith('*** ')) {
      current = undefined
    } else if (current !== undefined && line.startsWith('+')) {
      current.added.push(line.slice(1))
    }
  }
  return files
}

/** Longest stretch of old or new lines, after the shared head and tail, that {@link removedLineIndexes} will compare line by line. */
export const MAX_DIFF_SPAN = 2000

/** The 0-based indexes of `oldLines` that a rewrite into `newLines` removes: every old line outside one longest common subsequence. Walks back through one bit per table cell, so the table stays small; a stretch longer than MAX_DIFF_SPAN on either side is not compared and counts every old line in it as removed, which only makes the blind-drop guard speak where it might have passed; a shared head and tail are matched off first, which is nearly all of a small edit. */
export function removedLineIndexes(oldLines: string[], newLines: string[]): number[] {
  let head = 0
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++
  let tail = 0
  while (tail < oldLines.length - head && tail < newLines.length - head && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++
  const n = oldLines.length - head - tail
  const m = newLines.length - head - tail
  const removed: number[] = []
  if (m === 0 || n > MAX_DIFF_SPAN || m > MAX_DIFF_SPAN) {
    for (let i = 0; i < n; i++) removed.push(head + i)
    return removed
  }
  const width = m + 1
  // Two rolling rows carry the lengths; the walk back needs only, per mismatching cell, whether the cell to its left held at least as much as the one above, so that is kept as one bit per cell (0.5 MB at the 2000 x 2000 bound, where the full Uint16 table was 8 MB).
  const goesLeft = new Uint8Array(Math.ceil(((n + 1) * width) / 8))
  let above = new Uint16Array(width)
  let row = new Uint16Array(width)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[head + i - 1] === newLines[head + j - 1]) {
        row[j] = (above[j - 1] ?? 0) + 1
      } else {
        const left = row[j - 1] ?? 0
        const up = above[j] ?? 0
        row[j] = Math.max(left, up)
        if (left >= up) goesLeft[(i * width + j) >> 3]! |= 1 << ((i * width + j) & 7)
      }
    }
    ;[above, row] = [row, above]
  }
  let i = n
  let j = m
  while (i > 0) {
    if (j > 0 && oldLines[head + i - 1] === newLines[head + j - 1]) {
      i--
      j--
    } else if (j > 0 && ((goesLeft[(i * width + j) >> 3] ?? 0) & (1 << ((i * width + j) & 7))) !== 0) {
      j--
    } else {
      removed.push(head + i - 1)
      i--
    }
  }
  return removed.reverse()
}

/** Inclusive 1-based line runs of `oldLines` that a rewrite into `newLines` removes and that fall outside every served range. Empty when nothing unseen is removed. */
export function unseenRemovedRuns(oldLines: string[], newLines: string[], served: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const unseen = removedLineIndexes(oldLines, newLines)
    .map((i) => i + 1)
    .filter((line) => !served.some(([s, e]) => line >= s && line <= e))
  const runs: Array<[number, number]> = []
  for (const line of unseen) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last[1] === line - 1) last[1] = line
    else runs.push([line, line])
  }
  return runs
}

/** Lines of unseen content a Write must drop before the guard speaks; below it the rewrite is a normal edit of a partly read file. */
export const BLIND_DROP_MIN_LINES = 5

export function countRunLines(runs: ReadonlyArray<readonly [number, number]>): number {
  return runs.reduce((sum, [s, e]) => sum + (e - s + 1), 0)
}

const ELISION_ADVICE = 'Write the real content, or change only the part you mean to with `Edit` or `token-goat replace`. If this exact text is intended, repeat the identical call and it goes through.'

export function placeholderMessage(line: string): string {
  const shown = echoedValue(line.length > 100 ? line.slice(0, 100) + '...' : line)
  return `This call writes a placeholder line (${shown}) that is not in the file now. Written as it stands, that line replaces whatever it stands for. ${ELISION_ADVICE}`
}

/** How many flagged lines {@link placeholdersMessage} quotes before it counts the rest. */
const MAX_QUOTED_PLACEHOLDERS = 3

/** The message for one call that carries a placeholder in several edits: the first few lines quoted, each display-safe, and a count of the rest. One line is worded as {@link placeholderMessage} words it. */
export function placeholdersMessage(found: readonly string[]): string {
  if (found.length === 1) return placeholderMessage(found[0]!)
  const quoted = found.slice(0, MAX_QUOTED_PLACEHOLDERS).map((line) => echoedValue(line.length > 100 ? line.slice(0, 100) + '...' : line))
  const more = found.length > quoted.length ? ` and ${found.length - quoted.length} more` : ''
  return `This call writes ${found.length} placeholder lines (${quoted.join(', ')}${more}) that are not in the files now. Written as they stand, each replaces whatever it stands for. ${ELISION_ADVICE}`
}

export function blindDropMessage(filePath: string, runs: ReadonlyArray<readonly [number, number]>): string {
  const total = countRunLines(runs)
  const named = [...runs].sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, 3).sort((a, b) => a[0] - b[0])
  const shownPath = displaySafePath(filePath)
  const commands = named.map(([s, e]) => fencedCommand('token-goat read ' + quotedArg(`${shownPath}@${s}-${e}`)))
  return `This Write would delete ${total} lines of ${fileSubject(commands.join(' '), shownPath, filePath)} that this session never read in full (lines ${named.map(([s, e]) => (s === e ? String(s) : `${s}-${e}`)).join(', ')}). ` +
    `Read them first with ${commands.join(' or ')}, or change only what you mean to with \`Edit\` or \`token-goat replace\`. If dropping them is intended, repeat the identical call and it goes through.`
}

export interface SyntaxIssue {
  line: number
  column: number
  token: string
  message: string
}

function positionAtOffset(content: string, offset: number): { line: number; column: number } {
  const before = content.slice(0, Math.max(0, Math.min(offset, content.length)))
  const lines = before.split(/\r\n|\r|\n/)
  return { line: lines.length, column: lines[lines.length - 1]!.length + 1 }
}

function tokenAtOffset(content: string, offset: number, length = 1): string {
  let start = Math.max(0, Math.min(offset, content.length))
  while (start < content.length && /\s/u.test(content[start]!)) start++
  if (start >= content.length) return '<eof>'
  return content.slice(start, start + Math.max(1, length)).trim() || content[start]!
}

function syntaxIssueAt(content: string, offset: number, message: string, length?: number): SyntaxIssue {
  const position = positionAtOffset(content, offset)
  return {
    ...position,
    token: tokenAtOffset(content, offset, length),
    message,
  }
}

function jsonSyntaxIssue(content: string): SyntaxIssue | null {
  try {
    JSON.parse(content)
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON'
    const ts = loadTs()
    if (ts !== null) {
      const sourceFile = ts.parseJsonText('input.json', content)
      const diagnostic = (sourceFile as tsType.JsonSourceFile & {
        parseDiagnostics?: readonly tsType.Diagnostic[]
      }).parseDiagnostics?.[0]
      if (diagnostic !== undefined) {
        return syntaxIssueAt(
          content,
          diagnostic.start ?? content.length,
          ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
          diagnostic.length,
        )
      }
    }
    const position = /\bposition\s+(\d+)\b/i.exec(message)
    const lineColumn = /\bline\s+(\d+)\s+column\s+(\d+)\b/i.exec(message)
    let offset = content.length
    if (position !== null) {
      offset = Number(position[1])
    } else if (lineColumn !== null) {
      const targetLine = Number(lineColumn[1])
      const targetColumn = Number(lineColumn[2])
      const lines = content.split(/\r\n|\r|\n/)
      offset = 0
      for (let i = 0; i < targetLine - 1 && i < lines.length; i++) offset += lines[i]!.length + 1
      offset += targetColumn - 1
    }
    return syntaxIssueAt(content, offset, message)
  }
}

const PYTHON_AST_SCRIPT = [
  'import ast, json, sys',
  'try:',
  '    ast.parse(sys.stdin.read())',
  'except SyntaxError as error:',
  '    text = error.text or ""',
  '    column = error.offset or 1',
  '    token = text[column - 1] if column <= len(text) else "<eof>"',
  '    print(json.dumps({"line": error.lineno or 1, "column": column, "token": token, "message": error.msg}))',
  '    raise SystemExit(1)',
].join('\n')

function pythonSyntaxIssue(content: string): SyntaxIssue | null {
  const commands = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']
  for (const command of commands) {
    const result = spawnSync(command, ['-I', '-c', PYTHON_AST_SCRIPT], {
      encoding: 'utf8',
      input: content,
      maxBuffer: 1024 * 1024,
      timeout: 5000,
      windowsHide: true,
    })
    if (result.error !== undefined) {
      if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') continue
      return null
    }
    if (result.status === 0) return null
    try {
      const issue = JSON.parse(result.stdout.trim()) as Partial<SyntaxIssue>
      if (
        typeof issue.line === 'number' &&
        typeof issue.column === 'number' &&
        typeof issue.token === 'string' &&
        typeof issue.message === 'string'
      ) {
        return issue as SyntaxIssue
      }
    } catch {
      // Try the next interpreter when the executable is a launcher with incompatible arguments.
    }
  }
  return null
}

/** Return the first immediate syntax error for a supported source extension. */
export function findSyntaxError(filePath: string, content: string): SyntaxIssue | null {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.json') return jsonSyntaxIssue(content)
  if (extension === '.py') return pythonSyntaxIssue(content)
  const javascript = ['.js', '.jsx', '.mjs', '.cjs'].includes(extension)
  const typescript = ['.ts', '.tsx', '.mts', '.cts'].includes(extension)
  if (!javascript && !typescript) return null

  const ts = loadTs()
  if (ts === null) return null
  const scriptKind = extension === '.tsx'
    ? ts.ScriptKind.TSX
    : extension === '.jsx'
      ? ts.ScriptKind.JSX
      : javascript
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind)
  const diagnostics = (sourceFile as tsType.SourceFile & {
    parseDiagnostics?: readonly tsType.Diagnostic[]
  }).parseDiagnostics
  const diagnostic = diagnostics?.find((entry) => entry.category === ts.DiagnosticCategory.Error)
  if (diagnostic === undefined) return null
  const offset = diagnostic.start ?? content.length
  return syntaxIssueAt(
    content,
    offset,
    ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    diagnostic.length,
  )
}

export interface SafetyViolation {
  rule: string
  line: number
  column: number
  token: string
  message: string
}

const MOCK_CREDENTIAL_ASSIGNMENT = /\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?[_-]?token|client[_-]?secret|secret|password)\b\s*(?:=|:)\s*(['"`])\s*(?:mock|fake|dummy|sample|placeholder|test)[a-z0-9_.-]*\1/i
// eslint-disable-next-line regexp/no-super-linear-backtracking
const MOCK_DATA_DECLARATION = /^\s*(?:export\s+)?(?:const|let|var)\s+(?:mock|fake|dummy|sample)[a-z0-9_]*(?:\s*:[^=\r\n]+)?\s*=/i
const MODEL_IDENTIFIER = /\b(?:gpt-(?:\d+(?:\.\d+)?|[a-z0-9]+)(?:-[a-z0-9.]+)*|claude-(?:\d+(?:\.\d+)?|[a-z][a-z0-9]*)(?:-[a-z0-9.]+)*|gemini-\d+(?:\.\d+)?(?:-[a-z0-9.]+)*|grok-\d+(?:\.\d+)?(?:-[a-z0-9.]+)*|kimi-[a-z0-9]+(?:-[a-z0-9.]+)*|llama-\d+(?:\.\d+)?(?:-[a-z0-9.]+)*|mistral-[a-z0-9]+(?:-[a-z0-9.]+)*|qwen-\d+(?:\.\d+)?(?:-[a-z0-9.]+)*|deepseek-(?:r|v)?\d+(?:\.\d+)?(?:-[a-z0-9.]+)*|hydrafusion(?:-[a-z0-9.]+)*|mai-code-[a-z0-9.]+)\b/i
const GIT_COMMIT_INVOCATION = /\bgit(?:\.exe)?(?:(?:\s+-[cC]\s+\S+)|(?:\s+--[a-z-]+(?:=\S+)?))*\s+commit\b/i
const GIT_MESSAGE_ARGUMENT = /(?:^|\s)(?:-m|--message)(?:=|\s+)(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s;&|]+))/gi
const DANGEROUS_SHELL_PATTERNS: ReadonlyArray<{
  rule: string
  pattern: RegExp
  token: string
  message: string
}> = [
  {
    rule: 'remote-shell-pipeline',
    pattern: /\b(?:curl|wget|iwr|invoke-webrequest)\b[^\r\n;]*?\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|pwsh|powershell|iex|invoke-expression)\b/i,
    token: 'downloaded content | shell',
    message: 'Piping downloaded content directly into a shell is blocked.',
  },
  {
    rule: 'root-recursive-delete',
    pattern: /\b(?:sudo\s+)?rm\s+(?=[^\s]*r)(?=[^\s]*f)-[^\s]+\s+(?:--no-preserve-root\s+)?(?:\/(?=\s|$)|~\/?(?=\s|$)|\$\{?HOME\}?(?:\/)?(?=\s|$))/i,
    token: 'rm -rf /',
    message: 'Recursive deletion of a filesystem root is blocked.',
  },
  {
    rule: 'destructive-git-reset',
    pattern: /\bgit(?:\.exe)?(?:\s+-[cC]\s+\S+)*\s+reset\s+--hard(?:\s|$)/i,
    token: 'git reset --hard',
    message: 'git reset --hard can discard uncommitted changes and is blocked.',
  },
  {
    rule: 'destructive-git-clean',
    pattern: /\bgit(?:\.exe)?(?:\s+-[cC]\s+\S+)*\s+clean\s+(?=[^\s]*f)(?=[^\s]*d)(?=[^\s]*x)-[^\s]+(?:\s|$)/i,
    token: 'git clean -fdx',
    message: 'git clean -fdx can permanently remove untracked files and is blocked.',
  },
]

function safetyViolation(
  rule: string,
  message: string,
  content: string,
  offset: number,
  token: string,
): SafetyViolation {
  return { rule, ...positionAtOffset(content, offset), token, message }
}

function isTestOrFixturePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  return /(?:^|\/)(?:__tests__|tests?|fixtures?)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(normalized)
}

function firstModelIdentifier(message: string): RegExpExecArray | null {
  return MODEL_IDENTIFIER.exec(message)
}

/** Find new mock data markers in a production file, excluding test and fixture paths. */
export function findWriteSafetyViolation(filePath: string, content: string): SafetyViolation | null {
  if (isTestOrFixturePath(filePath) || /[\\/]write_guards(?:_hooks)?\.ts$/i.test(filePath)) return null

  if (/\.git[\\/](?:COMMIT_EDITMSG|MERGE_MSG)$/i.test(filePath)) {
    const model = firstModelIdentifier(content)
    if (model !== null) {
      return safetyViolation(
        'model-name-in-commit',
        'Git commit messages must not mention model identifiers.',
        content,
        model.index ?? 0,
        model[0],
      )
    }
  }

  const lines = content.split(/\r\n|\r|\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const credential = MOCK_CREDENTIAL_ASSIGNMENT.exec(line)
    if (credential !== null) {
      const token = line.slice(0, credential.index ?? 0).trim().split(/\s+/).pop() || 'credential'
      return {
        rule: 'mock-data-leak',
        line: index + 1,
        column: (credential.index ?? 0) + 1,
        token,
        message: 'Mock or placeholder credential values must not be written into production files.',
      }
    }
    const declaration = MOCK_DATA_DECLARATION.exec(line)
    if (declaration !== null) {
      const token = /\b(?:mock|fake|dummy|sample)[a-z0-9_]*/i.exec(line)?.[0] ?? 'mock-data'
      return {
        rule: 'mock-data-leak',
        line: index + 1,
        column: (declaration.index ?? 0) + 1,
        token,
        message: 'Mock data declarations must not be written into production files.',
      }
    }
  }
  return null
}

/** Find a model identifier in an explicit `git commit -m/--message` argument. */
export function findCommitMessageViolation(command: string): SafetyViolation | null {
  const invocation = GIT_COMMIT_INVOCATION.exec(command)
  if (invocation === null) return null
  const argsStart = (invocation.index ?? 0) + invocation[0].length
  const args = command.slice(argsStart)
  for (const match of args.matchAll(GIT_MESSAGE_ARGUMENT)) {
    const message = match[1] ?? match[2] ?? match[3]
    if (message === undefined) continue
    const model = firstModelIdentifier(message)
    if (model === null) continue
    const messageStart = match[0].indexOf(message)
    const offset = argsStart + (match.index ?? 0) + Math.max(0, messageStart) + (model.index ?? 0)
    return safetyViolation(
      'model-name-in-commit',
      'Git commit messages must not mention model identifiers.',
      command,
      offset,
      model[0],
    )
  }
  return null
}

/** Return the first high-confidence shell or commit-message safety violation. */
export function findShellSafetyViolation(command: string): SafetyViolation | null {
  for (const rule of DANGEROUS_SHELL_PATTERNS) {
    const match = rule.pattern.exec(command)
    if (match !== null) {
      return safetyViolation(rule.rule, rule.message, command, match.index ?? 0, rule.token)
    }
  }
  return findCommitMessageViolation(command)
}
