/**
 * Shared same-file reachability analysis for the structural guards.
 *
 * Two guards ask the same question of `src/` -- "does every function that does X also do Y" --
 * and both need to follow a call one or two hops to answer it, because the thing being checked is
 * usually a helper away from the thing doing the checking. This module is that traversal, factored
 * out of `third_party_content_reaches_fence.test.ts` when a second guard
 * (`substituted_output_reaches_fence.test.ts`) needed the identical machinery. Keeping one copy is
 * not tidiness: two copies drift, and a guard that silently stops resolving a hop reports green
 * about code it can no longer see.
 *
 * Scope limit, stated once here rather than in each caller: resolution is same-file only. A helper
 * imported from another module is not followed, so a fence (or a substitution) that happens one
 * import away is invisible. Both callers handle that with a named exception list rather than by
 * widening the analysis, because a cross-module call graph is a different tool with its own failure
 * modes, and an unexplained exception is easier to notice than a subtly wrong graph.
 */

export interface FnInfo {
  readonly name: string
  readonly body: string
}

/** Index just past the parameter list opening at `parenStart`, or -1 when it never closes. */
function endOfParams(src: string, parenStart: number): number {
  let depth = 0
  for (let i = parenStart; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return i + 1
  }
  return -1
}

/**
 * Index of the `{` that opens a body, scanning from `i` past an optional return-type annotation.
 *
 * A return type's object literals carry braces of their own. A brace opens a *type* when it stands
 * where a type is expected -- directly after `:`, a union/intersection operator, a generic `<`, or
 * a `,` -- and opens the *body* otherwise, since a body brace can only follow a complete type (an
 * identifier, `]`, `}`, `>`) or the closing paren. Testing the position rather than tracking
 * whether an annotation is still open is what handles `): { a: X } | null {`, where the body brace
 * follows a bare union member and no bracket at all. Getting this wrong is not cosmetic: taking the
 * FIRST `{` after the parameters made `function f(...): { output: X; raw: string } | null {` look
 * like a 44-character body, which silently removed the two real unfenced `emitRewrite` sites in
 * hooks_read.ts from a guard's population while every assertion still passed. A guard's parser is
 * part of what it is guarding.
 */
function openOfBody(src: string, from: number): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] !== '{') continue
    let k = i - 1
    while (k >= 0 && /\s/.test(src[k]!)) k--
    const prev = src[k] ?? ''
    if (prev !== ':' && prev !== '|' && prev !== '&' && prev !== '<' && prev !== ',') return i
    let typeDepth = 0
    let j = i
    for (; j < src.length; j++) {
      if (src[j] === '{') typeDepth++
      else if (src[j] === '}' && --typeDepth === 0) break
    }
    if (j >= src.length) return -1
    i = j
  }
  return -1
}

/** The brace-matched block starting at `open`, or null when it never closes. */
function blockAt(src: string, open: number): string | null {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
  }
  return null
}

/**
 * The text of an expression-bodied arrow's expression, starting at `from` (just past `=>`).
 *
 * Ends at the first `;` or newline seen at bracket depth zero, skipping string and template
 * literals so a delimiter inside one cannot cut the body short. Erring short is the safe direction
 * here: a body that stops early can only make a guard flag MORE, never silently miss a call.
 */
function expressionAt(src: string, from: number): string | null {
  let depth = 0
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') i++
        else if (src[i] === c) break
      }
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return src.slice(from, i).trim() || null
      depth--
    } else if (depth === 0 && (c === ';' || c === '\n')) return src.slice(from, i).trim() || null
  }
  return src.slice(from).trim() || null
}

interface Candidate {
  readonly name: string
  readonly index: number
  /** Index of the `(` opening the parameter list, or -1 for a single unparenthesized arrow param. */
  readonly paren: number
  /** Index just past the parameter list when `paren` is -1. */
  readonly bareEnd: number
  readonly arrow: boolean
}

/**
 * Module-scope `const`/`let`/`var` bindings whose initializer is an arrow function.
 *
 * The assignment `=` is found by scanning rather than by regex, because a type annotation can
 * legally contain both parentheses and an arrow: in
 * `const f: (a: number) => void = (a) => {...}` the annotation's own `=>` must not be mistaken for
 * the assignment. Skipping any `=` immediately followed by `>` or `=`, at bracket depth zero,
 * distinguishes them without parsing types.
 */
function arrowCandidates(src: string): Candidate[] {
  const out: Candidate[] = []
  const bindRe = /^(?:export\s+)?(?:const|let|var)\s+(\w+)/gm
  let m: RegExpExecArray | null
  while ((m = bindRe.exec(src)) !== null) {
    let i = m.index + m[0].length
    let depth = 0
    let assign = -1
    for (; i < src.length; i++) {
      const c = src[i]
      // A declaration's `=` is on the same logical line as its name; a newline at depth zero
      // before one means this binding has no initializer (or is not a binding at all), and
      // scanning on would pair the name with some later statement's `=`. Multi-line generic
      // annotations stay inside `<...>`, so their newlines are not at depth zero.
      if (c === '\n' && depth === 0) break
      if (c === '(' || c === '[' || c === '{' || c === '<') depth++
      else if (c === ')' || c === ']' || c === '}' || c === '>') depth = Math.max(0, depth - 1)
      else if (c === '=' && depth === 0 && src[i + 1] !== '>' && src[i + 1] !== '=' && src[i - 1] !== '!' && src[i - 1] !== '<' && src[i - 1] !== '>') {
        assign = i
        break
      }
    }
    if (assign === -1) continue
    let j = assign + 1
    while (j < src.length && /\s/.test(src[j]!)) j++
    if (src.startsWith('async', j)) {
      j += 5
      while (j < src.length && /\s/.test(src[j]!)) j++
    }
    if (src[j] === '<') {
      // A generic arrow's type parameters: `const f = <T,>(x: T) => ...`.
      const close = src.indexOf('>', j)
      if (close === -1) continue
      j = close + 1
      while (j < src.length && /\s/.test(src[j]!)) j++
    }
    if (src[j] === '(') {
      out.push({ name: m[1]!, index: m.index, paren: j, bareEnd: -1, arrow: true })
      continue
    }
    // A single unparenthesized parameter: `const f = q => ...`.
    const bare = /^(\w+)\s*=>/.exec(src.slice(j))
    if (bare !== null) out.push({ name: m[1]!, index: m.index, paren: -1, bareEnd: j + bare[1]!.length, arrow: true })
  }
  return out
}

/**
 * Every top-level function in `src`, in source order, with its full body text (brace-matched, so a
 * `}` inside a string or a nested block never ends it early).
 *
 * Two shapes count: a `function name(...)` / `async function name(...)` declaration, and a
 * module-scope `const name = (...) => ...` arrow. The arrow half was missing until an audit
 * injected both shapes into src/vscode_duplicate.ts and only the `function` one came back -- a
 * latent hole rather than a live one (there were zero module-scope arrows in the pre-dispatch
 * modules at the time), but a latent hole in EVERY guard built on this helper, since an ungated
 * pre-approval `fs` touch written as `const check = (p) => fs.existsSync(p)` would have gone green.
 *
 * Known limit, stated rather than left to be discovered: CLASS METHODS are still invisible. Adding
 * them means telling a class body apart from an object literal, and a method-shorthand pattern that
 * cannot do that would sweep every `{ replace(x) {...} }` in the repo into these populations --
 * a wrong graph is worse than a stated gap. No guard's current subject matter lives in a class
 * method; the day one does, this is the line that has to change.
 */
export function parseTopLevelFunctions(src: string): FnInfo[] {
  const candidates: Candidate[] = []
  const declRe = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^(]*>)?\s*\(/gm
  let m: RegExpExecArray | null
  while ((m = declRe.exec(src)) !== null) {
    candidates.push({ name: m[1]!, index: m.index, paren: m.index + m[0].length - 1, bareEnd: -1, arrow: false })
  }
  candidates.push(...arrowCandidates(src))
  candidates.sort((a, b) => a.index - b.index)

  const out: FnInfo[] = []
  for (const c of candidates) {
    const afterParams = c.paren === -1 ? c.bareEnd : endOfParams(src, c.paren)
    if (afterParams === -1) continue
    if (!c.arrow) {
      const open = openOfBody(src, afterParams)
      if (open === -1) continue
      const body = blockAt(src, open)
      if (body !== null) out.push({ name: c.name, body })
      continue
    }
    // An arrow's return type sits between the parameters and `=>`; the arrow itself is the marker
    // that the body has started, so find it rather than guessing which brace opens what.
    const arrow = src.indexOf('=>', afterParams)
    if (arrow === -1) continue
    let k = arrow + 2
    while (k < src.length && /\s/.test(src[k]!)) k++
    const body = src[k] === '{' ? blockAt(src, k) : expressionAt(src, k)
    if (body !== null) out.push({ name: c.name, body })
  }
  return out
}

/** A file's function bodies, keyed by name, for same-file transitive-call resolution. */
export function functionMap(fns: readonly FnInfo[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const fn of fns) m.set(fn.name, fn.body)
  return m
}

/** Direct callee names referenced in `body` (a superset of real calls -- good enough for BFS,
 * since a false-positive edge can only make `reaches()` MORE permissive, matching the guards'
 * conservative-toward-not-flagging design given the scope limit above). */
export function calleeNames(body: string): string[] {
  const names: string[] = []
  const callRe = /\b([A-Za-z_]\w*)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = callRe.exec(body)) !== null) names.push(m[1]!)
  return names
}

/**
 * A function body with comments and string/template literals removed, so that *naming* one of
 * these functions is not mistaken for *calling* it.
 *
 * This is not cosmetic, and it is wrong in both directions without it. A doc comment or a
 * `'file.ts::fetchDoc (...)'` pointer string makes the source scan report a function that reads
 * nothing -- noisy but visible. The dangerous direction is the other one: the predicates these
 * guards pass in match on a bare substring, so a comment that merely mentions `fenceUntrustedContent`
 * marks its function as fenced, and the guard then reports green about a function that never fences
 * anything. A call can never live inside a literal or a comment, so removing them cannot hide a
 * real one.
 */
const codeCache = new Map<string, string>()
export function codeOnly(body: string): string {
  const hit = codeCache.get(body)
  if (hit !== undefined) return hit
  // Order matters: comments first, then literals, matching the helper in
  // capabilities_cover_every_egress.test.ts so both guards strip the same way.
  const stripped = body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  codeCache.set(body, stripped)
  return stripped
}

/** True when `fn`'s body, or any locally-defined function reachable from it by same-file calls,
 * satisfies `predicate`. */
export function reaches(
  fn: FnInfo,
  byName: Map<string, string>,
  predicate: (body: string) => boolean,
): boolean {
  const visited = new Set<string>()
  const stack: string[] = [fn.name]
  while (stack.length > 0) {
    const name = stack.pop()!
    if (visited.has(name)) continue
    visited.add(name)
    const raw = byName.get(name)
    if (raw === undefined) continue
    const body = codeOnly(raw)
    if (predicate(body)) return true
    for (const callee of calleeNames(body)) {
      if (!visited.has(callee) && byName.has(callee)) stack.push(callee)
    }
  }
  return false
}

/**
 * Comments removed, everything else kept verbatim.
 *
 * Distinct from `codeOnly` above, which also blanks template literals. Some source in this repo
 * *is* a template literal -- every bridge shim body is one -- so a guard reading that text must not
 * use `codeOnly`, which would erase exactly what it came to read. What has to go either way is
 * comment prose: a line explaining why `shell: true` is needed matches a scan for `shell: true`.
 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
}
