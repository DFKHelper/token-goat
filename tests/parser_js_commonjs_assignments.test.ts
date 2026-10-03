/** Regression: CommonJS exports and prototype assignments produced no symbols, so a classic Node module (`exports.start = function () {}`, `Animal.prototype.speak = function () {}`) outlined as nearly empty and its functions could not be read by name. Provenance: HAND-DERIVED. The sources are written here and every expected name, kind, parent and line is counted by hand from them; the node shapes (expression_statement > assignment_expression with a member_expression left side and a function_expression / arrow_function right side) were dumped from this exact text with node_modules/tree-sitter-javascript, not read off our extractor. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { parseFile } from '../src/parser.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cjs-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

const SOURCE = [
  'exports.start = function () {}', // 1
  'module.exports.run = async function () {}', // 2
  'exports.stop = () => 2', // 3
  'Animal.prototype.speak = function () {}', // 4
  'module.exports = function named() {}', // 5
  'exports.value = 5', // 6
  'module.exports = function () {}', // 7
  'function wrapper() {', // 8
  '  exports.inner = function () {}', // 9
  '}', // 10
  'Dog.prototype.bark = function () {', // 11
  '  return 1', // 12
  '}', // 13
  '',
].join('\n')

const EXPECTED = [
  'function start@1-1 parent=',
  'function run@2-2 parent=',
  'function stop@3-3 parent=',
  'method speak@4-4 parent=Animal',
  'function named@5-5 parent=',
  'function wrapper@8-10 parent=',
  'method bark@11-13 parent=Dog',
]

describe('CommonJS and prototype assignments', () => {
  for (const ext of ['js', 'ts']) {
    it(`indexes exports, module.exports and prototype methods in a .${ext} file`, async () => {
      const file = path.join(TMP, `mod.${ext}`)
      fs.writeFileSync(file, SOURCE)
      const result = await parseFile(file)
      expect(result.symbols.map((s) => `${s.kind} ${s.name}@${s.lineStart}-${s.lineEnd} parent=${s.parent}`)).toEqual(EXPECTED)
    })
  }
})
