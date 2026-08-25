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
    const lines = readFileSync(file, 'utf-8').split('\n')
    lines.forEach((text, i) => {
      const at = { file, line: i + 1 }
      for (const m of text.matchAll(/recordStat\(\s*'([^']+)'/g)) sites.push({ kind: m[1], ...at })
      for (const m of text.matchAll(/recordStat\(\s*`([^`$]*)\$\{/g)) sites.push({ kind: m[1], ...at })
      for (const m of text.matchAll(/emitRewrite\([^)]*\bkind: '([^']+)'/g)) sites.push({ kind: m[1], ...at })
    })
  }
  return sites
}

describe('every stat kind recorded by src/ is registered in stats.ts', () => {
  it('finds the call sites at all, so an empty scan cannot pass vacuously', () => {
    const sites = collectKindSites()
    expect(sites.length, 'the scan matched nothing -- the regexes have drifted from the call shape').toBeGreaterThan(20)
    expect(new Set(sites.map((s) => s.file)).size, 'every match came from one file, which is not how recordStat is used').toBeGreaterThan(5)
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
