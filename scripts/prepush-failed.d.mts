export interface FailureRecord {
  sha: string
  files: string[]
}
export function loadStore(store: string): Record<string, FailureRecord>
export function recordFailure(store: string, leg: string, sha: string, files: string[]): void
export function readFailure(store: string, leg: string): FailureRecord | null
export function clearFailure(store: string, leg: string): void
