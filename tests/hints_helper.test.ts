import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { showHintOnce } from '../src/hints.js'
import { clearModuleCaches } from '../src/reset.js'
import { exportSessionState, importSessionState } from '../src/session.js'

// Provenance: HAND-DERIVED. The expected booleans follow from the rule in the task brief (show when the key is new or its trigger differs), computed here independently of showHintOnce's implementation.

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  clearModuleCaches()
})

describe('showHintOnce', () => {
  it('shows a key once for the same trigger', () => {
    expect(showHintOnce({ category: 'edit_callers_tests', key: 'src/a.ts', trigger: 'h1' })).toBe(true)
    expect(showHintOnce({ category: 'edit_callers_tests', key: 'src/a.ts', trigger: 'h1' })).toBe(false)
  })

  it('shows the same key again when its trigger changes', () => {
    expect(showHintOnce({ category: 'edit_callers_tests', key: 'src/a.ts', trigger: 'h1' })).toBe(true)
    expect(showHintOnce({ category: 'edit_callers_tests', key: 'src/a.ts', trigger: 'h2' })).toBe(true)
    expect(showHintOnce({ category: 'edit_callers_tests', key: 'src/a.ts', trigger: 'h2' })).toBe(false)
  })

  it('leaves other keys and other categories unaffected', () => {
    expect(showHintOnce({ category: 'edit_callers_tests', key: 'src/a.ts', trigger: 'h1' })).toBe(true)
    expect(showHintOnce({ category: 'edit_callers_tests', key: 'src/b.ts', trigger: 'h1' })).toBe(true)
    expect(showHintOnce({ category: 'duplicate_function', key: 'src/a.ts', trigger: 'h1' })).toBe(true)
  })

  it('keeps the trigger in the persisted session array and round-trips it', () => {
    expect(showHintOnce({ category: 'edit_callers_tests', key: 'src/a.ts', trigger: 'h1' })).toBe(true)
    const snapshot = exportSessionState()
    expect(snapshot.hintsShown.some((k) => k.includes('"h1"'))).toBe(true)
    clearModuleCaches()
    importSessionState(snapshot)
    expect(showHintOnce({ category: 'edit_callers_tests', key: 'src/a.ts', trigger: 'h1' })).toBe(false)
    expect(showHintOnce({ category: 'edit_callers_tests', key: 'src/a.ts', trigger: 'h2' })).toBe(true)
  })
})
