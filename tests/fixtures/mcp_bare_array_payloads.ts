import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** PROVENANCE: CAPTURE. A real PostToolUse payload, recorded from this machine's own Claude Code run of `mcp__plugin_github_github__list_tags` against `sqlite/sqlite`, committed verbatim at `tasks/captures/mcp-hook-payload/list_tags-bare-array.json` with only the machine-identifying fields (cwd, session_id, transcript_path, tool_use_id, prompt_id) stripped. It is read from disk rather than inlined here so the fixture cannot drift from the artifact it claims to be. The point of it: `tool_response` is the MCP content block array **bare**, with no `{ content: ... }` wrapper. Both of this repo's tool_response readers were written against the wrapped shape only, and a bare array passes their `typeof tr === 'object'` check before finding no `.content` -- so the text extractor fell through to `JSON.stringify` and handed the model escaped JSON, and the image handler saw `null` and skipped every block. */
export const BARE_ARRAY_LIST_TAGS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../tasks/captures/mcp-hook-payload/list_tags-bare-array.json', import.meta.url)), 'utf-8'),
) as Record<string, unknown>

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
