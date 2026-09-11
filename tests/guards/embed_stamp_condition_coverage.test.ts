/**
 * Guard: every conditional skip that stamps `files.embed_sha` encodes the condition it skipped on.
 *
 * `embed_sha` is a freshness key. A skip that stamps the BARE content sha writes the same value a
 * genuinely successful embed writes, so the two become indistinguishable and the decision can never
 * re-open: change the input the skip hinged on and the file still reads as fresh, forever. That has
 * shipped here three times now, each caught separately -- `disabled:` for the config-off skip,
 * `unavailable:` for the missing-deps skip, and `oversize:<kb>:` for the size-threshold skip, which
 * left `semantic` permanently blind to content that `symbol` and `read` kept serving normally.
 *
 * So the rule is a decision per site rather than a blanket ban. A stamp site either carries a
 * condition-encoding marker, or it is listed below with a reason saying why its skip is terminal --
 * where terminal means no reachable input change could make that file embeddable later. The reason
 * is checked against a marker that must still be present in `src/parser.ts`, so a reason that stops
 * being true fails rather than reading as a settled decision. A site the scanner finds but this
 * table does not name fails outright, which is what makes adding a new skip a decision.
 *
 * Terminal by nature versus terminal by today's code is recorded per entry, because the second kind
 * is only terminal until someone makes its hardcoded value configurable -- at which point the stamp
 * has to start encoding it, exactly as the size threshold did.
 *
 * The scanner matches on the call's own syntax and the count floors below are non-zero, so a rename
 * that empties the population fails instead of passing vacuously.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PARSER = path.join(REPO_ROOT, 'src', 'parser.ts')

/** Prefix helpers whose presence in a stamp's transform means the stored value encodes the skip's condition. */
const CONDITION_ENCODING = ['disabledEmbedSha', 'unavailableEmbedSha', 'oversizeEmbedSha'] as const

interface Site {
  /** The full source text of the `stampEmbedSha(...)` call. */
  readonly call: string
  /** The source immediately preceding the call, used to identify which skip it belongs to. */
  readonly context: string
}

/**
 * Every `stampEmbedSha(` call in `src/parser.ts`, with the source that precedes it.
 *
 * Balanced-paren scanning rather than a regex: the transform argument contains its own call
 * parentheses (`(s) => oversizeEmbedSha(s, ixCfg.large_file_symbol_only_kb)`), which a
 * non-greedy `\(...\)` match would cut in half and silently misclassify as bare.
 */
function collectStampSites(source: string): Site[] {
  const sites: Site[] = []
  const needle = 'stampEmbedSha('
  let from = 0
  for (;;) {
    const at = source.indexOf(needle, from)
    if (at === -1) break
    // The function's own declaration is not a stamp site: it has no transform argument to classify.
    if (source.slice(Math.max(0, at - 9), at) === 'function ') {
      from = at + needle.length
      continue
    }
    let depth = 0
    let end = at + needle.length - 1
    for (; end < source.length; end++) {
      const ch = source[end]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) break
      }
    }
    sites.push({ call: source.slice(at, end + 1), context: source.slice(Math.max(0, at - 900), at) })
    from = end + 1
  }
  return sites
}

type Terminality = 'by nature' | "by today's code"

interface Exemption {
  /** A string from the skip's own condition, which must appear in the source just above the stamp. */
  readonly anchor: string
  readonly terminality: Terminality
  readonly reason: string
}

/**
 * The bare-sha stamps, each with why its skip can never re-open.
 *
 * "By nature" means the content itself offers nothing to embed, so no setting anywhere could change
 * the outcome. "By today's code" means the condition is a literal in this function: terminal only
 * while it stays one, and the day it becomes configurable the stamp must start encoding it.
 */
const EXEMPT: readonly Exemption[] = [
  {
    anchor: "filePath.toLowerCase().endsWith('.profile-meta.xml')",
    terminality: "by today's code",
    reason:
      'The suffix is a literal in indexFileEmbeddings and no config key or environment variable reaches it, so a profile file can never become embeddable without a source change. If the never-embed list is ever made configurable, this stamp has to carry the list it was skipped under.',
  },
  {
    anchor: 'extracted === null || extracted.trim().length === 0',
    terminality: 'by nature',
    reason:
      'The document yielded no extractable text at all. There is nothing to embed regardless of any threshold, flag, model or runtime, so re-reading it could only reach this same return.',
  },
  {
    anchor: 'virtual.cellLanguage === null',
    terminality: 'by nature',
    reason:
      'The notebook declares no cell language, so ipynbToVirtualSource produces no source to chunk. No input change makes a language appear in a file that does not name one.',
  },
  {
    anchor: "detectLanguage(filePath) === 'salesforce_metadata' && content.length > 512 * 1024",
    terminality: "by today's code",
    reason:
      'The 512 KB ceiling is a literal in this branch rather than a config key, so nothing a user can set re-opens it. Making it configurable would put this branch in exactly the position the large_file_symbol_only_kb skip was in before it started stamping oversize:<kb>:, and the stamp would then have to encode the ceiling.',
  },
]

const source = fs.readFileSync(PARSER, 'utf8')
const sites = collectStampSites(source)

describe('every conditional embed_sha stamp encodes the condition it skipped on', () => {
  it('finds the stamp sites at all, so a rename cannot empty this guard silently', () => {
    // Floors, not exact counts: adding a skip must not require touching this line, but losing the
    // whole population to a rename must fail here rather than pass vacuously.
    expect(sites.length).toBeGreaterThanOrEqual(8)
    const encoding = sites.filter((s) => CONDITION_ENCODING.some((p) => s.call.includes(p)))
    expect(encoding.length).toBeGreaterThanOrEqual(3)
    // Each marker helper must really be in use: a union floor alone would let one of the three
    // disappear behind its siblings.
    for (const prefix of CONDITION_ENCODING) {
      expect(sites.filter((s) => s.call.includes(prefix)).length).toBeGreaterThanOrEqual(1)
    }
  })

  it('every bare-sha stamp is a listed skip with a stated reason for being terminal', () => {
    const bare = sites.filter((s) => !CONDITION_ENCODING.some((p) => s.call.includes(p)))
    expect(bare.length).toBeGreaterThan(0)
    const unexplained = bare.filter((s) => !EXEMPT.some((e) => s.context.includes(e.anchor)))
    expect(
      unexplained.map((s) => s.call),
      'a stamp site writes the bare content sha, which a successful embed also writes: give it a condition-encoding marker, or list it in EXEMPT with the reason its skip can never re-open',
    ).toEqual([])
  })

  it('every stated reason still matches the code it describes', () => {
    // An anchor that no longer appears is a reason that has quietly stopped being about anything:
    // the branch moved, was renamed, or was deleted, and the exemption would otherwise keep reading
    // as a settled decision for a site that is not there.
    for (const entry of EXEMPT) {
      expect(source.includes(entry.anchor), `EXEMPT anchor no longer in src/parser.ts: ${entry.anchor}`).toBe(true)
      expect(entry.reason.length).toBeGreaterThan(40)
    }
    // Both kinds of terminality are represented, so the distinction stays a live one rather than a
    // label everything happens to share.
    expect(new Set(EXEMPT.map((e) => e.terminality)).size).toBe(2)
  })
})

describe('the embedding stack identity re-opens the embed decision on both index paths', () => {
  // ensureEmbeddingProvenance is what re-opens every embed_sha at once when the model or inference
  // runtime changes, an input embed_sha itself does not encode. It used to be reachable only from
  // upsertChunks and searchSemantic, both downstream of the per-file freshness gate, so a whole
  // index run after a runtime upgrade skipped every file and kept the previous stack's vectors.
  const ENTRY_POINTS = ['src/cli.ts', 'src/worker.ts'] as const

  it('is called from both entry points, before either reads a file row', () => {
    expect(ENTRY_POINTS.length).toBeGreaterThan(0)
    for (const rel of ENTRY_POINTS) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
      const callAt = text.indexOf('ensureEmbeddingProvenance(')
      expect(callAt, `${rel} no longer calls ensureEmbeddingProvenance`).toBeGreaterThan(-1)
      // Ordering is the whole point: the reset clears each affected file's embed_sha, so a check
      // that runs after the row has been read into `entry` cannot be seen by the gate that uses it.
      const rowReadAt = text.indexOf('getFileEntry(')
      expect(rowReadAt, `${rel} no longer reads a file row`).toBeGreaterThan(-1)
      expect(callAt, `${rel} checks the embedding stack only after reading a file row`).toBeLessThan(rowReadAt)
    }
  })
})
