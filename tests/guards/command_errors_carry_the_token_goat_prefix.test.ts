/** Guard: a CLI error -- the stderr message a command prints on its way to a non-zero exit -- is rendered by src/command_error.ts, so it opens with exactly one `token-goat:` and has its file-derived text escaped. Before this guard a few hundred such writes spelled the message out by hand: most printed no prefix at all ("Symbol 'foo' not found in 'nope.ts'", "File not found: x.csv"), a dozen hand-spelled the prefix, and the `{ text, code }` adapters sent a failure's text to stderr raw, so whether an error said who was speaking depended on which command raised it. Rule 1: in any statement list, the run of stderr writes directly above a non-zero exit (a non-zero `return`, `return null`, `throw`, `process.exitCode = N`, `process.exit(N)`), or directly below a `process.exitCode = N`, must open with a write whose argument calls formatCommandError or formatFailedResultText. Continuation lines after that first write (a did-you-mean, an empty-index note) are deliberately left as they are: the prefix marks where the error starts. Rule 2: a write of a `{ text, code }` result's text to stderr goes through formatFailedResultText, which is what gives that path the same first line. What this cannot see: an error written somewhere other than directly beside its exit (the write in one function, the exit code set by its caller), and an error printed to stdout. Hook output is out of scope by construction: hooks answer through their JSON envelope and exit 0, so none of their writes sit beside a non-zero exit. */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SRC = path.join(ROOT, 'src')

type Allowed = { file: string; write: string; reason: string }

/** Error writes beside a non-zero exit that are deliberately not a `token-goat:` line, each matched on its file and a fragment of the write's own text. */
const ALLOWED: readonly Allowed[] = [
  {
    file: 'src/bash_runner.ts',
    write: '`[token-goat: ${displaySafeText(result.error.message)}]\\n`',
    reason: "`token-goat run`'s passthrough path reporting that the wrapped command could not be spawned. It speaks inside the wrapped command's own stderr stream, in the bracketed marker shape the captured path appends for the same failure (and for its timeout and capture-cap notes), so both paths of the runner report a spawn failure identically to the agent reading that command's output.",
  },
]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(p))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function isStderrWrite(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text === 'emitErr' || callee.text === 'err'
  if (ts.isPropertyAccessExpression(callee)) {
    const name = callee.getText()
    return name === 'process.stderr.write' || name === 'console.error'
  }
  return false
}

/** The stderr writes one statement makes, or null when it is not purely a write: a bare write, an if/else whose every branch is one write, or a for-of whose body is one write. */
function writesOf(stmt: ts.Statement): ts.CallExpression[] | null {
  if (ts.isExpressionStatement(stmt)) return isStderrWrite(stmt.expression) ? [stmt.expression] : null
  const single = (s: ts.Statement): ts.Statement | null => (ts.isBlock(s) ? (s.statements.length === 1 ? s.statements[0]! : null) : s)
  if (ts.isIfStatement(stmt)) {
    const calls: ts.CallExpression[] = []
    for (const branch of [stmt.thenStatement, stmt.elseStatement]) {
      if (branch === undefined) continue
      const inner = single(branch)
      const w = inner === null ? null : writesOf(inner)
      if (w === null) return null
      calls.push(...w)
    }
    return calls
  }
  if (ts.isForOfStatement(stmt)) {
    const inner = single(stmt.statement)
    return inner === null ? null : writesOf(inner)
  }
  return null
}

const nonZeroLiteral = (e: ts.Expression | undefined): boolean => e !== undefined && ts.isNumericLiteral(e) && e.text !== '0'

/** 'after' when an error write may also follow this exit (an exitCode assignment, which does not leave the block); 'before' for an exit that does; null when the statement is no non-zero exit. */
function exitKind(stmt: ts.Statement): 'before' | 'after' | null {
  if (ts.isReturnStatement(stmt)) {
    const e = stmt.expression
    return nonZeroLiteral(e) || e?.kind === ts.SyntaxKind.NullKeyword ? 'before' : null
  }
  if (ts.isThrowStatement(stmt)) return 'before'
  if (!ts.isExpressionStatement(stmt)) return null
  const e = stmt.expression
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && e.left.getText() === 'process.exitCode' && nonZeroLiteral(e.right)) return 'after'
  if (ts.isCallExpression(e) && e.expression.getText() === 'process.exit' && nonZeroLiteral(e.arguments[0])) return 'before'
  return null
}

const ROUTED = /\b(?:formatCommandError|formatFailedResultText)\(/

type Site = { file: string; line: number; write: string }

function scan(): { errorWrites: Site[]; textWrites: Site[] } {
  const errorWrites: Site[] = []
  const textWrites: Site[] = []
  for (const abs of sourceFiles(SRC)) {
    const file = path.relative(ROOT, abs).split(path.sep).join('/')
    const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true)
    const site = (call: ts.CallExpression): Site => ({ file, line: sf.getLineAndCharacterOfPosition(call.getStart()).line + 1, write: call.arguments.map((a) => a.getText()).join(', ') })
    const visit = (node: ts.Node): void => {
      // The two stderr sinks themselves (cli.ts `err`, emit.ts `emitErr`): their `text` parameter is whatever the caller already formatted.
      if (ts.isFunctionDeclaration(node) && (node.name?.text === 'err' || node.name?.text === 'emitErr')) return
      if (isStderrWrite(node) && node.arguments.length >= 1) {
        // A result's text written bare, or passed through one wrapper call (`f(text)`, `f(text) + '\n'`): the population is both, so a routed site still counts toward the floor.
        const isText = (e: ts.Expression): boolean => (ts.isIdentifier(e) && e.text === 'text') || (ts.isPropertyAccessExpression(e) && e.name.text === 'text')
        let arg = node.arguments[0]!
        if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) arg = arg.left
        if (isText(arg) || (ts.isCallExpression(arg) && arg.arguments.length === 1 && isText(arg.arguments[0]!))) textWrites.push(site(node))
      }
      const stmts = ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseClause(node) || ts.isDefaultClause(node) ? node.statements : null
      if (stmts !== null) {
        for (let i = 0; i < stmts.length; i++) {
          const kind = exitKind(stmts[i]!)
          if (kind === null) continue
          let first: ts.CallExpression[] | null = null
          for (let j = i - 1; j >= 0; j--) {
            const w = writesOf(stmts[j]!)
            if (w === null || w.length === 0) break
            first = w
          }
          if (first === null && kind === 'after') {
            const w = i + 1 < stmts.length ? writesOf(stmts[i + 1]!) : null
            if (w !== null && w.length > 0) first = w
          }
          for (const call of first ?? []) errorWrites.push(site(call))
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { errorWrites, textWrites }
}

const { errorWrites, textWrites } = scan()
const label = (s: Site): string => `${s.file}:${s.line} ${s.write.replace(/\s+/g, ' ').slice(0, 140)}`
const allowedFor = (s: Site): Allowed | undefined => ALLOWED.find((a) => a.file === s.file && s.write.includes(a.write))

describe('command errors carry the token-goat prefix', () => {
  it('opens every error written beside a non-zero exit with formatCommandError', () => {
    pinnedPopulation({
      what: 'first stderr writes beside a non-zero exit in src/',
      items: errorWrites.map(label),
      floor: 150,
      ceiling: 185,
      mustInclude: ['src/cli_dispatch.ts', 'src/read_structured_data.ts', 'src/read_inspect.ts', 'src/session_store_schema.ts', 'src/cli_upgrade.ts', 'src/bash_runner.ts'],
    })
    const offenders = errorWrites.filter((s) => !ROUTED.test(s.write) && allowedFor(s) === undefined).map(label)
    expect(offenders, 'route these through formatCommandError (src/command_error.ts), or add an ALLOWED entry saying why the line is not a token-goat error').toEqual([])
  })

  it('writes a failed { text, code } result to stderr through formatFailedResultText', () => {
    pinnedPopulation({
      what: '{ text, code } texts written to stderr in src/',
      items: textWrites.map(label),
      floor: 6,
      ceiling: 12,
      mustInclude: ['src/cli_dispatch.ts', 'src/read_brief.ts', 'src/session_store_schema.ts', 'src/cli.ts'],
    })
    const offenders = textWrites.filter((s) => !ROUTED.test(s.write)).map(label)
    expect(offenders).toEqual([])
  })

  it('keeps every ALLOWED entry matched to a live write', () => {
    for (const a of ALLOWED) {
      expect(errorWrites.some((s) => allowedFor(s) === a), `ALLOWED entry for ${a.file} matches no error write any more; delete it`).toBe(true)
      expect(a.reason.length).toBeGreaterThan(40)
    }
  })
})
