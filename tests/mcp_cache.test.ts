import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isMcpReadOnly,
  mcpHash,
  mcpOutputId,
  storeMcpOutput,
  getMcpOutput,
  MCP_MAX_CACHE_BYTES,
} from '../src/mcp_cache.js'
import { getBashOutput } from '../src/bash_output_cache.js'
import { likeSearchForTesting } from '../src/recall_index.js'
import { clearModuleCaches } from '../src/reset.js'

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  clearModuleCaches()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

describe('isMcpReadOnly', () => {
  it('returns true for read-only tools', () => {
    expect(isMcpReadOnly('mcp__plugin_github_github__get_file_contents', {})).toBe(true)
    expect(isMcpReadOnly('mcp__plugin_github_github__list_issues', {})).toBe(true)
  })

  it('returns false for mutation tools', () => {
    expect(isMcpReadOnly('mcp__plugin_github_github__create_issue', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_github_github__update_issue', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_github_github__delete_file', {})).toBe(false)
  })

  it('returns false for non-mcp tools', () => {
    expect(isMcpReadOnly('some_tool', {})).toBe(false)
    expect(isMcpReadOnly('bash', {})).toBe(false)
  })

  it('handles case-insensitive mutation verbs', () => {
    expect(isMcpReadOnly('mcp__test__Create', {})).toBe(false)
    expect(isMcpReadOnly('mcp__test__UPDATE', {})).toBe(false)
  })

  it('returns false for browser-automation / state-mutating verbs', () => {
    // These chrome-devtools-mcp tool names mutate page/browser state (or their
    // result is expected to change between calls), so they must never be
    // classified as read-only/cacheable.
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__click', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__fill', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__fill_form', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__press_key', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__type_text', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__navigate_page', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__evaluate_script', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__drag', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__hover', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__handle_dialog', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_snapshot', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__wait_for', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__emulate', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__upload_file', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__close_page', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__new_page', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__select_page', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__resize_page', {})).toBe(false)
  })

  it('returns false for mutating verbs not covered by the old blocklist', () => {
    // These verbs (finalize_plan, approve, cancel, deploy, toggle, pin, grant,
    // sync, commit, apply, trigger) are all state-changing but contained none
    // of the old MUTABLE_VERBS_RE blocklist entries, so the pre-fix classifier
    // silently miscategorized them as read-only/cacheable. The allowlist
    // redesign fixes this by defaulting anything not a known-safe read verb
    // to NOT read-only, so no enumeration of every mutating verb is needed.
    expect(isMcpReadOnly('mcp__design_sync__finalize_plan', {})).toBe(false)
    expect(isMcpReadOnly('mcp__test__approve', {})).toBe(false)
    expect(isMcpReadOnly('mcp__test__cancel', {})).toBe(false)
    expect(isMcpReadOnly('mcp__test__deploy', {})).toBe(false)
    expect(isMcpReadOnly('mcp__test__toggle', {})).toBe(false)
    expect(isMcpReadOnly('mcp__test__pin', {})).toBe(false)
    expect(isMcpReadOnly('mcp__test__grant', {})).toBe(false)
    expect(isMcpReadOnly('mcp__test__sync', {})).toBe(false)
    expect(isMcpReadOnly('mcp__test__commit', {})).toBe(false)
    expect(isMcpReadOnly('mcp__test__apply', {})).toBe(false)
    expect(isMcpReadOnly('mcp__test__trigger', {})).toBe(false)
  })

  it('returns false for an unrecognized/unknown verb (fail-safe default)', () => {
    // The allowlist's core invariant: anything NOT matching a known-safe read
    // verb defaults to mutating, even a made-up verb no one has classified.
    expect(isMcpReadOnly('mcp__test__frobnicate', {})).toBe(false)
  })

  it('returns true for common read verbs beyond get/list', () => {
    expect(isMcpReadOnly('mcp__test__search_code', {})).toBe(true)
    expect(isMcpReadOnly('mcp__test__view_file', {})).toBe(true)
    expect(isMcpReadOnly('mcp__test__fetch_data', {})).toBe(true)
    expect(isMcpReadOnly('mcp__test__describe_thing', {})).toBe(true)
    expect(isMcpReadOnly('mcp__test__export_data', {})).toBe(true)
    expect(isMcpReadOnly('mcp__test__download_file', {})).toBe(true)
    expect(isMcpReadOnly('mcp__test__find_item', {})).toBe(true)
    expect(isMcpReadOnly('mcp__test__show_status', {})).toBe(true)
    expect(isMcpReadOnly('mcp__test__query_records', {})).toBe(true)
    expect(isMcpReadOnly('mcp__test__resolve_ref', {})).toBe(true)
  })

  it('returns false for compound names carrying a read-verb token alongside a mutating one', () => {
    // READ_VERBS_RE alone would match on the read-verb token present in each of these
    // (get / search / view) and misclassify them as read-only, even though the full name is
    // a mutating operation (create / update / delete respectively). MUTATING_VERBS_RE closes
    // that gap.
    expect(isMcpReadOnly('mcp__test__get_or_create', {})).toBe(false)
    expect(isMcpReadOnly('mcp__test__search_and_update', {})).toBe(false)
    expect(isMcpReadOnly('mcp__test__view_and_delete', {})).toBe(false)
  })

  it('still classifies genuinely read-only compound names as read-only (no regression)', () => {
    expect(isMcpReadOnly('mcp__plugin_github_github__get_file_contents', {})).toBe(true)
    expect(isMcpReadOnly('mcp__plugin_github_github__list_repository_collaborators', {})).toBe(true)
    expect(isMcpReadOnly('mcp__plugin_github_github__search_pull_requests', {})).toBe(true)
  })

  it('returns true for genuinely read-only chrome-devtools tools, borderline ones excluded', () => {
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_pages', {})).toBe(true)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__get_console_message', {})).toBe(true)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_console_messages', {})).toBe(true)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__get_network_request', {})).toBe(true)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__list_network_requests', {})).toBe(true)
    // Borderline (triggers a page reload/navigation): conservative default is to exclude it.
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__lighthouse_audit', {})).toBe(false)
  })

  it('returns false for screenshot tools (not idempotent, content changes between calls)', () => {
    // Screenshots are not idempotent: the page content can change between calls,
    // so they must never be cached/dedup'd. This test ensures the pre_screenshot hook
    // can always capture a fresh screenshot within the cache TTL window.
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot', {})).toBe(false)
    expect(isMcpReadOnly('mcp__plugin_chrome-devtools-mcp_chrome-devtools__browser_take_screenshot', {})).toBe(false)
  })

  // Bug: Anthropic's Claude-in-Chrome docs (code.claude.com/docs/en/chrome) state that
  // an otherwise read-only call that sets createIfEmpty/clear/save_to_disk is treated
  // as state-changing by their own permission system as of v2.1.199 - token-goat's
  // verb-only classifier didn't know this, so it would dedup e.g. a second
  // read_console_messages({clear: true}) call and silently re-serve the first call's
  // messages instead of letting the (state-mutating) clear actually re-run. These
  // tests fail on the pre-fix single-arg isMcpReadOnly(toolName) and pass once the
  // toolInput flag check is added.
  it('returns false for a read-verb tool when a state-changing input flag is truthy', () => {
    expect(
      isMcpReadOnly('mcp__claude-in-chrome__read_console_messages', { tabId: 5, clear: true }),
    ).toBe(false)
    expect(
      isMcpReadOnly('mcp__claude-in-chrome__read_network_requests', { tabId: 5, clear: true }),
    ).toBe(false)
    expect(isMcpReadOnly('mcp__claude-in-chrome__tabs_context_mcp', { createIfEmpty: true })).toBe(
      false,
    )
    // Use a non-screenshot-named tool for save_to_disk so this assertion actually
    // exercises the input-flag check rather than the pre-existing screenshot-name regex.
    expect(
      isMcpReadOnly('mcp__claude-in-chrome__get_page_source', { save_to_disk: true }),
    ).toBe(false)
  })

  it('returns true for the same read-verb tools when those flags are absent or falsy', () => {
    expect(isMcpReadOnly('mcp__claude-in-chrome__read_console_messages', { tabId: 5 })).toBe(true)
    expect(
      isMcpReadOnly('mcp__claude-in-chrome__read_console_messages', { tabId: 5, clear: false }),
    ).toBe(true)
    expect(isMcpReadOnly('mcp__claude-in-chrome__tabs_context_mcp', { createIfEmpty: false })).toBe(
      true,
    )
  })
})

describe('mcpHash', () => {
  it('returns a 16-char hex string', () => {
    expect(mcpHash('mcp__test__tool', { key: 'value' })).toMatch(/^[0-9a-f]{16}$/)
  })

  it('produces consistent hashes', () => {
    const input = { key: 'value', number: 42 }
    expect(mcpHash('mcp__test__tool', input)).toBe(mcpHash('mcp__test__tool', input))
  })

  it('produces different hashes for different tools', () => {
    expect(mcpHash('mcp__tool1', { key: 'value' })).not.toBe(mcpHash('mcp__tool2', { key: 'value' }))
  })

  it('produces different hashes for different inputs', () => {
    expect(mcpHash('mcp__test__tool', { key: 'value1' })).not.toBe(
      mcpHash('mcp__test__tool', { key: 'value2' }),
    )
  })

  it('normalizes key order for consistent hashing', () => {
    expect(mcpHash('mcp__test__tool', { a: 1, b: 2 })).toBe(mcpHash('mcp__test__tool', { b: 2, a: 1 }))
  })
})

describe('mcpOutputId', () => {
  it('is a fixed-length mcp_<16hex> id', () => {
    expect(mcpOutputId('session-abc', 'deadbeefdeadbeef')).toMatch(/^mcp_[0-9a-f]{16}$/)
  })

  it('is deterministic for the same (session, hash)', () => {
    expect(mcpOutputId('s', 'h')).toBe(mcpOutputId('s', 'h'))
  })

  it('is session-scoped (different sessions => different ids)', () => {
    expect(mcpOutputId('session-a', 'h')).not.toBe(mcpOutputId('session-b', 'h'))
  })

  it('stays within the 64-char blob-id budget for long session ids', () => {
    const id = mcpOutputId('x'.repeat(500), 'h')
    expect(id.length).toBeLessThanOrEqual(64)
    expect(id).toMatch(/^mcp_[0-9a-f]{16}$/)
  })
})

describe('storeMcpOutput / getMcpOutput', () => {
  const sessionId = 'sess-1'
  const toolName = 'mcp__plugin_github_github__get_file_contents'
  const toolInput = { owner: 'o', repo: 'r', path: 'README.md' }

  it('persists a result and recalls its id', () => {
    const id = storeMcpOutput(sessionId, toolName, toolInput, 'file body here')
    expect(id).not.toBeNull()
    expect(getMcpOutput(sessionId, toolName, toolInput)).toBe(id)
  })

  it('recalls across a cleared in-memory cache (disk round-trip)', () => {
    const id = storeMcpOutput(sessionId, toolName, toolInput, 'persisted body')
    expect(id).not.toBeNull()
    // Drop every in-memory map; recall must now resolve from the blob on disk —
    // the exact cross-hook-process path the previous in-memory-only cache failed.
    clearModuleCaches()
    expect(getMcpOutput(sessionId, toolName, toolInput)).toBe(id)
    const entry = getBashOutput(id as string)
    expect(entry?.output).toBe('persisted body')
  })

  it('returns null on a miss', () => {
    expect(getMcpOutput(sessionId, toolName, toolInput)).toBeNull()
  })

  it('does not cache results above MCP_MAX_CACHE_BYTES', () => {
    const big = 'x'.repeat(MCP_MAX_CACHE_BYTES + 1)
    expect(storeMcpOutput(sessionId, toolName, toolInput, big)).toBeNull()
    expect(getMcpOutput(sessionId, toolName, toolInput)).toBeNull()
  })

  it('does not cache empty results or empty sessions', () => {
    expect(storeMcpOutput(sessionId, toolName, toolInput, '')).toBeNull()
    expect(storeMcpOutput('', toolName, toolInput, 'body')).toBeNull()
  })

  it('scopes the cache per session', () => {
    const id = storeMcpOutput(sessionId, toolName, toolInput, 'body')
    expect(id).not.toBeNull()
    expect(getMcpOutput('other-session', toolName, toolInput)).toBeNull()
  })

  it('with no ttlMs given, recalls indefinitely (back-compat default)', () => {
    const id = storeMcpOutput(sessionId, toolName, toolInput, 'body')
    expect(id).not.toBeNull()
    expect(getMcpOutput(sessionId, toolName, toolInput)).toBe(id)
  })

  it('recalls within the given TTL window', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const id = storeMcpOutput(sessionId, toolName, toolInput, 'body')
      expect(id).not.toBeNull()
      vi.setSystemTime(1_000_000 + 30_000) // 30s later, inside a 60s TTL
      expect(getMcpOutput(sessionId, toolName, toolInput, 60_000)).toBe(id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats an entry as a miss once it ages past the TTL window', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const id = storeMcpOutput(sessionId, toolName, toolInput, 'body')
      expect(id).not.toBeNull()
      vi.setSystemTime(1_000_000 + 61_000) // 61s later, outside a 60s TTL
      expect(getMcpOutput(sessionId, toolName, toolInput, 60_000)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  // Regression (secret-redaction bypass): storeMcpOutput indexed the raw, pre-redaction
  // resultText into the cache_recall table even though storeBlob() redacted the same
  // text before writing it to disk -- `token-goat recall`/FTS search over cache_recall
  // could surface a secret the blob-store redaction was specifically built to strip.
  it('never indexes a raw secret into the recall table, even when the blob is redacted', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE'
    const id = storeMcpOutput(sessionId, toolName, toolInput, `before ${secret} after`)
    expect(id).not.toBeNull()
    // The on-disk/in-memory blob is redacted (existing behavior via storeBlob).
    const entry = getBashOutput(id as string)
    expect(entry?.output).not.toContain(secret)
    // The recall index must reflect the same redacted text, not the raw secret.
    const hits = likeSearchForTesting(secret, 'mcp')
    expect(hits).toHaveLength(0)
  })
})
