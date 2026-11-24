/** `<dataDir>/hook-entry.json`, the pointer to where this install's bundle lives, and `<dataDir>/hook-broken.json`, the notice the native client leaves when a hook call could not use its first route. The pointer is what lets a hook command whose baked entry path has gone missing (a dev checkout deleted, a package moved) still reach the current bundle. Install, upgrade and the native-copy sync write it; the native client (native/tg-hook/src/pointer.rs) and the Node shim read it. tests/fixtures/hook_pointer/cases.json is judged by both this reader and the Rust one. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { dataDir, VERSION } from './constants.js'
import { atomicWriteText } from './util.js'
import { installNodePath, plainWindowsPath } from './process_util.js'

export const HOOK_POINTER_FILE = 'hook-entry.json'
export const HOOK_BROKEN_FILE = 'hook-broken.json'
/** The largest pointer file either reader accepts; the writer's output is a few hundred bytes. */
export const HOOK_POINTER_MAX_BYTES = 4096
const ENTRY_NAME = 'token-goat.mjs'
const SHIM_NAME = 'token-goat-shim.cjs'

export interface HookPointer {
  readonly schema: 1
  readonly version: string
  readonly bundleDir: string
  readonly entry: string
  readonly node: string | null
  readonly shim: string | null
  /** Additive: each harness's own shim (the shims differ per harness), for the harnesses whose shim exists. */
  readonly shims: Readonly<Record<string, string>>
  readonly nativeBin: string
  readonly writtenAt: string
}

/** A pointer that passed every structural check, with which of its optional files exist. `entry` exists, or the pointer is not usable. */
export interface ValidPointer {
  readonly entry: string
  readonly node: string | undefined
  readonly shim: string | undefined
  readonly shims: Readonly<Record<string, string>>
}

export function hookPointerPath(home: string = dataDir()): string {
  return path.join(home, HOOK_POINTER_FILE)
}

export function hookBrokenPath(home: string = dataDir()): string {
  return path.join(home, HOOK_BROKEN_FILE)
}

function baseOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? ''
}

function nameMatches(p: string, names: readonly string[]): boolean {
  const base = baseOf(p)
  return names.some((n) => (process.platform === 'win32' ? base.toLowerCase() === n.toLowerCase() : base === n))
}

/** Absolute, no `..`, no UNC or device namespace, no NUL: the checks the Rust reader makes. */
function structurallySound(p: string): string | undefined {
  if (p === '' || p.includes('\0')) return 'empty path or NUL'
  if (p.startsWith('\\\\') || p.startsWith('//')) return `UNC or device path ${p}`
  if (!path.isAbsolute(p)) return `not an absolute path: ${p}`
  if (p.split(/[\\/]/).includes('..')) return `parent reference in ${p}`
  return undefined
}

function existingFile(p: string): boolean {
  try {
    return fs.statSync(fs.realpathSync(p)).isFile()
  } catch {
    return false
  }
}

function trimmedDir(dir: string): string {
  let text = dir.replace(/\\/g, '/')
  while (text.length > 1 && text.endsWith('/')) text = text.slice(0, -1)
  return process.platform === 'win32' ? text.toLowerCase() : text
}

/** Why the reader would reject this `nativeBin`, or undefined; the writer asks the same question. */
function nativeBinProblem(nativeBin: string): string | undefined {
  const bad = structurallySound(nativeBin)
  if (bad !== undefined) return bad
  if (nameMatches(nativeBin, ['tg-hook', 'tg-hook.exe'])) return undefined
  return `nativeBin is not tg-hook: ${nativeBin}`
}

/** Judges the text of a pointer file exactly as the native client does. */
export function validateHookPointer(text: string): { readonly ok: true; readonly pointer: ValidPointer } | { readonly ok: false; readonly reason: string } {
  const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })
  if (Buffer.byteLength(text) > HOOK_POINTER_MAX_BYTES) return fail(`larger than ${String(HOOK_POINTER_MAX_BYTES)} bytes`)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (e) {
    return fail(`not JSON: ${(e as Error).message}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('not an object')
  const o = value as Record<string, unknown>
  if (o['schema'] !== 1) return fail('schema is not 1')
  if (typeof o['version'] !== 'string' || typeof o['writtenAt'] !== 'string') return fail('version or writtenAt missing')
  const str = (key: string): string | undefined => (typeof o[key] === 'string' ? o[key] : undefined)
  const entry = str('entry')
  if (entry === undefined) return fail('entry missing')
  const entryBad = structurallySound(entry)
  if (entryBad !== undefined) return fail(entryBad)
  if (!nameMatches(entry, [ENTRY_NAME])) return fail(`entry is not ${ENTRY_NAME}: ${entry}`)
  const bundle = str('bundleDir')
  if (bundle === undefined) return fail('bundleDir missing')
  const bundleBad = structurallySound(bundle)
  if (bundleBad !== undefined) return fail(bundleBad)
  const entryDir = /^(.*)[\\/][^\\/]*$/.exec(entry)?.[1] ?? ''
  if (trimmedDir(bundle) !== trimmedDir(entryDir)) return fail(`bundleDir ${bundle} is not the directory of ${entry}`)
  const nativeBin = str('nativeBin')
  if (nativeBin === undefined) return fail('nativeBin missing')
  const nativeBad = nativeBinProblem(nativeBin)
  if (nativeBad !== undefined) return fail(nativeBad)
  const optional = (key: string, names: readonly string[]): { value: string | undefined; error?: string } => {
    const v = o[key]
    if (v === undefined || v === null) return { value: undefined }
    if (typeof v !== 'string') return { value: undefined, error: `${key} is not a string or null` }
    const bad = structurallySound(v)
    if (bad !== undefined) return { value: undefined, error: bad }
    if (!nameMatches(v, names)) return { value: undefined, error: `${key} has an unexpected name: ${v}` }
    return { value: existingFile(v) ? v : undefined }
  }
  const node = optional('node', ['node', 'node.exe'])
  if (node.error !== undefined) return fail(node.error)
  const shim = optional('shim', [SHIM_NAME])
  if (shim.error !== undefined) return fail(shim.error)
  const shims: Record<string, string> = {}
  const rawShims = o['shims']
  if (typeof rawShims === 'object' && rawShims !== null && !Array.isArray(rawShims)) {
    for (const [harness, p] of Object.entries(rawShims)) {
      if (typeof p !== 'string' || structurallySound(p) !== undefined || !nameMatches(p, [SHIM_NAME])) continue
      if (existingFile(p)) shims[harness] = p
    }
  }
  if (!existingFile(entry)) return fail(`entry file is missing: ${entry}`)
  return { ok: true, pointer: { entry, node: node.value, shim: shim.value, shims } }
}

/** Reads and validates the pointer in `home`. */
export function readHookPointer(home: string = dataDir()): ReturnType<typeof validateHookPointer> {
  const file = hookPointerPath(home)
  let text: string
  try {
    const size = fs.statSync(file).size
    if (size > HOOK_POINTER_MAX_BYTES) return { ok: false, reason: `larger than ${String(HOOK_POINTER_MAX_BYTES)} bytes` }
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return { ok: false, reason: `cannot read ${file}: ${(e as Error).message}` }
  }
  return validateHookPointer(text)
}

const shimLocators = new Map<string, () => string>()

/** Each harness's installer registers where its shim lives, so this leaf module imports none of them (they import it). */
export function registerHookShim(harness: string, locate: () => string): void {
  shimLocators.set(harness, locate)
}

/** The shim each registered harness installer writes, for the shims that exist now. */
function existingShims(): Record<string, string> {
  const found: Record<string, string> = {}
  for (const [harness, locate] of shimLocators) {
    try {
      const p = locate()
      if (existingFile(p)) found[harness] = p
    } catch {
      // a harness whose home cannot be resolved has no shim to name
    }
  }
  return found
}

/** Writes the pointer for the bundle at `entry`, atomically, only once the entry exists, and keeps the old file when the write fails. Returns whether the pointer on disk now names `entry`; never throws, since a pointer is a repair aid and must not fail an install. */
export function writeHookPointer(entry: string, nativeBin: string, home: string = dataDir(), now: () => Date = () => new Date()): boolean {
  try {
    const resolved = plainWindowsPath(path.resolve(entry))
    if (!nameMatches(resolved, [ENTRY_NAME]) || !existingFile(resolved)) return false
    // The reader rejects the whole pointer for a bad nativeBin, so keep the old one rather than write that.
    const nativeResolved = plainWindowsPath(path.resolve(nativeBin))
    if (nativeBinProblem(nativeResolved) !== undefined) return false
    const shims = existingShims()
    const pointer: HookPointer = {
      schema: 1,
      version: VERSION,
      bundleDir: path.dirname(resolved),
      entry: resolved,
      node: existingFile(process.execPath) ? installNodePath() : null,
      shim: Object.values(shims)[0] ?? null,
      shims,
      nativeBin: nativeResolved,
      writtenAt: now().toISOString(),
    }
    fs.mkdirSync(home, { recursive: true })
    const text = `${JSON.stringify(pointer)}\n`
    atomicWriteText(hookPointerPath(home), text)
    // The shims read no home location, so each finds a copy beside itself; a failed copy leaves that shim on its baked entry.
    for (const shim of Object.values(shims)) {
      try {
        atomicWriteText(path.join(path.dirname(shim), HOOK_POINTER_FILE), text)
      } catch {
        // the shim keeps working from its baked entry
      }
    }
    return true
  } catch {
    return false
  }
}

export interface HookBrokenEvent {
  readonly time: string
  readonly route: string
  readonly path: string
  readonly error: string
}

export interface HookBroken {
  readonly first: string
  readonly last: string
  readonly count: number
  readonly events: readonly HookBrokenEvent[]
}

/** The notice the native client leaves, or undefined when there is none or it cannot be read as one. */
export function readHookBroken(home: string = dataDir()): HookBroken | undefined {
  try {
    const file = hookBrokenPath(home)
    if (fs.statSync(file).size > HOOK_POINTER_MAX_BYTES) return undefined
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<HookBroken> & { schema?: number }
    if (v.schema !== 1 || typeof v.count !== 'number' || !Array.isArray(v.events)) return undefined
    return { first: String(v.first), last: String(v.last), count: v.count, events: v.events }
  } catch {
    return undefined
  }
}

/** Removes the notice: what it described is repaired. Absent already is success. */
export function clearHookBroken(home: string = dataDir()): void {
  try {
    fs.rmSync(hookBrokenPath(home), { force: true })
  } catch {
    // a notice that cannot be removed stays; doctor reports it again
  }
}
