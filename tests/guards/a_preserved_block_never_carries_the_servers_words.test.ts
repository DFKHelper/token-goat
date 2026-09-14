/**
 * A rewrite of an MCP result now emits an array: one text block holding the redacted, fenced words,
 * followed by the blocks a string cannot carry. Those trailing blocks are copied VERBATIM out of the
 * remote server's payload, which makes them a second route to the model running alongside the fenced
 * one. Any of them that carries words would hand back an unredacted, unfenced copy of exactly the
 * text the fence beside it was built to mark -- the credential the first block proves was stripped,
 * legible in the second.
 *
 * So: nothing textual is ever preserved. Written against the live hook over a matrix of block shapes
 * rather than against the filter predicate, because the predicate agreeing with itself is not the
 * property at risk -- a sixth block type added to the MCP union later is.
 */
import { describe, expect, it } from 'vitest'

import { buildEvent } from '../../src/relay.js'
import { runHook } from '../../src/hook_registry.js'

/** PROVENANCE: FORMAT-DERIVED from the MCP ContentBlock union (TextContent, ImageContent, AudioContent, EmbeddedResource, ResourceLink) at modelcontextprotocol.io/specification. Each entry pairs a block with a marker string placed in whatever field of it holds words, so an assertion can ask whether those words travelled rather than whether a type name did. */
const BLOCKS: readonly { label: string; block: Record<string, unknown>; marker: string | null }[] = [
  { label: 'text', block: { type: 'text', text: 'MARKERTEXT plain prose' }, marker: 'MARKERTEXT' },
  { label: 'resource with text', block: { type: 'resource', resource: { uri: 'file:///a', text: 'MARKERRES embedded body' } }, marker: 'MARKERRES' },
  { label: 'resource_link', block: { type: 'resource_link', uri: 'https://example.invalid/MARKERURI', name: 'MARKERNAME', description: 'MARKERDESC the link blurb' }, marker: 'MARKERDESC' },
  { label: 'image', block: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }, marker: null },
  { label: 'audio', block: { type: 'audio', data: 'SUQzBAAA', mimeType: 'audio/mpeg' }, marker: null },
  { label: 'resource with blob', block: { type: 'resource', resource: { uri: 'file:///b', blob: 'QUJD', mimeType: 'application/octet-stream' } }, marker: null },
]

/** Every block the whole matrix can produce, so one call exercises the interleaving rather than six calls each seeing a single shape. A rewrite is only emitted when there is text to rewrite, which the text block at the head supplies. */
function post(id: string): Record<string, unknown> {
  return {
    tool_name: 'mcp__probe_server__fetch',
    tool_input: { id },
    session_id: `blockguard-${id}`,
    tool_response: { content: BLOCKS.map((b) => b.block) },
  }
}

describe('a preserved MCP block never carries the server own words', () => {
  it('preserves the blocks that hold no words and drops every one that does', async () => {
    const out = await runHook(buildEvent('post_tool_use', post('matrix')))
    expect(out.hookType, 'no rewrite was emitted at all, so the assertions below measure nothing').toBe('rewriteOutput')
    if (out.hookType !== 'rewriteOutput') throw new Error('unreachable')
    // Calibration. Without it every assertion below is satisfied by an undefined updatedBlocks, which is what a regression that quietly stopped preserving anything would look like.
    expect(out.updatedBlocks, 'nothing was preserved, so this guard would pass for the rest of its life without exercising what it names').toBeDefined()
    const preserved = (out.updatedBlocks ?? []).slice(1)
    expect(preserved, 'the non-textual blocks were dropped').toHaveLength(BLOCKS.filter((b) => b.marker === null).length)

    // The head block is the rewrite itself, and it is the only place the server's words are allowed to appear.
    expect(out.updatedBlocks?.[0]).toEqual({ type: 'text', text: out.updatedOutput })
    const trailing = JSON.stringify(preserved)
    for (const { label, marker } of BLOCKS) {
      if (marker === null) continue
      expect(trailing, `${label}: the server's own words shipped verbatim beside the fenced copy of them`).not.toContain(marker)
    }
    // And every word that was dropped is accounted for in the fenced block, or the fix traded a leak for a silent loss.
    for (const { label, marker } of BLOCKS) {
      if (marker === null) continue
      expect(out.updatedOutput, `${label}: its text reached neither the rewrite nor a preserved block`).toContain(marker)
    }
  })

  it('a link target survives the block being dropped, since the model cannot follow what it never sees', async () => {
    const out = await runHook(buildEvent('post_tool_use', post('link')))
    if (out.hookType !== 'rewriteOutput') throw new Error('no rewrite emitted')
    expect(out.updatedOutput).toContain('MARKERURI')
    expect(out.updatedOutput).toContain('MARKERNAME')
  })
})
