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

/**
 * Every top-level `function name(...) { ... }` / `async function name(...) { ... }` declaration
 * in `src`, keyed by file, with each function's full body text (brace-matched, so a `}` inside a
 * string or a nested block never ends it early).
 */
export function parseTopLevelFunctions(src: string): FnInfo[] {
  const out: FnInfo[] = []
  const declRe = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^(]*>)?\s*\(/gm
  let m: RegExpExecArray | null
  while ((m = declRe.exec(src)) !== null) {
    const name = m[1]!
    const parenStart = m.index + m[0].length - 1 // the '(' the regex ended on
    let depth = 0
    let seenParams = false
    let open = -1
    for (let i = parenStart; i < src.length; i++) {
      const c = src[i]
      if (c === '(') {
        depth++
        seenParams = true
      } else if (c === ')') {
        depth--
      } else if (c === '{' && seenParams && depth === 0) {
        open = i
        break
      }
    }
    if (open === -1) continue
    let braceDepth = 0
    let close = -1
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') braceDepth++
      else if (src[i] === '}' && --braceDepth === 0) {
        close = i
        break
      }
    }
    if (close === -1) continue
    out.push({ name, body: src.slice(open, close + 1) })
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
