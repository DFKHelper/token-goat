/** parserFingerprintForLanguage only reads back which digest an already-indexed row should carry. It decides nothing about what a parse extracts or how a file's bytes become chunk text, so it must not live in a file either fingerprint hashes -- and it did, for one commit: it was added to src/parser_types.ts, which embedFingerprintSources() hashes whole, and the embed digest moved from b7b2ff71de288d13 to 08d8101c9bce353e. That would have re-embedded every already-indexed file on upgrade (17,855 of them on one real index measured here), the expensive half of indexing, for a pure map lookup. This guard pins the property rather than either digest's current value: wherever the resolver is defined, that file must be outside both hashed sets. */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { embedFingerprintSources, extractionSources } from '../../scripts/parser-fingerprint.mjs'
import { pinnedPopulation } from './population.js'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'src')

const relative = (f: string): string => path.relative(ROOT, f).split(path.sep).join('/')

/** FORMAT-DERIVED: the exported-function declaration form is TypeScript's own syntax (https://www.typescriptlang.org/docs/handbook/2/modules.html), not a shape read off this repo's code. The only borrowed token is the symbol name itself, and the non-vacuity assertion below turns a stale name into a failure rather than a silent pass. */
const DECLARATION = /^export function parserFingerprintForLanguage\b/m

/** Every .ts file under src/, pinned so a broken walk cannot report "the resolver is nowhere hashed" by having scanned nothing. The anchor names parser_types.ts, the file the resolver was wrongly added to, since a walk that stopped reaching it would go green with the defect restored. */
function srcTypeScriptFiles(): readonly string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) found.push(relative(full))
    }
  }
  walk(SRC)
  // Moved 524 -> 529 when src/unbounded_walk.ts (find2), src/process_tree.ts (orph4), src/resident_process.ts and src/stray_residents.ts (s1), and src/bash_backslash_repair.ts (BS) were added (measured: 529 modules). Moved 529 -> 530 when src/git_hint.ts (gitasync 1b: the spawn-free branch read and the timed-out dirty probe) was added (measured: 530 modules). Moved 530 -> 531 when src/git_async.ts (gitasync 4b: runGitAsync, loaded lazily by the hooks) was added (measured: 531 modules). Moved 531 -> 532 when src/bridges/aider_install.ts was added (measured: 532 modules). Moved 532 -> 533 when src/read_signature.ts was added (measured: 533 modules). Moved 533 -> 534 when src/inline_symbol_answer.ts (the inlined Grep answer) was added (measured: 534 modules). Moved 534 -> 535 when src/inline_grep_scan.ts (the ripgrep line model the answer proves its pattern against) was added (measured: 535 modules). Moved 535 -> 536 when src/image_slice.ts was added (measured: 536 modules). Moved 536 -> 537 when src/cold_gap.ts (the session-audit cold-cache re-write accounting) was added (measured: 537 modules). Moved 537 -> 538 when src/verification_commands.ts (the Stop advisory's script-check recogniser) was added (measured: 538 modules). Moved 538 -> 539 when src/shell_writes.ts (the files a shell command writes, and whether it may write any) was added (measured: 539 modules). Moved 539 -> 540 when src/build_stamp.ts (the running build against the one on disk) was added (measured: 540 modules). Moved 540 -> 541 when src/reconcile_stamp.ts (session start remembers a recent sweep and a slow listing) was added (measured: 541 modules). Moved 541 -> 542 when src/hooks_read_window_stream.ts (streamed bounded source-window reads) was added (measured: 542 modules). Moved 542 -> 543 when src/skill_section_spec.ts was added (measured: 543 modules).
  return pinnedPopulation({ what: 'TypeScript modules under src/', items: found.sort(), floor: 414, ceiling: 543, mustIncludeExact: ['src/parser_types.ts'] })
}

function srcFilesDefining(pattern: RegExp): string[] {
  return srcTypeScriptFiles().filter((f) => pattern.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
}

describe('the parser-stamp resolver lives outside every hashed fingerprint source', () => {
  it('is defined exactly once under src/, so this guard cannot pass because it found nothing', () => {
    expect(
      srcFilesDefining(DECLARATION),
      'no src/ file declares parserFingerprintForLanguage -- the symbol was renamed or removed, and every assertion below would have passed vacuously against an empty set',
    ).toHaveLength(1)
  })

  it('is not hashed by extractionSources() or embedFingerprintSources(), so editing a stamp lookup reparses and re-embeds nothing', () => {
    const extraction = new Set(extractionSources().map(relative))
    const embed = new Set(embedFingerprintSources().map(relative))
    for (const file of srcFilesDefining(DECLARATION)) {
      expect(
        embed.has(file),
        `${file} defines parserFingerprintForLanguage and is hashed into EMBED_FINGERPRINT, so every edit to a stamp lookup re-embeds every indexed file -- the expensive half of indexing, for a map lookup that decides nothing about chunk text`,
      ).toBe(false)
      expect(
        extraction.has(file),
        `${file} defines parserFingerprintForLanguage and is hashed into PARSER_FINGERPRINT, so every edit to a stamp lookup invalidates every indexed file's parse`,
      ).toBe(false)
    }
  })
})
