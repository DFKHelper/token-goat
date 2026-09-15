export interface SyncArchDocsOptions {
  check?: boolean
  write?: boolean
  srcDir?: string
  archDocPath?: string
}

export interface SyncArchDocsResult {
  ok: boolean
  count: number
  added?: string[]
  removed?: string[]
  drift?: boolean
}

export function syncArchDocs(options?: SyncArchDocsOptions): SyncArchDocsResult
export function scanSourceFiles(dir?: string): string[]
export function toPosixRel(fullPath: string, rootDir?: string): string
export function extractExistingDescriptions(content: string): Map<string, string>
