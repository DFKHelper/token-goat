/**
 * A workflow with no top-level `permissions:` block inherits whatever the repository default is,
 * which on many repositories is a writable `GITHUB_TOKEN`. CI and the publish workflow both had no
 * top-level block, so every job in them ran on an inherited token nobody had chosen. The publish
 * job already declared its own least-privilege set; CI never did. An IaC scan flags this as
 * CKV2_GHA_1, and the fix is the one worth having anyway: a read-only default that any job needing
 * more has to override in the open. The sibling guard covers action pinning, not token scope.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { pinnedPopulation } from './population.js'

const workflowDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows')

function workflowFiles(): string[] {
  // Pinned: a rename of the workflow directory, or a move to a third extension, would empty this
  // list and let every permissions assertion below pass against no workflows at all.
  return [
    ...pinnedPopulation({
      what: '.github/workflows/*.yml files',
      items: fs.readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')),
      floor: 3,
      mustInclude: ['ci.yml', 'publish.yml'],
    }),
  ]
}

function read(file: string): string {
  return fs.readFileSync(path.join(workflowDir, file), 'utf8')
}

/** Column zero only. A `permissions:` nested under a job says nothing about the workflow default. */
function topLevelPermissionsBlock(text: string): string | undefined {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^permissions:/.test(l))
  if (start === -1) return undefined
  const body: string[] = [lines[start] as string]
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    body.push(line)
  }
  return body.join('\n')
}

describe('workflow token scope', () => {
  const files = workflowFiles()

  it('finds the workflow files at all, so an empty sweep cannot pass as a clean one', () => {
    expect(files.length).toBeGreaterThanOrEqual(3)
  })

  it.each(files.map((f) => [f]))('%s declares a top-level permissions default', (file) => {
    expect(topLevelPermissionsBlock(read(file)), `${file} inherits the repository default token`).toBeDefined()
  })

  it.each(files.map((f) => [f]))('%s does not hand out write-all', (file) => {
    const block = topLevelPermissionsBlock(read(file)) ?? ''

    expect(block).not.toMatch(/permissions:\s*write-all/)
    expect(block).not.toMatch(/^\s+\S+:\s*write-all/m)
  })

  // The default is only meaningful if it is actually restrictive. `contents: read` is the floor
  // every one of these workflows can live with, since the job that needs more says so itself.
  it.each(files.map((f) => [f]))('%s keeps contents read-only at the top level', (file) => {
    expect(topLevelPermissionsBlock(read(file))).toMatch(/^\s+contents:\s*read\s*$/m)
  })

  it('still grants the publish job the id-token it needs for provenance, at the job level', () => {
    const publish = read('publish.yml')

    expect(publish).toContain('id-token: write')
    expect(topLevelPermissionsBlock(publish), 'id-token must not be the workflow-wide default').not.toContain(
      'id-token',
    )
  })
})
