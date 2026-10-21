export const TARGET_WORDS: string[]
export const TARGET_PUNCTUATION: string
export const FIXTURE_PATH: string
export const SOURCE_PATH: string
export const ENTRIES_PREFIX: string
export function targetCharacters(): Set<string>
export function filterRows(fullText: string): string[]
export function normalizationFold(ch: string): string
export function deriveEntries(rows: string[]): string
