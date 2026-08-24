/**
 * `yaml-query` did not expand YAML merge keys. js-yaml 4 leaves `<<: *anchor` as a literal `<<`
 * key holding the anchor's mapping, rather than folding those keys into the parent, so a query for
 * an inherited key returned nothing. `parseYamlDocument` now applies the merge-key spec after
 * parsing: own keys win over merged keys, and among a list of merge sources the earlier ones win.
 */
import { describe, it, expect } from 'vitest'

import { parseYamlDocument } from '../src/read_commands.js'

describe('YAML merge keys', () => {
  it('folds a single anchor into the parent and drops the literal << key', () => {
    const doc = parseYamlDocument('base: &b\n  x: 1\n  y: 2\nchild:\n  <<: *b\n  z: 3\n') as Record<
      string,
      Record<string, unknown>
    >
    expect(doc['child']).toEqual({ x: 1, y: 2, z: 3 })
    expect(doc['child'], 'the literal merge key must not survive expansion').not.toHaveProperty('<<')
  })

  it("lets the node's own key override the merged one", () => {
    const doc = parseYamlDocument('base: &b\n  x: 1\nchild:\n  <<: *b\n  x: 99\n') as Record<
      string,
      Record<string, unknown>
    >
    expect(doc['child']?.['x'], 'own keys win over merged keys').toBe(99)
  })

  it('merges a list of anchors with the earlier source winning', () => {
    const yaml = ['a: &a', '  k: 1', '  only_a: true', 'b: &b', '  k: 2', '  only_b: true', 'c:', '  <<: [*a, *b]'].join(
      '\n',
    )
    const doc = parseYamlDocument(yaml) as Record<string, Record<string, unknown>>
    expect(doc['c']).toEqual({ k: 1, only_a: true, only_b: true })
  })

  it('expands a merge key nested inside another merge target', () => {
    const yaml = ['grand: &g', '  g: 1', 'parent: &p', '  <<: *g', '  p: 2', 'child:', '  <<: *p', '  c: 3'].join('\n')
    const doc = parseYamlDocument(yaml) as Record<string, Record<string, unknown>>
    expect(doc['child']).toEqual({ g: 1, p: 2, c: 3 })
  })

  it('does not mutate the shared anchor target when merging it in two places', () => {
    const yaml = ['base: &b', '  x: 1', 'one:', '  <<: *b', '  x: 10', 'two:', '  <<: *b', '  y: 20'].join('\n')
    const doc = parseYamlDocument(yaml) as Record<string, Record<string, unknown>>
    // `two` overrode nothing on x, so it must still see the anchor's original x:1 -- proof that
    // `one` overriding x to 10 did not write through the shared anchor object.
    expect(doc['two']).toEqual({ x: 1, y: 20 })
    expect(doc['base']).toEqual({ x: 1 })
  })
})
