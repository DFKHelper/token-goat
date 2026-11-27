import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// The native client's busy answer for a shell command must refuse exactly what node's walk-guard prefilter would load the guard for. PREFILTER_CHARS and PREFILTER_NAMES are not exported from src/hooks_bash.ts, so this reads both lists from source text: a change to one side without the other fails here by name.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const nodeSource = fs.readFileSync(path.join(repo, 'src', 'hooks_bash.ts'), 'utf8')
const rustSource = fs.readFileSync(path.join(repo, 'native', 'tg-hook', 'src', 'deadline.rs'), 'utf8')

// Regex alternatives that the native list writes out word by word; each must expand to exactly these words.
const EXPANSIONS: Record<string, string[]> = {
  '[efz]?grep': ['grep', 'egrep', 'fgrep', 'zgrep'],
  'v?dir': ['dir', 'vdir'],
  'ch(?:mod|own|grp)': ['chmod', 'chown', 'chgrp'],
}
// Checked by its form text: the native side implements it as is_sh_family, whose doc comment states this same shape.
const SH_FAMILY = '[a-z]{0,2}a?sh'

function unescape(raw: string): string {
  return raw.replace(/\\(.)/g, '$1')
}

function nodeChars(): string {
  const match = /const PREFILTER_CHARS = \/\[([^\]]*)\]\/\.source/.exec(nodeSource)
  if (match === null) throw new Error('src/hooks_bash.ts no longer declares PREFILTER_CHARS as a character class')
  return unescape(match[1])
}

function nativeChars(): string {
  const match = /pub const PREFILTER_CHARS: &str = "((?:[^"\\]|\\.)*)";/.exec(rustSource)
  if (match === null) throw new Error('native/tg-hook/src/deadline.rs no longer declares PREFILTER_CHARS')
  return unescape(match[1])
}

function nodeNames(): string {
  const block = /const PREFILTER_NAMES = \[([\s\S]*?)\]\.join\('\|'\)/.exec(nodeSource)
  if (block === null) throw new Error('src/hooks_bash.ts no longer declares PREFILTER_NAMES as a joined list')
  return [...block[1].matchAll(/'([^']*)'/g)].map((m) => m[1]).join('|')
}

function nativeNames(): string[] {
  const block = /pub const PREFILTER_NAMES: &\[&str\] = &\[([\s\S]*?)\];/.exec(rustSource)
  if (block === null) throw new Error('native/tg-hook/src/deadline.rs no longer declares PREFILTER_NAMES')
  return [...block[1].matchAll(/"([^"]*)"/g)].map((m) => m[1])
}

// Splits on alternation bars outside a group: the only group in the node list is ch(?:mod|own|grp).
function topLevelAlternatives(text: string): string[] {
  return text.split(/\|(?![^(]*\))/)
}

describe('native walk-guard prefilter mirrors node', () => {
  it('holds the same character class as src/hooks_bash.ts PREFILTER_CHARS', () => {
    expect(nativeChars(), 'native PREFILTER_CHARS in deadline.rs differs from src/hooks_bash.ts PREFILTER_CHARS').toBe(nodeChars())
  })

  it('holds only node walker names, and every literal node name', () => {
    const nodeRe = new RegExp(`^(?:${nodeNames()})$`, 'i')
    const rust = nativeNames()
    for (const word of rust) {
      expect(nodeRe.test(word), `native name "${word}" in deadline.rs is not a walker name in src/hooks_bash.ts PREFILTER_NAMES`).toBe(true)
    }
    const alternatives = topLevelAlternatives(nodeNames())
    const literals = alternatives.filter((alt) => !/[()[\]{}?*+\\]/.test(alt))
    for (const word of literals) {
      expect(rust, `walker name "${word}" from src/hooks_bash.ts PREFILTER_NAMES is missing from deadline.rs PREFILTER_NAMES`).toContain(word)
    }
    for (const [form, words] of Object.entries(EXPANSIONS)) {
      expect(alternatives, `src/hooks_bash.ts PREFILTER_NAMES no longer has the alternative "${form}" that deadline.rs expands`).toContain(form)
      for (const word of words) {
        expect(rust, `expansion "${word}" of "${form}" is missing from deadline.rs PREFILTER_NAMES`).toContain(word)
      }
    }
    expect(alternatives, `src/hooks_bash.ts PREFILTER_NAMES no longer has the alternative "${SH_FAMILY}" that deadline.rs implements as is_sh_family`).toContain(SH_FAMILY)
    expect(rustSource, 'deadline.rs no longer implements the sh-family alternative as is_sh_family').toContain('fn is_sh_family')
  })
})
