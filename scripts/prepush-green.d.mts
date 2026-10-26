export const MAX_ENTRIES: number
export const STATIC_LEG: string
export interface KeyParts {
  leg: string
  platform: string
  node: string
  root: string
  deps: string
  dist: string
  env: string
}
export interface GreenEntry extends KeyParts {
  tree: string
  at: number
  done: string[]
}
export function reuseOff(env: Record<string, string | undefined>): boolean
export function recordOff(env: Record<string, string | undefined>): boolean
export function treeId(root: string): string | null
export function keyParts(root: string, leg: string, env?: Record<string, string | undefined>): KeyParts
export function storePath(root: string, env?: Record<string, string | undefined>): string | null
export function readEntries(store: string): GreenEntry[]
export function isGreen(store: string, tree: string, parts: KeyParts, name: string): boolean
export function recordGreen(store: string, tree: string, parts: KeyParts, names: string[], now?: number): void
export function runChecked(root: string, name: string, leg: string, cmd: string[], env?: Record<string, string | undefined>): number
export function splitGreen(files: string[], entries: GreenEntry[], tree: string, parts: KeyParts, staticParts: KeyParts): { keep: string[]; reused: string[] }
