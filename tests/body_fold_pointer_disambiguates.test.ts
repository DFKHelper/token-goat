/**
 * A body fold's recall pointer must name one body, not a name two bodies share.
 *
 * Two same-named symbols in one file (`class Alpha { render() {} }` beside `class Beta { render() {} }`
 * is the everyday shape) each got a fold notice ending `token-goat read "file.ts::render"`. The two
 * notices were BYTE-IDENTICAL, so nothing in the delivered text distinguished which command recovered
 * which body, and running either landed on resolveSymbolSpec's ambiguity error rather than a body.
 *
 * The repo had already solved this once: graph_commands.ts anchors every `context` suggestion with the
 * `file::symbol@LINE` grammar, and its comment gives this exact reason. The fold simply never adopted
 * the grammar. The anchor is the symbol's DECLARATION line, which is not the first folded line: a body
 * fold keeps the opening lines of the body, so the first folded line sits BODY_FOLD_KEEP_LINES below
 * the declaration, and anchoring on the wrong one of those two resolves to nothing.
 *
 * Provenance: CAPTURE. The two notice strings asserted here were taken from the built bundle's own
 * output on this fixture, driven through `token-goat hook post_tool_use` in the event shape a real
 * harness sends. Before the fix that run emitted `::render` twice; after it, `::render@2` and
 * `::render@37`.
 */
import { describe, it, expect } from 'vitest'

import { planBodyFolds } from '../src/code_fold.js'
import { bodyFoldNotice } from '../src/fold_delivery.js'

describe('a body fold points at one body, not at an ambiguous name', () => {
  /** Two classes, each with a `render` whose body clears BODY_FOLD_MIN_SPAN. */
  function twoRenders(): { rows: { no: number; text: string; raw: string }[]; spans: { name: string; kind: string; lineStart: number; lineEnd: number }[] } {
    const lines: string[] = []
    for (const [cls, tag] of [
      ['Alpha', 'alpha'],
      ['Beta', 'beta'],
    ]) {
      lines.push(`export class ${cls} {`)
      lines.push('  render(input: string): string {')
      lines.push(`    let v = input + '${tag}-0'`)
      for (let i = 1; i < 30; i++) lines.push(`    v = v + '${tag}-${i}'`)
      lines.push(`    return v + '${tag.toUpperCase()}_SENTINEL'`)
      lines.push('  }')
      lines.push('}')
    }
    const rows = lines.map((text, i) => ({ no: i + 1, text, raw: `${String(i + 1).padStart(6, ' ')}\t${text}` }))
    // Declaration lines 2 and 37, matching what `token-goat outline` reports for this fixture.
    const spans = [
      { name: 'render', kind: 'method', lineStart: 2, lineEnd: 34 },
      { name: 'render', kind: 'method', lineStart: 37, lineEnd: 69 },
    ]
    return { rows, spans }
  }

  it('gives two same-named symbols in one file two different recall commands', () => {
    const { rows, spans } = twoRenders()
    const folds = planBodyFolds(rows, spans, 8, 20)
    const bodies = folds.filter((f) => f.kind === 'body')
    expect(bodies, 'both bodies should fold, or this fixture is not exercising the bug').toHaveLength(2)

    const notices = bodies.map((f) => bodyFoldNotice(f.name, f.firstLine, f.lastLine, 'dup.ts', f.declLine))
    // The defect, stated as the thing that must not happen: two notices a reader cannot tell apart.
    expect(notices[0]).not.toBe(notices[1])
    // And stated positively, so a change that merely perturbs one string cannot satisfy the line above.
    expect(notices[0]).toContain('dup.ts::render@2"')
    expect(notices[1]).toContain('dup.ts::render@37"')
  })

  it('anchors on the declaration line, not on the first folded line', () => {
    const { rows, spans } = twoRenders()
    const body = planBodyFolds(rows, spans, 8, 20).filter((f) => f.kind === 'body')[0]
    expect(body).toBeDefined()
    // The two are genuinely different numbers here, which is the only reason this assertion has teeth: the fold keeps the opening lines of the body, so folding starts well below the declaration.
    expect(body?.firstLine).not.toBe(body?.declLine)
    expect(body?.declLine).toBe(2)
    const notice = bodyFoldNotice(body!.name, body!.firstLine, body!.lastLine, 'dup.ts', body!.declLine)
    // Both directions, because either alone passes in a state the other rejects: without the positive assertion the negative one is trivially true when no anchor is emitted at all, which is exactly the pre-fix behaviour this test exists to reject.
    expect(notice).toContain(`::render@${String(body?.declLine)}"`)
    expect(notice).not.toContain(`::render@${String(body?.firstLine)}"`)
  })

  it('omits the anchor when no declaration line is known, rather than emitting a broken one', () => {
    // fold_structure and fold_delivery both pass a line today, but the parameter is optional and a future caller may not. `@undefined` in a command a reader is told to run is worse than no anchor.
    const notice = bodyFoldNotice('solo', 10, 34, 'one.ts')
    expect(notice).toContain('one.ts::solo"')
    expect(notice).not.toContain('@')
  })
})
