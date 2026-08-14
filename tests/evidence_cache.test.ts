import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let testDataDir = ''

vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, dataDir: () => testDataDir }
})

import {
  buildDeltaCapsule,
  findVerifiedFileEvidence,
  recordEvidence,
  searchEvidence,
  searchEvidenceSemantically,
} from '../src/evidence_cache.js'
import { normalizePath } from '../src/paths.js'
import { setPipelineFnForTesting } from '../src/embeddings.js'
import { clearModuleCaches } from '../src/reset.js'

beforeEach(() => {
  testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-evidence-cache-'))
})

afterEach(() => {
  clearModuleCaches()
  fs.rmSync(testDataDir, { recursive: true, force: true })
})

describe('workspace evidence cache', () => {
  it('finds only same-project, same-file evidence with an exact current-content hash', () => {
    const project = path.join(testDataDir, 'project')
    const source = path.join(project, 'src', 'example.ts')
    const content = 'export const answer = 42\n'

    recordEvidence({ projectRoot: project, source, representation: 'file', text: content })

    expect(findVerifiedFileEvidence(project, source, content)?.source).toBe(normalizePath(source))
    expect(findVerifiedFileEvidence(project, source, 'export const answer = 43\n')).toBeNull()
    expect(findVerifiedFileEvidence(path.join(testDataDir, 'other'), source, content)).toBeNull()
  })

  it('redacts persisted text while retaining a hash of the original content for verification', () => {
    const project = path.join(testDataDir, 'project')
    const source = path.join(project, 'config.ts')
    const content = 'const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"\n'

    recordEvidence({ projectRoot: project, source, representation: 'file', text: content })

    const cache = fs.readFileSync(path.join(testDataDir, 'workspace-evidence.json'), 'utf8')
    expect(cache).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890')
    expect(findVerifiedFileEvidence(project, source, content)).not.toBeNull()
  })

  it('keeps only the latest evidence for a file and reports changed files without their bodies', () => {
    const project = path.join(testDataDir, 'project')
    const source = path.join(project, 'src', 'example.ts')
    fs.mkdirSync(path.dirname(source), { recursive: true })
    fs.writeFileSync(source, 'export const answer = 42\n')

    recordEvidence({ projectRoot: project, source, representation: 'file', text: 'export const answer = 41\n' })
    recordEvidence({ projectRoot: project, source, representation: 'file', text: 'export const answer = 42\n' })
    expect(buildDeltaCapsule(project)).toBeNull()

    fs.writeFileSync(source, 'export const answer = 43\n')
    const capsule = buildDeltaCapsule(project)
    expect(capsule).toContain(normalizePath(source))
    expect(capsule).not.toContain('answer = 43')
    expect(searchEvidence(project, 'answer')).toHaveLength(1)
  })

  it('ranks redacted evidence semantically within its project and persists its vector', async () => {
    const project = path.join(testDataDir, 'project')
    const otherProject = path.join(testDataDir, 'other')
    setPipelineFnForTesting(async () => async (text: string) => {
      const vector = new Float32Array(384)
      vector[text.includes('marine') ? 0 : 1] = 1
      return { data: vector }
    })
    recordEvidence({ projectRoot: project, source: path.join(project, 'ocean.md'), representation: 'file', text: 'marine biology report' })
    recordEvidence({ projectRoot: otherProject, source: path.join(otherProject, 'forest.md'), representation: 'file', text: 'forest ecology report' })

    const hits = await searchEvidenceSemantically(project, 'marine research')

    expect(hits).toHaveLength(1)
    expect(hits[0]?.source).toBe(normalizePath(path.join(project, 'ocean.md')))
    expect(fs.readFileSync(path.join(testDataDir, 'workspace-evidence.json'), 'utf8')).toContain('"embedding"')
  })
})
