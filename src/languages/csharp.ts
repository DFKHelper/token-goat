/**
 * C# symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: namespaces, classes, interfaces, enums, structs, records,
 * delegates, methods, constructors, properties, and `using` import directives.
 */

import type { SymbolEntry } from '../parser_types.js'
import { stripBlockCommentSpan, stripStringLiterals } from './common.js'

export interface CsharpImport {
  readonly kind: string
  readonly target: string
  readonly line: number
}

interface ClassFrame {
  name: string
  startDepth: number
  bodyEntered: boolean
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
  '^\\s+(?:(?:public|protected|private|internal|static)\\s+)*' +
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

  const classStack: ClassFrame[] = []
  let braceDepth = 0
  let inComment = false

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1
    let openedFrameThisLine = false

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

    // class/struct/interface/enum/record. Always pushes its own frame, even while already
    // inside another class's body, so a nested class (and its own members) get tracked against
    // their own start depth instead of being silently folded into the enclosing class.
    const cm = CLASS_HEADER_RE.exec(stripped)
    if (cm) {
      const cname = cm[1] ?? ''
      const parent = classStack.length > 0 ? classStack[classStack.length - 1]!.name : undefined
      symbols.push(makeSymbol(filePath, cname, 'class', lineNum, stripped.slice(0, 200), parent))
      classStack.push({ name: cname, startDepth: braceDepth, bodyEntered: false })
      openedFrameThisLine = true
    }

    const frame = classStack.length > 0 ? classStack[classStack.length - 1]! : null
    if (frame !== null) {
      const depthInClass = braceDepth - frame.startDepth
      if (depthInClass === 1) {
        // constructor
        const ctorM = CONSTRUCTOR_RE.exec(line)
        if (ctorM && ctorM[1] === frame.name) {
          const sigEnd = line.indexOf('{')
          const sig = sigEnd >= 0 ? line.slice(0, sigEnd).trimEnd() : line.trimEnd()
          symbols.push(makeSymbol(filePath, frame.name, 'method', lineNum, sig.slice(0, 200), frame.name))
        }
        // property
        const propM = PROPERTY_RE.exec(line)
        if (propM) {
          symbols.push(makeSymbol(filePath, propM[1] ?? '', 'var', lineNum, stripped.slice(0, 200), frame.name))
        }
        // method
        const methM = METHOD_RE.exec(line)
        if (methM) {
          const mname = methM[1] ?? ''
          if (mname && mname !== frame.name) {
            const sigEnd = line.indexOf('{')
            const sig = sigEnd >= 0 ? line.slice(0, sigEnd).trimEnd() : line.trimEnd()
            symbols.push(makeSymbol(filePath, mname, 'method', lineNum, sig.slice(0, 200), frame.name))
          }
        }
      }
    }

    // Brace-count on a string-stripped copy of the line so a literal brace inside a string
    // literal (e.g. `private string bracket = "{";`) is never counted as real nesting.
    const braceLine = stripStringLiterals(line)
    const openBraces = (braceLine.match(/\{/g) ?? []).length
    const closeBraces = (braceLine.match(/\}/g) ?? []).length
    braceDepth += openBraces - closeBraces

    if (
      openedFrameThisLine &&
      ((openBraces > 0 && openBraces === closeBraces) ||
        (openBraces === 0 && closeBraces === 0 && stripped.endsWith(';')))
    ) {
      // Self-contained one-liner: a brace-less positional record ending in `;`, or a
      // class/struct/record body fully opened and closed on the declaration line itself
      // (`class Foo { }`). Neither ever raises braceDepth above the frame's own start depth, so
      // the bodyEntered-gated pop below would never fire and the frame would stay "stuck" for
      // the rest of the file. Pop it immediately instead.
      classStack.pop()
    } else {
      const top = classStack.length > 0 ? classStack[classStack.length - 1]! : null
      if (top !== null && braceDepth > top.startDepth) {
        top.bodyEntered = true
      }
      // Pop finished frames. A frame only pops once its own opening brace has actually been
      // entered (bodyEntered) - this guards Allman-style declarations (`class Foo` on one line,
      // `{` on the next), where braceDepth still equals the frame's start depth on the header
      // line itself.
      while (classStack.length > 0) {
        const t = classStack[classStack.length - 1]!
        if (t.bodyEntered && braceDepth <= t.startDepth) {
          classStack.pop()
        } else {
          break
        }
      }
    }
  }

  return { symbols, imports }
}
