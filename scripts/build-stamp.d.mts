export interface BuildStamp {
  commit: string
  builtAt: string
  stamp: string
}
export const BUILD_INFO_FILE: string
export const UNKNOWN_STAMP: string
export function shortCommit(root: string): string
export function computeBuildStamp(root: string, now?: Date): BuildStamp
export function buildInfoPath(root: string): string
export function clearBuildInfo(root: string): void
export function writeBuildInfo(root: string, version: string, info: BuildStamp): void
