/**
 * A PostToolUse payload fixture modeling an MCP tool response delivered as a bare content-block array
 * with no `{ content: ... }` wrapper (matching the wire shape emitted by servers like GitHub's list_tags).
 *
 * The point of it: `tool_response` is the MCP content block array **bare**, with no `{ content: ... }`
 * wrapper. Both of this repo's tool_response readers were written against the wrapped shape only, and a
 * bare array passes their `typeof tr === 'object'` check before finding no `.content` -- so the text
 * extractor fell through to `JSON.stringify` and handed the model escaped JSON, and the image handler
 * saw `null` and skipped every block.
 */
export const BARE_ARRAY_LIST_TAGS: Record<string, unknown> = {
  permission_mode: 'bypassPermissions',
  effort: {
    level: 'medium',
  },
  hook_event_name: 'PostToolUse',
  tool_name: 'mcp__plugin_github_github__list_tags',
  tool_input: {
    owner: 'sqlite',
    repo: 'sqlite',
    perPage: 2,
  },
  tool_response: [
    {
      type: 'text',
      text: '[{"name":"vesion-3.45.1","sha":"189e44dfecdc7868bb860dfb5d98eab371318c37"},{"name":"version-3.53.4","sha":"b09c88c14082339b66c7b7158d609a771e64ca69"}]',
    },
  ],
  duration_ms: 797,
}

/** The one text block's `text` field from that capture, spelled out here so a test can assert the extractor returns exactly it rather than comparing against a value it re-derived from the same payload. PROVENANCE: CAPTURE, transcribed from the committed artifact. */
export const BARE_ARRAY_LIST_TAGS_TEXT =
  '[{"name":"vesion-3.45.1","sha":"189e44dfecdc7868bb860dfb5d98eab371318c37"},{"name":"version-3.53.4","sha":"b09c88c14082339b66c7b7158d609a771e64ca69"}]'

/** PROVENANCE: HAND-DERIVED. An image-bearing bare-array payload, assembled from the block shape the capture above establishes plus the `image`/`source` block fields named in the MCP `CallToolResult` schema. No capture of a bare-array *image* response exists here, so this proves the handler's branching on that shape and nothing about the wire format of any particular server. */
export function bareArrayImagePayload(toolName: string, b64: string, mediaType = 'image/jpeg'): Record<string, unknown> {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: {},
    tool_response: [
      { type: 'text', text: 'Took a screenshot of the current page' },
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
    ],
  }
}
