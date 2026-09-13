/**
 * A pattern the INDEXER builds from a file it is indexing, rather than one a caller supplied.
 *
 * `tests/guards/caller_supplied_patterns_are_guarded.test.ts` is the other half of this and does
 * not cover it: it flags a `new RegExp` sink by the NAME of its argument, against a set of names
 * that mean "this came from a `--grep` or a `--filter`". The language adapters interpolate under
 * names like `namesAlt` and `root`, so the guard's population never contained them -- a green run
 * of it has never been evidence about `src/languages/` at all.
 *
 * The risk here is not the caller's risk. A search pattern arrives from a model or a command line
 * and the worry is catastrophic backtracking; an indexer pattern is built from a file that may have
 * been placed in the tree by whoever wrote the repository being reviewed, and the two things that
 * go wrong are a pattern that matches more than the literal it was built from, and a pattern whose
 * SIZE grows with the file. Neither needs a nested quantifier, so a shape check reports both clean.
 *
 * `indexFileSync` runs synchronously inside the worker's drain loop, which has no per-file
 * deadline, so a file that costs seconds costs them to every file queued behind it too.
 */
import { describe, expect, it } from 'vitest'

import { extractApex } from '../src/languages/apex.js'
import { extractSalesforceMetadata } from '../src/languages/salesforce_metadata.js'

describe('a pattern built from the file being indexed', () => {
  it('does not grow with the number of types an Apex file declares', () => {
    // PROVENANCE: HAND-DERIVED. The shape is chosen from what makes a literal alternation expensive
    // -- many branches sharing a long prefix, and lines that match that prefix and then fail -- not
    // from anything the adapter does. Against the interpolated alternation this replaced, a replica
    // of the same pattern measured 0.78 s at 2,000 names, 4.87 s at 4,000 and 17.3 s at 6,000, an
    // exponent near three; the 2 MB default of `indexing.large_file_skip_kb` admits about 25,000.
    //
    // The ceiling is deliberately far above what a linear implementation costs (this runs in tens
    // of milliseconds) and far below what the previous one did. It is an order-of-magnitude
    // assertion, not a stopwatch, so a slow CI runner cannot fail it and a quadratic term cannot
    // pass it.
    const prefix = 'A'.repeat(30)
    const names = Array.from({ length: 4_000 }, (_, i) => `${prefix}${i}`)
    const content =
      names.map((n) => `class ${n} {`).join('\n') +
      '\n' +
      // Bait: shares each name's prefix, then fails. Every one of these forces the engine through
      // the branch list, which is the whole cost when the list is interpolated and none of it when
      // the name is captured and looked up.
      names.map((n) => `${n}z () {`).join('\n') +
      '\n'

    const started = Date.now()
    const { symbols } = extractApex(content, 'Bomb.cls')
    const elapsed = Date.now() - started

    expect(elapsed, 'the indexer pattern grows with the file again').toBeLessThan(2_000)
    // The other half: cheap is not the goal on its own, and deleting the pass would also be cheap.
    expect(symbols.some((s) => s.name === `${prefix}0` && s.kind === 'apex_class')).toBe(true)
    expect(symbols.some((s) => s.name === `${prefix}0z`), 'a name no type declares was indexed as a constructor').toBe(false)
  })

  it('still finds a constructor with no access modifier, in any case', () => {
    // The regression the fix above could plausibly cause: the alternation it replaced carried the
    // type names, and a capture-then-look-up has to reach the same answer, including Apex's
    // case-insensitivity, which is why the lookup folds.
    const content = `public class Account_Service {
  account_service() {}
  void helper() {}
}
`
    const { symbols } = extractApex(content, 'Account_Service.cls')
    expect(symbols.find((s) => s.name === 'account_service')?.kind).toBe('apex_constructor')
    expect(symbols.find((s) => s.name === 'helper')?.kind).toBe('apex_method')
  })

  it('does not read a dot in an XML root name as a wildcard', () => {
    // PROVENANCE: HAND-DERIVED. An XML name may legally contain a `.`, and the adapter's own
    // capture admits one; `CustomXObject` is the minimal string a `.` matches and a literal does
    // not. Unescaped, the close tag below satisfies the root check and a document that is not well
    // formed is accepted -- the adapter's only test that the file is what it claims to be.
    const mismatched = `<?xml version="1.0"?>
<Custom.Object xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>x</label>
</CustomXObject>
`
    expect(extractSalesforceMetadata(mismatched, 'Broken.object-meta.xml').symbols).toEqual([])

    // The mirror, or refusing everything satisfies the assertion above.
    const wellFormed = mismatched.replace('</CustomXObject>', '</Custom.Object>')
    expect(extractSalesforceMetadata(wellFormed, 'Broken.object-meta.xml').symbols.length).toBeGreaterThan(0)
  })
})
