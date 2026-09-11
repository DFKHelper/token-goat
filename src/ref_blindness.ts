/**
 * Honest answers for questions the reference index cannot answer.
 *
 * `refs`, `callers`, `dead` and their siblings all read the same `refs` table, and that table is
 * not populated uniformly. Two independent blind spots exist, and in both of them an empty result
 * set is indistinguishable from a genuine "this symbol has no callers":
 *
 *  1. Language. `src/parser.ts`'s `REF_LANGUAGES` records call-site references for nine
 *     tree-sitter languages only. Every other language token-goat indexes -- C#, PHP, Kotlin,
 *     Swift, Scala, Dart, Elixir, Lua, R, Zig, PowerShell, Apex, SQL, GraphQL, proto, Terraform,
 *     Vue/Svelte/Astro, and the config/markup families -- yields symbols but never a single ref
 *     row, so every symbol in those files reads as unreferenced.
 *  2. Kind. Even inside a ref-indexed language, only value-position usages are recorded (call,
 *     `new`, macro invocation, and a few bare-identifier shapes). A name used only as a type
 *     annotation is never recorded, so a type declaration reads as unreferenced no matter how
 *     widely it is used. See {@link REF_BLIND_KIND_REASON}.
 *
 * This repo's disclosure contract says a zero means "none found", never "none exists". These
 * helpers are how the affected commands say so.
 */
import { detectLanguage } from './parser_types.js'
import type { Language } from './parser_types.js'

// Mirror of `REF_LANGUAGES` in src/parser.ts (the set gating `extractRefs`). Deliberately duplicated rather than imported: src/parser.ts is hashed into PARSER_FINGERPRINT (scripts/parser-fingerprint.mjs digests src/parser.ts plus src/languages/**), so adding an `export` keyword there would change the stamp and force every existing user to fully reindex on upgrade, for a change that alters nothing about extraction. tests/ref_blindness.test.ts parses the literal out of src/parser.ts and asserts set equality, so the two cannot drift apart silently.
export const REF_INDEXED_LANGUAGES: ReadonlySet<Language> = new Set<Language>([
  'typescript',
  'javascript',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'ruby',
])

/** True when the reference index records call sites for this language at all. False means every `refs`/`callers` answer for a file in it is an empty set produced by the indexer's blindness, not by the code. */
export function isRefIndexedLanguage(language: Language): boolean {
  return REF_INDEXED_LANGUAGES.has(language)
}

/** {@link isRefIndexedLanguage} for a file path, resolving the language the same way the indexer did. */
export function isRefIndexedFile(filePath: string): boolean {
  return isRefIndexedLanguage(detectLanguage(filePath))
}

// Display spellings for the language ids that are not already their own proper name. Anything absent renders as its id, which is already the conventional spelling ('python', 'go', 'rust').
const LANGUAGE_LABELS: ReadonlyMap<Language, string> = new Map<Language, string>([
  ['csharp', 'C#'],
  ['cpp', 'C++'],
  ['c', 'C'],
  ['php', 'PHP'],
  ['powershell', 'PowerShell'],
  ['vb', 'Visual Basic'],
  ['sql', 'SQL'],
  ['graphql', 'GraphQL'],
  ['proto', 'Protocol Buffers'],
  ['html', 'HTML'],
  ['css', 'CSS'],
  ['toml', 'TOML'],
  ['json', 'JSON'],
  ['yaml', 'YAML'],
  ['ini', 'INI'],
  ['env_file', 'env file'],
  ['ipynb', 'Jupyter notebook'],
  ['salesforce_metadata', 'Salesforce metadata'],
  ['salesforce_markup', 'Salesforce markup'],
  ['unknown', 'this file type'],
])

/** Human spelling of a language id, for a message a person reads. */
export function languageLabel(language: Language): string {
  return LANGUAGE_LABELS.get(language) ?? language
}

/** The message a single-symbol reference lookup emits instead of a bare empty result, when the symbol's own defining file is in a language the reference index never records call sites for. Names the language and says the absence is the index's, so it cannot be read as "this symbol is unused". */
export function refBlindLanguageNotice(symbolName: string, language: Language, displayPath: string): string {
  return `Cannot determine references for '${symbolName}': ${languageLabel(language)} call sites are not indexed (${displayPath}). ` +
    'This is a gap in token-goat\'s index, not evidence the symbol is unreferenced. ' +
    `Search the source directly instead, e.g. \`rg -n -w ${symbolName}\`.`
}

// Why the type-declaration kinds below cannot be assessed for deadness, quoted verbatim into every message that reports the exclusion so the caller is told the mechanism rather than just the verdict.
export const REF_BLIND_KIND_REASON =
  'the index records value-position references only (calls, `new`, macro invocations), never type annotations, so a type declaration has no ref rows however widely it is used'

// How many definitions of one name a single-symbol reference lookup fetches when deciding whether every one of them sits in a ref-blind language. Unbounded (-1), not a finite cap: querySymbols orders by (file_path, line_start), so a name-scoped probe with no other predicate returns a deterministic alphabetical PREFIX of the definitions, not a representative sample -- a name defined 50+ times where the alphabetically-first definitions happen to share a ref-blind language (e.g. many .ps1 files in a directory that sorts before the one real TypeScript definition) truncates the genuinely ref-indexed definition clean off the probe, so the all-or-nothing verdict wrongly reports "every definition is ref-blind" for a symbol that WAS fully searched and genuinely has zero real references (confirmed with a 51-definition fixture: 50 PowerShell defs sorting before one TypeScript def). The verdict is still all-or-nothing, but only an unbounded probe can honestly answer it.
export const REF_BLIND_DEF_PROBE_LIMIT = -1

// Renders one kind id with its indefinite article, so a message reads "is an interface" / "is a struct" rather than naming the id bare. Vowel test only: every kind id in REF_BLIND_KINDS is an ordinary lowercase word or an underscore-joined pair of them, none of them a silent-h or long-u word where the vowel rule misfires.
function kindWithArticle(kind: string): string {
  return `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`
}

// How the blind kinds of one name's definitions are spelled inside a sentence: a single kind reads as "'Foo' is an interface", several as a list, since a name defined once as an interface and once as a type alias is one symbol with two type-position declarations and neither is more the answer than the other.
function refBlindKindClause(symbolName: string, kinds: ReadonlyArray<string>): string {
  const first = kinds[0]
  if (kinds.length === 1 && first !== undefined) return `'${symbolName}' is ${kindWithArticle(first)}`
  return `every definition of '${symbolName}' is a type declaration (${kinds.map((k) => `'${k}'`).join(', ')})`
}

/** The message a single-symbol reference lookup emits instead of a bare empty result, when every definition of the name is of a kind whose usages the index never records: the sibling of {@link refBlindLanguageNotice} for the second blind spot. Names the kind, quotes {@link REF_BLIND_KIND_REASON} for the mechanism so there is one wording rather than two, and points at a search that does answer the question. */
export function refBlindKindNotice(symbolName: string, kinds: ReadonlyArray<string>): string {
  return `Cannot determine references for '${symbolName}': ${refBlindKindClause(symbolName, kinds)}, and ${REF_BLIND_KIND_REASON}. ` +
    'This is a gap in token-goat\'s index, not evidence the symbol is unreferenced. ' +
    `Search the source directly instead, e.g. \`rg -n -w ${symbolName}\`.`
}

/** The note emitted alongside an ordinary empty result when only SOME definitions of the name are of a ref-blind kind. The remaining ones were genuinely searched, so the result stands for them and is not refused, but dropping the blind ones without a word is the same defect wearing the opposite sign: it presents a partial answer as a whole one. */
export function refBlindKindPartialNote(symbolName: string, kinds: ReadonlyArray<string>, blindCount: number, totalCount: number): string {
  return `Note: ${blindCount} of ${totalCount} definitions of '${symbolName}' (${kinds.map((k) => `'${k}'`).join(', ')}) are not covered by this result -- ${REF_BLIND_KIND_REASON}. ` +
    `The empty result above speaks only for the other ${totalCount - blindCount}; for the rest, search the source directly, e.g. \`rg -n -w ${symbolName}\`.`
}
