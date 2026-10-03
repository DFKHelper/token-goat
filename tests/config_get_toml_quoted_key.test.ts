/** config-get on a .toml file must read a key path the way TOML reads a dotted key: a quoted segment is one key with its dots kept. Before, the path was split on every `.`, so `site."google.com"` was never found and a quoted `"google.com"` key could not be reached at all once a `[site.google]` table also existed. Provenance: HAND-DERIVED, the expected values follow from the fixture text and the TOML v1.0.0 spec's dotted-key and quoted-key rules (toml.io/en/v1.0.0#keys). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runConfigGet } from '../src/read_inspect.js'

import { captureStdout } from './helpers/capture-stdout.js'

const BOTH = ['[site]', '"google.com" = "quoted"', "'a.b' = \"literal\"", '"tab\\tkey" = "escaped"', '[site.google]', 'com = "nested"', ''].join('\n')
const QUOTED_ONLY = ['[site]', '"google.com" = "quoted"', ''].join('\n')

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cfgtomlq-'))
  fs.writeFileSync(path.join(dir, 'both.toml'), BOTH)
  fs.writeFileSync(path.join(dir, 'quoted.toml'), QUOTED_ONLY)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function get(file: string, key: string): { code: number; stdout: string } {
  let code = -1
  const stdout = captureStdout(() => { code = runConfigGet({ file: path.join(dir, file), key }) })
  return { code, stdout: stdout.trim() }
}

describe('config-get TOML quoted keys', () => {
  it('reads a double-quoted segment as one key even when a nested table matches the unquoted spelling', () => {
    expect(get('both.toml', 'site."google.com"')).toEqual({ code: 0, stdout: 'quoted' })
  })

  it('reads a single-quoted (literal) segment as one key', () => {
    expect(get('both.toml', "site.'a.b'")).toEqual({ code: 0, stdout: 'literal' })
  })

  it('decodes escapes in a double-quoted segment the way TOML does', () => {
    expect(get('both.toml', 'site."tab\\tkey"')).toEqual({ code: 0, stdout: 'escaped' })
  })

  it('still resolves the unquoted spelling to the nested table', () => {
    expect(get('both.toml', 'site.google.com')).toEqual({ code: 0, stdout: 'nested' })
  })

  it('still resolves the unquoted spelling to a quoted key when no table competes', () => {
    expect(get('quoted.toml', 'site.google.com')).toEqual({ code: 0, stdout: 'quoted' })
  })

  it('treats a key that is not valid TOML as a plain dotted path and reports it missing', () => {
    expect(get('both.toml', 'site."google').code).toBe(1)
  })

  it('does not let a key carrying a value or a second TOML line pass as the path it starts with', () => {
    expect(get('both.toml', 'site.google.com = 1 #').code).toBe(1)
    expect(get('both.toml', 'site.google.com = 0\nother').code).toBe(1)
  })

  // HAND-DERIVED: `= 0 #` turns the probe line into `site.google.com = 0 # = 0`, valid TOML whose value is exactly the probe's own, so only a second probe with a different value tells the key text apart from a real key.
  it('does not let a key carrying the probe value itself pass as the path it starts with', () => {
    expect(get('both.toml', 'site.google.com = 0 #').code).toBe(1)
    expect(get('both.toml', 'site.google.com = {x = 0} #').code).toBe(1)
  })

  // HAND-DERIVED: these header lines put the probe under `site.google.com` but also create a sibling `other` table, so the probe document holds two top-level keys and is not one key path.
  it('does not let key text that opens several tables pass as the one path the probe ends on', () => {
    expect(get('both.toml', '[site]\n[other]\n[site.google]\ncom').code).toBe(1)
  })
})

describe('config-get TOML quoted segments are never merged with their neighbours', () => {
  // HAND-DERIVED: `site."google.com".more` names key `more` inside table `"google.com"`; the literal key `"google.com.more"` is a different key, and `site."google.com"` alone is a table, so a merged join reaching the literal key is wrong.
  const MERGE = ['[site]', '"google.com.more" = "merged"', '', '[site."google.com"]', 'other = "x"', ''].join('\n')
  const OUTER = ['"site.google.com" = "outer"', '[site]', 'x = 1', ''].join('\n')

  it('does not read a literal dotted key by joining a quoted segment with the one after it', () => {
    fs.writeFileSync(path.join(dir, 'merge.toml'), MERGE)
    expect(get('merge.toml', 'site."google.com".more').code).toBe(1)
  })

  it('does not read a literal dotted key by joining a bare segment with the quoted one after it', () => {
    fs.writeFileSync(path.join(dir, 'outer.toml'), OUTER)
    expect(get('outer.toml', 'site."google.com"').code).toBe(1)
  })

  it('still reads the literal dotted key through its own quoted spelling and its unquoted spelling', () => {
    fs.writeFileSync(path.join(dir, 'merge.toml'), MERGE)
    expect(get('merge.toml', 'site."google.com.more"')).toEqual({ code: 0, stdout: 'merged' })
    expect(get('merge.toml', 'site.google.com.more')).toEqual({ code: 0, stdout: 'merged' })
  })
})
