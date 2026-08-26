import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isRegisteredKind, kindToSource } from '../../src/stats.js'

// Walks src/ collecting every stat kind that is statically visible at a call site: a literal first argument to recordStat(), the static prefix of a template-literal first argument, and the `kind:` of a RewriteSavings object passed to emitRewrite(). Kinds reaching recordStat through a plain variable are invisible here by construction, which is exactly why emitRewrite's object literal is scanned separately -- it is the one indirection this repo actually uses.
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

interface Site {
  kind: string
  file: string
  line: number
}

function collectKindSites(): Site[] {
  const sites: Site[] = []
  for (const file of walk('src')) {
    const text = readFileSync(file, 'utf-8')
    // Scanned as one string rather than line by line. A call formatted across several lines -- `recordStat(` alone, then the kind on the next line -- is invisible to a per-line scan, and there is one such site in the tree today (hooks_compact.ts's compact_summary). Line numbers come from counting newlines before the match offset instead.
    const lineOf = (index: number): number => text.slice(0, index).split('\n').length
    const push = (kind: string, index: number | undefined): void => void sites.push({ kind, file, line: lineOf(index ?? 0) })
    // Both quote styles: this repo writes single quotes, but a double-quoted literal is still a valid kind, and a guard that only sees one style goes silently blind the day someone uses the other.
    for (const m of text.matchAll(/recordStat\(\s*(['"])([^'"\n]+)\1/g)) push(m[2], m.index)
    for (const m of text.matchAll(/recordStat\(\s*`([^`$\n]*)\$\{/g)) push(m[1], m.index)
    // A bounded lazy window rather than `[^)]*`: the savings object's own `Buffer.byteLength(...)` contains a closing paren, so a negated-paren class stops matching the moment anyone reorders the object's fields. Over-matching into a neighbouring `kind:` would only demand that an already-registered kind stay registered, so the loose direction is the safe one here.
    for (const m of text.matchAll(/emitRewrite\([\s\S]{0,400}?\bkind:\s*(['"])([^'"\n]+)\1/g)) push(m[2], m.index)
  }
  return sites
}

describe('every stat kind recorded by src/ is registered in stats.ts', () => {
  it('finds the call sites at all, so an empty scan cannot pass vacuously', () => {
    const sites = collectKindSites()
    expect(sites.length, 'the scan matched nothing -- the regexes have drifted from the call shape').toBeGreaterThan(20)
    expect(new Set(sites.map((s) => s.file)).size, 'every match came from one file, which is not how recordStat is used').toBeGreaterThan(5)
  })

  it('sees the three call shapes that a naive scan misses', () => {
    const found = collectKindSites()
    const has = (kind: string): boolean => found.some((s) => s.kind === kind)
    // Pinned individually rather than left to the count above. Each of these is a shape an earlier version of this scan could not see, and losing one again would leave the aggregate floor satisfied by the ~50 ordinary single-line sites while a whole call shape went dark.
    expect(has('compact_summary'), 'a recordStat( call split across lines must still be seen').toBe(true)
    expect(has('bash_compress:'), 'a template-literal kind must be seen by its static prefix').toBe(true)
    expect(has('bashoutput:delta'), "a RewriteSavings object's kind must be seen through emitRewrite").toBe(true)
  })

  it('resolves every statically visible kind through KIND_TO_SOURCE, the _overhead rule, or a prefix', () => {
    const unregistered = collectKindSites().filter((s) => !isRegisteredKind(s.kind))
    expect(
      unregistered.map((s) => `${s.kind} (${s.file}:${s.line})`),
      'kindToSource() silently files an unregistered kind under "other" -- add it to KIND_TO_SOURCE or KIND_PREFIX_TO_SOURCE',
    ).toEqual([])
  })

  it('registers the five bashoutput/taskoutput savings kinds under the sources their output belongs to', () => {
    expect(kindToSource('bashoutput:unchanged')).toBe(kindToSource('bash_compress:x'))
    expect(kindToSource('bashoutput:delta')).toBe(kindToSource('bash_compress:x'))
    for (const k of ['taskoutput:collapse', 'taskoutput:unchanged', 'taskoutput:delta']) {
      expect(kindToSource(k), `${k} must share agent_report_compact's source`).toBe(kindToSource('agent_report_compact'))
    }
  })

  it('does not treat an unregistered kind as registered', () => {
    expect(isRegisteredKind('definitely_not_a_registered_kind')).toBe(false)
    expect(kindToSource('definitely_not_a_registered_kind')).toBe('other')
  })
})
