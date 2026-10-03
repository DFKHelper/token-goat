/** Regression: a Go method's receiver type was never recorded as the symbol's parent. `func (s *Square) Area() float64` indexed with `parent: ''`, so `symbol Area --json` could not say which type owns it, and with `Circle.Area` and `Square.Area` both present, `read "g.go::Square.Area"` could not narrow the two (a Go method sits outside its type's line range, so the containment fallback never matches). Provenance: FORMAT-DERIVED. Receiver shapes (pointer, value, generic, multi-parameter generic, unnamed) are the forms in the Go spec's Method declarations section, https://go.dev/ref/spec#Method_declarations. Expected parents are read off those declarations by hand. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { parseFile } from '../src/parser.js'
import { findSymbolCandidates } from '../src/read_spec.js'
import { globalDbPath } from '../src/constants.js'
import { indexFileSync } from '../src/parser.js'

let TMP: string

beforeEach(() => {
  TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-go-recv-')))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

const SOURCE = [
  'package main',
  '',
  'type Square struct{}',
  'type Circle struct{}',
  'type Box[T any] struct{}',
  'type Pair[K comparable, V any] struct{}',
  '',
  'func (s *Square) Area() float64 { return 4 }',
  'func (c Circle) Area() float64 { return 3 }',
  'func (b *Box[T]) Get() T { var z T; return z }',
  'func (p Pair[K, V]) Key() K { var z K; return z }',
  'func (Square) Unnamed() {}',
  'func free() {}',
  '',
].join('\n')

describe('Go method receiver type as symbol parent', () => {
  it('records the receiver type, stripped of pointer and type parameters', async () => {
    const file = path.join(TMP, 'g4.go')
    fs.writeFileSync(file, SOURCE)
    const result = await parseFile(file)
    const parents = Object.fromEntries(result.symbols.filter((s) => s.kind === 'method' || s.kind === 'function').map((s) => [`${s.name}@${s.lineStart}`, s.parent]))
    expect(parents).toEqual({ 'Area@8': 'Square', 'Area@9': 'Circle', 'Get@10': 'Box', 'Key@11': 'Pair', 'Unnamed@12': 'Square', 'free@13': '' })
  })

  it('lets read resolve Square.Area when Circle also has an Area', () => {
    const file = path.join(TMP, 'g4.go')
    fs.writeFileSync(file, SOURCE)
    indexFileSync(file, globalDbPath())
    const sq = findSymbolCandidates('g4.go', file, 'Square.Area', TMP, globalDbPath())
    expect(sq.candidates.map((c) => c.lineStart)).toEqual([8])
    const ci = findSymbolCandidates('g4.go', file, 'Circle.Area', TMP, globalDbPath())
    expect(ci.candidates.map((c) => c.lineStart)).toEqual([9])
  })
})
