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
  readers: () => string[] | null
}
export type Selection = { full: true; why: string } | { full: false; files: string[]; note: string }
export function parsePushRefs(text: string): { refs: PushRef[]; bad: string | null }
export function rangeOf(ref: PushRef, headSha: string): { from: string; to: string } | { full: string }
export function classifyPath(status: string, p: string): { kind: 'test' | 'module' | 'skip' } | { full: string }
export function parseNameStatus(out: string): ChangedRow[]
export function decideSelection(io: SelectionIo): Selection
