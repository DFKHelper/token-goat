export interface PushRef {
  lref: string
  lsha: string
  rref: string
  rsha: string
}
export interface ChangedRow {
  status: string
  path: string
}
export interface SelectionIo {
  leg: string
  headSha: string
  pushText: string
  env: Record<string, string | undefined>
  changed: (from: string, to: string) => ChangedRow[] | null
  failed: () => string[]
  unparsedFailure: () => boolean
  exists: (rel: string) => boolean
  guards: () => string[]
  matrix: () => string[]
  mergeBase: (sha: string) => string | null
  readers: (named: string[], srcChanged: boolean) => string[][] | null
  importers: (modules: string[]) => Map<string, number> | null
  setups: (modules: string[]) => string[] | null
  durations: () => Record<string, number>
  workers: number
  onRemote?: (sha: string) => boolean
  allTests?: () => string[] | null
}
export type Selection = { full: true; why: string } | { full: false; files: string[]; note: string; deferred: string[]; deferredReport: string; doubts: string[] }
export function orNull<T>(fn: () => T): T | null
export function importSeams(read: (modules: string[]) => { tests: Map<string, number>; setups: string[] }): { importers: (modules: string[]) => Map<string, number> | null; setups: (modules: string[]) => string[] | null }
export function parsePushRefs(text: string): { refs: PushRef[]; bad: string | null }
export function rangeOf(ref: PushRef, base?: string | null): { from: string; to: string } | { doubt: string }
export function classifyPath(status: string, p: string): { kind: 'test' | 'module' | 'doc' | 'skip' } | { doubt: string }
export function parseNameStatus(out: string): ChangedRow[]
export function decideSelection(io: SelectionIo): Selection
export function onEveryRemote(git: (...args: string[]) => string, sha: string): boolean
