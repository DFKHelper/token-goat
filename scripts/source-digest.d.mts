export function bundleStampPath(root: string): string
export function buildScripts(root: string): string[]
export function sourceDigest(root: string): string
export function readBundleStamp(root: string): string | null
export function clearBundleStamp(root: string): void
export function writeBundleStamp(root: string, digest: string): void
