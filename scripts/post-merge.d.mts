type ProcessRow = {
  pid: number
  ppid: number
  createdMs: number
}

type ProcessIdentity = {
  pid: number
  createdMs: number
}

export const PROCESS_TERMINATE_SCRIPT: string

export function selectSurvivors(
  rows: readonly ProcessRow[],
  rootPid: number,
  spawnedAtMs: number,
  rootExitedAtMs: number,
  rootExited?: boolean,
): ProcessIdentity[]

export function shouldKillSurvivor(
  target: ProcessIdentity,
  current: ProcessIdentity | null | undefined,
  excludedPids?: ReadonlySet<number>,
): boolean

export function killVerifiedSurvivors(
  targets: readonly ProcessIdentity[],
  readCurrent: (pid: number) => ProcessIdentity | null | undefined,
  killFn: (targets: readonly ProcessIdentity[]) => void,
  excludedPids?: ReadonlySet<number>,
): ProcessIdentity[]

type WindowsProcessTerminationResult = {
  pid: number
  createdMs: number
  verified: boolean
  cutoffMs: number
}

type WindowsOwnedTreeDrainOptions = {
  snapshotFn: () => readonly ProcessRow[] | null
  killBatchFn: (targets: readonly ProcessIdentity[]) => false | readonly WindowsProcessTerminationResult[]
  maxPasses?: number
}

type WindowsOwnedTreeOptions = {
  snapshotFn?: WindowsOwnedTreeDrainOptions['snapshotFn']
  killBatchFn?: WindowsOwnedTreeDrainOptions['killBatchFn']
  maxPasses?: number
  runWindowsPowerShellFn?: (
    script: string,
    targets?: readonly ProcessIdentity[],
  ) => {
    status: number | null
    stdout: string
    stderr: string
    error?: Error
  }
}

type WindowsOwnedTreeDrainResult =
  | { status: 'converged'; passes: number }
  | { status: 'aborted'; passes: number; reason: 'snapshot' | 'kill' }
  | { status: 'exhausted'; passes: number }

export function drainWindowsOwnedTree(
  rootPid: number,
  spawnedAtMs: number,
  rootExitedAtMs: number,
  options: WindowsOwnedTreeDrainOptions,
): WindowsOwnedTreeDrainResult

export function endWindowsOwnedTree(
  rootPid: number | undefined,
  spawnedAtMs: number,
  rootExitedAtMs: number,
  options?: WindowsOwnedTreeOptions,
): WindowsOwnedTreeDrainResult | undefined
