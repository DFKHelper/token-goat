/** Guard the hand-listed filter entries in src/filter_counts.ts against going stale. The advertised "NNN+ filter & interception rules" figure is the sum of those entry lists, and the list drifted in both directions: a MEMORY.md re-read denial was removed from src/hooks_read.ts while still counted, and a dozen new rules were never added. Each entry therefore carries an anchor, a literal that must appear in the named source file's code as a use (full-line comments, imports, export lists and the declaration of the helper the anchor names do not count, so neither a comment nor a helper left exported after its last caller was removed can keep a dead rule alive). This row catches the stale-high side for every list: delete or rename a rule and its anchor goes missing, naming the constant and the entry. It cannot see a rule that was ADDED without an entry (no source table enumerates the bash or read decisions), so that side is checked only where the source has a regular shape, the file type dispatcher below; elsewhere it stays a review obligation. Anchors are scoped by shape (a call with its open parenthesis, a config key, a named constant), never by one phrasing of a message. */

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

/** Import statements and `export { ... }` / `export * from` lists: they bind or re-export a name without running it, so a name listed there is not a use. */
const BINDING_STATEMENT = /^[ \t]*(?:export\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)(?:\s*from\s*['"][^'"]*['"])?|import\s+[^;'"]*?from\s*['"][^'"]*['"]|import\s*['"][^'"]*['"])[ \t]*;?/gm

/** Line prefix that ends in `function`, so the name after it is being declared. */
const FUNCTION_PREFIX = /(?:^|\s)function\s*\*?\s*$/
/** Line prefix that ends in `const`/`let`/`var`, so the name after it is being declared when `=`, `:`, `;` or `,` follows. */
const VARIABLE_PREFIX = /(?:^|\s)(?:const|let|var)\s+$/
/** Line prefix holding only the modifiers a class or object method definition may start with, so `NAME(...) {` after it is a definition and not a call. */
const METHOD_PREFIX = /^[ \t]*(?:(?:export|default|declare|public|private|protected|static|async|override|readonly|abstract|get|set)\s+)*\*?[ \t]*$/

/** Index of the `)` closing the `(` at `open`, skipping quoted text, or -1 when the scan cannot resolve it. */
function closingParen(code: string, open: number): number {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    const ch = code[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < code.length && code[i] !== ch; i++) if (code[i] === '\\') i++
    } else if (ch === '(') {
      depth++
    } else if (ch === ')' && --depth === 0) {
      return i
    }
  }
  return -1
}

/** Whether the anchor occurrence at `at` declares the name it starts with (function, variable, method definition) instead of using it. A method definition is `NAME(...)` at the start of a statement whose closing parenthesis is followed by an optional `: type` and then `{`; a call is never followed by that. A scan that cannot resolve the parentheses counts as a declaration, so an unreadable shape turns the guard red instead of passing. */
function declaresNameAt(code: string, at: number, anchor: string): boolean {
  const name = /^[A-Za-z_$][\w$]*/.exec(anchor)?.[0]
  if (name === undefined) return false
  const prefix = code.slice(code.lastIndexOf('\n', at - 1) + 1, at)
  const after = code.slice(at + name.length)
  if (FUNCTION_PREFIX.test(prefix)) return true
  if (VARIABLE_PREFIX.test(prefix) && /^\s*[=:;,]/.test(after)) return true
  if (!METHOD_PREFIX.test(prefix)) return false
  const open = /^(?:<[^>(]*>)?\(/.exec(after)
  if (open === null) return false
  const close = closingParen(code, at + name.length + open[0].length - 1)
  return close === -1 || /^(?:[ \t]*:[^{};=]+?)?[ \t]*\{/.test(code.slice(close + 1))
}

/** Whether `source` holds the anchor somewhere other than a full-line comment, an import or export list, or the declaration of the name the anchor starts with: a use on the decision path. A helper that stays exported after its last caller is removed therefore no longer keeps its entry alive. */
function hasUseSite(source: string, anchor: string): boolean {
  const code = codeOf(source).replace(BINDING_STATEMENT, '')
  for (let at = code.indexOf(anchor); at !== -1; at = code.indexOf(anchor, at + 1)) {
    if (!declaresNameAt(code, at, anchor)) return true
  }
  return false
}

/** One line per counted entry whose anchor has no use site in its file, the file text coming from `read`. */
function staleEntries(read: (file: string) => string): string[] {
  const stale: string[] = []
  for (const group of COUNTED_GROUPS) {
    for (const entry of group.entries) {
      if (!hasUseSite(read(entry.file), entry.anchor)) {
        stale.push(`${group.constant}: "${entry.name}" expects a use of ${JSON.stringify(entry.anchor)} in ${entry.file}`)
      }
    }
  }
  return stale
}

const readRepoFile = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8')

describe('filter count entry anchors', () => {
  it('every counted entry still has a use of its anchor in the code of its source file', () => {
    const missing = staleEntries(readRepoFile)
    expect(
      missing,
      'These counted rules are no longer used in the named file (a declaration or an export of the helper does not count), so TOTAL_FILTER_COUNT overstates the product. ' +
      'Remove each entry from src/filter_counts.ts (or repoint its anchor if the rule moved), then re-check ' +
      'the README figure and the GitHub repo description (`gh repo edit DFKHelper/token-goat --description "..."`):\n' +
      missing.join('\n')
    ).toEqual([])
  })

  // HAND-DERIVED: the sources below are written by hand from the shapes the brief names, not captured from src/. The two declaration lines hold `foo(` yet never call it; only the `if (foo(x))` text runs it.
  it('a declaration of the anchored name is not a use of it', () => {
    expect(hasUseSite('export function foo(a: string): boolean {\n  return true\n}\nfunction foo(a) {\n}', 'foo(')).toBe(false)
    expect(hasUseSite('export async function foo(a) {\n}', 'foo(')).toBe(false)
    expect(hasUseSite('export const foo = (a) => a', 'foo')).toBe(false)
    expect(hasUseSite('let foo: Handler = make()', 'foo')).toBe(false)
    expect(hasUseSite('class A {\n  foo(a: string): boolean {\n    return true\n  }\n}', 'foo(')).toBe(false)
    expect(hasUseSite('class A {\n  private async foo(\n    a: string,\n    b = bar(1),\n  ) {\n  }\n}', 'foo(')).toBe(false)
    expect(hasUseSite('const o = {\n  foo(a) {\n  },\n}', 'foo(')).toBe(false)
    expect(hasUseSite('function bar() {}\nexport { bar, foo }', 'foo')).toBe(false)
    expect(hasUseSite("import { foo } from './x.js'", 'foo')).toBe(false)
    expect(hasUseSite('if (foo(x)) {\n  go()\n}', 'foo(')).toBe(true)
    expect(hasUseSite('export function foo(a) {\n}\nif (foo(x)) {\n}', 'foo(')).toBe(true)
  })

  it('a call is a use however it is written', () => {
    for (const text of ['foo(x)', '  await foo(x)', 'return foo(\n  a,\n)', 'const y = foo(x)', 'obj.foo(x)', 'if (ok) foo(x)', 'a ? foo(x) : b', 'run(() => foo(x))', 'x.then(foo(y) as T)', 'const f = foo(a) as { n: number }']) {
      expect(hasUseSite(text, 'foo('), text).toBe(true)
    }
    expect(hasUseSite("const key = 'foo'", 'foo')).toBe(true)
  })

  it('removing the call from a real hook turns the guard red even though the helper stays exported', () => {
    // HAND-DERIVED: the edit is the one the orchestrator gate planted, the call replaced by `false` with its definition kept.
    const call = 'isBroadCatchAllGlob(pattern, pathArg, getCwd(event))'
    const real = readRepoFile('src/hooks_glob.ts')
    expect(real, 'src/hooks_glob.ts no longer holds the call this row mutates; update the row').toContain(call)
    const mutant = real.replace(call, 'false')
    expect(mutant).toContain('export function isBroadCatchAllGlob(')
    const before = staleEntries(readRepoFile)
    const stale = staleEntries((file) => (file === 'src/hooks_glob.ts' ? mutant : readRepoFile(file)))
    expect(stale.filter((line) => !before.includes(line))).toEqual([expect.stringContaining('GLOB_HOOK_COUNT: "broad catch-all glob hint"')])
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
