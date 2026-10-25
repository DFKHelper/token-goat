export interface FileDuration {
  file: string
  ms: number
  detail: string
}
export function parseDurations(text: string): FileDuration[]
export function parseFailedFiles(text: string): string[]
export function slowest(entries: readonly FileDuration[], n: number): FileDuration[]
export function formatTable(entries: readonly FileDuration[]): string
export function parseFailedRun(text: string): { files: string[]; trusted: boolean; reason: string }
export function durationsPath(store: string): string
export function readDurations(file: string, leg: string): Record<string, number>
export function recordDurations(file: string, leg: string, entries: readonly { file: string; ms: number }[]): void
export function medianMs(values: readonly number[]): number | null
