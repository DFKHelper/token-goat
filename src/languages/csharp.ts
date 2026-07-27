/**
 * C# symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: namespaces, classes, interfaces, enums, structs, records,
 * delegates, methods, constructors, properties, and `using` import directives.
 */

import type { SymbolEntry } from '../parser_types.js'
import {
  stripBlockCommentSpan,
  stripLineComment,
  stripMultilineStringSpan,
  stripStringLiterals,
  type MultilineStringState,
  type AdapterImport,
  makeLineSymbol,
} from './common.js'

interface ClassFrame {
  name: string
  startDepth: number
  bodyEntered: boolean
}

// The optional `global\s+` prefix covers C# 10's file-scoped implicit usings
// (`global using System;`), idiomatically consolidated into a single GlobalUsings.cs across a
// modern .NET project -- without it, USING_RE's anchored `^using` never matched a line starting
// with "global", so every global-using file silently reported zero imports.
// The optional trailing `(?:=\s*(...))?` covers a `using` *alias* directive (`using Project =
// PC.MyCompany.Project;`), used to disambiguate or shorten a long/colliding namespace or type.
// Without it, the capture group's `\s*;` had to sit immediately after the alias name, but a
// real alias line has ` = <target>;` there instead, so the whole regex failed to match at all --
// an aliased using directive silently dropped both the type/namespace dependency it declares and
// the import itself. When present, the second group (the aliased target) is what actually gets
// pushed below -- the real dependency, not the local alias name.
const USING_RE =
  /^(?:global\s+)?using\s+(?:static\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*(?:=\s*([A-Za-z_][A-Za-z0-9_.<>,\s]*))?\s*;/
const NAMESPACE_RE = /^(?:namespace\s+)([A-Za-z_][A-Za-z0-9_.]*)/

// C# idiomatically places attributes on the same line as the declaration they decorate
// (`[Obsolete] public class Foo`, `[Test] public Foo()`, `[JsonProperty("name")] public string
// Name { get; set; }`), but CLASS_HEADER_RE/CONSTRUCTOR_RE/PROPERTY_RE/PROPERTY_HEADER_RE/
// PROPERTY_ARROW_RE/METHOD_RE are all anchored against the modifier alternation or return type
// directly, with no room for a leading `[Attr]` list. Stripping it before matching only (never
// before slicing the signature/docstring, which still use the original line) fixes the whole
// family at once - same pattern as kotlin.ts's stripLeadingAnnotations(). Leading whitespace is
// preserved so METHOD_RE/CONSTRUCTOR_RE/PROPERTY_RE's own `^\s+` class-member indentation gate
// still functions correctly.
const LEADING_ATTRIBUTE_RE = /^(\s*)((?:\[[^[\]]*\]\s*)+)/
function stripLeadingAttributes(s: string): string {
  const m = LEADING_ATTRIBUTE_RE.exec(s)
  if (!m) return s
  return (m[1] ?? '') + s.slice(m[0].length)
}
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
// Allman-style auto-property header (`public int Foo` with the `{ get; set; }` block on the
// following lines rather than trailing this line) - same shape as PROPERTY_RE but anchored to
// end-of-line instead of requiring a same-line `{`.
const PROPERTY_HEADER_RE = new RegExp(
  '^\\s+(?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|new|readonly)\\s+)*' +
  '(?:[A-Za-z_][A-Za-z0-9_<>?,\\[\\]\\s]*?)\\s+' +
  '([A-Z][A-Za-z0-9_]*)\\s*$',
)
const ALLMAN_ACCESSOR_RE = /^(?:get\s*;\s*set\s*;|set\s*;\s*get\s*;|get\s*;|set\s*;)$/
// A real (non-shorthand) accessor body opener, e.g. `get { return 1; }` or `set {`. Safe to OR
// into the shorthand check below: PROPERTY_HEADER_RE already restricts the header line to a bare
// `Type Name` with no `(`, so in legal C# a following `{` plus a `get`/`set`-led line can only be
// a property/indexer/event accessor block, never a method body.
const ALLMAN_ACCESSOR_BODY_RE = /^(?:get|set)\b/
// Expression-bodied property (`public string Name => "value";` / `int Count => count;`) - the
// character classes used for the leading type/modifier filler exclude `(`/`)`, so this can never
// accidentally match an expression-bodied METHOD (`Add(int a, int b) => a + b;`), where the
// parens sit between the name and `=>`.
const PROPERTY_ARROW_RE = new RegExp(
  '^\\s+(?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|new|readonly)\\s+)*' +
  '(?:[A-Za-z_][A-Za-z0-9_<>?,\\[\\]\\s]*?)\\s+' +
  '([A-Z][A-Za-z0-9_]*)\\s*=>',
)
const CONSTRUCTOR_RE = new RegExp(
  '^\\s+(?:(?:public|protected|private|internal|static)\\s+)*' +
  '([A-Z][A-Za-z0-9_]*)\\s*\\(',
)
const CLASS_HEADER_RE = new RegExp(
  '^(?:(?:public|protected|private|internal|abstract|sealed|static|partial|readonly|ref|unsafe|file)\\s+)*' +
  '(class|struct|interface|enum|record)(?:\\s+(?:class|struct))?\\s+([A-Za-z_][A-Za-z0-9_]*)',
)
// Methods may have no access modifier (implicitly private) or only a return type (e.g. `void Run()`), so the modifier group is zero-or-more. The leading negative-lookahead rejects statement-starting keywords in the return-type slot so a no-modifier match cannot mistake `return Helper();`-style lines for a method; `new` is omitted from the guard because it is also a valid method modifier (`new void Foo()`). Method detection only runs at one brace level inside a class body, where bare statements cannot legally appear, so this stays safe.
// The name-suffix requires either a bare `(` or a generic-arg list `<...>` immediately followed
// by `(` (e.g. `Parse<T>(`), rather than any `<` or `(` - otherwise a generic RETURN type
// containing a nested generic (e.g. `Dictionary<string, List<int>> GetMap()`) lets the lazy
// name-capture group stop early at the first `<`, phantom-capturing the inner type name
// (`List`) instead of the real method name (`GetMap`).
const METHOD_RE = new RegExp(
  '^\\s+(?!(?:return|throw|yield|await|if|else|while|for|foreach|do|switch|case|' +
  'lock|using|fixed|checked|unchecked|goto|var)\\b)' +
  '(?:(?:public|protected|private|internal|static|virtual|override|abstract|' +
  'sealed|new|async|extern|partial|readonly)\\s+)*' +
  '(?:[A-Za-z_][A-Za-z0-9_<>?,\\[\\]\\s]*?)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*(?:<[^<>]*>\\s*)?\\(',
)

export function extractCsharp(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const imports: AdapterImport[] = []
  const lines = content.split(/\r?\n/)

  const classStack: ClassFrame[] = []
  let braceDepth = 0
  let inComment = false
  let mlState: MultilineStringState | null = null

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const lineNum = i + 1

    // Mask multi-line C# string spans (verbatim `@"..."`, raw `"""..."""`) first, state
    // carried across lines, so braces inside one of those can never desync braceDepth. Skipped
    // on lines that start already inside a block comment (mlState null) to avoid misreading
    // comment prose that happens to contain opener-shaped text.
    let mlLine = rawLine
    if (mlState !== null || !inComment) {
      const masked = stripMultilineStringSpan(rawLine, mlState, 'csharp')
      mlLine = masked.code
      mlState = masked.state
    }

    // Strip /* */ block-comment spans (state carried across lines) so braces inside
    // commented-out code are not counted toward braceDepth. A `/*` inside an open quote is
    // not treated as a comment opener.
    const { code: codeLine, inComment: nextInComment } = stripBlockCommentSpan(mlLine, inComment)
    inComment = nextInComment

    // Strip a trailing `//` line comment (quote-aware) so text after it — e.g. the brace-less
    // one-liner pop check's `stripped.endsWith(';')` below — isn't corrupted by comment prose.
    const line = stripLineComment(codeLine).trimEnd()
    const stripped = line.trim()

    if (!stripped || stripped.startsWith('//')) continue

    // using import
    const usingM = USING_RE.exec(stripped)
    if (usingM) {
      imports.push({ kind: 'import', target: usingM[2] ?? usingM[1] ?? '', line: lineNum })
    }

    // namespace
    const nsM = NAMESPACE_RE.exec(stripped)
    if (nsM) {
      symbols.push(makeLineSymbol(filePath, nsM[1] ?? '', 'namespace', lineNum, stripped.slice(0, 200)))
    }

    // delegate. Matched against stripLeadingAttributes(stripped), same as CLASS_HEADER_RE below --
    // without it, an idiomatic `[Serializable] public delegate void Handler();` (the attribute
    // list sits directly before the access modifier, exactly like a class/constructor/property/
    // method declaration) silently dropped the whole delegate from the index. A delegate nested
    // inside a class (a common shape for an event-handler type scoped to that class) must also
    // record its enclosing class name in docstring, exactly like the class/constructor/property/
    // method declarations below already do -- otherwise read_commands.ts's ambiguity-
    // disambiguation logic (findParentName's doc comment; the `c.docstring === symBase` scoping
    // filter) can never tell two same-named delegates nested in different classes apart and
    // silently falls through to the first candidate regardless of which class was requested.
    const delM = DELEGATE_RE.exec(stripLeadingAttributes(stripped))
    if (delM) {
      const delegateParent = classStack.length > 0 ? classStack[classStack.length - 1]!.name : undefined
      symbols.push(makeLineSymbol(filePath, delM[1] ?? '', 'interface', lineNum, stripped.slice(0, 200), delegateParent))
    }

    // class/struct/interface/enum/record. Always pushes its own frame, even while already
    // inside another class's body, so a nested class (and its own members) get tracked against
    // their own start depth instead of being silently folded into the enclosing class.
    const cm = CLASS_HEADER_RE.exec(stripLeadingAttributes(stripped))
    if (cm) {
      const keyword = cm[1] ?? 'class'
      const cname = cm[2] ?? ''
      // `record` is class-like (a record is still fundamentally a reference/value class), so it
      // maps to kind 'class' like the other adapters map their closest analog. struct/interface/
      // enum get their own distinct kinds instead of all collapsing to 'class'.
      const kind = keyword === 'struct' ? 'struct'
        : keyword === 'interface' ? 'interface'
        : keyword === 'enum' ? 'enum'
        : 'class'
      const parent = classStack.length > 0 ? classStack[classStack.length - 1]!.name : undefined
      symbols.push(makeLineSymbol(filePath, cname, kind, lineNum, stripped.slice(0, 200), parent))
      classStack.push({ name: cname, startDepth: braceDepth, bodyEntered: false })
    }

    const frame = classStack.length > 0 ? classStack[classStack.length - 1]! : null
    if (frame !== null) {
      const depthInClass = braceDepth - frame.startDepth
      if (depthInClass === 1) {
        const lineNoAttr = stripLeadingAttributes(line)
        // constructor
        const ctorM = CONSTRUCTOR_RE.exec(lineNoAttr)
        if (ctorM && ctorM[1] === frame.name) {
          const sigEnd = line.indexOf('{')
          const sig = sigEnd >= 0 ? line.slice(0, sigEnd).trimEnd() : line.trimEnd()
          symbols.push(makeLineSymbol(filePath, frame.name, 'method', lineNum, sig.slice(0, 200), frame.name))
        }
        // property
        let isPropertyLine = false
        const propM = PROPERTY_RE.exec(lineNoAttr)
        if (propM) {
          isPropertyLine = true
          symbols.push(makeLineSymbol(filePath, propM[1] ?? '', 'var', lineNum, stripped.slice(0, 200), frame.name))
        } else {
          // Allman-style auto-property: the `{`/`get;`/`set;` tokens live on their own
          // following lines rather than trailing the header line, so PROPERTY_RE (which
          // requires a same-line `{`) never matches. Peek the next two lines for that shape.
          const headerM = PROPERTY_HEADER_RE.exec(lineNoAttr)
          if (headerM) {
            const braceLineNext = (lines[i + 1] ?? '').trim()
            const accessorLine = (lines[i + 2] ?? '').trim()
            if (braceLineNext === '{' && (ALLMAN_ACCESSOR_RE.test(accessorLine) || ALLMAN_ACCESSOR_BODY_RE.test(accessorLine))) {
              isPropertyLine = true
              symbols.push(makeLineSymbol(filePath, headerM[1] ?? '', 'var', lineNum, stripped.slice(0, 200), frame.name))
            }
          } else {
            // Expression-bodied property (`Name => expr;`) - neither PROPERTY_RE nor the
            // Allman header match, since there is no `{` on this line or the next.
            const arrowM = PROPERTY_ARROW_RE.exec(lineNoAttr)
            if (arrowM) {
              isPropertyLine = true
              symbols.push(makeLineSymbol(filePath, arrowM[1] ?? '', 'var', lineNum, stripped.slice(0, 200), frame.name))
            }
          }
        }
        // method - skipped when the property detection above already matched this line, so a
        // property/auto-property declaration is never double-processed as a phantom method too.
        const methM = isPropertyLine ? null : METHOD_RE.exec(lineNoAttr)
        if (methM) {
          const mname = methM[1] ?? ''
          if (mname && mname !== frame.name) {
            const sigEnd = line.indexOf('{')
            const sig = sigEnd >= 0 ? line.slice(0, sigEnd).trimEnd() : line.trimEnd()
            symbols.push(makeLineSymbol(filePath, mname, 'method', lineNum, sig.slice(0, 200), frame.name))
          }
        }
      }
    }

    // Brace-count on a string-stripped copy of the line so a literal brace inside a string
    // literal (e.g. `private string bracket = "{";`) is never counted as real nesting.
    const braceLine = stripStringLiterals(stripLineComment(line))
    const openBraces = (braceLine.match(/\{/g) ?? []).length
    const closeBraces = (braceLine.match(/\}/g) ?? []).length
    braceDepth += openBraces - closeBraces

    const bracelessTop = classStack.length > 0 ? classStack[classStack.length - 1]! : null
    if (
      bracelessTop !== null &&
      !bracelessTop.bodyEntered &&
      braceDepth === bracelessTop.startDepth &&
      ((openBraces > 0 && openBraces === closeBraces) ||
        (openBraces === 0 && closeBraces === 0 && stripped.endsWith(';')))
    ) {
      // Self-contained one-liner: a brace-less positional record ending in `;`, or a
      // class/struct/record body fully opened and closed on the declaration line itself
      // (`class Foo { }`). Neither ever raises braceDepth above the frame's own start depth, so
      // the bodyEntered-gated pop below would never fire and the frame would stay "stuck" for
      // the rest of the file. Pop it immediately instead. Checked against the top frame on
      // EVERY line (not just the line that pushed it) - a positional record's signature can
      // span multiple lines (`record Person(\n  string First,\n  string Last);`), so the
      // terminating `;` frequently lands on a later line than the header that pushed the frame.
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
