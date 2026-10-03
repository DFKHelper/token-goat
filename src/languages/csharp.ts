/**
 * C# symbol extractor — regex-based (no tree-sitter grammar needed).
 *
 * Extracts: namespaces, classes, interfaces, enums, structs, records,
 * delegates, methods, constructors, properties, and `using` import directives.
 */

import type { RefEntry, SymbolEntry } from '../parser_types.js'
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
// C# lets any identifier be spelled with a leading `@` so that a keyword can be used as a name (`@class`, `@event`, `@operator`, `@params`), and code generators (protobuf, NSwag, EF scaffolding) emit those routinely. Every declaration pattern below therefore builds its identifier slots out of IDENT/DOTTED_IDENT rather than a bare `[A-Za-z_][A-Za-z0-9_]*`; without that, a generated `public class @class` or `using @System.Text;` matched nothing at all and the whole declaration was silently dropped from the index.
const IDENT = '@?[A-Za-z_][A-Za-z0-9_]*'
const DOTTED_IDENT = `${IDENT}(?:\\.${IDENT})*`
// The `@` is purely lexical - the identifier's real name is the text after it, and that is what the compiler, and any other file referring to it, uses. Stripping it from the recorded name keeps `namespace @System.Text` and `namespace System.Text` the same name in the index, the same way r.ts drops the backticks from a quoted R name.
function stripVerbatim(name: string): string {
  return name.replace(/@/g, '')
}
// C# lets a namespace-or-type name carry an alias qualifier (`global::System.Text`, `MyAlias::Some.Type`), and generated code emits `global::` routinely so the emitted name cannot be captured by a local declaration that shadows it. Every slot that holds a namespace-or-type name therefore admits one leading `<alias>::` segment; without it a `using global::System.Text;` line, or any member whose type or explicit-interface qualifier was spelled that way, matched nothing and was dropped from the index entirely.
const QUALIFIED_IDENT = `(?:${IDENT}::)?${DOTTED_IDENT}`
// `global::X` and `X` name the same entity: the `global::` root qualifier only says "resolve from the global namespace, ignoring any shadowing alias", so it is as purely lexical as the verbatim `@` above and is stripped for the same reason - a cross-file link from `using global::System.Text;` has to land on the same key as one from `using System.Text;`. A NON-global alias qualifier (`MyAlias::Some.Type`) is kept: it names a different extern assembly root, so dropping it would conflate two genuinely distinct targets.
function stripGlobalAlias(name: string): string {
  return name.replace(/^global::/, '')
}
const USING_RE = new RegExp(
  `^(?:global\\s+)?using\\s+(?:static\\s+)?(${QUALIFIED_IDENT})\\s*(?:=\\s*(@?[A-Za-z_](?:[A-Za-z0-9_.<>,@\\s]|::)*))?\\s*;`,
)
const NAMESPACE_RE = new RegExp(`^(?:namespace\\s+)(${DOTTED_IDENT})`)

// C# idiomatically places attributes on the same line as the declaration they decorate
// (`[Obsolete] public class Foo`, `[Test] public Foo()`, `[JsonProperty("name")] public string
// Name { get; set; }`), but CLASS_HEADER_RE/CONSTRUCTOR_RE/PROPERTY_RE/PROPERTY_HEADER_RE/
// PROPERTY_ARROW_RE/METHOD_RE are all anchored against the modifier alternation or return type
// directly, with no room for a leading `[Attr]` list. Stripping it before matching only (never
// before slicing the signature/docstring, which still use the original line) fixes the whole
// family at once - same pattern as kotlin.ts's stripLeadingAnnotations(). Leading whitespace is
// preserved so METHOD_RE/CONSTRUCTOR_RE/PROPERTY_RE's own `^\s+` class-member indentation gate
// still functions correctly.
// The inner `\[[^[\]]*\]` alternative admits one level of nesting, so an attribute whose
// ARGUMENT contains brackets (`[JsonPropertyName("x[y]")]`, `[Obsolete(nameof(A[0]))]`) is still
// consumed whole. With the flat `[^[\]]*` body this regex stopped at the first inner `]`, left a
// trailing `")]` on the line, and every regex below then failed against that garbage - silently
// dropping the decorated member.
const LEADING_ATTRIBUTE_RE = /^(\s*)((?:\[(?:[^[\]]|\[[^[\]]*\])*\]\s*)+)/
function stripLeadingAttributes(s: string): string {
  const m = LEADING_ATTRIBUTE_RE.exec(s)
  if (!m) return s
  return (m[1] ?? '') + s.slice(m[0].length)
}
// Shared filler for the return/property TYPE slot. `.` is included so a fully-qualified type
// (`System.Collections.Generic.List<int>`, `System.Threading.Tasks.Task`) matches - without it
// every member declared with a namespace-qualified type was dropped. `(`/`)` stay excluded: the
// expression-bodied-property regex relies on that exclusion to avoid matching an
// expression-bodied METHOD, whose parens sit between the name and `=>`.
// The alias qualifier is admitted as the two-character `::` alternative rather than by adding `:` to the character class: a lone `:` must stay excluded so the filler can never run across a ternary's `? :`, a `case X:` label, or a constructor's `: base(...)` initializer and swallow the declaration boundary.
const TYPE_FILLER = '@?[A-Za-z_](?:[A-Za-z0-9_<>?,.@\\[\\]\\s]|::)*?'
// The type slot proper: either a tuple type (`(int a, string b)`) or the filler above. The tuple
// alternative is a separate branch rather than parens added to the filler class, so the
// exclusion the arrow-property regex depends on is preserved.
const TYPE_SLOT = `(?:\\([^()]+\\)|${TYPE_FILLER})`
// Member names may carry an explicit-interface qualifier (`void IDisposable.Dispose()`); the
// qualifier is matched but not captured, so the recorded name is the final segment.
const MEMBER_NAME = `(?:${QUALIFIED_IDENT}\\.)?(${IDENT})`
// Members are matched with `^\s*`, not `^\s+`: a member written at column zero (legal, and common
// in file-scoped-namespace code) is still a member. Nothing else can reach these regexes - they
// only run one brace level inside a type body, where a bare statement cannot legally appear.
const MEMBER_INDENT = '^\\s*'
const DELEGATE_RE = new RegExp(
  `^\\s*(?:public|protected|private|internal)?\\s*delegate\\s+${TYPE_SLOT}\\s+` +
  `(${IDENT})\\s*[<(]`,
)
const PROPERTY_RE = new RegExp(
  `${MEMBER_INDENT}(?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|new|readonly)\\s+)*` +
  `${TYPE_SLOT}\\s+${MEMBER_NAME}\\s*\\{[^}]*(?:get|set)`,
)
// Allman-style auto-property header (`public int Foo` with the `{ get; set; }` block on the
// following lines rather than trailing this line) - same shape as PROPERTY_RE but anchored to
// end-of-line instead of requiring a same-line `{`.
const PROPERTY_HEADER_RE = new RegExp(
  `${MEMBER_INDENT}(?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|new|readonly)\\s+)*` +
  `${TYPE_SLOT}\\s+${MEMBER_NAME}\\s*$`,
)
// An event is a class member like a property, but no pattern above reaches either of its two spellings: the field-like `public event EventHandler Changed;` has no accessor block for PROPERTY_RE to find, and the accessor-block form `public event EventHandler Renamed { add { } remove { } }` carries `add`/`remove` rather than the `get`/`set` PROPERTY_RE requires. METHOD_RE cannot pick either up either, since neither has a parameter list. Events were therefore the one C# member category missing from the index entirely, while the properties and methods declared beside them were indexed normally.
// The pattern stops at the `event` keyword and the name is taken separately, rather than spanning the type in one regex the way the property patterns do. Every formulation that spans it puts a whitespace-admitting quantifier (TYPE_SLOT's own class, or a negated class) next to a `\s+`, which lets the two exchange characters and costs polynomial backtracking on a run of spaces -- the gate the repo carries a suppressions ledger for. Splitting the job keeps both halves unambiguous: nothing here can exchange with the literal `event` that follows it, and EVENT_NAME_RE's identifier class shares no character with the `\s*$` after it.
// `extern` and `unsafe` are here because METHOD_RE already reaches `public static extern int Native(int a)` and `public unsafe void Go()`; without them an event carrying the same modifier was the one member on its line that vanished.
const EVENT_RE = new RegExp(
  `${MEMBER_INDENT}(?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|new|extern|unsafe)\\s+)*event\\s`,
)
// The event's name is the last identifier before the declarator ends, whatever the type in front of it looks like -- a nullable `EventHandler?`, a generic `EventHandler<Foo, Bar>` carrying a space, or a namespace-qualified name.
const EVENT_NAME_RE = new RegExp(`(${IDENT})\\s*$`)
// `public event EventHandler Opened, Closed;` declares two members, so a declaration splits into one declarator per top-level comma. Commas inside a generic argument list are not separators, so the split tracks angle-bracket depth; `=` cannot open one here, since the caller has already cut the declaration at its terminator, so there is no `=>` to mistake for a closing bracket.
function splitEventDeclarators(decl: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < decl.length; i++) {
    const c = decl[i]
    if (c === '<') depth++
    else if (c === '>') { if (depth > 0) depth-- }
    else if (c === ',' && depth === 0) { parts.push(decl.slice(start, i)); start = i + 1 }
  }
  parts.push(decl.slice(start))
  return parts
}
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
  `${MEMBER_INDENT}(?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|new|readonly)\\s+)*` +
  `${TYPE_SLOT}\\s+${MEMBER_NAME}\\s*=>`,
)
// The name class is any identifier, not just an uppercase-initial one: a lowercase type name is
// unconventional but legal, and its constructor was dropped. Widening is safe here because the
// only caller additionally requires the captured name to equal the enclosing type's name.
const CONSTRUCTOR_RE = new RegExp(
  `${MEMBER_INDENT}(?:(?:public|protected|private|internal|static)\\s+)*` +
  `(${IDENT})\\s*\\(`,
)
// A finalizer (`~Calc()`), named with its tilde the way the C++ adapter names a destructor.
const FINALIZER_RE = new RegExp(`${MEMBER_INDENT}(?:(?:extern|unsafe)\\s+)*~\\s*(${IDENT})\\s*\\(`)
// An operator overload (`public static Calc operator +(Calc a, Calc b)`) or a user conversion (`public static implicit operator int(Calc c)`). Groups: 1 the conversion's target type, 2 `checked` when written, 3 the operator token. Its own pattern because METHOD_RE needs an identifier before the `(`, and read as a method the conversion form is a phantom method named for its target type. `operator` is a reserved word that only an operator declaration puts before a `(`, so the pattern anchors on the keyword and DECLARATION_PREFIX_RE vets what precedes it, rather than spelling out modifiers and return type in one backtracking-prone pattern.
const OPERATOR_RE = /\b(?:implicit|explicit)\s+operator\s([^(]+)\(|\boperator(\s+checked)?\s*([-+!~*/%&|^<>=]+|true|false)\s*\(/
// An indexer (`public int this[int i]`, or `IList.this[int i]` for an explicit interface one), named `this[]`: a property-like member whose parameter list is part of its header.
const INDEXER_RE = /\bthis\s*\[/
// What may precede `operator` or `this[` on a declaration line: modifiers, a (generic, tuple, array or nullable) type and an interface qualifier. An `=`, quote or comment marker means an initializer, string or comment, never a header.
const DECLARATION_PREFIX_RE = /^[\w@.<>,?[\]()\s]*$/
function isDeclarationPrefix(prefix: string): boolean {
  return DECLARATION_PREFIX_RE.test(prefix) && /\w/.test(prefix)
}
const CLASS_HEADER_RE = new RegExp(
  '^(?:(?:public|protected|private|internal|abstract|sealed|static|partial|readonly|ref|unsafe|file|new)\\s+)*' +
  `(class|struct|interface|enum|record)(?:\\s+(?:class|struct))?\\s+(${IDENT})`,
)
// Methods may have no access modifier (implicitly private) or only a return type (e.g. `void Run()`), so the modifier group is zero-or-more. The leading negative-lookahead rejects statement-starting keywords in the return-type slot so a no-modifier match cannot mistake `return Helper();`-style lines for a method; `new` is omitted from the guard because it is also a valid method modifier (`new void Foo()`). Method detection only runs at one brace level inside a class body, where bare statements cannot legally appear, so this stays safe.
// The name-suffix requires either a bare `(` or a generic-arg list `<...>` immediately followed
// by `(` (e.g. `Parse<T>(`), rather than any `<` or `(` - otherwise a generic RETURN type
// containing a nested generic (e.g. `Dictionary<string, List<int>> GetMap()`) lets the lazy
// name-capture group stop early at the first `<`, phantom-capturing the inner type name
// (`List`) instead of the real method name (`GetMap`).
const METHOD_RE = new RegExp(
  `${MEMBER_INDENT}(?!(?:return|throw|yield|await|if|else|while|for|foreach|do|switch|case|` +
  'lock|using|fixed|checked|unchecked|goto|var)\\b)' +
  '(?:(?:public|protected|private|internal|static|virtual|override|abstract|' +
  'sealed|new|async|extern|partial|readonly)\\s+)*' +
  `${TYPE_SLOT}\\s+${MEMBER_NAME}\\s*(?:<[^<>]*>\\s*)?\\(`,
)

// The next `count` lines that carry code, skipping blanks, `//` comments and preprocessor
// directives. The Allman auto-property peek uses this rather than raw `lines[i + 1]`/`[i + 2]`:
// a documentation or `#region` line between the header and its `{` used to shift the accessor
// block out of the two-line window, dropping the property.
function nextCodeLines(lines: readonly string[], from: number, count: number): string[] {
  const out: string[] = []
  for (let j = from + 1; j < lines.length && out.length < count; j++) {
    const t = (lines[j] ?? '').trim()
    if (!t || t.startsWith('//') || t.startsWith('#')) continue
    out.push(t)
  }
  return out
}

const CS_REF_NOISE: ReadonlySet<string> = new Set([
  'if',
  'else',
  'while',
  'for',
  'foreach',
  'switch',
  'case',
  'catch',
  'finally',
  'using',
  'lock',
  'fixed',
  'sizeof',
  'typeof',
  'nameof',
  'default',
  'checked',
  'unchecked',
  'delegate',
  'return',
  'throw',
  'yield',
  'base',
  'this',
  'new',
  'var',
  'async',
  'await',
  'get',
  'set',
  'init',
  'add',
  'remove',
  'where',
  'when',
  'select',
  'from',
  'join',
  'into',
  'let',
  'orderby',
  'group',
  'by',
  'equals',
  'on',
  'ascending',
  'descending',
  'true',
  'false',
  'null',
  'void',
  'bool',
  'byte',
  'sbyte',
  'short',
  'ushort',
  'int',
  'uint',
  'long',
  'ulong',
  'float',
  'double',
  'decimal',
  'char',
  'string',
  'object',
  'dynamic',
  'public',
  'private',
  'protected',
  'internal',
  'static',
  'readonly',
  'volatile',
  'virtual',
  'override',
  'abstract',
  'sealed',
  'extern',
  'unsafe',
  'partial',
  'class',
  'struct',
  'interface',
  'enum',
  'record',
])

const CS_NEW_CALL_RE = /\bnew\s+([A-Za-z_][A-Za-z0-9_.]*)(?:<[^>()]+>)?\s*(?:\(|(?=\{))/g
const CS_INVOCATION_RE =
  /(?:\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.|\?\.)\s*|(?:\.|\?\.)\s*)?\b([A-Za-z_][A-Za-z0-9_]*)(?:\s*<[^>()\n]+>)?\s*\(/g
const CS_MULTILINE_INVOCATION_RE =
  /(?:\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.|\?\.)\s*|(?:\.|\?\.)\s*)?\b([A-Za-z_][A-Za-z0-9_]*)(?:\s*<[^>()\n]+>)?\s*$/

export function extractCsharp(
  content: string,
  filePath: string,
): { symbols: SymbolEntry[]; refs: RefEntry[]; imports: AdapterImport[] } {
  const symbols: SymbolEntry[] = []
  const refs: RefEntry[] = []
  const imports: AdapterImport[] = []
  const seenRefs = new Set<string>()
  const lines = content.split(/\r?\n/)

  const classStack: ClassFrame[] = []
  let braceDepth = 0
  let inComment = false
  let mlState: MultilineStringState | null = null
  let inFalseBlock = false
  let falseNesting = 0
  let currentMember: string | undefined
  let memberBodyEntered = false

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

    // Preprocessor directives are not code: a brace inside one (`#region {`, a very common way to
    // label a region after an opening brace) previously incremented braceDepth with no matching
    // decrement, leaving the enclosing type "open" for the rest of the file - its own members
    // were lost and every later top-level type was recorded as nested inside it.
    if (stripped.startsWith('#')) {
      if (inFalseBlock) {
        if (/^#if\b/.test(stripped)) falseNesting++
        else if (/^#endif\b/.test(stripped)) {
          if (falseNesting > 0) falseNesting--
          else inFalseBlock = false
        } else if (falseNesting === 0 && /^#(?:else|elif)\b/.test(stripped)) inFalseBlock = false
      } else if (/^#if\s+(?:false|0)\s*$/.test(stripped)) {
        inFalseBlock = true
        falseNesting = 0
      }
      continue
    }
    if (inFalseBlock) continue

    // using import
    const usingM = USING_RE.exec(stripped)
    if (usingM) {
      imports.push({ kind: 'import', target: stripGlobalAlias(stripVerbatim(usingM[2] ?? usingM[1] ?? '')), line: lineNum })
    }

    // namespace
    const nsM = NAMESPACE_RE.exec(stripped)
    if (nsM) {
      symbols.push(makeLineSymbol(filePath, stripVerbatim(nsM[1] ?? ''), 'namespace', lineNum, stripped.slice(0, 200), undefined, lines, 'c'))
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
      // A delegate declares a function type, not an interface. Filing it as 'interface' made `outline` and `symbol` report a C# reader something the language has no such construct for, and put it in the same bucket as the real `interface` declarations beside it. 'type' is what the other adapters use for the closest analog, a type alias naming a function signature.
      symbols.push(makeLineSymbol(filePath, stripVerbatim(delM[1] ?? ''), 'type', lineNum, stripped.slice(0, 200), delegateParent, lines, 'c'))
    }

    // class/struct/interface/enum/record. Always pushes its own frame, even while already
    // inside another class's body, so a nested class (and its own members) get tracked against
    // their own start depth instead of being silently folded into the enclosing class.
    const cm = CLASS_HEADER_RE.exec(stripLeadingAttributes(stripped))
    if (cm) {
      const keyword = cm[1] ?? 'class'
      const cname = stripVerbatim(cm[2] ?? '')
      // `record` is class-like (a record is still fundamentally a reference/value class), so it
      // maps to kind 'class' like the other adapters map their closest analog. struct/interface/
      // enum get their own distinct kinds instead of all collapsing to 'class'.
      const kind = keyword === 'struct' ? 'struct'
        : keyword === 'interface' ? 'interface'
        : keyword === 'enum' ? 'enum'
        : 'class'
      const parent = classStack.length > 0 ? classStack[classStack.length - 1]!.name : undefined
      symbols.push(makeLineSymbol(filePath, cname, kind, lineNum, stripped.slice(0, 200), parent, lines, 'c'))
      classStack.push({ name: cname, startDepth: braceDepth, bodyEntered: false })
    }

    let ctorM: RegExpExecArray | null = null
    let finM: RegExpExecArray | null = null
    let methM: RegExpExecArray | null = null
    let propM: RegExpExecArray | null = null
    let headerM: RegExpExecArray | null = null
    let arrowM: RegExpExecArray | null = null

    const frame = classStack.length > 0 ? classStack[classStack.length - 1]! : null
    if (frame !== null) {
      const depthInClass = braceDepth - frame.startDepth
      if (depthInClass === 1) {
        const lineNoAttr = stripLeadingAttributes(line)
        // constructor
        ctorM = CONSTRUCTOR_RE.exec(lineNoAttr)
        if (ctorM && stripVerbatim(ctorM[1] ?? '') === frame.name) {
          const sigEnd = line.indexOf('{')
          const sig = sigEnd >= 0 ? line.slice(0, sigEnd).trimEnd() : line.trimEnd()
          symbols.push(makeLineSymbol(filePath, frame.name, 'method', lineNum, sig.slice(0, 200), frame.name, lines, 'c'))
          currentMember = frame.name
          memberBodyEntered = line.includes('{')
        }
        // event. Checked before the property patterns so the accessor-block spelling is claimed here rather than falling through to the Allman header peek, which would read its `{` and following `add`/`remove` line as a property body.
        let isPropertyLine = false
        const eventM = EVENT_RE.exec(lineNoAttr)
        if (eventM) {
          isPropertyLine = true
          // Everything after the keyword up to the terminator is the type and its declarators; the field-like spelling ends at `;`, the accessor-block one at `{`, and an Allman `{` on the next line leaves the whole remainder. A per-declarator initializer is cut at its own `=` rather than with the terminator, because `First = null, Second;` would otherwise end at the `=` and lose `Second`.
          const decl = lineNoAttr.slice(eventM[0].length).split(/[;{]/)[0] ?? ''
          for (const part of splitEventDeclarators(decl)) {
            const declM = EVENT_NAME_RE.exec(part.split('=')[0]?.trim() ?? '')
            if (declM) symbols.push(makeLineSymbol(filePath, stripVerbatim(declM[1] ?? ''), 'var', lineNum, stripped.slice(0, 200), frame.name, lines, 'c'))
          }
        }
        // property
        propM = isPropertyLine ? null : PROPERTY_RE.exec(lineNoAttr)
        if (propM) {
          isPropertyLine = true
          const propName = stripVerbatim(propM[1] ?? '')
          symbols.push(makeLineSymbol(filePath, propName, 'var', lineNum, stripped.slice(0, 200), frame.name, lines, 'c'))
          currentMember = propName
          memberBodyEntered = line.includes('{')
        } else {
          // Allman-style auto-property: the `{`/`get;`/`set;` tokens live on their own
          // following lines rather than trailing the header line, so PROPERTY_RE (which
          // requires a same-line `{`) never matches. Peek the next two lines for that shape.
          headerM = PROPERTY_HEADER_RE.exec(lineNoAttr)
          if (headerM) {
            const [braceLineNext = '', accessorLine = ''] = nextCodeLines(lines, i, 2)
            if (braceLineNext === '{' && (ALLMAN_ACCESSOR_RE.test(accessorLine) || ALLMAN_ACCESSOR_BODY_RE.test(accessorLine))) {
              isPropertyLine = true
              const propName = stripVerbatim(headerM[1] ?? '')
              symbols.push(makeLineSymbol(filePath, propName, 'var', lineNum, stripped.slice(0, 200), frame.name, lines, 'c'))
              currentMember = propName
              memberBodyEntered = false
            }
          } else {
            // Expression-bodied property (`Name => expr;`) - neither PROPERTY_RE nor the
            // Allman header match, since there is no `{` on this line or the next.
            arrowM = PROPERTY_ARROW_RE.exec(lineNoAttr)
            if (arrowM) {
              isPropertyLine = true
              const propName = stripVerbatim(arrowM[1] ?? '')
              symbols.push(makeLineSymbol(filePath, propName, 'var', lineNum, stripped.slice(0, 200), frame.name, lines, 'c'))
              currentMember = propName
              memberBodyEntered = false
            }
          }
        }
        // finalizer, operator overload and indexer: members with no identifier before their parameter list (or, for the indexer, no parameter parentheses), so METHOD_RE and the property patterns above cannot see them.
        let specialName: string | null = null
        let specialKind = 'method'
        finM = FINALIZER_RE.exec(lineNoAttr)
        if (finM && stripVerbatim(finM[1] ?? '') === frame.name) specialName = `~${frame.name}`
        else finM = null
        const opM = specialName === null && !isPropertyLine ? OPERATOR_RE.exec(lineNoAttr) : null
        if (opM && isDeclarationPrefix(lineNoAttr.slice(0, opM.index))) specialName = opM[1] !== undefined ? `operator ${opM[1].replace(/\s+/g, ' ').trim()}` : `operator${opM[2] !== undefined ? ' checked ' : ''}${opM[3] ?? ''}`
        const ixM = specialName === null && !isPropertyLine ? INDEXER_RE.exec(lineNoAttr) : null
        if (ixM && isDeclarationPrefix(lineNoAttr.slice(0, ixM.index))) {
          specialName = 'this[]'
          specialKind = 'var'
        }
        if (specialName !== null) {
          isPropertyLine = true
          const sigEnd = line.indexOf('{')
          const sig = sigEnd >= 0 ? line.slice(0, sigEnd).trimEnd() : line.trimEnd()
          symbols.push(makeLineSymbol(filePath, specialName, specialKind, lineNum, sig.slice(0, 200), frame.name, lines, 'c'))
          currentMember = specialName
          memberBodyEntered = line.includes('{')
        }
        // method - skipped when the property detection above already matched this line, so a
        // property/auto-property declaration is never double-processed as a phantom method too.
        methM = isPropertyLine ? null : METHOD_RE.exec(lineNoAttr)
        if (methM) {
          const mname = stripVerbatim(methM[1] ?? '')
          if (mname && mname !== frame.name) {
            const sigEnd = line.indexOf('{')
            const sig = sigEnd >= 0 ? line.slice(0, sigEnd).trimEnd() : line.trimEnd()
            symbols.push(makeLineSymbol(filePath, mname, 'method', lineNum, sig.slice(0, 200), frame.name, lines, 'c'))
            currentMember = mname
            memberBodyEntered = line.includes('{')
          }
        }
      }
    }

    // Brace-count and extract references on a string-stripped copy of the line. For interpolated
    // strings ($"..." or $@"..."), stripping comments from rawLine preserves holes containing executable code.
    const isInterpolatedLine = rawLine.includes('$"') || rawLine.includes('$@"') || rawLine.includes('@$"')
    const baseLine = isInterpolatedLine ? stripLineComment(rawLine) : stripLineComment(line)
    const braceLine = stripStringLiterals(baseLine, { tripleQuotes: true })

    if (!inFalseBlock && !stripped.startsWith('#')) {
      const declSpans: Array<{ name: string; col: number }> = []
      if (cm) {
        const name = stripVerbatim(cm[2] ?? '')
        declSpans.push({ name, col: line.indexOf(name) })
      }
      if (ctorM) {
        const name = stripVerbatim(ctorM[1] ?? '')
        declSpans.push({ name, col: line.indexOf(name) })
      }
      if (methM) {
        const name = stripVerbatim(methM[1] ?? '')
        declSpans.push({ name, col: line.indexOf(name) })
      }
      if (delM) {
        const name = stripVerbatim(delM[1] ?? '')
        declSpans.push({ name, col: line.indexOf(name) })
      }
      if (propM) {
        const name = stripVerbatim(propM[1] ?? '')
        declSpans.push({ name, col: line.indexOf(name) })
      }
      if (headerM) {
        const name = stripVerbatim(headerM[1] ?? '')
        declSpans.push({ name, col: line.indexOf(name) })
      }
      if (finM) declSpans.push({ name: stripVerbatim(finM[1] ?? ''), col: line.indexOf('~') + 1 })
      if (arrowM) {
        const name = stripVerbatim(arrowM[1] ?? '')
        declSpans.push({ name, col: line.indexOf(name) })
      }

      const isDeclaration = (name: string, col: number): boolean =>
        declSpans.some((d) => d.name === name && Math.abs(d.col - col) <= 2)

      const context = currentMember ?? (frame !== null ? frame.name : '')

      for (const m of braceLine.matchAll(CS_NEW_CALL_RE)) {
        const rawName = stripVerbatim(m[1] ?? '')
        const name = rawName.includes('.') ? rawName.slice(rawName.lastIndexOf('.') + 1) : rawName
        if (name.length < 1 || CS_REF_NOISE.has(name)) continue
        const nameOffset = m[0].lastIndexOf(name)
        const col = m.index !== undefined ? m.index + (nameOffset >= 0 ? nameOffset : 0) : 0
        if (isDeclaration(name, col)) continue
        const key = `${name}\0${lineNum}`
        if (!seenRefs.has(key)) {
          seenRefs.add(key)
          refs.push({ filePath, name, line: lineNum, col, context })
        }
      }

      for (const m of braceLine.matchAll(CS_INVOCATION_RE)) {
        const callee = stripVerbatim(m[2] ?? '')
        if (callee.length >= 1 && !CS_REF_NOISE.has(callee)) {
          const dotIdx = m[0].indexOf('.')
          const searchStart = dotIdx >= 0 ? m[0].lastIndexOf('.') + 1 : 0
          const calleeOffset = m[0].indexOf(callee, searchStart)
          const col = m.index !== undefined ? m.index + (calleeOffset >= 0 ? calleeOffset : 0) : 0
          if (!isDeclaration(callee, col)) {
            const key = `${callee}\0${lineNum}`
            if (!seenRefs.has(key)) {
              seenRefs.add(key)
              refs.push({ filePath, name: callee, line: lineNum, col, context })
            }
          }
        }
        const receiver = m[1] !== undefined ? stripVerbatim(m[1]) : ''
        if (receiver.length > 1 && !CS_REF_NOISE.has(receiver)) {
          const col = m.index !== undefined ? m.index + m[0].indexOf(receiver) : 0
          if (!isDeclaration(receiver, col)) {
            const key = `${receiver}\0${lineNum}`
            if (!seenRefs.has(key)) {
              seenRefs.add(key)
              refs.push({ filePath, name: receiver, line: lineNum, col, context })
            }
          }
        }
      }

      const nextCode = nextCodeLines(lines, i, 1)[0]
      if (nextCode?.startsWith('(')) {
        const mlMatch = CS_MULTILINE_INVOCATION_RE.exec(braceLine)
        if (mlMatch) {
          const callee = stripVerbatim(mlMatch[2] ?? '')
          if (callee.length >= 1 && !CS_REF_NOISE.has(callee)) {
            const dotIdx = mlMatch[0].indexOf('.')
            const searchStart = dotIdx >= 0 ? mlMatch[0].lastIndexOf('.') + 1 : 0
            const calleeOffset = mlMatch[0].indexOf(callee, searchStart)
            const col = mlMatch.index !== undefined ? mlMatch.index + (calleeOffset >= 0 ? calleeOffset : 0) : 0
            if (!isDeclaration(callee, col)) {
              const key = `${callee}\0${lineNum}`
              if (!seenRefs.has(key)) {
                seenRefs.add(key)
                refs.push({ filePath, name: callee, line: lineNum, col, context })
              }
            }
          }
          const receiver = mlMatch[1] !== undefined ? stripVerbatim(mlMatch[1]) : ''
          if (receiver.length > 1 && !CS_REF_NOISE.has(receiver)) {
            const col = mlMatch.index !== undefined ? mlMatch.index + mlMatch[0].indexOf(receiver) : 0
            if (!isDeclaration(receiver, col)) {
              const key = `${receiver}\0${lineNum}`
              if (!seenRefs.has(key)) {
                seenRefs.add(key)
                refs.push({ filePath, name: receiver, line: lineNum, col, context })
              }
            }
          }
        }
      }
    }

    const openBraces = (braceLine.match(/\{/g) ?? []).length
    const closeBraces = (braceLine.match(/\}/g) ?? []).length
    braceDepth += openBraces - closeBraces

    if (currentMember !== undefined) {
      if (!memberBodyEntered) {
        if (openBraces > 0 && braceDepth > (frame?.startDepth ?? 0) + 1) {
          memberBodyEntered = true
        } else if (stripped.endsWith(';')) {
          currentMember = undefined
        }
      } else if (frame === null || braceDepth <= frame.startDepth + 1) {
        currentMember = undefined
        memberBodyEntered = false
      }
    }

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

  return { symbols, refs, imports }
}
