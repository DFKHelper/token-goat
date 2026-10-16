export interface FileDuration {
  file: string
  ms: number
  detail: string
}
export function parseDurations(text: string): FileDuration[]
export function slowest(entries: readonly FileDuration[], n: number): FileDuration[]
export function formatTable(entries: readonly FileDuration[]): string
