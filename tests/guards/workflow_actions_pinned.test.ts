/**
 * A `uses: actions/checkout@v4` reference resolves through a mutable tag: whoever controls the
 * action repository can repoint it at any commit, and every workflow run picks that up silently.
 * Supply-chain review asks for a commit SHA instead. The publish workflow was already pinned; CI
 * and Pages were not, and Pages holds `pages: write` and `id-token: write`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { pinnedPopulation } from './population.js'

const workflowDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows')

interface Reference {
  file: string
  line: number
  value: string
}

function collectUses(): Reference[] {
  const refs: Reference[] = []
  for (const file of pinnedPopulation({
    what: '.github/workflows/*.yml files',
    items: fs.readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')),
    floor: 3,
    mustInclude: ['ci.yml', 'publish.yml'],
  })) {
    const lines = fs.readFileSync(path.join(workflowDir, file), 'utf8').split('\n')
    lines.forEach((text, index) => {
      const match = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(text)
      if (match?.[1]) refs.push({ file, line: index + 1, value: match[1] })
    })
  }
  return refs
}

describe('workflow action pinning', () => {
  const refs = collectUses()

  it('finds the workflow files at all, so an empty sweep cannot pass as a clean one', () => {
    expect(refs.length).toBeGreaterThan(10)
    expect(new Set(refs.map((r) => r.file)).size).toBeGreaterThanOrEqual(3)
  })

  it('pins every third-party action to a full commit SHA', () => {
    const unpinned = refs
      .filter((r) => !r.value.startsWith('./'))
      .filter((r) => !/@[0-9a-f]{40}$/.test(r.value))
      .map((r) => `${r.file}:${r.line} ${r.value}`)

    expect(unpinned, 'these resolve through a mutable tag').toEqual([])
  })

  it('keeps a version comment beside each pin, so the SHA can be read by a human', () => {
    const missing: string[] = []
    for (const file of pinnedPopulation({
      what: '.github/workflows/*.yml files',
      items: fs.readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')),
      floor: 3,
      mustInclude: ['ci.yml', 'publish.yml'],
    })) {
      const lines = fs.readFileSync(path.join(workflowDir, file), 'utf8').split('\n')
      lines.forEach((text, index) => {
        if (!/uses:\s*\S+@[0-9a-f]{40}/.test(text)) return
        if (!/#\s*v?\d/.test(text)) missing.push(`${file}:${index + 1}`)
      })
    }

    expect(missing).toEqual([])
  })
})
