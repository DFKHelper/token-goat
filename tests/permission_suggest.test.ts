import { describe, expect, it } from 'vitest'

import {
  NOT_READ_ONLY_COMMANDS,
  READ_ONLY_COMMANDS,
  WRITE_CAPABLE_COMMANDS,
  permissionSuggestionJson,
} from '../src/cli_diagnostics.js'

// Provenance: FORMAT-DERIVED from the C-T4 brief T1 notes (`Bash(token-goat <cmd> *)`); host docs not re-read.
const RULE = /^Bash\(token-goat [a-z-]+( [a-z-]+)? \*\)$/

describe('permissions suggest allow list', () => {
  it('prints parseable JSON whose allow entries are one space-form Bash rule per read-only command', () => {
    const parsed = JSON.parse(permissionSuggestionJson()) as { permissions: { allow: string[] } }
    expect(parsed.permissions.allow.length, 'the allow list must not be empty').toBeGreaterThan(0)
    for (const rule of parsed.permissions.allow) {
      expect(rule, `allow entry "${rule}" must use the Bash(token-goat <cmd> *) form`).toMatch(RULE)
    }
    const listed = parsed.permissions.allow
    expect(listed, 'every read-only command must be listed').toHaveLength(READ_ONLY_COMMANDS.length)
  })

  it('never lists a write-capable command', () => {
    const listed = JSON.parse(permissionSuggestionJson()).permissions.allow as string[]
    for (const write of WRITE_CAPABLE_COMMANDS) {
      const rule = `Bash(token-goat ${write} *)`
      expect(listed, `write-capable command "${write}" must never be allow-listed`).not.toContain(rule)
    }
  })

  it('keeps the read-only and not-read-only tables disjoint, write-capable names in the latter', () => {
    const readOnly = new Set(READ_ONLY_COMMANDS)
    for (const name of NOT_READ_ONLY_COMMANDS) {
      expect(readOnly.has(name), `"${name}" is in both tables; an unsure command is not read-only`).toBe(false)
    }
    for (const name of WRITE_CAPABLE_COMMANDS) {
      expect(NOT_READ_ONLY_COMMANDS, `write-capable "${name}" must be classed not read-only`).toContain(name)
    }
  })

  it('is deterministic and sorted, so a re-run diffs clean', () => {
    const allow = JSON.parse(permissionSuggestionJson()).permissions.allow as string[]
    expect(allow, 'the entries must be sorted').toEqual([...allow].sort())
    expect(permissionSuggestionJson()).toBe(permissionSuggestionJson())
  })
})
