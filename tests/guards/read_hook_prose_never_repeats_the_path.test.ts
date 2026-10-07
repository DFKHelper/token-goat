/** Guard: the read hooks' own words never name the file being read; only the commands they suggest carry its path, through quotedArg or quotedArgs. A path the prose repeated reached the model unquoted, so a path the relay's suggestion guard refused in a command (one holding a backtick or `$(`) still arrived whole in the sentence beside it: the large-file deny for a/a`b.ts read "… `token-goat (command omitted …)` … a/a`b.ts is very large (1406KB)." (CAPTURE: relayInProcess on a Read of a real file named a`b.ts, source at d3e48216, 2026-10-07). The hook answers a read of that one file, so "this file" names it. Provenance for the flagged sample: HAND-DERIVED, the shape of the pre-fix large-file deny (src/hooks_read.ts at d3e48216). */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The hooks whose messages answer a read or an edit of one file. */
const FILES = ['src/hooks_read.ts', 'src/hooks_read_policy.ts', 'src/hooks_read_post.ts', 'src/hooks_edit.ts']

/** Names those hooks give the path (or base name) of the file being read or edited. */
const PATH_NAMES = new Set(['shown', 'safeShown', 'basename', 'editedBasename'])

/** Calls that hand back a spelling of the path they are given, so `displaySafePath(editedBasename) + ' was edited.'` is the path spliced into prose. */
const PATH_SPELLINGS = new Set(['displaySafePath'])

/** Calls whose arguments are a command's own arguments, quoted for the shells. */
const QUOTING_CALLS = new Set(['quotedArg', 'quotedArgs'])

/** Every `file:line` where a path name is spliced into text (an operand of `+` or a template slot) outside a quoting call, and how many uses of a path name were seen in all. */
function proseSplices(file: string, source: string): { hits: string[]; seen: number } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const hits: string[] = []
  let seen = 0
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && PATH_NAMES.has(node.text)) {
      seen++
      const spelled = throughPathSpellings(node)
      if (isSpliced(spelled) && !insideQuotingCall(spelled)) hits.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { hits, seen }
}

/** `node`, or the outermost call around it that only respells it ({@link PATH_SPELLINGS}). */
function throughPathSpellings(node: ts.Node): ts.Node {
  let at = node
  while (ts.isCallExpression(at.parent) && ts.isIdentifier(at.parent.expression) && PATH_SPELLINGS.has(at.parent.expression.text) && at.parent.arguments.includes(at as ts.Expression)) at = at.parent
  return at
}

/** Whether `node` is joined into a string: an operand of `+`, or the expression of a template slot, possibly through parentheses or a conditional. */
function isSpliced(node: ts.Node): boolean {
  let at: ts.Node = node
  while (ts.isParenthesizedExpression(at.parent) || (ts.isConditionalExpression(at.parent) && at.parent.condition !== at)) at = at.parent
  const parent = at.parent
  if (ts.isTemplateSpan(parent)) return true
  return ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken
}

/** Whether the nearest call around `node` quotes its arguments for the shells. */
function insideQuotingCall(node: ts.Node): boolean {
  for (let at = node.parent; at && !ts.isStatement(at); at = at.parent) {
    if (ts.isCallExpression(at)) return ts.isIdentifier(at.expression) && QUOTING_CALLS.has(at.expression.text)
  }
  return false
}

describe('read hook prose never repeats the path', () => {
  it('flags a path spliced into prose, and not one spliced into a quoted argument', () => {
    const sample = "denyOutput((hint + ' ' + shown + ' is very large (' + kb + 'KB). ').trimStart())\nquotedArg(shown + '::' + name)\n"
    expect(proseSplices('sample.ts', sample)).toEqual({ hits: ['sample.ts:1'], seen: 2 })
  })

  // HAND-DERIVED: the shape of the pre-fix edit hint (src/hooks_edit.ts at f56b1bd7), whose base name reached the prose through displaySafePath, beside the same name respelled inside a quoted argument.
  it('flags a path respelled by displaySafePath and spliced into prose, and not one respelled inside a quoted argument', () => {
    const sample = "leadWithCommand(cmd, 'to re-read', displaySafePath(editedBasename) + ' was edited.')\nquotedArg(displaySafePath(editedBasename) + '::' + name)\n"
    expect(proseSplices('sample.ts', sample)).toEqual({ hits: ['sample.ts:1'], seen: 2 })
  })

  it.each(FILES)('%s names the file only through quoted command arguments', (file) => {
    const { hits, seen } = proseSplices(file, readFileSync(path.join(ROOT, file), 'utf8'))
    expect(seen, `${file} names no path at all, so this guard checks nothing there`).toBeGreaterThan(0)
    expect(hits).toEqual([])
  })
})
