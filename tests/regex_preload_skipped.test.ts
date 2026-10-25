/** The proof that tests/setup/load-regex-extractors.ts no longer does the adapter import in a file that never reaches src/parser.ts. This file imports nothing from src, so the globalSetup lists it, and the hook must have left both registry slots empty. tests/regex_preload_scope.test.ts pins that this file is on the list; a hook that loaded anyway fills the slots and fails here. */
import { expect, inject, it } from 'vitest'

it('has the setup leave the regex adapter slots empty', () => {
  expect(inject('outsideParserTests')).toContain('tests/regex_preload_skipped.test.ts')
  const slot = globalThis as unknown as Record<symbol, unknown>
  expect(slot[Symbol.for('token-goat.regex-adapters')]).toBeUndefined()
  expect(slot[Symbol.for('token-goat.salesforce-frontend')]).toBeUndefined()
})
