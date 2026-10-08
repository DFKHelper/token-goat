export interface LockProblem {
  dependent: string
  field: string
  name: string
  spec: string
  declaredSpec?: string
  kind: 'mismatch' | 'missing' | 'unsupported'
  resolvedPath?: string
  resolvedVersion?: string
}
export function parseRange(spec: string): unknown[][] | null
export function satisfies(versionText: string, spec: string): boolean | null
export function resolveEntry(packages: Record<string, unknown>, from: string, name: string): { path: string; entry: Record<string, unknown> } | null
export function checkLockConsistency(lock: unknown, options?: { overrides?: Record<string, unknown> }): LockProblem[]
export function checkLockFiles(root: string): LockProblem[]
export function formatProblem(problem: LockProblem): string
