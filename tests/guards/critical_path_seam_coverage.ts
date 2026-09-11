/**
 * Shared scanner for the injectable seams on the indexer/worker critical path.
 *
 * CLAUDE.md names one failure mode for this area specifically: "a test always supplies the
 * dependency the shipping path omits", so the tested path and the shipped path are different code.
 * A release once shipped with `drainOnce`'s default index callback being a stub that never wrote to
 * the `symbols` table, and the suite stayed green because every worker test injected its own
 * callback.
 *
 * A "seam" here is (a) a parameter of an EXPORTED function in one of {@link SEAM_FILES} that is
 * optional or default-valued and function-typed -- an injectable callback the shipping path leaves
 * to its default -- or (b) a module-level `set<Name>ForTesting` override, which is the same
 * substitution one level up. A plain `dbPath = globalDbPath()` / `dir = dataDir()` default is
 * deliberately NOT counted: passing a temp path is how a test isolates itself, not a way for it to
 * replace behavior, and counting every one of them would bury the callbacks that matter in path
 * plumbing.
 *
 * Kept in a plain `.ts` module rather than inside the guard test so the population can also be
 * listed from a scratch script when adding a seam, without running vitest.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** The files that make up the parse -> write -> drain critical path CLAUDE.md prioritizes. */
export const SEAM_FILES = ['src/worker.ts', 'src/parser.ts', 'src/embeddings.ts', 'src/index_prune.ts'] as const

/** One injectable seam: `<file>::<function>::<parameter>`, or `<file>::<setter>` for an override. */
export interface Seam {
  readonly id: string
  readonly file: string
  readonly fn: string
  readonly param: string
  readonly line: number
}

/** Split a parameter list on commas that sit at depth 0 of every bracket kind. */
function splitTopLevel(params: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  let prev = ''
  for (const ch of params) {
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++
    // The `>` of an arrow type closes nothing: counting it drives depth negative, after which the
    // remaining commas no longer read as top level, so a signature with two callbacks reported only
    // its first seam and the second slipped in undeclared -- the exact blindness this guard exists
    // to prevent.
    else if (ch === ')' || ch === ']' || ch === '}' || (ch === '>' && prev !== '=')) depth--
    if (ch === ',' && depth === 0) {
      out.push(current)
      current = ''
      prev = ch
      continue
    }
    current += ch
    prev = ch
  }
  if (current.trim() !== '') out.push(current)
  return out
}

/**
 * Every exported `function NAME(...)` signature in `source`, as {name, params, line}. Reads the raw
 * text rather than a TS AST deliberately: the guard must stay runnable with no extra dependency, and
 * the shapes it looks for are ordinary declaration syntax.
 */
function signatures(source: string): Array<{ name: string; params: string; line: number }> {
  const out: Array<{ name: string; params: string; line: number }> = []
  const decl = /\bexport\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^(]*>)?\s*\(/g
  let m: RegExpExecArray | null
  while ((m = decl.exec(source)) !== null) {
    const open = decl.lastIndex - 1
    let depth = 0
    let close = -1
    for (let i = open; i < source.length; i++) {
      const ch = source[i]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    if (close === -1) continue
    out.push({
      name: m[1] ?? '',
      params: source.slice(open + 1, close),
      line: source.slice(0, m.index).split('\n').length,
    })
  }
  return out
}

/** Does this single parameter declaration match the seam definition in this file's doc comment? */
function isSeam(param: string): boolean {
  const trimmed = param.trim()
  if (trimmed === '') return false
  const optional = /^[A-Za-z_][A-Za-z0-9_]*\?\s*:/.test(trimmed)
  // `=>` inside the TYPE is not an assignment. Find a `=` that is not part of `=>`, `<=`, `>=`, `==`.
  let defaultAt = -1
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== '=') continue
    if (trimmed[i + 1] === '>' || trimmed[i - 1] === '>' || trimmed[i - 1] === '<' || trimmed[i - 1] === '=') continue
    defaultAt = i
    break
  }
  if (!optional && defaultAt === -1) return false
  const typePart = defaultAt === -1 ? trimmed : trimmed.slice(0, defaultAt)
  return /=>/.test(typePart)
}

/** Every seam in {@link SEAM_FILES}, relative to `repoRoot`. */
export function collectSeams(repoRoot: string): Seam[] {
  const seams: Seam[] = []
  const setterRe = /\bexport\s+function\s+(set[A-Za-z0-9_]*ForTesting)\s*\(/g
  for (const file of SEAM_FILES) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8')
    for (const sig of signatures(source)) {
      for (const raw of splitTopLevel(sig.params)) {
        if (!isSeam(raw)) continue
        const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(raw)?.[1]
        if (name === undefined) continue
        seams.push({ id: `${file}::${sig.name}::${name}`, file, fn: sig.name, param: name, line: sig.line })
      }
    }
    // A module-level testing override is the same substitution one level up: production reads the
    // real backend, every test installs its own through the setter. Counted as a seam named for its
    // setter so a second one cannot be added without a decision.
    setterRe.lastIndex = 0
    let s: RegExpExecArray | null
    while ((s = setterRe.exec(source)) !== null) {
      seams.push({
        id: `${file}::${s[1] ?? ''}`,
        file,
        fn: s[1] ?? '',
        param: '<module override>',
        line: source.slice(0, s.index).split('\n').length,
      })
    }
  }
  return seams
}
