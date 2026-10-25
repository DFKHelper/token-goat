export interface FailureRecord {
  sha: string
  files: string[]
  unparsed?: boolean
}
export function inspectStore(store: string): { data: Record<string, FailureRecord>; corrupt: boolean }
export function loadStore(store: string): Record<string, FailureRecord>
export function recordFailure(store: string, leg: string, sha: string, files: string[], unparsed?: boolean): boolean
export function readFailure(store: string, leg: string): FailureRecord | null
export function hasUnparsedFailure(store: string, leg: string): boolean
export function clearFailure(store: string, leg: string): void
