#!/usr/bin/env node
// Fold multi-line comments in TypeScript/JavaScript sources onto one line each, per the house rule that a comment is a sentence and its wrap points are diff noise.
//
// The reason this is a script with a verifier rather than a regex someone re-derives per task: an ad-hoc version of it silently swallowed the closing `*/` of a JSDoc block in two guard files, which commented out the function bodies below them. Lint caught it, but only because those files happened to have unused imports afterwards; a merge that swallows a closer in the middle of a file can compile fine and mean something else. So every rewrite here is checked against an invariant: strip comments from the file before and after with esbuild, and the two results must be byte-identical. If they are not, the file is left untouched and the run fails.
//
// Usage: `node scripts/merge-comments.mjs FILE...` rewrites in place, `--check FILE...` reports and changes nothing (exit 1 if a file would change), and `--self-test` runs the cases below.

import { readFileSync, writeFileSync } from 'node:fs'
import { transformSync } from 'esbuild'
import { pathToFileURL } from 'node:url'

const BLOCK_OPEN = /^\s*\/\*/
const BLOCK_CLOSE = /\*\//
const LINE_COMMENT = /^(\s*)\/\/ ?(.*)$/
// Comment text a tool reads as an instruction, which must stay on a line of its own. Folded onto the explanation above it, `// eslint-disable-next-line no-control-regex` became prose and the rule fired again; a `///` reference or a `#region` marker stops parsing the same way.
const DIRECTIVE = /^(?:\/|eslint(?:-disable|-enable)?(?:[-\s]|$)|@ts-|(?:istanbul|c8|v8) ignore|prettier-ignore|biome-ignore|#(?:end)?region)/

/** Fold `/* ... *\/` blocks and runs of `//` lines onto one line each. Purely line-leading lexical analysis, so a `*\/` or `//` appearing inside a string or regex mid-line is never mistaken for a comment delimiter. */
export function mergeComments(source) {
  const nl = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(nl)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (BLOCK_OPEN.test(line) && !BLOCK_CLOSE.test(line)) {
      const indent = line.match(/^\s*/)[0]
      const parts = [line.trim()]
      let j = i + 1
      let closed = false
      for (; j < lines.length; j++) {
        const body = lines[j].trim()
        parts.push(body)
        if (BLOCK_CLOSE.test(body)) { closed = true; break }
      }
      // An unterminated block is a malformed file, not something to reflow: emit it verbatim and move on.
      if (!closed) { out.push(line); continue }
      const inner = parts
        .map((p, k) => (k === 0 ? p.replace(/^\/\*+/, '') : k === parts.length - 1 ? p.replace(/\*\/\s*$/, '').replace(/^\*+ ?/, '') : p.replace(/^\*+ ?/, '')))
        .map(p => p.trim())
        .filter(Boolean)
        .join(' ')
      const opener = parts[0].startsWith('/**') ? '/**' : '/*'
      out.push(`${indent}${opener} ${inner} */`)
      i = j
      continue
    }
    const m = LINE_COMMENT.exec(line)
    if (m) {
      const indent = m[1]
      // A run that opens on a blank `//` is a deliberate paragraph break, the same as one that hits a blank `//` further down.
      if (!m[2].trim() || DIRECTIVE.test(m[2].trim())) { out.push(line); continue }
      const parts = [m[2].trim()]
      let j = i + 1
      for (; j < lines.length; j++) {
        const n = LINE_COMMENT.exec(lines[j])
        // Same indent only: a dedent or indent means a different comment attached to different code. A blank comment line (`//`) ends the run, since it was a deliberate paragraph break.
        if (!n || n[1] !== indent || !n[2].trim() || DIRECTIVE.test(n[2].trim())) break
        parts.push(n[2].trim())
      }
      if (j === i + 1) { out.push(line); continue }
      out.push(`${indent}// ${parts.join(' ')}`)
      i = j - 1
      continue
    }
    out.push(line)
  }
  return out.join(nl)
}

/** esbuild's comment-stripped, normalized rendering of `source`. Minified rather than merely transformed, because a plain transform preserves most comments, which would make the identity check below compare the comments it is supposed to be ignoring and refuse every legitimate fold. Throws on a parse error, which is itself the signal that a rewrite broke the file. */
function codeOnly(source, loader) {
  return transformSync(source, { loader, minify: true }).code
}

function selfTest() {
  const cases = [
    ['/**\n * one\n * two\n */\nconst a = 1\n', '/** one two */\nconst a = 1\n', 'jsdoc folds and keeps its closer'],
    ['// one\n// two\nconst a = 1\n', '// one two\nconst a = 1\n', 'line-comment run folds'],
    ['const s = "/*"\nconst t = "*/"\n', 'const s = "/*"\nconst t = "*/"\n', 'delimiters inside strings are untouched'],
    ['  // a\n  // b\nconst a = 1\n', '  // a b\nconst a = 1\n', 'indent is preserved'],
    ['// a\n  // b\nconst a = 1\n', '// a\n  // b\nconst a = 1\n', 'a different indent is a different comment'],
    ['// a\n//\n// b\nconst a = 1\n', '// a\n//\n// b\nconst a = 1\n', 'a blank comment line ends the run'],
    ['/* unterminated\nconst a = 1\n', '/* unterminated\nconst a = 1\n', 'an unterminated block is left verbatim'],
    ['/** already one line */\nconst a = 1\n', '/** already one line */\nconst a = 1\n', 'a single-line block is unchanged'],
    ['/**\n * one\n */\r\nconst a = 1\n'.replace(/\n/g, '\r\n'), '/** one */\r\nconst a = 1\r\n', 'CRLF is preserved'],
    ['// why\n// eslint-disable-next-line no-control-regex\nconst a = 1\n', '// why\n// eslint-disable-next-line no-control-regex\nconst a = 1\n', 'a directive never joins the run above it'],
    ['// eslint-disable-next-line no-explicit-any\n// why\nconst a = 1\n', '// eslint-disable-next-line no-explicit-any\n// why\nconst a = 1\n', 'a directive never starts a run'],
    ['// why\n// @ts-expect-error untyped\nconst a = 1\n', '// why\n// @ts-expect-error untyped\nconst a = 1\n', 'a ts directive stays on its own line'],
    ['/// <reference types="node" />\n/// <reference types="vite" />\n', '/// <reference types="node" />\n/// <reference types="vite" />\n', 'triple-slash references stay separate'],
    ['// eslintrc notes\n// more\nconst a = 1\n', '// eslintrc notes more\nconst a = 1\n', 'a word that merely starts with eslint still folds'],
  ]
  let failed = 0
  for (const [src, want, name] of cases) {
    const got = mergeComments(src)
    if (got !== want) { failed++; console.log(`FAIL ${name}:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`) }
  }
  // The invariant the ad-hoc version lacked: folding must not move a single token of real code.
  const tricky = 'const re = /\\/\\*/\n/**\n * doc\n */\nexport function f() {\n  // a\n  // b\n  return "*/"\n}\n'
  if (codeOnly(mergeComments(tricky), 'ts') !== codeOnly(tricky, 'ts')) { failed++; console.log('FAIL code-identity invariant on the tricky case') }
  for (const [src] of cases) {
    const once = mergeComments(src)
    if (mergeComments(once) !== once) { failed++; console.log('FAIL not idempotent') }
  }
  console.log(failed ? `SELF-TEST FAILED (${failed})` : 'SELF-TEST OK')
  return failed ? 1 : 0
}

function main(argv) {
  if (argv.includes('--self-test')) return selfTest()
  const check = argv.includes('--check')
  const files = argv.filter(a => !a.startsWith('--'))
  if (!files.length) { console.log('usage: node scripts/merge-comments.mjs [--check] FILE...'); return 2 }
  let changed = 0
  let broke = 0
  for (const file of files) {
    const loader = file.endsWith('.ts') || file.endsWith('.mts') ? 'ts' : 'js'
    const raw = readFileSync(file, 'utf8')
    const next = mergeComments(raw)
    if (next === raw) continue
    let before
    let after
    try {
      before = codeOnly(raw, loader)
      after = codeOnly(next, loader)
    } catch (err) {
      console.log(`${file}: SKIPPED, does not parse (${err.message.split('\n')[0]})`)
      broke++
      continue
    }
    if (before !== after) {
      console.log(`${file}: REFUSED, the fold would move real code`)
      broke++
      continue
    }
    changed++
    console.log(`${file}: ${raw.split('\n').length - next.split('\n').length} line(s) folded`)
    if (!check) writeFileSync(file, next)
  }
  if (broke) return 1
  return check && changed ? 1 : 0
}

// Only act when run as a command. Importing this module (a test, or a caller that wants `mergeComments` alone) must not execute a rewrite or exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)))
