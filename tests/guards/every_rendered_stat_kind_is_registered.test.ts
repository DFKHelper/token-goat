import { describe, it, expect } from 'vitest'
import { isRegisteredKind, _registeredKinds } from '../../src/stats.js'
import { _renderedKindNames } from '../../src/render/stats_renderer.js'

/**
 * The third mirror in the stat-registry guard family.
 *
 * guards/every_recorded_stat_kind_is_registered.test.ts checks recorded implies registered.
 * guards/every_registered_stat_kind_has_a_producer.test.ts checks registered implies produced.
 * Neither covers a name that exists only in the RENDERER: stats_renderer.ts's _KIND_GROUPS decides
 * which group heading a kind prints under, and a name listed there that stats.ts never registered
 * has no source, no producer, and can never carry a byte -- it is a group membership for a row that
 * cannot exist. That is how twenty-nine names carried over from the Python port (bash_output_cached,
 * web_output_recall, skill_body_recall, compact_manifest and the rest) sat in the by-kind table's
 * group sets forever, invisible to both existing guards.
 */

// Every rendered name with no registration, and the reason it is allowed to have none. Empty on purpose: a rendered name that stats.ts does not register cannot ever produce a row, so the correct answer is always to register it or drop it, never to excuse it. An entry here needs a reason that survives that argument.
const UNREGISTERED_RENDER_ALLOWLIST: Record<string, string> = {}

describe('every stat kind named by the renderer is registered in stats.ts', () => {
  it('reads real group members, so an empty scan cannot pass vacuously', () => {
    expect(
      _renderedKindNames().length,
      'the renderer exposed no group members -- _KIND_GROUPS or its accessor has drifted',
    ).toBeGreaterThan(30)
  })

  it('leaves no rendered kind without either a registration or a stated reason', () => {
    const orphans = _renderedKindNames().filter(
      (k) => !isRegisteredKind(k) && UNREGISTERED_RENDER_ALLOWLIST[k] === undefined,
    )
    expect(
      orphans,
      'these kinds are listed in stats_renderer.ts _KIND_GROUPS but stats.ts never registered them -- they have no source, no producer, and can only ever group a row that never appears; either register and wire them or drop the group membership',
    ).toEqual([])
  })

  it('does not treat an unregistered rendered name as registered', () => {
    // Anchors the predicate itself: if isRegisteredKind ever started answering true for everything, the orphan check above would pass vacuously.
    expect(isRegisteredKind('definitely_not_a_rendered_or_registered_kind')).toBe(false)
    expect(_registeredKinds().length, 'stats.ts registered nothing -- the registry import has drifted').toBeGreaterThan(50)
  })

  it('keeps the allowlist honest: every entry names a kind the renderer still groups and stats.ts still does not register', () => {
    const rendered = new Set(_renderedKindNames())
    for (const [name, reason] of Object.entries(UNREGISTERED_RENDER_ALLOWLIST)) {
      expect(rendered.has(name), `${name} is allowlisted but the renderer no longer groups it -- drop the entry`).toBe(true)
      expect(isRegisteredKind(name), `${name} is now registered -- drop its allowlist entry rather than leaving a stale excuse`).toBe(false)
      expect(reason.length, `${name} needs a real reason, not a placeholder`).toBeGreaterThan(20)
    }
  })
})
