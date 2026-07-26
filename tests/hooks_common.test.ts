import { describe, expect, it } from 'vitest'

import {
  BODY_FIRST_TOOL_RESPONSE_KEYS,
  contextOutput,
  countNonEmptyLines,
  denyOutput,
  estimateResultCount,
  extractToolResponseField,
  getCwd,
  getFilePath,
  getToolInput,
  getToolName,
  OUTPUT_FIRST_TOOL_RESPONSE_KEYS,
  passOutput,
} from '../src/hooks_common.js'
import { makeHookEvent as makeEvent } from './helpers/hook-event.js'

describe('hooks_common', () => {
  describe('accessors', () => {
    it('getToolName returns the event tool name', () => {
      expect(getToolName(makeEvent({ toolName: 'Bash' }))).toBe('Bash')
    })

    it('getToolName returns undefined for non-tool events', () => {
      expect(getToolName(makeEvent({ toolName: undefined }))).toBeUndefined()
    })

    it('getToolInput returns the input object', () => {
      const input = { command: 'ls' }
      expect(getToolInput(makeEvent({ toolInput: input }))).toBe(input)
    })

    it('getFilePath extracts file_path', () => {
      expect(getFilePath(makeEvent({ toolInput: { file_path: '/a/b.ts' } }))).toBe('/a/b.ts')
    })

    it('getFilePath returns undefined when absent', () => {
      expect(getFilePath(makeEvent({ toolInput: {} }))).toBeUndefined()
    })

    it('getFilePath returns undefined for an empty string', () => {
      expect(getFilePath(makeEvent({ toolInput: { file_path: '' } }))).toBeUndefined()
    })

    it('getFilePath returns undefined for a non-string value', () => {
      expect(getFilePath(makeEvent({ toolInput: { file_path: 42 } }))).toBeUndefined()
    })

    it('getFilePath falls back to notebook_path when file_path is absent (NotebookEdit)', () => {
      expect(
        getFilePath(makeEvent({ toolName: 'NotebookEdit', toolInput: { notebook_path: '/a/nb.ipynb' } })),
      ).toBe('/a/nb.ipynb')
    })

    it('getFilePath prefers file_path over notebook_path when both are present', () => {
      expect(
        getFilePath(
          makeEvent({ toolInput: { file_path: '/a/b.ts', notebook_path: '/a/nb.ipynb' } }),
        ),
      ).toBe('/a/b.ts')
    })

    it('getFilePath returns undefined when notebook_path is an empty string', () => {
      expect(getFilePath(makeEvent({ toolInput: { notebook_path: '' } }))).toBeUndefined()
    })
  })

  describe('getCwd', () => {
    it('extracts a string cwd from event.raw', () => {
      expect(getCwd(makeEvent({ raw: { cwd: '/proj/root' } }))).toBe('/proj/root')
    })

    it('returns undefined when raw has no cwd key', () => {
      expect(getCwd(makeEvent({ raw: {} }))).toBeUndefined()
    })

    it('returns undefined for an empty-string cwd', () => {
      expect(getCwd(makeEvent({ raw: { cwd: '' } }))).toBeUndefined()
    })

    it('returns undefined for a non-string cwd instead of throwing (malformed payload)', () => {
      expect(getCwd(makeEvent({ raw: { cwd: 42 } }))).toBeUndefined()
    })

    it('returns undefined when raw itself is not an object', () => {
      expect(getCwd(makeEvent({ raw: null as unknown as Record<string, unknown> }))).toBeUndefined()
      expect(getCwd(makeEvent({ raw: 'not-an-object' as unknown as Record<string, unknown> }))).toBeUndefined()
    })
  })

  describe('extractToolResponseField', () => {
    it('returns the tool_response directly when it is already a plain string', () => {
      expect(extractToolResponseField({ tool_response: 'raw text' }, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)).toBe(
        'raw text',
      )
    })

    it('returns the first matching key in caller-supplied priority order', () => {
      const raw = { tool_response: { body: 'b-value', text: 't-value', content: 'c-value' } }
      // OUTPUT_FIRST prefers content over text over body (output absent here).
      expect(extractToolResponseField(raw, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)).toBe('c-value')
      // BODY_FIRST prefers body over text over content (output absent here).
      expect(extractToolResponseField(raw, BODY_FIRST_TOOL_RESPONSE_KEYS)).toBe('b-value')
    })

    it('skips a non-string value for a key and falls through to the next one in priority order', () => {
      const raw = { tool_response: { output: 42, content: 'c-value' } }
      expect(extractToolResponseField(raw, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)).toBe('c-value')
    })

    it('returns empty string when tool_response is absent, null, or has no matching key', () => {
      expect(extractToolResponseField({}, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)).toBe('')
      expect(extractToolResponseField({ tool_response: null }, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)).toBe('')
      expect(extractToolResponseField({ tool_response: { other: 'x' } }, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)).toBe('')
    })
  })

  describe('countNonEmptyLines', () => {
    it('counts only non-empty lines, ignoring blank lines', () => {
      expect(countNonEmptyLines('a\n\nb\n\n\nc')).toBe(3)
    })

    it('returns 0 for an empty string', () => {
      expect(countNonEmptyLines('')).toBe(0)
    })

    it('handles CRLF and lone-CR line endings the same as LF', () => {
      expect(countNonEmptyLines('a\r\nb\rc\nd')).toBe(4)
    })

    it('treats a whitespace-only line as non-empty (only a truly zero-length line is dropped)', () => {
      expect(countNonEmptyLines('a\n   \nb')).toBe(3)
    })
  })

  describe('estimateResultCount', () => {
    // Real Claude Code Grep `files_with_matches` wire format (confirmed against real transcript
    // logs), which prefixes the file list with a "Found N file(s)" summary line that is not
    // itself a match -- countNonEmptyLines would overcount these by exactly one.
    it('reads the count from a "Found N files" summary line rather than counting it as a match', () => {
      expect(estimateResultCount('Found 4 files\na.ts\nb.ts\nc.ts\nd.ts')).toBe(4)
    })

    it('handles the singular "Found 1 file" form', () => {
      expect(estimateResultCount('Found 1 file\na.ts')).toBe(1)
    })

    it('treats "No files found" as zero matches, not one', () => {
      expect(estimateResultCount('No files found')).toBe(0)
    })

    it('treats "No matches found" (content/count mode empty result) as zero matches', () => {
      expect(estimateResultCount('No matches found')).toBe(0)
    })

    it('reads a "Found N matches" summary line the same way', () => {
      expect(estimateResultCount('Found 3 matches\nfoo\nbar\nbaz')).toBe(3)
    })

    it('falls back to a raw non-empty-line count when there is no summary line (Grep content mode, Glob path list)', () => {
      expect(estimateResultCount('a.ts\nb.ts\nc.ts')).toBe(3)
    })

    it('returns 0 for an empty string', () => {
      expect(estimateResultCount('')).toBe(0)
    })
  })

  describe('output builders', () => {
    it('passOutput', () => {
      expect(passOutput()).toEqual({ hookType: 'pass' })
    })

    it('denyOutput', () => {
      expect(denyOutput('blocked')).toEqual({ hookType: 'deny', message: 'blocked' })
    })

    it('contextOutput', () => {
      expect(contextOutput('hint')).toEqual({ hookType: 'context', context: 'hint' })
    })
  })
})
