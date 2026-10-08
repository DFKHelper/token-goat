export interface LockDiff {
  added: { path: string; name: string; version: string }[]
  removed: { path: string; name: string; version: string }[]
  changed: { path: string; name: string; from: string; to: string; integrityChanged: boolean }[]
  flagChanges: { path: string; flag: string; from: boolean; to: boolean }[]
  dependencyChanges: { path: string; field: string; name: string; from: string | null; to: string | null }[]
  newInstallScripts: string[]
  rootReclassified: { name: string; from: string; to: string }[]
}
export interface Violation {
  kind: 'cooldown' | 'integrity' | 'lookup' | 'optional-lost' | 'reclassified' | 'integrity-same-version' | 'inconsistent'
  path: string
  message: string
}
export interface RegistryAnswer {
  publishedAt: string | null
  integrity: string | null
}
export function packageName(lockPath: string, entry: { name?: string } | undefined): string
export function diffLocks(oldLock: unknown, newLock: unknown): LockDiff
export function formatDiff(diff: LockDiff): string[]
export function auditLockChange(options: {
  oldLock: unknown
  newLock: unknown
  overrides?: Record<string, unknown>
  cooldownDays: number
  at: Date
  lookup: (name: string, version: string) => Promise<RegistryAnswer> | RegistryAnswer
}): Promise<{ diff: LockDiff; violations: Violation[] }>
export function parseNpmView(stdout: string, version: string): RegistryAnswer
