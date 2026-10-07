/** Guard: no hook splices a path or a name it was handed (a file, a skill, a symbol, a heading, a script, a tool) into its own words raw. A value spliced in raw reached the model outside any quotes, so a name holding a backtick opened a code span that paired with the fence of the command beside it and the command read as prose: "Skill `" + skillName + "` was already loaded", "(tool: " + toolOrScript + ")", the Bash re-read pointer's path (CAPTURE: preBashHandler on a token-goat read of a real file named a`b.ts, source at 1dc90b40, 2026-10-07). Such a value now goes through quotedArg or quotedArgs inside a command, or through fileSubject or nameSubject in a sentence, which quote it the way the commands do and say "this file" or "this <noun>" when no quote mark can hold it. The identifiers below are matched by their names, the way these files spell such values; a value the allowlist names is one the code fixes to a known vocabulary, with the reason beside it. tests/guards/read_hook_prose_never_repeats_the_path.test.ts holds the read hooks to the stricter rule of never naming their own file. Provenance for the flagged samples: HAND-DERIVED, the shapes of the pre-fix skill and xml lines (src/hooks_skill.ts and src/hooks_bash.ts at 1dc90b40). */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const FILES = pinnedPopulation({
  what: 'src/hooks_*.ts files',
  items: readdirSync(path.join(ROOT, 'src')).filter((f) => /^hooks_.*\.ts$/.test(f)).sort().map((f) => `src/${f}`),
  floor: 25,
  mustInclude: ['src/hooks_bash.ts', 'src/hooks_bash_post.ts', 'src/hooks_read.ts', 'src/hooks_skill.ts', 'src/hooks_screenshot.ts'],
})

/** How these files name a value they were handed: a path, a name, a heading, a symbol, a script. */
const NAME = /^(?:.*(?:Path|Name|Heading|Script)|path|name|heading|sym|shown|safeShown|basename|toolOrScript)$/

/** Calls that hand back a spelling of the value they are given, so `displaySafePath(filePath) + ' was read'` is the value spliced into prose. */
const SPELLINGS = new Set(['displaySafePath', 'displaySafeText'])

/** Calls whose arguments are quoted for the shells or named the quoted way, or never reach the model at all. */
const SAFE_CALLS = new Set(['quotedArg', 'quotedArgs', 'fileSubject', 'nameSubject', 'recordStat', 'join', 'resolve', 'debugLog', 'logDebug', 'RegExp'])

/** `file::expression` splices that name a value from a fixed vocabulary, and why. */
const ALLOWED: Record<string, string> = {
  'src/hooks_agent_spawn.ts::shown': 'agent names are held to AGENT_NAME_RE, /^[A-Za-z0-9._:-]{1,64}$/, before they are listed',
  'src/hooks_bash.ts::filterName': "a compression filter's registry name, or 'passthrough' or 'generic'",
  'src/hooks_bash_post.ts::filter.name': "a compression filter's registry name, written into a stat kind",
  'src/hooks_common.ts::opts.toolName': "the tool a dedup hook is registered for, a literal at its call site ('Grep', 'Glob')",
  'src/hooks_screenshot.ts::paramName': "the literal 'filename' or 'filePath'",
}

/** Every `file::expression@line` where a name is spliced into text (an operand of `+` or a template slot) outside a safe call, how many names were seen, and which allowlist keys matched. */
function proseSplices(file: string, source: string): { hits: string[]; seen: number; allowed: Set<string> } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const hits: string[] = []
  const allowed = new Set<string>()
  let seen = 0
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && NAME.test(node.text)) {
      const at = valueExpression(node)
      if (at !== null) {
        seen++
        const spelled = throughSpellings(at)
        if (isSpliced(spelled) && !insideSafeCall(spelled)) {
          const key = `${file}::${at.getText()}`
          if (key in ALLOWED) allowed.add(key)
          else hits.push(`${key}@${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { hits, seen, allowed }
}

/** The expression a name identifier stands for: the identifier itself, or `a.name` when it is the property read; null when it is only the object of a longer access (`name.length`) or not a value at all (a declaration, a property key, a function being called such as `displaySafePath`). */
function valueExpression(node: ts.Identifier): ts.Expression | null {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node ? parent : null
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return null
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isPropertyAssignment(parent) || ts.isFunctionDeclaration(parent) || ts.isBindingElement(parent)) && parent.name === node) return null
  return node
}

/** `node`, or the outermost call around it that only respells it ({@link SPELLINGS}). */
function throughSpellings(node: ts.Node): ts.Node {
  let at = node
  while (ts.isCallExpression(at.parent) && ts.isIdentifier(at.parent.expression) && SPELLINGS.has(at.parent.expression.text) && at.parent.arguments.includes(at as ts.Expression)) at = at.parent
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

/** Whether the nearest call or construction around `node` is one of {@link SAFE_CALLS}. */
function insideSafeCall(node: ts.Node): boolean {
  for (let at = node.parent; at && !ts.isStatement(at); at = at.parent) {
    if (ts.isCallExpression(at) || ts.isNewExpression(at)) {
      const callee = at.expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      return SAFE_CALLS.has(name)
    }
  }
  return false
}

describe('hook prose names a value only through a quoting helper', () => {
  it('flags a name spliced into prose, through a display-safe spelling too, and not one inside a quoting helper', () => {
    const sample = [
      "denyOutput('Skill `' + skillName + '` was already loaded this session.')",
      'context(`(tool: ${displaySafeText(toolOrScript)})`)',
      "denyOutput(sentenceStart(nameSubject('skill', skillName)) + ' was already loaded.')",
      "hint('token-goat read ' + quotedArg(filePath + '::' + sym))",
      "fileSubject('', displaySafePath(filePath)) + ' was read'",
    ].join('\n')
    const { hits, seen } = proseSplices('sample.ts', sample)
    expect(hits).toEqual(['sample.ts::skillName@1', 'sample.ts::toolOrScript@2'])
    expect(seen).toBe(6)
  })

  it.each(FILES)('%s splices no handed name into its own words', (file) => {
    const { hits } = proseSplices(file, readFileSync(path.join(ROOT, file), 'utf8'))
    expect(hits).toEqual([])
  })

  it('checks some names across the hooks, and every allowlist entry still matches a splice', () => {
    let seen = 0
    const matched = new Set<string>()
    for (const file of FILES) {
      const result = proseSplices(file, readFileSync(path.join(ROOT, file), 'utf8'))
      seen += result.seen
      for (const key of result.allowed) matched.add(key)
    }
    expect(seen).toBeGreaterThan(100)
    expect([...matched].sort()).toEqual(Object.keys(ALLOWED).sort())
  })
})
