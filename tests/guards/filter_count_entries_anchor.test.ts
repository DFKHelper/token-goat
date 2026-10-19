/** Guard the hand-listed filter entries in src/filter_counts.ts against going stale. The advertised "NNN+ filter & interception rules" figure is the sum of those entry lists, and the list drifted in both directions: a MEMORY.md re-read denial was removed from src/hooks_read.ts while still counted, and a dozen new rules were never added. Each entry therefore carries an anchor, a literal that must appear in the named source file's code (full-line comments do not count, so a comment mentioning a removed rule cannot keep it alive). This row catches the stale-high side for every list: delete or rename a rule and its anchor goes missing, naming the constant and the entry. It cannot see a rule that was ADDED without an entry (no source table enumerates the bash or read decisions), so that side is checked only where the source has a regular shape, the file type dispatcher below; elsewhere it stays a review obligation. Anchors are scoped by shape (a call with its open parenthesis, a config key, a named constant), never by one phrasing of a message. */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { COUNTED_GROUPS } from '../../src/filter_counts.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The source with every full-line comment (`//`, `/*`, ` *`) removed, so an anchor that survives only in a comment is not found. */
function codeOf(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trimStart()
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'))
    })
    .join('\n')
}

const codeByFile = new Map<string, string>()
function codeForFile(file: string): string {
  let code = codeByFile.get(file)
  if (code === undefined) {
    code = codeOf(fs.readFileSync(path.join(ROOT, file), 'utf8'))
    codeByFile.set(file, code)
  }
  return code
}

describe('filter count entry anchors', () => {
  it('every counted entry still has its anchor in the code of its source file', () => {
    const missing: string[] = []
    for (const group of COUNTED_GROUPS) {
      for (const entry of group.entries) {
        if (!codeForFile(entry.file).includes(entry.anchor)) {
          missing.push(`${group.constant}: "${entry.name}" expects ${JSON.stringify(entry.anchor)} in ${entry.file}`)
        }
      }
    }
    expect(
      missing,
      'These counted rules no longer exist in the named file, so TOTAL_FILTER_COUNT overstates the product. ' +
      'Remove each entry from src/filter_counts.ts (or repoint its anchor if the rule moved), then re-check ' +
      'the README figure and the GitHub repo description (`gh repo edit DFKHelper/token-goat --description "..."`):\n' +
      missing.join('\n')
    ).toEqual([])
  })

  it('no list repeats an entry name or a file-and-anchor pair', () => {
    for (const group of COUNTED_GROUPS) {
      expect(group.entries.length, `${group.constant} lists no entries`).toBeGreaterThan(0)
      const names = group.entries.map((e) => e.name)
      const sites = group.entries.map((e) => `${e.file}\u0000${e.anchor}`)
      expect(new Set(names).size, `${group.constant} repeats an entry name`).toBe(names.length)
      expect(new Set(sites).size, `${group.constant} counts one anchor twice`).toBe(sites.length)
    }
  })

  it('a comment that only mentions an anchor does not keep its entry alive', () => {
    expect(codeOf('// extractGone(\n  /* extractGone( */\n * extractGone(\nconst a = 1').includes('extractGone(')).toBe(false)
    expect(codeOf('  const x = extractHere(cmd)').includes('extractHere(')).toBe(true)
  })

  it('the file type dispatcher lists every handler it routes to', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/hints/file_type_handler.ts'), 'utf8')
    const start = source.indexOf('export function dispatchFileTypeHandler(')
    expect(start, 'dispatchFileTypeHandler moved or was renamed; update this guard').toBeGreaterThan(-1)
    const end = source.indexOf('\n}\n', start)
    const body = codeOf(source.slice(start, end === -1 ? undefined : end))
    const routed = [...body.matchAll(/return (handle[A-Za-z]+)\(/g)].map((m) => m[1])
    const listed = COUNTED_GROUPS.find((g) => g.constant === 'FILE_TYPE_HANDLER_COUNT')!.entries
      .map((e) => /return (handle[A-Za-z]+)\(/.exec(e.anchor)?.[1])
    expect(
      [...routed].sort(),
      'dispatchFileTypeHandler routes to a handler that FILE_TYPE_HANDLER_COUNT does not list (or lists one it no longer routes to). Add or remove the entry in src/filter_counts.ts, then update the README figure and the GitHub repo description.'
    ).toEqual([...listed].sort())
  })
})
