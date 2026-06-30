/**
 * C# symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: namespaces, classes, interfaces, enums, structs, records,
 * delegates, methods, constructors, properties, and `using` import directives.
 */

import type { SymbolEntry } from '../parser_types.js'

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
  let braceDepth = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const stripped = line.trim()
    const lineNum = i + 1

    if (!stripped || stripped.startsWith('//')) {
      braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
      continue
    }

    // using import
    const usingM = USING_RE.exec(stripped)
    if (usingM) {
      imports.push({ kind: 'import', target: usingM[1] ?? '', line: lineNum })
    }

    // namespace
    const nsM = NAMESPACE_RE.exec(stripped)
    if (nsM) {
      symbols.push(makeSymbol(filePath, nsM[1] ?? '', 'const', lineNum, stripped.slice(0, 200)))
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

    braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length

    if (currentClass !== null && braceDepth <= classStartDepth) {
      currentClass = null
    }
  }

  return { symbols, imports }
}
