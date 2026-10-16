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
