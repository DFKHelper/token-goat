/** The seeded distractor corpus the retrieval eval can index beside the labelled files: the same inputs must give the same files on every run (a report made with it is diffed against another), and the corpus must actually contain the three things it exists to supply. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { DISTRACTOR_SEED, generateDistractors } from '../evals/retrieval/distractors.js'
import { materializeCorpus, parseDistractorCount } from '../scripts/eval-retrieval.js'

describe('generateDistractors', () => {
  // HAND-DERIVED: the properties below are stated from the generator's contract (seed DISTRACTOR_SEED = 20261008, 40 files, four declarations per file), not read off its output.
  const files = generateDistractors(40, ['processDirtyBatch', 'runAnswer'])

  it('gives the same files for the same seed and different files for another', () => {
    expect(generateDistractors(40, ['processDirtyBatch', 'runAnswer'], DISTRACTOR_SEED)).toEqual(files)
    expect(generateDistractors(40, ['processDirtyBatch', 'runAnswer'], DISTRACTOR_SEED + 1)).not.toEqual(files)
  })

  it('makes exactly count files, four declarations each, under distractors/', () => {
    expect(files).toHaveLength(40)
    expect(files[0]?.path).toBe('distractors/d0000.ts')
    expect(files[39]?.path).toBe('distractors/d0039.ts')
    for (const f of files) expect(f.content.match(/^export function /gm)).toHaveLength(4)
  })

  it('supplies placeholder bodies, near-duplicate names and boilerplate', () => {
    const all = files.map((f) => f.content).join('\n')
    expect(all).toContain("throw new Error('not implemented')")
    expect(all).toContain('// TODO: implement')
    expect(all).toMatch(/\): void \{\}/)
    expect(all).toMatch(/export function (processDirtyBatch|runAnswer)(Impl|Stub|Legacy|V2|Fallback)\(/)
    expect(all).toContain('return holder.value')
  })

  it('never uses a supplied name bare, so a distractor cannot be the symbol the golden set asks for', () => {
    const all = files.map((f) => f.content).join('\n')
    expect(all).not.toMatch(/export function (processDirtyBatch|runAnswer)\(/)
  })

  it('returns no files for a count of zero and still names things with no near names given', () => {
    expect(generateDistractors(0)).toEqual([])
    expect(generateDistractors(5).map((f) => f.content).join('\n')).toMatch(/export function [a-z]+[A-Z][a-z]+[0-9]{2}\(/)
  })
})

describe('parseDistractorCount', () => {
  it('is null without the flag, a number for a whole number, and a refusal for anything else', () => {
    expect(parseDistractorCount(undefined)).toBeNull()
    expect(parseDistractorCount('0')).toBe(0)
    expect(parseDistractorCount('120')).toBe(120)
    for (const bad of ['', '-1', '1.5', 'many', '12x']) expect(() => parseDistractorCount(bad)).toThrow(/whole number/)
  })
})

describe('materializeCorpus', () => {
  it('copies the labelled files and adds the distractors, in a git repo that tracks them', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'tg-corpus-'))
    try {
      const repo = path.join(tmp, 'repo')
      mkdirSync(path.join(repo, 'src'), { recursive: true })
      writeFileSync(path.join(repo, 'src', 'a.ts'), 'export function alpha(): number {\n  return 1\n}\n')
      const golden = [{ id: 'g1', query: 'alpha', kind: 'identifier' as const, relevant: [{ file: 'src/a.ts', symbol: 'alpha' }] }]
      const dest = path.join(tmp, 'corpus')
      materializeCorpus(repo, golden, dest, 3)
      expect(readFileSync(path.join(dest, 'src', 'a.ts'), 'utf8')).toContain('alpha')
      const tracked = spawnSync('git', ['ls-files'], { cwd: dest, encoding: 'utf8' }).stdout.split('\n').filter((l) => l !== '')
      expect(tracked).toEqual(['distractors/d0000.ts', 'distractors/d0001.ts', 'distractors/d0002.ts', 'src/a.ts'])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
