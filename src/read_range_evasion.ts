/** Sticky, epoch-scoped explicit-range refusals and bounded recent-window evasion detection. */
import { quotedArg } from './hint_suggestion_guard.js'

export type ReadRange = readonly [number, number]
type Identity = { size: number; mtimeMs: number }
type Visit = { span: [number, number]; at: number }
export interface RangeEvasionState {
  resetAt: number
  denied: Visit[]
  recent: Visit[]
  identity?: Identity
}
export type RangeEvasionEntries = Array<[string, RangeEvasionState]>
export type RangeEvasionReason = 'locked' | 'same_anchor' | 'micro_shift' | 'overlap'

let states = new Map<string, RangeEvasionState>()
let clock = 0

function stamp(): number {
  clock = Math.max(Date.now(), clock + 1)
  return clock
}

function stateFor(key: string): RangeEvasionState {
  const state = states.get(key) ?? { resetAt: 0, denied: [], recent: [] }
  states.set(key, state)
  return state
}

/** Decide from recent spans only; distant historical ranges cannot create micro-shift matches. */
export function evaluateRangeEvasion(options: {
  span: ReadRange
  served: ReadonlyArray<ReadRange>
  denied?: ReadonlyArray<ReadRange>
  locked?: boolean
}): RangeEvasionReason | null {
  if (options.locked) return 'locked'
  const [start, end] = options.span
  const denied = options.denied ?? []
  const recent = [...options.served.slice(-3), ...denied].slice(-3)
  const overlap = ([s, e]: ReadRange): number => Math.max(0, Math.min(end, e) - Math.max(start, s) + 1)
  const anchored = recent.filter(([s]) => s === start)
  if (anchored.length >= 3 || anchored.some(([, e]) => Math.abs(end - e) <= 20)) return 'same_anchor'
  const microCandidates = [...options.served.slice(-2), ...denied.slice(-1)]
  if (microCandidates.some(([s, e]) => {
    const startDelta = Math.abs(start - s)
    const endDelta = Math.abs(end - e)
    return startDelta >= 1 && startDelta <= 15 && endDelta >= 1 && endDelta <= 15 && overlap([s, e]) > 0
  })) return 'micro_shift'
  if (recent.some(([s, e]) => {
    // A deliberate same-anchor expansion by >20 lines is allowed until the fourth window.
    if (s === start && end - e > 20) return false
    return overlap([s, e]) >= Math.min(end - start + 1, e - s + 1) / 2
  })) return 'overlap'
  return null
}

/** Any retained denied span locks this file until its ranges or compaction epoch are reset. */
export function getReadRangeDenials(key: string): ReadonlyArray<ReadRange> {
  return states.get(key)?.denied.map((v) => v.span) ?? []
}

/** Called before returning a range deny, never relying on post_tool_use for refused reads. */
export function lockReadRange(key: string, span: ReadRange, identity?: Identity): void {
  const state = stateFor(key)
  state.denied.push({ span: [span[0], span[1]], at: stamp() })
  state.denied = state.denied.slice(-3)
  if (identity) state.identity = identity
}

/** Separate from the containment ledger, whose disk-first cap intentionally preserves coverage. */
export function recordRecentReadRange(key: string, span: ReadRange): void {
  const state = stateFor(key)
  // Both pre and post hooks book a successful window. That pair is one visit, not two slices.
  const last = state.recent.at(-1)?.span
  if (last?.[0] === span[0] && last[1] === span[1]) return
  state.recent.push({ span: [span[0], span[1]], at: stamp() })
  state.recent = state.recent.slice(-3)
}

export function getRecentReadRanges(key: string): ReadonlyArray<ReadRange> {
  return states.get(key)?.recent.map((v) => v.span) ?? []
}

/** A denied-only file may have no served-range identity; its lock carries its own fingerprint. */
export function clearReadRangeIfChanged(key: string, identity: Identity | undefined): void {
  const prior = states.get(key)?.identity
  if (prior && identity && (prior.size !== identity.size || prior.mtimeMs !== identity.mtimeMs)) clearReadRangeEvasion(key)
}

export function clearReadRangeEvasion(key: string): void {
  // Persist the reset generation so an overlapping hook's stale snapshot cannot resurrect a lock.
  states.set(key, { resetAt: stamp(), denied: [], recent: [] })
}

export function clearAllReadRangeEvasion(): void {
  states.clear()
}

/** Session persistence preserves the lock across the per-call hook processes. */
export function exportReadRangeEvasion(): RangeEvasionEntries {
  return structuredClone(Array.from(states))
}

export function importReadRangeEvasion(entries: RangeEvasionEntries): void {
  states = new Map(structuredClone(entries))
  for (const [, state] of states) {
    clock = Math.max(clock, state.resetAt, ...state.recent.map((v) => v.at), ...state.denied.map((v) => v.at))
  }
}

/** Validate persisted state at the JSON boundary, without trusting arbitrary ranges or timestamps. */
export function coerceReadRangeEvasion(raw: unknown): RangeEvasionEntries {
  if (!Array.isArray(raw)) return []
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
  const visits = (rawVisits: unknown): Visit[] => {
    if (!Array.isArray(rawVisits)) return []
    return rawVisits.flatMap((v: unknown): Visit[] => {
      if (typeof v !== 'object' || v === null || !('span' in v) || !('at' in v)) return []
      const span: unknown = v.span
      if (!Array.isArray(span) || span.length !== 2 || !finite(span[0]) || !finite(span[1]) ||
        !Number.isInteger(span[0]) || !Number.isInteger(span[1]) || span[0] < 1 || span[1] < span[0] || !finite(v.at)) return []
      return [{ span: [span[0], span[1]], at: v.at }]
    }).slice(-3)
  }
  return raw.flatMap((pair: unknown): RangeEvasionEntries => {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') return []
    const value: unknown = pair[1]
    if (typeof value !== 'object' || value === null || !('resetAt' in value) || !finite(value.resetAt)) return []
    const state: RangeEvasionState = {
      resetAt: value.resetAt,
      denied: visits('denied' in value ? value.denied : undefined),
      recent: visits('recent' in value ? value.recent : undefined),
    }
    if ('identity' in value && typeof value.identity === 'object' && value.identity !== null &&
      'size' in value.identity && 'mtimeMs' in value.identity && finite(value.identity.size) && finite(value.identity.mtimeMs)) {
      state.identity = { size: value.identity.size, mtimeMs: value.identity.mtimeMs }
    }
    return [[pair[0], state]]
  })
}

/** Reset generations win over stale locks; recent visits merge by observation time, not coverage. */
export function mergeReadRangeEvasion(disk: RangeEvasionEntries, mem: RangeEvasionEntries): RangeEvasionEntries {
  const merged = new Map(structuredClone(disk))
  const mergeVisits = (a: Visit[], b: Visit[]): Visit[] =>
    Array.from(new Map([...a, ...b].map((v) => [JSON.stringify(v), v])).values()).sort((a, b) => a.at - b.at).slice(-3)
  for (const [key, state] of mem) {
    const prior = merged.get(key)
    if (!prior || state.resetAt > prior.resetAt) {
      merged.set(key, state)
    } else if (state.resetAt === prior.resetAt) {
      const denied = mergeVisits(prior.denied, state.denied)
      const recent = mergeVisits(prior.recent, state.recent)
      const newestIdentity = (state.denied.at(-1)?.at ?? 0) >= (prior.denied.at(-1)?.at ?? 0) ? state.identity : prior.identity
      merged.set(key, { resetAt: state.resetAt, denied, recent, ...(newestIdentity ? { identity: newestIdentity } : {}) })
    }
  }
  return Array.from(merged)
}

export function rangeLockMessage(shown: string, span: ReadRange): string {
  return 'Line-range reads of this file are locked for this compaction epoch. Run `token-goat read ' +
    quotedArg(shown + '@' + span[0] + '-' + span[1]) + '` for this window, or `token-goat skeleton ' +
    quotedArg(shown) + '` for structure. Do not shrink, grow, or shift the Read range.'
}
