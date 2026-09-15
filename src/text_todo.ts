import * as fs from 'fs'
import * as path from 'path'
import { walkProject } from './baseline.js'
import { displaySafeText, displaySafeJson } from './paths.js'
import { pushAll, decodeSource, escapeRegExp } from './util.js'

const DEFAULT_KINDS = ['TODO', 'FIXME', 'HACK', 'XXX', 'NOTE']

interface TodoItem {
  file: string
  line: number
  kind: string
  text: string
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

function countUnescapedQuotes(text: string, quoteChar: string): number {
  let count = 0
  let backslashes = 0
  for (const ch of text) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    if (ch === quoteChar && backslashes % 2 === 0) count++
    backslashes = 0
  }
  return count
}

function isInsideStringLiteral(line: string, markerIndex: number): boolean {
  const before = line.slice(0, markerIndex)
  const dqCount = countUnescapedQuotes(before, '"')
  return dqCount % 2 !== 0
}

/**
 * Whether an occurrence of a marker word is actually a marker rather than ordinary prose.
 *
 * The match is case-insensitive because `// todo: fix` is as real a marker as `// TODO: fix`, but
 * "NOTE" and "HACK" are also ordinary English words, and matching them in any case turned every
 * sentence containing "a note for this" or "note that" into a reported marker. On this repo that
 * was 681 of 800 hits, nearly all of them changelog prose, which buries the real markers this
 * command exists to surface. Case alone is not enough either (lowercase `note:` in a comment is a
 * genuine annotation) and the colon alone is not enough (`// TODO fix this` carries none), so a
 * marker is one or the other: written in upper case, or carrying the colon that marks it as a
 * label rather than a word in a sentence.
 */
function isMarkerOccurrence(matched: string, hasColon: boolean): boolean {
  return hasColon || matched === matched.toUpperCase()
}

function scanFileForTodos(filePath: string, kindSet: Set<string>): TodoItem[] {
  let text: string
  try {
    text = decodeSource(fs.readFileSync(filePath))
  } catch {
    return []
  }
  const kindPattern = [...kindSet].map(escapeRegExp).join('|')
  const re = new RegExp(`\\b(${kindPattern})\\b(\\s*:)?\\s*(.*)`, 'i')
  const items: TodoItem[] = []
  const lines = splitLines(text)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const m = re.exec(line)
    if (m === null) continue
    if (!isMarkerOccurrence(m[1] ?? '', m[2] !== undefined)) continue
    const idx = m.index ?? 0
    if (isInsideStringLiteral(line, idx)) continue
    items.push({ file: filePath, line: i + 1, kind: m[1]?.toUpperCase() ?? '', text: (m[3] ?? '').trim() })
  }
  return items
}

function collectTodoFiles(patterns: string[]): string[] {
  if (patterns.length > 0) {
    const results: string[] = []
    for (const p of patterns) {
      const abs = path.resolve(p)
      try {
        const stat = fs.statSync(abs)
        if (stat.isDirectory()) {
          pushAll(results, walkProject(abs).files)
        } else {
          results.push(abs)
        }
      } catch {
        // skip non-existent paths
      }
    }
    return results
  }
  return walkProject(process.cwd()).files
}

export function cmdTodo(
  patterns: string[],
  opts: { group?: string; kinds?: string; json?: boolean },
): void {
  const kindSet = new Set<string>(
    opts.kinds !== undefined && opts.kinds.length > 0
      ? opts.kinds.split(',').map((k) => k.trim().toUpperCase())
      : DEFAULT_KINDS,
  )
  const files = collectTodoFiles(patterns)
  const items: TodoItem[] = []
  for (const f of files) {
    pushAll(items, scanFileForTodos(f, kindSet))
  }

  if (opts.json === true) {
    process.stdout.write(displaySafeJson({ items }) + '\n')
    return
  }

  if (items.length === 0) {
    process.stdout.write('No TODO markers found.\n')
    return
  }

  const groupBy = opts.group ?? 'file'
  if (groupBy === 'kind') {
    const byKind = new Map<string, TodoItem[]>()
    for (const item of items) {
      const arr = byKind.get(item.kind) ?? []
      arr.push(item)
      byKind.set(item.kind, arr)
    }
    for (const [kind, group] of byKind) {
      process.stdout.write(`\n[${kind}]\n`)
      for (const item of group) {
        process.stdout.write(`  ${displaySafeText(item.file)}:${item.line}  ${displaySafeText(item.text)}\n`)
      }
    }
  } else {
    const byFile = new Map<string, TodoItem[]>()
    for (const item of items) {
      const arr = byFile.get(item.file) ?? []
      arr.push(item)
      byFile.set(item.file, arr)
    }
    for (const [file, group] of byFile) {
      for (const item of group) {
        process.stdout.write(`${displaySafeText(file)}:${item.line}  ${displaySafeText(item.kind)}  ${displaySafeText(item.text)}\n`)
      }
    }
  }
}
