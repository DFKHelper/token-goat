/**
 * `updatedToolOutput` must match the tool's own output shape.
 *
 * token-goat emitted a bare string there for every tool. Claude Code accepts that only when the
 * tool's own result is a string (MCP); for every built-in tool it rejects the rewrite with
 * "PostToolUse hook returned updatedToolOutput that does not match <Tool>'s output shape; using
 * original output" and shows the model the original. So every built-in-tool rewrite token-goat
 * shipped was dead on the wire while the suite stayed green.
 *
 * FIXTURE PROVENANCE -- every `tool_response` below is CAPTURE: the key sets and value types are
 * counted from real `toolUseResult` records in recorded Claude Code session transcripts (4,000+
 * results; Read 13,324, WebFetch 3,813, Grep 1,918, WebSearch 1,499, Bash 2,852 base plus its
 * documented variants). Only the key names and value types come from that corpus; every value here
 * is invented placeholder text. None of it is written from token-goat's own serializer, which would
 * agree with the bug by construction.
 */
import { describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { serializeOutput } from '../src/hook_registry.js'
import {
  extractToolResponseField,
  replaceToolResponseField,
  OUTPUT_FIRST_TOOL_RESPONSE_KEYS,
  BODY_FIRST_TOOL_RESPONSE_KEYS,
} from '../src/hooks_common.js'
import { makeHookEvent } from './helpers/hook-event.js'

/** CAPTURE — Bash base shape: {interrupted,isImage,noOutputExpected,stderr,stdout}, 2,852 corpus results. */
function bashResponse(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { interrupted: false, isImage: false, noOutputExpected: false, stderr: '', stdout: 'ORIGINAL STDOUT', ...extra }
}

function postEvent(toolName: string, toolResponse: unknown): HookEvent {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName,
    raw: { tool_name: toolName, tool_response: toolResponse },
  })
}

function emitted(toolName: string, toolResponse: unknown, newText: string): unknown {
  const json = serializeOutput(
    { hookType: 'rewriteOutput', updatedOutput: newText },
    'post_tool_use',
    'claudecode',
    postEvent(toolName, toolResponse),
  )
  return (JSON.parse(json) as { hookSpecificOutput: { updatedToolOutput: unknown } }).hookSpecificOutput
    .updatedToolOutput
}

describe('serializeOutput rewriteOutput: shape matches the tool result', () => {
  it('Bash base shape is rewritten as an object, not a bare string', () => {
    const out = emitted('Bash', bashResponse(), 'COMPRESSED')
    expect(typeof out).toBe('object')
    const o = out as Record<string, unknown>
    expect(o['stdout']).toBe('COMPRESSED')
    expect(o['stderr']).toBe('')
    expect(o['interrupted']).toBe(false)
    expect(o['isImage']).toBe(false)
    expect(o['noOutputExpected']).toBe(false)
  })

  it('Bash variant keys survive the rewrite (no whitelist rebuild)', () => {
    // CAPTURE — the seven optional Bash extras seen in the corpus. persistedOutputPath is the
    // load-bearing one: dropping it takes away the model's only handle on a capped output.
    const variantKeys = {
      persistedOutputPath: '/tmp/persisted-output.txt',
      persistedOutputSize: 40000,
      gitOperation: { type: 'commit' },
      returnCodeInterpretation: 'success',
      backgroundTaskId: 'bg-1',
      backgroundCwdHint: '/work',
      staleReadFileStateHint: 'stale',
      timedOutAfterMs: 120000,
    }
    expect(Object.keys(variantKeys).length).toBeGreaterThan(0)
    const out = emitted('Bash', bashResponse(variantKeys), 'COMPRESSED') as Record<string, unknown>
    expect(out['stdout']).toBe('COMPRESSED')
    for (const [k, v] of Object.entries(variantKeys)) {
      expect(out[k], `variant key ${k} must survive the rewrite`).toEqual(v)
    }
  })

  it('Bash stderr-only result rewrites stderr, the same field the handler read', () => {
    // The handler resolves stderr only when stdout is empty; the rewrite must land in the same one.
    const resp = bashResponse({ stdout: '', stderr: 'compiler diagnostic' })
    expect(extractToolResponseField({ tool_response: resp }, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)).toBe('compiler diagnostic')
    const out = emitted('Bash', resp, 'COMPRESSED') as Record<string, unknown>
    expect(out['stderr']).toBe('COMPRESSED')
    expect(out['stdout']).toBe('')
  })

  it('WebFetch rewrites result and keeps its metadata', () => {
    // CAPTURE — {bytes,code,codeText,durationMs,result,url}, 3,813 corpus results. Resolved via
    // BODY_FIRST because hooks_fetch.ts reads its body with that list.
    const resp = { bytes: 1234, code: 200, codeText: 'OK', durationMs: 90, result: 'PAGE BODY', url: 'https://example.com' }
    const out = emitted('WebFetch', resp, 'FENCED BODY') as Record<string, unknown>
    expect(out['result']).toBe('FENCED BODY')
    expect(out['url']).toBe('https://example.com')
    expect(out['code']).toBe(200)
    expect(out['bytes']).toBe(1234)
  })

  it('Grep rewrites content and keeps its counters', () => {
    // CAPTURE — {content,filenames,mode,numFiles,numLines,totalLines}, 1,918 corpus results.
    const resp = { content: 'a.ts:1:hit', filenames: ['a.ts'], mode: 'content', numFiles: 1, numLines: 1, totalLines: 1 }
    const out = emitted('Grep', resp, 'FOLDED') as Record<string, unknown>
    expect(out['content']).toBe('FOLDED')
    expect(out['mode']).toBe('content')
    expect(out['filenames']).toEqual(['a.ts'])
  })

  it('nested Read shape rewrites file.content and keeps the file metadata', () => {
    // CAPTURE — {file:{filePath,content,numLines,startLine,totalLines},type:'text'}, 13,324 results.
    const resp = { type: 'text', file: { filePath: '/p/a.ts', content: 'LINE1\nLINE2', numLines: 2, startLine: 1, totalLines: 2 } }
    const out = emitted('Read', resp, 'ELIDED') as Record<string, unknown>
    expect(typeof out).toBe('object')
    const file = out['file'] as Record<string, unknown>
    expect(file['content']).toBe('ELIDED')
    expect(file['filePath']).toBe('/p/a.ts')
    expect(file['totalLines']).toBe(2)
    expect(out['type']).toBe('text')
  })

  it('does not mutate the original tool_response object', () => {
    const resp = bashResponse()
    emitted('Bash', resp, 'COMPRESSED')
    expect(resp['stdout']).toBe('ORIGINAL STDOUT')
  })

  it('MCP string response stays a bare string', () => {
    // CAPTURE — 97 corpus results whose toolUseResult is a plain string. This path is the one the
    // harness already accepts (13 accepted MCP rewrites); it must not regress into an object.
    const out = emitted('mcp__server__tool', 'ORIGINAL MCP TEXT', 'COMPRESSED MCP TEXT')
    expect(out).toBe('COMPRESSED MCP TEXT')
  })

  it('falls back to a bare string when no field resolves', () => {
    // CAPTURE — WebSearch {durationSeconds,query,results:array,searchCount}, 1,499 corpus results.
    // No key list resolves a text field here, so the rewrite stays a string: the harness rejects it
    // and shows the original, which beats injecting the body into a field that never held it.
    const resp = { durationSeconds: 2.5, query: 'q', results: [{ title: 't' }], searchCount: 1 }
    expect(emitted('WebSearch', resp, 'REWRITTEN')).toBe('REWRITTEN')
  })

  it('falls back to a bare string when the event is absent or carries no tool_response', () => {
    const json = serializeOutput({ hookType: 'rewriteOutput', updatedOutput: 'X' }, 'post_tool_use', 'claudecode')
    expect(JSON.parse(json).hookSpecificOutput.updatedToolOutput).toBe('X')
    expect(emitted('Bash', undefined, 'X')).toBe('X')
    expect(emitted('Bash', null, 'X')).toBe('X')
  })
})

describe('replaceToolResponseField mirrors extractToolResponseField', () => {
  it('non-firing guard: replaces exactly the field extract resolves, over every real shape', () => {
    // Non-firing in the sense that matters here: on valid, real tool_response shapes the
    // replacement must land on the very field the extractor reads, never a different one and never
    // nothing. If the two rules drift, the body survives in its own field and the replacement is
    // injected somewhere the tool's schema never meant to carry it.
    const cases: readonly { name: string; resp: Record<string, unknown>; keys: readonly string[] }[] = [
      { name: 'Bash', resp: bashResponse(), keys: OUTPUT_FIRST_TOOL_RESPONSE_KEYS },
      { name: 'Bash stderr-only', resp: bashResponse({ stdout: '', stderr: 'DIAGNOSTIC-BODY' }), keys: OUTPUT_FIRST_TOOL_RESPONSE_KEYS },
      {
        name: 'WebFetch',
        resp: { bytes: 1, code: 200, codeText: 'OK', durationMs: 1, result: 'BODY', url: 'https://e.com' },
        keys: BODY_FIRST_TOOL_RESPONSE_KEYS,
      },
      {
        name: 'Grep',
        resp: { content: 'hit', filenames: ['a'], mode: 'content', numFiles: 1, numLines: 1, totalLines: 1 },
        keys: OUTPUT_FIRST_TOOL_RESPONSE_KEYS,
      },
      {
        name: 'Read nested',
        resp: { type: 'text', file: { filePath: '/p', content: 'BODY', numLines: 1, startLine: 1, totalLines: 1 } },
        keys: OUTPUT_FIRST_TOOL_RESPONSE_KEYS,
      },
    ]
    expect(cases.length).toBeGreaterThan(0)
    for (const c of cases) {
      const before = extractToolResponseField({ tool_response: c.resp }, c.keys)
      expect(before, `${c.name}: extractor must resolve a non-empty body`).not.toBe('')
      const replaced = replaceToolResponseField(c.resp, c.keys, 'SENTINEL-REPLACEMENT')
      expect(replaced, `${c.name}: replacement must resolve the same field`).not.toBeNull()
      const after = extractToolResponseField({ tool_response: replaced as Record<string, unknown> }, c.keys)
      expect(after, `${c.name}: extractor must now read the replacement, not the original`).toBe('SENTINEL-REPLACEMENT')
      expect(JSON.stringify(replaced), `${c.name}: original body must not survive anywhere`).not.toContain(before)
    }
  })

  it('nested Read body is now extractable at all', () => {
    // Second defect on the same path: the flat key walk matched nothing on Claude Code's real Read
    // shape (its keys are `file` and `type`; neither is in any key list), so extractReadOutput
    // returned '' and read:served_elide could never fire. Zero corpus emissions confirm it.
    const resp = { type: 'text', file: { filePath: '/p/a.ts', content: 'REAL BODY', numLines: 1, startLine: 1, totalLines: 1 } }
    expect(extractToolResponseField({ tool_response: resp }, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)).toBe('REAL BODY')
  })

  it('returns null when nothing resolves', () => {
    expect(replaceToolResponseField({ durationSeconds: 1, results: [] }, OUTPUT_FIRST_TOOL_RESPONSE_KEYS, 'X')).toBeNull()
  })
})
