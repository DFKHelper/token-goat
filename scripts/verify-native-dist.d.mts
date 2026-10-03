export interface NativeTarget {
  readonly triple: string
  readonly platformArch: string
  readonly exe: string
  readonly format: 'pe' | 'elf'
  readonly machine: number
}

export const NATIVE_TARGETS: readonly NativeTarget[]
export function peSignatureProblem(buf: Buffer, machine: number): string | undefined
export function elfProblem(buf: Buffer, machine: number): string | undefined
export function parseManifest(text: string, label?: string): { entries: Map<string, string>; problems: string[] }
export function releaseTargets(withoutWindows?: boolean): readonly NativeTarget[]
export function verifyNativeDist(dir: string, manifests: Record<string, string>, options?: { withoutWindows?: boolean }): string[]
export function verifyPackDir(dir: string): string[]
