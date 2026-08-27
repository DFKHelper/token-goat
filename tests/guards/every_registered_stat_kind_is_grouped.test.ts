import { describe, it, expect } from 'vitest'
import { _registeredKinds, _registeredKindPrefixes } from '../../src/stats.js'
import { _kindGroupLabel, _renderedKindNames } from '../../src/render/stats_renderer.js'

/**
 * The fourth and last mirror in the stat-registry guard family.
 *
 * guards/every_recorded_stat_kind_is_registered.test.ts checks recorded implies registered.
 * guards/every_registered_stat_kind_has_a_producer.test.ts checks registered implies produced.
 * guards/every_rendered_stat_kind_is_registered.test.ts checks rendered implies registered.
 * None of the three covers the remaining direction: REGISTERED implies GROUPED. A kind stats.ts
 * registers, a producer records, and the renderer has no group membership for still prints -- but
 * under the 'Other' heading, separated from the very siblings it belongs beside, reading to a user
 * as an uncategorised leftover. That is how brief_view (SOURCE_READ, produced by `token-goat brief`)
 * rendered below 'Other' in `stats --full` instead of under 'Read savings'.
 */

// Every registered kind that deliberately renders under 'Other', and why it belongs there. A kind here must be one whose savings genuinely do not belong beside any existing group's siblings -- not merely one nobody has grouped yet.
const UNGROUPED_KIND_ALLOWLIST: Record<string, string> = {
  secret_redacted: 'SOURCE_OTHER and deliberately excluded from _KIND_GROUPS: a redaction removes secret bytes, it does not save a read, so grouping it beside a savings family would add non-savings bytes to that family (see tests/disk_cache.test.ts).',
  note_write: 'SOURCE_OTHER by design: note-add is a write with no full-source counterfactual, recorded event-only at zero bytes purely for usage visibility, so it belongs beside no savings group.',
  dirty_queue_append_failed: 'Fail-soft diagnostic counter from hooks_edit.ts: it records that a side task threw, never a byte saving, so "Other" is exactly where a reader should find it.',
  worker_healthcheck_failed: 'Fail-soft diagnostic counter from hooks_edit.ts: it records that a side task threw, never a byte saving, so "Other" is exactly where a reader should find it.',
  known_root_record_failed: 'Fail-soft diagnostic counter from hooks_edit.ts: it records that a side task threw, never a byte saving, so "Other" is exactly where a reader should find it.',
  compact_summary: 'Measurement of what a compaction produced, always recorded at zero bytes and zero tokens because the summary was written whether or not token-goat was watching; grouping it under a savings heading would imply a counterfactual that does not exist.',
}

describe('every stat kind registered in stats.ts is grouped by the renderer', () => {
  it('reads a real registry and a real grouper, so an empty scan cannot pass vacuously', () => {
    expect(_registeredKinds().length, 'stats.ts registered nothing -- the registry import has drifted').toBeGreaterThan(50)
    expect(_renderedKindNames().length, 'the renderer exposed no group members -- _KIND_GROUPS or its accessor has drifted').toBeGreaterThan(30)
    expect(_kindGroupLabel('read_replacement'), 'the grouper no longer resolves a known Read kind -- the export has drifted').toBe('Read savings')
    expect(_kindGroupLabel('definitely_not_a_registered_kind'), 'the grouper claims an unregistered name -- the orphan checks below would pass vacuously').toBe('Other')
  })

  it('leaves no registered kind falling through to Other without a stated reason', () => {
    const orphans = _registeredKinds().filter(
      (k) => _kindGroupLabel(k) === 'Other' && UNGROUPED_KIND_ALLOWLIST[k] === undefined,
    )
    expect(
      orphans,
      'these kinds are registered in stats.ts KIND_TO_SOURCE but no _KIND_GROUPS member set or prefix branch claims them, so `token-goat stats --full` prints them under "Other" instead of beside their siblings; either add the group membership or add an allowlist entry saying why "Other" is right',
    ).toEqual([])
  })

  it('groups every registered kind prefix too, not just the literal names', () => {
    // The prefix branches in _kindGroupLabel are the only thing grouping colon-prefixed kinds; a new KIND_PREFIX_TO_SOURCE entry with no matching branch sends a whole mechanism's rows to 'Other' at once.
    const ungroupedPrefixes = _registeredKindPrefixes().filter(
      (p) => _kindGroupLabel(`${p}sample`) === 'Other' && UNGROUPED_KIND_ALLOWLIST[p] === undefined,
    )
    expect(
      ungroupedPrefixes,
      'these prefixes are registered in stats.ts KIND_PREFIX_TO_SOURCE but _kindGroupLabel has no branch for them, so every kind under them renders under "Other"',
    ).toEqual([])
  })

  it('keeps the allowlist honest: every entry names a kind or prefix that is still registered and still ungrouped', () => {
    const registered = new Set([..._registeredKinds(), ..._registeredKindPrefixes()])
    expect(Object.keys(UNGROUPED_KIND_ALLOWLIST).length, 'the allowlist changed size -- every entry has to be argued for individually, so a blanket addition should show up here').toBe(6)
    for (const [name, reason] of Object.entries(UNGROUPED_KIND_ALLOWLIST)) {
      expect(registered.has(name), `${name} is allowlisted but stats.ts no longer registers it -- drop the entry`).toBe(true)
      const probe = name.endsWith(':') ? `${name}sample` : name
      expect(_kindGroupLabel(probe), `${name} is now grouped -- drop its allowlist entry rather than leaving a stale excuse`).toBe('Other')
      expect(reason.length, `${name} needs a real reason, not a placeholder`).toBeGreaterThan(20)
    }
  })
})
