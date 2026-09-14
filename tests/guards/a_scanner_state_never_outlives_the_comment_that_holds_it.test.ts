/**
 * Two adapters run a string scanner over text that includes comments, so an apostrophe or a quote run sitting in prose can open a literal frame that was never meant to exist. Both have a guard for exactly that, and in both the guard sat one tier above the branch that skipped it, so the frame stayed open to end of file and every symbol after it was silently dropped -- no error, no partial answer, just a shorter list.
 *
 * Apex: `stripStringLiterals` resets its frame stack on `\n` precisely so a `// Don't ...` comment cannot leak a quote across lines, but the backslash-escape branch runs first and consumes `\` plus whatever follows it, newline included. A comment ending in a backslash therefore ate its own line break and the reset never fired.
 *
 * GraphQL: `stripGraphqlDescriptions` resolves `#`-versus-`"""` precedence itself, but only for the first opener on a line. Once a description closed mid-line, `findMultilineOpener` took over and consulted the comment markers of the `MultilineStringLang` GraphQL was borrowing -- `'kotlin'`, whose markers are `['//']` -- so a `"""` inside a `#` comment read as a real description opener.
 *
 * The controls are load-bearing in both: an empty symbol list looks identical whether the scanner desynced or the fixture simply has no symbols, so each defect input is paired with inputs that differ only in the one ingredient that triggers it.
 */
import { describe, expect, it } from 'vitest'

import { extractApex } from '../../src/languages/apex.js'
import { extractGraphql } from '../../src/languages/graphql_idx.js'

/** A literal backslash, built rather than written, because this file is repeatedly edited through shells that collapse escape sequences inside heredocs. */
const BACKSLASH = String.fromCharCode(92)

/** PROVENANCE: HAND-DERIVED. Ordinary Apex in the shape of the language reference's class declaration (Apex Developer Guide, "Classes, Objects, and Interfaces"); the only unusual ingredient is the comment text, which each caller supplies. */
function apexClass(comment: string): string {
  return `public class Foo {\n    // ${comment}\n    public void bar() {\n    }\n    public void baz() {\n    }\n}\n`
}

const apexNames = (source: string): string[] => extractApex(apexClass(source), 'Foo.cls').symbols.map((s) => s.name)

/** PROVENANCE: HAND-DERIVED, in the block-description-then-type shape of the GraphQL spec's "Descriptions" and "Objects" sections (spec.graphql.org/October2021). The first line is the caller's; the rest is a schema whose two types must survive it. */
function graphqlSchema(firstLine: string): string {
  return `${firstLine}\ntype User {\n  id: ID!\n}\ntype Query {\n  me: User\n}\n`
}

const graphqlNames = (firstLine: string): string[] =>
  extractGraphql(graphqlSchema(firstLine), 'schema.graphql').symbols.map((s) => s.name)

describe('a scanner state never outlives the comment that holds it', () => {
  it('an Apex comment ending in a backslash does not swallow its own line break', () => {
    // Both controls isolate one ingredient each: the apostrophe with no trailing backslash, and the trailing backslash with no apostrophe. Either alone is harmless; the defect needs both.
    expect(apexNames("Don't put the file at C:"), 'the apostrophe control lost a symbol, so this file is measuring something else').toEqual(['Foo', 'bar', 'baz'])
    expect(apexNames('Do not put the file at C:' + BACKSLASH), 'the backslash control lost a symbol, so this file is measuring something else').toEqual(['Foo', 'bar', 'baz'])

    expect(apexNames("Don't put the file at C:" + BACKSLASH)).toEqual(['Foo', 'bar', 'baz'])
  })

  it("an Apex class's own span is not truncated at the comment either", () => {
    // The dropped method is the loud half; the quiet half is that the enclosing class kept a span ending at the line the desync reached, which would have handed back four lines of a seven-line class as the whole of it.
    const [foo] = extractApex(apexClass("Don't put the file at C:" + BACKSLASH), 'Foo.cls').symbols
    expect(foo.name).toBe('Foo')
    expect(foo.lineEnd).toBe(7)
  })

  it('a triple quote inside a GraphQL hash comment is prose, not a description opener', () => {
    // Control 1 removes the quote run from the comment; control 2 removes the closed description that precedes it. The second is the pointed one: it proves the caller's own precedence guard works, and so pins the failure to the tier below it.
    expect(graphqlNames('"""A user."""  # use triple quotes to describe a type'), 'the no-quote-run control returned no types, so this file is measuring something else').toEqual(['User', 'Query'])
    expect(graphqlNames('# use """ to describe a type'), 'the comment-first control returned no types, so the caller-level guard is broken too').toEqual(['User', 'Query'])

    expect(graphqlNames('"""A user."""  # use """ to describe a type')).toEqual(['User', 'Query'])
  })
})
