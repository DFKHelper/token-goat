import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { measureListings, renderListingReport, splitListingContent } from '../src/listing_size.js'

// Provenance: CAPTURE of the attachment shapes, FORMAT only. Key names and value shapes were read off `skill_listing` and `agent_listing_delta` attachments in local Claude Code transcripts on 2026-09-28: `skill_listing` carries {type, content, skillCount, isInitial, names}, and `agent_listing_delta` carries {type, addedTypes, addedLines, removedTypes, isInitial, showConcurrencyNote}. The same scan found a skill description running over several lines, a plugin agent named `code-simplifier:code-simplifier`, 113 non-initial skill listings that add skills, and agent deltas that only remove types. The names and description text here are synthetic stand-ins for those shapes, and the byte counts are HAND-DERIVED from them.

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function transcript(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-listing-'))
  tmpDirs.push(dir)
  const file = path.join(dir, 'session.jsonl')
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
  return file
}

const skillA = '- alpha: Short.'
const skillB = '- beta: A description that runs\nover a second line.'
const skillC = '- plug:gamma: Plugin. Use when: asked.'
const skillD = '- delta: Added later from a nested directory.'

function skillListing(content: string, isInitial: boolean): unknown {
  return { type: 'attachment', attachment: { type: 'skill_listing', content, skillCount: content.split('\n- ').length, isInitial, names: [] } }
}

function agentDelta(added: [string, string][], removed: string[], isInitial: boolean): unknown {
  return {
    type: 'attachment',
    attachment: { type: 'agent_listing_delta', addedTypes: added.map(([t]) => t), addedLines: added.map(([, l]) => l), removedTypes: removed, isInitial, showConcurrencyNote: true },
  }
}

describe('splitListingContent', () => {
  it('keeps a description that runs over several lines with its entry, and ends a name at the first ": "', () => {
    const entries = splitListingContent([skillA, skillB, skillC].join('\n'))
    expect(entries).toEqual([
      { name: 'alpha', bytes: Buffer.byteLength(skillA) },
      { name: 'beta', bytes: Buffer.byteLength(skillB) },
      { name: 'plug:gamma', bytes: Buffer.byteLength(skillC) },
    ])
  })
})

describe('measureListings', () => {
  it('counts every re-send, replaces the listing on an initial one, and merges a non-initial one', async () => {
    const first = [skillA, skillB].join('\n')
    const resend = [skillA, skillB, skillC].join('\n')
    const file = transcript([
      skillListing(first, true),
      'not json at all _listing',
      { type: 'user', message: { content: 'hello' } },
      skillListing(skillD, false),
      // A compaction: Claude Code sends the whole listing again, without the nested-directory skill until it is re-discovered.
      skillListing(resend, true),
    ])
    const r = await measureListings(file)
    expect(r.skills.injections).toBe(3)
    expect(r.skills.injectedBytes).toBe(Buffer.byteLength(first) + Buffer.byteLength(skillD) + Buffer.byteLength(resend))
    expect(r.skills.entries.map((e) => e.name)).toEqual(['beta', 'plug:gamma', 'alpha'])
    expect(r.skills.bytes).toBe(Buffer.byteLength(skillA) + Buffer.byteLength(skillB) + Buffer.byteLength(skillC))
  })

  it('names agents by addedTypes, starts over on an initial delta, applies removals, and does not count a removal-only delta as a re-send', async () => {
    const coder = '- coder: Writes code. (Tools: All tools)'
    const plugin = '- code-simplifier:code-simplifier: Simplifies code. (Tools: All tools)'
    const stale = '- old-agent: Gone after the compaction.'
    const file = transcript([
      agentDelta([['old-agent', stale]], [], true),
      agentDelta([['coder', coder], ['code-simplifier:code-simplifier', plugin]], [], true),
      agentDelta([], ['coder'], false),
    ])
    const r = await measureListings(file)
    expect(r.agents.injections).toBe(2)
    expect(r.agents.injectedBytes).toBe(Buffer.byteLength(stale) + Buffer.byteLength(coder) + Buffer.byteLength(plugin))
    expect(r.agents.entries).toEqual([{ name: 'code-simplifier:code-simplifier', bytes: Buffer.byteLength(plugin) }])
  })
})

describe('renderListingReport', () => {
  it('ranks the largest descriptions, honours --top, and says so when a transcript has no listing', async () => {
    const file = transcript([skillListing([skillA, skillB, skillC].join('\n'), true)])
    const r = await measureListings(file)
    const text = renderListingReport(r, 2)
    expect(text).toMatch(/Skills: 3 listed, .* sent once in this session/)
    expect(text).toContain('Agents: no listing in this transcript')
    const ranked = text.split('\n').filter((l) => /^\s+\d+ B /.test(l))
    expect(ranked).toHaveLength(2)
    expect(ranked[0]).toMatch(/ beta$/)
    expect(ranked[1]).toMatch(/ plug:gamma$/)
    expect(renderListingReport(r, 0)).not.toContain('## Largest')
  })
})
