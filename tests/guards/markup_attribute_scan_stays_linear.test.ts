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
import type { SymbolEntry } from '../../src/parser_types.js'
import { escapeRegExp } from '../../src/util.js'
import { buildLineIndex, offsetToLine } from '../../src/languages/common.js'
import { extractHtml, makeTagScanner } from '../../src/languages/html.js'
import { addFlowElements, directChildText, elementBlocks, extractSalesforceMetadata, propertyElements, rootElement, xmlText } from '../../src/languages/salesforce_metadata.js'
import { extractTagBlocks, extractVue } from '../../src/languages/sfc_idx.js'

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

// ---- Family A: the language-file scanners (salesforce_metadata, sfc_idx, html) ----
// The patterns below are the ones those files used before the hand-written scans, kept verbatim as the reference for the differential fuzz and as the negative control.
function oldDecode(value: string): string {
  return value.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
}

function oldXmlText(content: string, tag: string): string | null {
  const re = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${tag}\\s*>`, 'i')
  const match = re.exec(content)
  if (match?.[1] === undefined) return null
  return oldDecode(match[1].trim())
}

function oldDirectChildText(content: string, tag: string): string | null {
  const candidateRe = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${tag}\\s*>`, 'gi')
  const tagRe = /<(\/?)([A-Za-z_:][\w.:-]*)\b[^>]*?(\/?)>/g
  for (const cand of content.matchAll(candidateRe)) {
    const idx = cand.index ?? 0
    let depth = 0
    tagRe.lastIndex = 0
    let t: RegExpExecArray | null
    while ((t = tagRe.exec(content)) !== null) {
      if (t.index >= idx) break
      if (t[3] === '/') continue
      depth += t[1] === '/' ? -1 : 1
    }
    if (depth === 0) return oldDecode((cand[1] ?? '').trim())
  }
  return null
}

function oldRootElement(content: string): string | null {
  const match = /<(?!\?|!)(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)\b[^>]*>/.exec(content)
  if (match === null) return null
  const root = match[1]
  if (root === undefined) return null
  if (match[0].endsWith('/>')) return root
  const close = new RegExp(`</(?:[A-Za-z_][\\w.-]*:)?${escapeRegExp(root)}\\s*>`, 'i')
  return close.test(content) ? root : null
}

function oldElementBlocks(content: string, tag: string): Array<{ inner: string; offset: number; text: string }> {
  const re = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${tag}\\s*>`, 'gi')
  return [...content.matchAll(re)].map((match) => ({ inner: match[1] ?? '', offset: match.index ?? 0, text: match[0] }))
}

function oldPropertyElements(content: string): Array<{ name: string; offset: number; text: string }> {
  const re = /<(?:[A-Za-z_][\w.-]*:)?property\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?property\s*>)/gi
  const out: Array<{ name: string; offset: number; text: string }> = []
  for (const match of content.matchAll(re)) {
    const named = /\bname\s*=\s*(["'])(.*?)\1/i.exec(match[1] ?? '')
    const name = named?.[2] === undefined ? null : oldDecode(named[2])
    if (name !== null && name !== '') out.push({ name, offset: match.index ?? 0, text: match[0] })
  }
  return out
}

const FLOW_TAGS = ['actionCalls', 'assignments', 'choices', 'collectionProcessors', 'constants', 'decisions', 'dynamicChoiceSets', 'formulas', 'loops', 'recordCreates', 'recordDeletes', 'recordLookups', 'recordUpdates', 'screens', 'subflows', 'textTemplates', 'transforms', 'variables']

// What addFlowElements emitted before the hand-written scan: one entry per element with a direct-child name, deduped the way emit() dedupes (same name, kind and start line, and the kind is a function of the tag).
function oldFlowElements(content: string): Array<{ name: string; body: string; lineStart: number; lineEnd: number }> {
  const re = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?(${FLOW_TAGS.join('|')})(?:\\s[^>]*)?>\\s*([\\s\\S]*?)\\s*</(?:[A-Za-z_][\\w.-]*:)?\\1\\s*>`, 'g')
  const lineIndex = buildLineIndex(content)
  const seen = new Set<string>()
  const out: Array<{ name: string; body: string; lineStart: number; lineEnd: number }> = []
  for (const match of content.matchAll(re)) {
    const name = oldDirectChildText(match[2] ?? '', 'name')
    if (name === null || name === '') continue
    const start = match.index ?? 0
    const lineStart = offsetToLine(lineIndex, start)
    const lineEnd = offsetToLine(lineIndex, Math.max(start, start + match[0].length - 1))
    const key = `${name}\0${match[1] ?? ''}\0${lineStart}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, body: content.slice(start, start + match[0].length).trimEnd(), lineStart, lineEnd })
  }
  return out
}

const OLD_HTML_TAG_SOURCE = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)(?:\s(?:"[^"]*"|'[^']*'|[^'">])*)?>/g.source

type HtmlTagRow = { start: number; end: number; isClose: boolean; name: string; selfClosing: boolean }

function oldHtmlTags(code: string): HtmlTagRow[] {
  const re = new RegExp(OLD_HTML_TAG_SOURCE, 'g')
  const out: HtmlTagRow[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, isClose: m[1] === '/', name: (m[2] ?? '').toLowerCase(), selfClosing: m[0][m[0].length - 2] === '/' })
  }
  return out
}

function newHtmlTags(code: string): HtmlTagRow[] {
  const next = makeTagScanner(code)
  const out: HtmlTagRow[] = []
  let from = 0
  for (let t = next(from); t !== null; t = next(from)) {
    out.push({ start: t.start, end: t.end, isClose: t.isClose, name: t.name, selfClosing: t.selfClosing })
    from = t.end
  }
  return out
}

function oldTagBlocks(content: string, tag: string): Array<{ content: string; matchStart: number; matchEnd: number }> {
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi')
  const blocks: Array<{ content: string; matchStart: number; matchEnd: number }> = []
  for (const m of content.matchAll(re)) {
    const matchStart = m.index ?? 0
    const innerStart = matchStart + 1 + tag.length + (m[1] ?? '').length + 1
    blocks.push({ content: content.slice(innerStart, innerStart + (m[2] ?? '').length), matchStart, matchEnd: matchStart + m[0].length })
  }
  return blocks
}

// A small seeded generator, so a failing case is reproducible from its index alone.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function fuzzStrings(tokens: readonly string[], seed: number, count: number, maxTokens: number): string[] {
  const rand = mulberry32(seed)
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const len = 1 + Math.floor(rand() * maxTokens)
    let s = ''
    for (let j = 0; j < len; j++) s += tokens[Math.floor(rand() * tokens.length)] as string
    out.push(s)
  }
  return out
}

describe('differential: the hand-written scans return what the old patterns returned', () => {
  // Provenance: HAND-DERIVED. The inputs are random sequences of markup fragments from a fixed seed; the expected value is the old pattern's own answer, kept verbatim above, which predates the change.
  it('xmlText, elementBlocks and rootElement', () => {
    const tokens = ['<fullName>', '</fullName>', '<fullName a="1">', '<md:fullName>', '</md:fullName >', '<fullName', '<fullNameX>', 'x', ' ', '\n', '<', '>', '/', '&amp;', '<?xml v="1"?>', '<!-- c -->', '<a', '<b:c', ' x="1"', '/>', '</a>', '</c>', '<labels>', '</labels>']
    for (const s of fuzzStrings(tokens, 1, 3000, 24)) {
      expect(xmlText(s, 'fullName'), JSON.stringify(s)).toEqual(oldXmlText(s, 'fullName'))
      expect(elementBlocks(s, 'fullName'), JSON.stringify(s)).toEqual(oldElementBlocks(s, 'fullName'))
      expect(elementBlocks(s, 'labels'), JSON.stringify(s)).toEqual(oldElementBlocks(s, 'labels'))
      expect(rootElement(s), JSON.stringify(s)).toEqual(oldRootElement(s))
    }
  })

  it('propertyElements, including a self-closing property after one that never closes', () => {
    const tokens = ['<property', '<property name="p"', ' name="q"', " name='r'", '/>', '>', '</property>', '</md:property >', '<md:property', '<propertyX>', '<property-x name="d">', ' ', '\n', '"', '<', '/', 'x']
    for (const s of fuzzStrings(tokens, 2, 4000, 22)) {
      expect(propertyElements(s), JSON.stringify(s)).toEqual(oldPropertyElements(s))
    }
  })

  it('directChildText', () => {
    const tokens = ['<name>', '</name>', '<name a="1">', '<md:name>', '</md:name >', '<b>', '</b>', '<c/>', '<c />', '<d x=">">', '<_e>', '</_e>', '<f.g-h>', '<i-/>', 'x', ' ', '\n', '<', '>', '/', '&lt;']
    for (const s of fuzzStrings(tokens, 3, 4000, 26)) {
      expect(directChildText(s, 'name'), JSON.stringify(s)).toEqual(oldDirectChildText(s, 'name'))
    }
  })

  it('the Flow elements addFlowElements emits', () => {
    const tokens = ['<variables>', '</variables>', '<variables a="1">', '<md:variables>', '</md:variables >', '<variables', '<loops>', '</loops>', '<screens>', '</screens>', '<name>n</name>', '<name>m</name>', '<name>', '</name>', '<fields>', '</fields>', '<a/>', ' ', '\n', '<', '>', '/', 'x']
    for (const s of fuzzStrings(tokens, 4, 3000, 26)) {
      const emitted: SymbolEntry[] = []
      addFlowElements(emitted, new Set<string>(), s, 'f.flow-meta.xml', 'F')
      const got = emitted.map((e) => ({ name: e.name, body: e.body, lineStart: e.lineStart, lineEnd: e.lineEnd }))
      expect(got, JSON.stringify(s)).toEqual(oldFlowElements(s))
    }
  })

  it('extractTagBlocks (the string masker is the identity on input with no quote characters)', () => {
    const tokens = ['<script', '<script lang=ts', '<Script>', '>', '</script>', '</script >', '</SCRIPT>', '<template>', '</template>', '<scripts>', 'x', ' ', '\n', '<', '/']
    for (const s of fuzzStrings(tokens, 5, 4000, 22)) {
      const got = extractTagBlocks(s, buildLineIndex(s), 'script').map((b) => ({ content: b.content, matchStart: b.matchStart, matchEnd: b.matchEnd }))
      expect(got, JSON.stringify(s)).toEqual(oldTagBlocks(s, 'script'))
    }
  })

  it('the html tag grammar: every tag, end and flag, with quotes that pair and quotes that do not', () => {
    const tokens = ['<a', '<b', '<br', '<A-b:c', '</a>', '</b', '>', ' ', 'x', '"', "'", '/', '=', '\n', '<', 'x="y"', "'z'", '<style>', '</style>', '<a x', '<a "', "<a '", '>>']
    for (const s of fuzzStrings(tokens, 6, 6000, 30)) {
      expect(newHtmlTags(s), JSON.stringify(s)).toEqual(oldHtmlTags(s))
    }
  })
})

// Padding between starts, so the quadratic term (each start re-reading the rest) outweighs the linear per-start cost and a quadratic scan lands near 4 rather than 3.
const PAD = ' '.repeat(60)
const FLOW_PATH = 'force-app/main/default/flows/F.flow-meta.xml'
const OBJECT_PATH = 'force-app/main/default/objects/O/O.object-meta.xml'
const LWC_META_PATH = 'force-app/main/default/lwc/x/x.js-meta.xml'

type Shape = { make: (n: number) => string; run: (text: string) => unknown; n?: number }

const FAMILY_A: Record<string, Shape> = {
  'flow: <variables> starts with no close': { make: (n) => '<Flow xmlns="x">' + ('<variables>' + PAD).repeat(n) + '</Flow>', run: (s) => extractSalesforceMetadata(s, FLOW_PATH) },
  // These two call addFlowElements directly: a flow with no closing root tag is rejected by rootElement before it is reached.
  'flow: <variables a starts with no >': { make: (n) => '<Flow xmlns="x">' + '<variables a'.repeat(n), run: (s) => addFlowElements([], new Set<string>(), s, FLOW_PATH, 'F') },
  'flow: <variables a starts and one distant >': { make: (n) => '<Flow xmlns="x">' + ('<variables a' + PAD.repeat(10)).repeat(n) + '>', run: (s) => addFlowElements([], new Set<string>(), s, FLOW_PATH, 'F') },
  'flow: one element holding n nested names': { make: (n) => '<Flow xmlns="x"><variables>' + '<f><name>a</name>'.repeat(n) + '</variables></Flow>', run: (s) => extractSalesforceMetadata(s, FLOW_PATH) },
  'object: <a starts with no >': { make: (n) => '<a'.repeat(n), run: (s) => extractSalesforceMetadata(s, OBJECT_PATH) },
  'object: <fields> starts with no close': { make: (n) => '<CustomObject xmlns="x">' + ('<fields>' + PAD).repeat(n) + '</CustomObject>', run: (s) => extractSalesforceMetadata(s, OBJECT_PATH) },
  'object: <fullName> starts with no close': { make: (n) => '<CustomObject xmlns="x">' + ('<fullName>' + PAD).repeat(n) + '</CustomObject>', run: (s) => extractSalesforceMetadata(s, OBJECT_PATH) },
  'lwc meta: <property> starts with no close, then a self-closing one': {
    make: (n) => '<LightningComponentBundle xmlns="x"><targetConfigs>' + ('<property name="p">' + PAD).repeat(n) + '<property name="z"/></targetConfigs></LightningComponentBundle>',
    run: (s) => extractSalesforceMetadata(s, LWC_META_PATH),
  },
  'vue: <script starts with no close': { make: (n) => '<script lang="ts">'.repeat(n), run: (s) => extractVue(s, 'a.vue') },
  'vue: <script a starts with no >': { make: (n) => '<script a'.repeat(n), run: (s) => extractVue(s, 'a.vue') },
  'html: <a x starts with no >': { make: (n) => '<a x'.repeat(n), run: (s) => extractHtml(s, 'a.html') },
  'html: <a "x starts with an unpaired quote': { make: (n) => '<a "x'.repeat(n), run: (s) => extractHtml(s, 'a.html') },
  "html: <a 'x starts with an unpaired quote": { make: (n) => "<a 'x".repeat(n), run: (s) => extractHtml(s, 'a.html') },
  'html: <a x=" starts then one >': { make: (n) => '<a x="'.repeat(n) + '>', run: (s) => extractHtml(s, 'a.html') },
  'html: <a "x\' mixed quotes': { make: (n) => '<a "x\''.repeat(n), run: (s) => extractHtml(s, 'a.html') },
  'html: <style> starts with no close': { make: (n) => '<style>'.repeat(n), run: (s) => extractHtml(s, 'a.html') },
}

describe('the language-file scanners grow linearly on malformed markup', () => {
  for (const [label, { make, run }] of Object.entries(FAMILY_A)) {
    it(label, () => {
      const canary = growth(make, run, 300)
      expect(canary.ratio, `canary n=300 -> 600: ${canary.small.toFixed(2)} ms -> ${canary.large.toFixed(2)} ms`).toBeLessThan(BOUND * 1.5)
      const g = growth(make, run, 3000)
      expect(g.ratio, `n=3000 -> 6000: ${g.small.toFixed(2)} ms -> ${g.large.toFixed(2)} ms`).toBeLessThan(BOUND)
    })
  }

  // Negative control: each old pattern is flagged by the same measurement on the shape that breaks it, so the bound above is shown able to fail.
  const OLD: Record<string, Shape> = {
    'old rootElement on <a starts': { make: (n) => '<a'.repeat(n), run: oldRootElement },
    'old xmlText on <fullName starts': { make: (n) => ('<fullName>' + PAD).repeat(n), run: (s) => oldXmlText(s, 'fullName') },
    'old propertyElements on <property> starts': { make: (n) => ('<property name="p">' + PAD).repeat(n), run: oldPropertyElements },
    'old directChildText on n nested names': { make: (n) => '<f><name>a</name>'.repeat(n), run: (s) => oldDirectChildText(s, 'name'), n: 1000 },
    'old html tag grammar on <a x starts': { make: (n) => '<a x'.repeat(n), run: oldHtmlTags },
    'old tag-block pattern on <script starts': { make: (n) => '<script a'.repeat(n), run: (s) => oldTagBlocks(s, 'script') },
  }
  for (const [label, { make, run, n = 2000 }] of Object.entries(OLD)) {
    it(`negative control: ${label} fails the bound`, () => {
      const g = growth(make, run, n)
      expect(g.ratio, `old pattern n=${n} -> ${2 * n}: ${g.small.toFixed(2)} ms -> ${g.large.toFixed(2)} ms`).toBeGreaterThan(BOUND)
    })
  }
})
