// The architectural analysis of `--check`: side-effect labels, inward-only layer order and static dependency cycles. Contract: SKILL.md "Architectural Analysis Contract" of the arch-doc-sync skill; the reference is sync_arch_docs.py `analyze_architecture` and the helpers above it.
import * as path from 'node:path'
import { byteCompare } from './table.mjs'

const LAYER_ORDER = ['Presentation', 'Application', 'Domain Core', 'Infrastructure', 'Data Persistence']
const LAYER_RANKS = new Map(LAYER_ORDER.map((name, rank) => [name, rank]))
const PURE_DOMAIN = '[Pure Domain]'
const BOM = '﻿'

const ORACLE_MUTATING_SQL = /\b(?:INSERT\s+INTO|UPDATE\s+[a-zA-Z0-9_$]+|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\b/i
const ORACLE_SELECT = /\bSELECT\b/i
const ORACLE_CLIENT = /\b(?:cx_Oracle|oracledb)\b/
const UI_VIEW = /\b(?:React|ReactDOM|render|createElement|useState|useEffect|Component)\b|xmlns=|<!DOCTYPE\s+html|<html[\s>]|<div[\s>]/i
const CLI_RUNTIME = /\b(?:argparse|optparse|click|typer|sys\.argv|process\.argv|ArgumentParser)\b/
const FS_IO = /(?:\bopen\s*\(|\bos\.|\bsys\.|\bsubprocess\b|\bPath\s*\(|\bchild_process\b|\bfs\.|\breadFileSync\b|\bwriteFileSync\b)/
const TOP_IMPORT = /(?:^|(?<=[\n\r\u2028\u2029]))(?:import\s+(?:(?:[a-zA-Z0-9_$,\s*{}]*\s+from\s+)?['"]([^'"]+)['"]|['"]([^'"]+)['"])|(?:const|let|var)\s+(?:[a-zA-Z0-9_$,\s*{}]+\s*=\s*)?require\(\s*['"]([^'"]+)['"]\s*\))/g
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

const stripBom = (text) => (text.startsWith(BOM) ? text.slice(1) : text)

/** The labels one module's text earns, in taxonomy order; the caller adds `[Pure Domain]` when there are none. */
function sideEffectLabels(key, text) {
  const labels = []
  if (ORACLE_MUTATING_SQL.test(text)) labels.push('[Oracle Mutating]')
  else if (ORACLE_SELECT.test(text) && (ORACLE_CLIENT.test(text) || key.toLowerCase().includes('oracle') || text.toLowerCase().includes('oracle'))) labels.push('[Oracle Read-Only]')
  if (FS_IO.test(text)) labels.push('[File / System I/O]')
  if (/\.(?:jsx|tsx|html|css)$/.test(key) || UI_VIEW.test(text)) labels.push('[UI / View]')
  if (CLI_RUNTIME.test(text)) labels.push('[CLI / Runtime]')
  return labels.length > 0 ? labels : [PURE_DOMAIN]
}

/** The specifiers of a module's top-level imports and requires; an indented (function-level) import is a deferred runtime edge and is not one. */
function topLevelImports(text) {
  return [...stripBom(text).matchAll(TOP_IMPORT)].map((match) => match[1] || match[2] || match[3]).filter((spec) => spec)
}

/** The module key an import specifier names, or undefined when it names nothing in the table. */
function resolveImport(sourceKey, spec, keys, sortedKeys) {
  if (keys.has(spec)) return spec
  const slashSpec = spec.replaceAll('.', '/')
  if (keys.has(slashSpec)) return slashSpec
  if (spec.startsWith('.')) {
    const sourceDir = sourceKey.includes('/') ? sourceKey.slice(0, sourceKey.lastIndexOf('/')) : '.'
    const resolved = path.posix.normalize(sourceDir === '.' ? spec : `${sourceDir}/${spec}`)
    if (keys.has(resolved)) return resolved
    for (const ext of RESOLVE_EXTENSIONS) if (keys.has(`${resolved}${ext}`)) return `${resolved}${ext}`
    if (keys.has(`${resolved}/index.ts`)) return `${resolved}/index.ts`
  }
  return sortedKeys.find((key) => key === slashSpec || key.endsWith(`/${slashSpec}`))
}

/** Strongly connected components with more than one module, or one module importing itself, each path-sorted, ordered by first path (Tarjan). */
function staticCycles(keys, graph) {
  let counter = 0
  const index = new Map()
  const lowlink = new Map()
  const onStack = new Set()
  const stack = []
  const cycles = []
  const connect = (v) => {
    index.set(v, counter)
    lowlink.set(v, counter)
    counter++
    stack.push(v)
    onStack.add(v)
    for (const w of graph.get(v)) {
      if (!index.has(w)) {
        connect(w)
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)))
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), index.get(w)))
      }
    }
    if (lowlink.get(v) !== index.get(v)) return
    const component = []
    for (let w = stack.pop(); ; w = stack.pop()) {
      onStack.delete(w)
      component.push(w)
      if (w === v) break
    }
    if (component.length > 1 || graph.get(v).includes(v)) cycles.push(component.sort(byteCompare))
  }
  for (const key of keys) if (!index.has(key)) connect(key)
  return cycles.sort((a, b) => byteCompare(a[0], b[0]))
}

/** Edges against the five-layer order (Presentation to Data Persistence): a module may depend on its own layer or a later one. A layer outside that order takes no part. */
function layerViolations(keys, rows, graph) {
  const violations = []
  for (const source of keys) {
    const sourceRank = LAYER_RANKS.get(rows.get(source).layer)
    if (sourceRank === undefined) continue
    for (const target of graph.get(source)) {
      const targetRank = LAYER_RANKS.get(rows.get(target).layer)
      if (targetRank === undefined || sourceRank <= targetRank) continue
      violations.push({ source, source_layer: rows.get(source).layer, target, target_layer: rows.get(target).layer })
    }
  }
  return violations
}

/** Side effects, layer-order violations and static cycles of the documented modules. `rows` maps a module key to `{ layer }` and `texts` maps it to its source; a module with no text has no edges. Returns `{ sideEffects: [{ module, labels }], layerViolations: [{ source, source_layer, target, target_layer }], staticCycles: [[module, ...]] }`, every list sorted bytewise by module path. */
export function analyzeArchitecture(rows, texts) {
  const keys = [...rows.keys()].sort(byteCompare)
  const keySet = new Set(keys)
  const graph = new Map()
  for (const key of keys) {
    const text = texts.get(key)
    const targets = new Set()
    for (const spec of text === undefined ? [] : topLevelImports(text)) {
      const target = resolveImport(key, spec, keySet, keys)
      if (target !== undefined) targets.add(target)
    }
    graph.set(key, [...targets].sort(byteCompare))
  }
  return {
    sideEffects: keys.map((module) => ({ labels: sideEffectLabels(module, texts.get(module) === undefined ? '' : stripBom(texts.get(module))), module })),
    layerViolations: layerViolations(keys, rows, graph),
    staticCycles: staticCycles(keys, graph),
  }
}
