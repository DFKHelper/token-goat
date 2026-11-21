/** The README claimed the suite ran on "Node.js 20 and 22" while package.json required >=22 and every CI job pinned 22, so a reviewer building a support matrix from the README got a version nothing was ever tested on. Three places state this and none of them checked each other. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { pinnedPopulation } from './population.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const workflowDir = path.join(repoRoot, '.github', 'workflows')

const engines = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { engines?: { node?: string } })
  .engines?.node
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')

/** Every `node-version:` a workflow pins, as a number, so a string mismatch cannot hide a real one. */
function workflowNodeVersions(): { where: string; version: number }[] {
  const found: { where: string; version: number }[] = []
  for (const file of pinnedPopulation({
    what: '.github/workflows/*.yml files',
    items: fs.readdirSync(workflowDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')),
    floor: 3,
    mustInclude: ['ci.yml', 'publish.yml'],
  })) {
    const lines = fs.readFileSync(path.join(workflowDir, file), 'utf8').split('\n')
    lines.forEach((text, index) => {
      const match = /node-version:\s*'?"?(\d+)/.exec(text)
      if (match?.[1]) found.push({ where: `${file}:${index + 1}`, version: Number(match[1]) })
    })
  }
  return found
}

/** Whether dotted version `version` is at or above `floor`, compared segment by segment as numbers, so `22.23.3` clears `22.16.0`. */
function atLeast(version: string, floor: string): boolean {
  const a = version.split('.').map(Number)
  const b = floor.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

describe('Node support claims', () => {
  const required = Number(/(\d+)/.exec(engines ?? '')?.[1] ?? -1)
  /** The whole floor, not just its major: `>=22.16.0` -> `22.16.0`. */
  const floor = /(\d+(?:\.\d+)*)/.exec(engines ?? '')?.[1] ?? ''
  // How a human writes that floor, which is how the README writes it: trailing zero segments are dropped, so `22.0.0` reads as "22" and `22.16.0` as "22.16". Comparing only the major would have let the README keep saying "Node.js 22" after the node:sqlite driver raised the real floor to 22.16, which is the drift this line exists to catch.
  const label = floor.replace(/(?:\.0)+$/, '')
  const pinned = workflowNodeVersions()
  // The Node release the WSL pre-push run downloads when the login shell has none new enough; a separate pin from the workflows, so it is read on its own.
  const wslPin = /^NODE_VERSION="(\d+(?:\.\d+)*)"/m.exec(fs.readFileSync(path.join(repoRoot, '.lefthook-scripts', 'wsl-test.sh'), 'utf8'))?.[1] ?? ''

  it('finds the declarations at all, so an empty sweep cannot pass as a clean one', () => {
    expect(required).toBeGreaterThan(0)
    expect(pinned.length).toBeGreaterThan(0)
    expect(label.length).toBeGreaterThan(0)
    // The trim only ever removes zeroes, so the label cannot quietly become a weaker claim than the floor it is derived from: `22.16.0` may shorten to `22.16`, never to `22`.
    const dropped = floor.split('.').slice(label.split('.').length)
    expect(
      dropped.every((part) => Number(part) === 0),
      `the README label "${label}" drops a non-zero part of the engines floor "${floor}"`,
    ).toBe(true)
  })

  it('states the engines floor in the README requirements line', () => {
    expect(readme).toContain(`Node.js ${label} or later`)
  })

  it('never runs CI on a version the package says it does not support', () => {
    const tooOld = pinned.filter((p) => p.version < required).map((p) => `${p.where} pins ${p.version}`)

    expect(tooOld, 'these run below the engines floor').toEqual([])
  })

  it('runs the WSL pre-push suite on a Node at or above the engines floor', () => {
    expect(wslPin, 'wsl-test.sh has no NODE_VERSION pin to check').not.toBe('')
    expect(atLeast(wslPin, floor), `wsl-test.sh pins Node ${wslPin}, below the engines floor ${floor}`).toBe(true)
  })

  it('does not advertise a tested version that no workflow actually runs', () => {
    const ran = new Set(pinned.map((p) => p.version))
    const advertised = [...readme.matchAll(/(?:runs?|tested) on Node\.js (\d+)/g)].map((m) => Number(m[1]))

    for (const version of advertised) expect(ran, `README says the suite runs on Node ${version}`).toContain(version)
  })
})
