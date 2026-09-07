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

// How many definitions of one name a single-symbol reference lookup fetches when deciding whether every one of them sits in a ref-blind language. The verdict is all-or-nothing, and a handful of rows settles it; nothing here needs the full definition list.
export const REF_BLIND_DEF_PROBE_LIMIT = 50
