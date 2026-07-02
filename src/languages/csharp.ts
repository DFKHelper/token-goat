/**
 * C# symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: namespaces, classes, interfaces, enums, structs, records,
 * delegates, methods, constructors, properties, and `using` import directives.
 */

import type { SymbolEntry } from '../parser_types.js'
import { stripBlockCommentSpan } from './common.js'

export interface CsharpImport {
  readonly kind: string
  readonly target: string
  readonly line: number
}

const USING_RE = /^using\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*;/
const NAMESPACE_RE = /^(?:namespace\s+)([A-Za-z_][A-Za-z0-9_.]*)/
const DELEGATE_RE = new RegExp(
  '^\\s*(?:public|protected|private|internal)?\\s*delegate\\s+' +
  '(?:[A-Za-z_][A-Za-z0-9_<>?,\\[\\]\\s]*?)\\s+' +
  '([A-Za-z_][A-Za-z0-9_]*)\\s*[<(]',
)
const PROPERTY_RE = new RegExp(
  '^\\s+(?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|new|readonly)\\s+)*' +
  '(?:[A-Za-z_][A-Za-z0-9_<>?,\\[\\]\\s]*?)\\s+' +
  '([A-Z][A-Za-z0-9_]*)\\s*\\{[^}]*(?:get|set)',
)
const CONSTRUCTOR_RE = new RegExp(
  '^\\s+(?:(?:public|protected|private|internal|static)\\s+)+' +
  '([A-Z][A-Za-z0-9_]*)\\s*\\(',
)
const CLASS_HEADER_RE = new RegExp(
  '^(?:(?:public|protected|private|internal|abstract|sealed|static|partial)\\s+)*' +
  '(?:class|struct|interface|enum|record)\\s+([A-Za-z_][A-Za-z0-9_]*)',
)
// Methods may have no access modifier (implicitly private) or only a return type (e.g. `void Run()`), so the modifier group is zero-or-more. The leading negative-lookahead rejects statement-starting keywords in the return-type slot so a no-modifier match cannot mistake `return Helper();`-style lines for a method; `new` is omitted from the guard because it is also a valid method modifier (`new void Foo()`). Method detection only runs at one brace level inside a class body, where bare statements cannot legally appear, so this stays safe.
const METHOD_RE = new RegExp(
  '^\\s+(?!(?:return|throw|yield|await|if|else|while|for|foreach|do|switch|case|' +
  'lock|using|fixed|checked|unchecked|goto|var)\\b)' +
  '(?:(?:public|protected|private|internal|static|virtual|override|abstract|' +
  'sealed|new|async|extern|partial)\\s+)*' +
  '(?:[A-Za-z_][A-Za-z0-9_<>?,\\[\\]\\s]*?)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*[<(]',
)

function makeSymbol(
  filePath: string,
  name: string,
  kind: string,
  line: number,
  sig?: string,
  parent?: string,
): SymbolEntry {
  return {
    filePath,
    name,
    kind,
    lineStart: line,
    lineEnd: line,
    body: sig ?? '',
    docstring: parent ?? '',
  }
}

export function extractCsharp(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: CsharpImport[] } {
  const symbols: SymbolEntry[] = []
  const imports: CsharpImport[] = []
  const lines = content.split(/\r?\n/)

  let currentClass: string | null = null
  let classStartDepth = 0
  // True once braceDepth has risen above classStartDepth at least once, i.e. the class's own
  // opening brace has actually been consumed. Guards the pop check below: for Allman-style
  // declarations (`class Foo` on one line, `{` on the next) braceDepth still equals
  // classStartDepth on the header line itself, so an ungated pop check fires immediately and
  // discards the class context before its body is ever seen.
  let classBodyEntered = false
  let braceDepth = 0
  let inComment = false

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1
    let openedClassThisLine = false

    // Strip /* */ block-comment spans (state carried across lines) so braces inside
    // commented-out code are not counted toward braceDepth. A `/*` inside an open quote is
    // not treated as a comment opener.
    const { code: codeLine, inComment: nextInComment } = stripBlockCommentSpan(rawLine, inComment)
    inComment = nextInComment
    const line = codeLine.trimEnd()
    const stripped = line.trim()

    if (!stripped || stripped.startsWith('//')) continue

    // using import
    const usingM = USING_RE.exec(stripped)
    if (usingM) {
      imports.push({ kind: 'import', target: usingM[1] ?? '', line: lineNum })
    }

    // namespace
    const nsM = NAMESPACE_RE.exec(stripped)
    if (nsM) {
      symbols.push(makeSymbol(filePath, nsM[1] ?? '', 'namespace', lineNum, stripped.slice(0, 200)))
    }

    // delegate
    const delM = DELEGATE_RE.exec(stripped)
    if (delM) {
      symbols.push(makeSymbol(filePath, delM[1] ?? '', 'interface', lineNum, stripped.slice(0, 200)))
    }

    // class/struct/interface/enum/record
    const cm = CLASS_HEADER_RE.exec(stripped)
    if (cm) {
      const cname = cm[1] ?? ''
      symbols.push(makeSymbol(filePath, cname, 'class', lineNum, stripped.slice(0, 200)))
      if (currentClass === null) {
        currentClass = cname
        classStartDepth = braceDepth
        classBodyEntered = false
        openedClassThisLine = true
      }
    }

    if (currentClass !== null) {
      const depthInClass = braceDepth - classStartDepth
      if (depthInClass === 1) {
        // constructor
        const ctorM = CONSTRUCTOR_RE.exec(line)
        if (ctorM && ctorM[1] === currentClass) {
          const sigEnd = line.indexOf('{')
          const sig = sigEnd >= 0 ? line.slice(0, sigEnd).trimEnd() : line.trimEnd()
          symbols.push(makeSymbol(filePath, currentClass, 'method', lineNum, sig.slice(0, 200), currentClass))
        }
        // property
        const propM = PROPERTY_RE.exec(line)
        if (propM) {
          symbols.push(makeSymbol(filePath, propM[1] ?? '', 'var', lineNum, stripped.slice(0, 200), currentClass))
        }
        // method
        const methM = METHOD_RE.exec(line)
        if (methM) {
          const mname = methM[1] ?? ''
          if (mname && mname !== currentClass) {
            const sigEnd = line.indexOf('{')
            const sig = sigEnd >= 0 ? line.slice(0, sigEnd).trimEnd() : line.trimEnd()
            symbols.push(makeSymbol(filePath, mname, 'method', lineNum, sig.slice(0, 200), currentClass))
          }
        }
      }
    }

    const openBraces = (line.match(/\{/g) ?? []).length
    const closeBraces = (line.match(/\}/g) ?? []).length
    braceDepth += openBraces - closeBraces

    if (
      openedClassThisLine &&
      ((openBraces > 0 && openBraces === closeBraces) ||
        (openBraces === 0 && closeBraces === 0 && stripped.endsWith(';')))
    ) {
      // Self-contained one-liner: a brace-less positional record ending in `;`, or a
      // class/struct/record body fully opened and closed on the declaration line itself
      // (`class Foo { }`). Neither ever raises braceDepth above classStartDepth, so the
      // classBodyEntered-gated pop below would never fire and currentClass would stay
      // "stuck" on this type for the rest of the file. Clear it immediately instead.
      currentClass = null
    } else {
      if (currentClass !== null && braceDepth > classStartDepth) {
        classBodyEntered = true
      }
      if (currentClass !== null && classBodyEntered && braceDepth <= classStartDepth) {
        currentClass = null
      }
    }
  }

  return { symbols, imports }
}
