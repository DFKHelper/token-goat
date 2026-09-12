/**
 * Nix (Nix Reference Manual, "Syntax" https://nix.dev/manual/nix/latest/language/syntax and
 * "String literals" https://nix.dev/manual/nix/latest/language/string-literals) adapter.
 *
 * Nix has no C-family top-level declaration syntax -- a Nix file is a single expression, almost
 * always either a function (`{ pkgs, ... }: { ... }`) or an attribute set, and definitions live as
 * `let`-bound names inside a `let ... in` block or as attribute-set keys (`name = value;`,
 * `a.b.c = value;`). This adapter indexes both of those as symbols (kind `let_binding` or
 * `attribute`), one single-line symbol per definition -- following the "a key is a symbol"
 * convention `ini_idx.ts` uses for flat key-value formats (`extractIni`'s `[section]` headers,
 * `extractEnv`'s `KEY=value` lines), the closest existing precedent in this repo for a language with
 * no block-scoped declaration syntax to open/close a symbol's body against. `inherit (...) name;`
 * bindings are NOT indexed (a real, separate follow-up): they introduce names into scope but carry
 * no `=` this adapter's definition regex can key on. A line with more than one binding (Nix's
 * compact `a = 1; b = 2;` style) only yields its FIRST binding, the same one-match-per-line scope
 * limit `ini_idx.ts`'s own extractors accept.
 *
 * Scope classification (`let_binding` vs `attribute`) is a per-line heuristic, not a true parse:
 * `letDepth` is a simple increment/decrement counter driven by bare `let`/`in` keywords seen on
 * each masked line (never inside a masked comment or string, since the counting regexes run over
 * the MASKED line), not a real scope stack -- correct for the common, idiomatic one-`let`-block-
 * indented-on-its-own-lines style, imprecise for an unusual `let x = 1; in x` written on one line
 * or deeply nested/sibling `let` blocks. This is the same class of simplifying tradeoff
 * `fsharp.ts`/`ocaml.ts` document for their own top-level-boundary heuristics.
 *
 * MASKING is a MODE STACK, not a flat scan (its own pass, independent of every other adapter in
 * this repo): Nix's `${...}` string interpolation (antiquotation) means a string can contain a
 * NESTED Nix expression, which can itself contain another string, which can contain another
 * `${...}`, arbitrarily deep -- a flat single-pass scan cannot correctly find where the OUTER
 * string actually closes, because a `}` or `"`/`''` that belongs to an inner interpolation's own
 * nested record literal or nested string must not be mistaken for the outer string's own delimiter.
 * `maskNix` keeps an explicit array-based mode stack (never native recursion, which would grow
 * unboundedly with adversarial input -- see the perf note below) with three frame kinds:
 *
 *  - `dquote`: inside a `"..."` string (manual, "String literals"). Backslash escapes the following
 *    character (so `\${` is a literal `${`, not an interpolation opener); an unescaped `${` opens
 *    an `interp` frame; an unescaped `"` closes the frame.
 *  - `istring`: inside a `''...''` indented string (manual, "String literals", "Indented strings").
 *    Per the manual's dedicated escape forms for THIS string type -- different from `"..."`'s
 *    backslash escaping -- `'''` (three single quotes) is a literal `''`, and `''${` is a literal
 *    `${` that does NOT open an interpolation. Both are checked, longest-prefix first, before the
 *    plain two-quote closer or a plain `${` opener are considered, so a `'''`/`''${` sitting
 *    immediately adjacent to a real `''`/`${` is never misread as that real delimiter starting one
 *    character early (see the doubled-delimiter mutation-discrimination trap in
 *    `tasks/agent-wiki/coder.md`'s 2026-09-12 F# entry: the dedicated fixture for this below is
 *    built so a naive "close on the first quote pair" masker actually produces a DIFFERENT net
 *    masked span, not one that happens to compose back to the same range).
 *  - `interp`: inside a `${...}` interpolation's own Nix-expression code (whether the enclosing
 *    string is `dquote` or `istring` -- the frame stacked immediately below records which). Ordinary
 *    Nix code inside an interpolation is scanned exactly like top-level code (line/block comments
 *    recognized, nested strings pushed as their own frames), EXCEPT this frame also tracks its own
 *    brace depth: a `{` increments it, a `}` decrements it if positive, and only a `}` seen at
 *    depth 0 actually closes the interpolation and pops the frame -- so `${ { a = 1; }.a }` does not
 *    close the interpolation at its first, inner `}`.
 *
 * `/`+`* ... *`+`/` block comments do NOT nest (unlike Haskell/OCaml/F#'s `{- -}`/`(* *)`): the
 * manual's "Syntax" page documents this as a plain, non-nesting comment form, so
 * `maskNixBlockComment` is an exact, non-counting search for the first closer. `#` line comments
 * run to end of line.
 *
 * The ENTIRE span of a string -- including every nested interpolation and every string nested
 * inside those -- is masked to spaces, the same whole-span approach `fsharp.ts`/`ocaml.ts` use for
 * their own strings: the mode stack's only job is finding the correct END of the outer string, not
 * preserving "real code" that happens to live inside an interpolation for separate extraction.
 *
 * PERFORMANCE: `maskNix` is a single left-to-right scan (no backtracking, no per-character regex);
 * the mode stack's depth is bounded by the input's actual `${`/`"`/`''` nesting, so pathological
 * input (e.g. thousands of unmatched `${` with no closing `}`) still terminates in one linear pass
 * -- it just leaves the stack non-empty at end of input, which is treated the same as any other
 * unterminated construct (the rest of the file masked as string/interpolation content, matching the
 * other adapters' "runs to end of input" convention for an unterminated string/comment).
 */
import type { SymbolEntry } from '../parser_types.js'
import { makeLineSymbol } from './common.js'

type Frame = { readonly kind: 'dquote' } | { readonly kind: 'istring' } | { kind: 'interp'; depth: number }

/** Returns the index just past a `/* *\/` block comment's closing `*\/` (manual, "Syntax": Nix
 * block comments do NOT nest, unlike Haskell/OCaml/F#'s): an exact, non-counting search for the
 * first `*\/`. `start` points at the `/`. */
function maskNixBlockComment(content: string, start: number): number {
  const idx = content.indexOf('*/', start + 2)
  return idx === -1 ? content.length : idx + 2
}

/**
 * Masks `#` line comments, `/* *\/` block comments (non-nesting), `"..."` strings, and `''...''`
 * indented strings -- including every `${...}` interpolation nested inside any of them, to
 * whatever depth -- to spaces (newlines preserved), left to right in one pass. See the module doc
 * for the mode-stack design and citations.
 */
function maskNix(content: string): string {
  const n = content.length
  const out: string[] = new Array(n)
  const stack: Frame[] = []
  let i = 0

  while (i < n) {
    const top = stack[stack.length - 1]
    const inCode = top === undefined || top.kind === 'interp'

    if (inCode) {
      if (content[i] === '#') {
        while (i < n && content[i] !== '\n') {
          out[i] = ' '
          i++
        }
        continue
      }
      if (content[i] === '/' && content[i + 1] === '*') {
        const start = i
        const end = maskNixBlockComment(content, i)
        for (let k = start; k < end; k++) out[k] = content[k] === '\n' ? '\n' : ' '
        i = end
        continue
      }
      if (content[i] === '"') {
        stack.push({ kind: 'dquote' })
        out[i] = ' '
        i++
        continue
      }
      if (content[i] === "'" && content[i + 1] === "'") {
        stack.push({ kind: 'istring' })
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
        continue
      }
      const interpFrame = top !== undefined && top.kind === 'interp' ? top : undefined
      if (interpFrame !== undefined && content[i] === '{') {
        interpFrame.depth++
        out[i] = ' '
        i++
        continue
      }
      if (interpFrame !== undefined && content[i] === '}') {
        if (interpFrame.depth > 0) {
          interpFrame.depth--
        } else {
          stack.pop()
        }
        out[i] = ' '
        i++
        continue
      }
      // Ordinary character. Top-level code (stack empty) is real, unmasked source; the same
      // detection logic run for `interp` frame content (comments/nested strings/brace depth, all
      // handled above) still applies, but every char inside a string -- including an
      // interpolation's own expression code -- is part of that string's whole masked span (see
      // module doc), so it is masked here whenever the stack is non-empty.
      out[i] = stack.length > 0 ? (content[i] === '\n' ? '\n' : ' ') : content[i]!
      i++
      continue
    }

    const frame = top!
    if (frame.kind === 'dquote') {
      if (content[i] === '\\' && i + 1 < n) {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
        continue
      }
      if (content[i] === '"') {
        stack.pop()
        out[i] = ' '
        i++
        continue
      }
      if (content[i] === '$' && content[i + 1] === '{') {
        stack.push({ kind: 'interp', depth: 0 })
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
        continue
      }
      out[i] = content[i] === '\n' ? '\n' : ' '
      i++
      continue
    }

    // frame.kind === 'istring': checked longest-prefix first so `'''`/`''${` are never misread as
    // the plain `''` closer or a plain `${` opener starting one character early (see module doc).
    if (content[i] === "'" && content[i + 1] === "'" && content[i + 2] === "'") {
      out[i] = ' '
      out[i + 1] = ' '
      out[i + 2] = ' '
      i += 3
      continue
    }
    if (content[i] === "'" && content[i + 1] === "'" && content[i + 2] === '$' && content[i + 3] === '{') {
      out[i] = ' '
      out[i + 1] = ' '
      out[i + 2] = ' '
      out[i + 3] = ' '
      i += 4
      continue
    }
    if (content[i] === "'" && content[i + 1] === "'") {
      stack.pop()
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      continue
    }
    if (content[i] === '$' && content[i + 1] === '{') {
      stack.push({ kind: 'interp', depth: 0 })
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      continue
    }
    out[i] = content[i] === '\n' ? '\n' : ' '
    i++
  }

  return out.join('')
}

interface Def {
  readonly kind: string
  readonly name: string
}

// Attribute path (`name`, or a dotted `a.b.c`) followed by a single `=` (the negative lookahead
// rejects `==`; `!=`/`<=`/`>=` never match since their extra operator char can't be part of the
// identifier class immediately before `=`).
const BINDING_RE = /([A-Za-z_][\w'-]*(?:\.[A-Za-z_][\w'-]*)*)\s*=(?!=)/
const LET_RE = /\blet\b/g
const IN_RE = /\bin\b/g

/** Classifies zero or one definition a masked line opens: a `let`-bound name (`kind: 'let_binding'`)
 * or an attribute-set key (`kind: 'attribute'`), per the module doc's per-line scope heuristic.
 * `letDepthBefore` is the running depth carried in from prior lines; a bare `let` earlier on THIS
 * same line (before the binding itself) also counts, so `let x = 1;` on a line with no prior `let`
 * context still classifies `x` as a `let_binding`. */
function classifyLine(maskedLine: string, letDepthBefore: number): Def | undefined {
  const m = BINDING_RE.exec(maskedLine)
  if (m === null) return undefined
  const name = m[1]!
  const letBeforeBinding = /\blet\b/.test(maskedLine.slice(0, m.index))
  const kind = letDepthBefore > 0 || letBeforeBinding ? 'let_binding' : 'attribute'
  return { kind, name }
}

const MAX_DEFS = 500
const MAX_NAME_LEN = 200

export function extractNix(content: string, filePath: string): SymbolEntry[] {
  if (content.includes('\0')) return []
  const rawLines = content.split(/\r?\n/)
  const masked = maskNix(content)
  const maskedLines = masked.split(/\r?\n/)
  const n = rawLines.length

  const symbols: SymbolEntry[] = []
  const seen = new Set<string>()
  let letDepth = 0

  for (let idx = 0; idx < n; idx++) {
    if (symbols.length >= MAX_DEFS) break
    const maskedLine = maskedLines[idx] ?? ''
    const letsOnLine = (maskedLine.match(LET_RE) ?? []).length
    const insOnLine = (maskedLine.match(IN_RE) ?? []).length
    const def = classifyLine(maskedLine, letDepth)
    letDepth = Math.max(0, letDepth + letsOnLine - insOnLine)
    if (def === undefined) continue
    if (!def.name || def.name.length > MAX_NAME_LEN) continue
    const key = `${def.name}\0${idx + 1}`
    if (seen.has(key)) continue
    seen.add(key)
    symbols.push(makeLineSymbol(filePath, def.name, def.kind, idx + 1, rawLines[idx] ?? ''))
  }
  return symbols
}
