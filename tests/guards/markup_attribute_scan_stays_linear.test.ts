/** Guards the Salesforce markup extractors against input whose cost grows faster than its size. The static regexp lint cannot see this: `regexp/no-super-linear-backtracking` does not flag the old Aura attribute pattern even written as a literal, `no-super-linear-move` is off, and neither can analyse a pattern built with `new RegExp` and an interpolated tag name. tests/indexer_patterns_cannot_stall_the_worker.test.ts measures only well-formed shapes. So this file feeds the extractors the malformed shapes (a tag that never closes, repeated) and measures how the time grows when the input doubles. */

import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { closeDb } from '../../src/db.js'
import { querySymbols } from '../../src/index_reader.js'
import { drainOnce, pendingEmbeddings } from '../../src/worker.js'
import { extractLwcTemplate, extractSalesforceMarkup } from '../../src/languages/salesforce_frontend.js'
import { normalizePath } from '../../src/paths.js'

import { runBundle, tgIsolatedEnv } from '../helpers/bundle.js'

// The pattern addAttributeSymbols used before the single-pass scanner, kept verbatim as the reference for the differential and as the negative control.
function oldAttributeNames(content: string, tag: string): string[] {
  const tagRe = new RegExp(`<\\s*${tag}\\b[^>]*\\bname\\s*=\\s*["']([^"']+)["'][^>]*>`, 'gi')
  return [...content.matchAll(tagRe)].map((m) => m[1] ?? '')
}

function newAttributeNames(content: string, tag: string): string[] {
  const kindOf: Record<string, string> = {
    'aura:attribute': 'aura_attribute',
    'aura:handler': 'aura_handler',
    'aura:registerEvent': 'aura_event',
    'design:attribute': 'aura_design_attribute',
  }
  return extractSalesforceMarkup(content, 'aura/x/x.cmp')
    .symbols.filter((s) => s.kind === kindOf[tag])
    .map((s) => s.name)
}

describe('Aura attribute names: the single-pass scanner against the old pattern', () => {
  // Provenance: HAND-DERIVED. Each expected list is worked out by reading the markup below, independently of either implementation.
  const cases: { label: string; markup: string; tag: string; expected: string[]; oldAgrees: boolean }[] = [
    { label: 'plain', markup: '<aura:attribute name="a" type="String"/>\n<aura:attribute name="b" type="Id"/>', tag: 'aura:attribute', expected: ['a', 'b'], oldAgrees: true },
    { label: 'name after other attributes', markup: '<aura:attribute type="String" default="x" name="late"/>', tag: 'aura:attribute', expected: ['late'], oldAgrees: true },
    { label: 'name before other attributes', markup: '<aura:attribute name="early" type="String" default="x"/>', tag: 'aura:attribute', expected: ['early'], oldAgrees: true },
    { label: 'single quotes', markup: "<aura:attribute name='single' type='String'/>", tag: 'aura:attribute', expected: ['single'], oldAgrees: true },
    { label: 'spaces around equals', markup: '<aura:attribute name = "spaced" type="String"/>', tag: 'aura:attribute', expected: ['spaced'], oldAgrees: true },
    { label: 'multi-line tag', markup: '<aura:attribute\n  type="String"\n  name="multi"\n  default="x"\n/>', tag: 'aura:attribute', expected: ['multi'], oldAgrees: true },
    { label: 'handler and event tags', markup: '<aura:handler name="init" value="{!this}" action="{!c.go}"/>\n<aura:registerEvent name="changed" type="c:E"/>', tag: 'aura:handler', expected: ['init'], oldAgrees: true },
    { label: 'registerEvent', markup: '<aura:handler name="init" action="{!c.go}"/>\n<aura:registerEvent name="changed" type="c:E"/>', tag: 'aura:registerEvent', expected: ['changed'], oldAgrees: true },
    { label: 'design attribute', markup: '<design:attribute name="title" label="Title"/>', tag: 'design:attribute', expected: ['title'], oldAgrees: true },
    { label: 'a name that is part of a longer word is not the attribute', markup: '<aura:attribute label="x" rename="no" name="yes"/>', tag: 'aura:attribute', expected: ['yes'], oldAgrees: true },
    { label: 'a tag with no name', markup: '<aura:attribute type="String"/>\n<aura:attribute name="after"/>', tag: 'aura:attribute', expected: ['after'], oldAgrees: true },
    { label: 'a > inside a quoted value before name', markup: '<aura:attribute description="a > b" name="gt" type="String"/>', tag: 'aura:attribute', expected: ['gt'], oldAgrees: false },
    { label: 'a name= inside another value is not an attribute', markup: '<aura:attribute description=\'set name="fake" here\' name="real"/>', tag: 'aura:attribute', expected: ['real'], oldAgrees: true },
    { label: 'a double quote inside single quotes', markup: '<aura:attribute description=\'say "hi"\' name="quoted"/>', tag: 'aura:attribute', expected: ['quoted'], oldAgrees: true },
  ]

  for (const c of cases) {
    it(`${c.label}: reports ${JSON.stringify(c.expected)}`, () => {
      expect(newAttributeNames(c.markup, c.tag)).toEqual(c.expected)
      // Where the old pattern agrees the two must match; where it does not, the new answer above is the one worked out by hand and the old one is wrong, which is pinned so the divergence stays deliberate.
      if (c.oldAgrees) expect(oldAttributeNames(c.markup, c.tag)).toEqual(c.expected)
      else expect(oldAttributeNames(c.markup, c.tag)).not.toEqual(c.expected)
    })
  }

  it('a tag whose quote never closes does not hide the tags before it', () => {
    const markup = '<aura:attribute name="realAttr" type="String"/>\n<aura:attribute name="'.repeat(1) + '\n<aura:attribute name="'
    expect(newAttributeNames(markup, 'aura:attribute')).toContain('realAttr')
  })
})

// Time `run` on inputs of size n and 2n, five times interleaved, keeping the minimum of each (load only adds time), and return the ratio. A linear scan is near 2, a quadratic one near 4, a cubic one near 8.
function growth(make: (n: number) => string, run: (text: string) => unknown, n: number): { ratio: number; small: number; large: number } {
  const small = make(n)
  const large = make(2 * n)
  let a = Infinity
  let b = Infinity
  for (let i = 0; i < 5; i++) {
    let t = performance.now()
    run(small)
    a = Math.min(a, performance.now() - t)
    t = performance.now()
    run(large)
    b = Math.min(b, performance.now() - t)
  }
  return { ratio: b / Math.max(a, 0.25), small: a, large: b }
}

const BOUND = 3.5

// Tag starts that never close, and quotes that never pair: the shapes that make an unbounded run re-read the rest of the file from every start.
const HOSTILE: Record<string, (n: number) => string> = {
  'attribute tag starts, name quote open, no >': (n) => '<aura:attribute name="'.repeat(n),
  'attribute tag starts, name quote open, trailing >': (n) => '<aura:attribute name="'.repeat(n) + '>',
  'attribute tags with a closed name, no >': (n) => '<aura:attribute name="x" '.repeat(n),
  'mixed quotes open, no >': (n) => '<aura:attribute name=\'a"'.repeat(n),
  'attribute tag starts, no quote, no >': (n) => '<aura:attribute '.repeat(n),
  'attribute tag starts, trailing >': (n) => '<aura:attribute '.repeat(n) + '>',
  'attribute tags with name= and no closing quote': (n) => '<aura:attribute name=\'a'.repeat(n) + '>',
  'handler tag starts, no >': (n) => '<aura:handler name="x" '.repeat(n),
  'design tag starts, trailing >': (n) => '<design:attribute name="'.repeat(n) + '>',
  'single quotes open': (n) => "<aura:attribute name='".repeat(n) + '>',
  'name tokens only': (n) => '<aura:attribute ' + 'name '.repeat(n) + '>',
  'name= tokens only': (n) => '<aura:attribute ' + 'name='.repeat(n) + '>',
  'controller attributes open': (n) => '<aura:component controller="'.repeat(n),
  'extensions attributes open': (n) => '<aura:component extensions="'.repeat(n) + '>',
}

describe('the Salesforce markup extractors grow linearly on malformed tags', () => {
  for (const [label, make] of Object.entries(HOSTILE)) {
    it(`.cmp: ${label}`, () => {
      const run = (text: string): unknown => extractSalesforceMarkup(text, 'aura/x/x.cmp')
      // A small pair first so an exponential or cubic pattern fails here, in milliseconds, before the large pair is ever run.
      const canary = growth(make, run, 300)
      expect(canary.ratio, `canary n=300 -> 600: ${canary.small.toFixed(2)} ms -> ${canary.large.toFixed(2)} ms`).toBeLessThan(BOUND * 1.5)
      const g = growth(make, run, 3000)
      expect(g.ratio, `n=3000 -> 6000: ${g.small.toFixed(2)} ms -> ${g.large.toFixed(2)} ms`).toBeLessThan(BOUND)
    })
  }

  it('.html template: tag starts that never close', () => {
    const run = (text: string): unknown => extractLwcTemplate(text, 'lwc/x/x.html')
    for (const make of [(n: number) => '<c-child onclick={'.repeat(n), (n: number) => '<template if:true={'.repeat(n) + '>', (n: number) => '<lightning-button label="'.repeat(n)]) {
      const g = growth(make, run, 3000)
      expect(g.ratio, `n=3000 -> 6000: ${g.small.toFixed(2)} ms -> ${g.large.toFixed(2)} ms`).toBeLessThan(BOUND)
    }
  })
})

describe('negative control: the old pattern is flagged by the same measurement', () => {
  it('the cubic shape (quote open, no >) fails the bound on the old pattern', () => {
    const make = HOSTILE['attribute tag starts, name quote open, no >']!
    const g = growth(make, (text) => oldAttributeNames(text, 'aura:attribute'), 300)
    expect(g.ratio, `old pattern n=300 -> 600: ${g.small.toFixed(2)} ms -> ${g.large.toFixed(2)} ms`).toBeGreaterThan(BOUND)
  })
})

const tempDirs = new Set<string>()
afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
})
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.add(dir)
  return dir
}

describe('critical path: a component with the pathological shape still indexes', () => {
  // Provenance: HAND-DERIVED. A real attribute declaration followed by a tag that never closes, repeated; realAttr is the one name present in the file.
  const body = (): string => '<aura:component>\n  <aura:attribute name="realAttr" type="String"/>\n</aura:component>\n' + '<aura:attribute name="'.repeat(1500)

  it('the worker default path drains it and realAttr resolves', async () => {
    const repo = tempDir('tg-markup-linear-repo-')
    const dataDir = tempDir('tg-markup-linear-data-')
    const file = normalizePath(path.join(repo, 'force-app/main/default/aura/pathological/pathological.cmp'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body())
    fs.writeFileSync(path.join(repo, 'sfdx-project.json'), '{"packageDirectories":[{"path":"force-app"}]}')
    const queue = path.join(dataDir, 'queue', 'dirty.txt')
    fs.mkdirSync(path.dirname(queue), { recursive: true })
    fs.writeFileSync(queue, `${file}\n`)
    const started = performance.now()
    expect(drainOnce(dataDir)).toBe(1)
    const elapsed = performance.now() - started
    await pendingEmbeddings()
    const dbPath = path.join(dataDir, 'global.db')
    try {
      expect(querySymbols({ name: 'realAttr' }, dbPath)[0]).toMatchObject({ kind: 'aura_attribute' })
      expect(querySymbols({ name: 'pathological' }, dbPath)[0]).toMatchObject({ kind: 'aura_bundle' })
    } finally {
      closeDb(dbPath)
    }
    expect(elapsed, `drainOnce took ${elapsed.toFixed(0)} ms`).toBeLessThan(5000)
  })

  it('the built CLI indexes it and resolves realAttr', () => {
    const repo = tempDir('tg-markup-linear-cli-')
    const dataBase = tempDir('tg-markup-linear-cli-data-')
    const file = path.join(repo, 'force-app/main/default/aura/pathological/pathological.cmp')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body())
    fs.writeFileSync(path.join(repo, 'sfdx-project.json'), '{"packageDirectories":[{"path":"force-app"}]}')
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })
    const env = tgIsolatedEnv(dataBase)
    const started = performance.now()
    const indexed = runBundle(['index', repo], { cwd: repo, env })
    const elapsed = performance.now() - started
    expect(indexed.status, indexed.stderr).toBe(0)
    const found = runBundle(['symbol', 'realAttr'], { cwd: repo, env })
    expect(found.status, found.stderr).toBe(0)
    expect(found.stdout).toContain('realAttr')
    expect(elapsed, `index took ${elapsed.toFixed(0)} ms`).toBeLessThan(10000)
  })
})
