export interface LibcAnswer {
  libc?: string[] | null
}
export type LibcLookup = (name: string, version: string) => Promise<LibcAnswer> | LibcAnswer
export interface LibcProblem {
  path: string
  message: string
}
export interface LibcRestoration {
  path: string
  libc: string[]
  source: 'previous lock' | 'registry'
}
export function bareLinuxPackages(lock: unknown): string[]
export function inPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void>
export function restoreLibc(options: { oldLock: unknown; newLock: unknown; lookup: LibcLookup }): Promise<{ restored: LibcRestoration[]; unresolved: LibcProblem[] }>
export function findMissingLibc(options: { lock: unknown; lookup: LibcLookup }): Promise<LibcProblem[]>
