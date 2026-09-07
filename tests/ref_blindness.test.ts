/**
 * The reference index has two blind spots, and in both of them an empty result set is
 * indistinguishable from a genuine "this symbol has no callers":
 *
 *   Kind. Only value-position usages are recorded (call, `new`, macro invocation, a few bare
 *   identifier shapes), never a type annotation. So `token-goat dead --kind interface` reported
 *   616 of this repo's 717 interfaces as dead; every one of them is used, as a type. The command
 *   was answering a question the index cannot answer. The same blindness reached the four
 *   single-symbol commands one release later: `refs src/types.ts::HookOutput` printed "No
 *   references found" for an interface named in 27 files, in TypeScript, where the language gate
 *   below correctly stays silent.
 *
 *   Language. `REF_LANGUAGES` in src/parser.ts gates ref extraction to nine tree-sitter
 *   languages. For a C#/PHP/Kotlin/Swift/Lua/... file, `refs` returned "No references found",
 *   which reads as "this symbol is unused" and invites deleting live code.
 *
 * Provenance:
 *   CAPTURE for every behavioural test below. Each one spawns the real built bundle
 *   (dist/token-goat.mjs) against a real on-disk project it indexes first, and asserts the literal
 *   bytes that process wrote to stdout/stderr plus its exit code. Nothing is stubbed.
 *   FORMAT-DERIVED for the REF_LANGUAGES mirror guard: the expected set is parsed out of
 *   src/parser.ts itself, the producer that gates extraction, so the two cannot drift apart. It is
 *   cited as a source rather than trusted as evidence of behaviour, which is what the CAPTURE
 *   tests above supply.
 *
 * Every assertion pairs the honest form being PRESENT with the misleading form being ABSENT: a
 * test that only checks for the new message passes even when the old wrong output is still emitted
 * alongside it, which is exactly how this class of defect survives a green suite.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { beforeAll, afterAll, describe, expect, it } from 'vitest'

import { BUNDLE, ROOT } from './helpers/bundle.js'
import { REF_INDEXED_LANGUAGES } from '../src/ref_blindness.js'
import { REF_BLIND_KINDS, TYPE_KINDS } from '../src/graph_commands.js'

let project: string

function tg(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: project, encoding: 'utf8' })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** stdout and stderr as one string, since these commands split honest prose onto stderr and rows onto stdout and an assertion about "what the caller was told" spans both. */
function out(r: { stdout: string; stderr: string }): string {
  return `${r.stdout}\n${r.stderr}`
}

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), 'tg-refblind-'))
  // TypeScript half: one referenced function, one genuinely unreferenced function, and one interface used ONLY as a type annotation -- the exact shape the indexer cannot see.
  writeFileSync(join(project, 'widget.ts'), [
    'export interface UsedShapeZq { readonly n: number }',
    'export function tsComputeZq(): number { return 42 }',
    'export function tsUnusedZq(): number { return 7 }',
    'export function tsCallerZq(s: UsedShapeZq): number { return tsComputeZq() + s.n }',
    '',
  ].join('\n'))
  // Mixed-kind half: one name declared both as an interface (type position only, unsearchable) and as a function (value position, genuinely searchable), neither of them referenced. An empty result is a real answer for the function and no answer at all for the interface, so this is the case that must be answered with a disclosure rather than refused outright.
  writeFileSync(join(project, 'mixed.ts'), [
    'export interface MixedZq { readonly n: number }',
    'export function MixedZq(): number { return 1 }',
    '',
  ].join('\n'))
  // C# half: a class whose method is called from the same file. The call site is real; the index simply never walks it, because csharp is outside REF_LANGUAGES. The interface is blind BOTH ways -- unindexed language AND type-only kind -- which is what fixes the precedence between the two notices.
  writeFileSync(join(project, 'Widget.cs'), [
    'namespace Demo {',
    '  public interface IShapeZq { int SizeZq(); }',
    '  public class WidgetZq {',
    '    public int ComputeZq() { return 42; }',
    '  }',
    '  public class CallerZq {',
    '    public int GoZq() { var w = new WidgetZq(); return w.ComputeZq(); }',
    '  }',
    '}',
    '',
  ].join('\n'))
  const indexed = tg('index', '--walk')
  expect(indexed.status, `indexing the fixture must succeed or every assertion below is vacuous: ${out(indexed)}`).toBe(0)
  // Population guard: if the fixture indexed nothing, every "the misleading output is absent" assertion below would pass for the wrong reason.
  const outline = tg('outline', 'widget.ts')
  expect(outline.stdout, 'the TypeScript fixture must be in the index').toContain('UsedShapeZq')
  const csOutline = tg('outline', 'Widget.cs')
  expect(csOutline.stdout, 'the C# fixture must be in the index, or the language gate is never reached').toContain('ComputeZq')
  expect(csOutline.stdout, 'the C# interface must be in the index, or the precedence test is vacuous').toContain('IShapeZq')
  const mixedOutline = tg('outline', 'mixed.ts')
  expect(mixedOutline.stdout, 'both definitions of the mixed-kind name must be in the index, or the partial-disclosure tests are vacuous').toContain('MixedZq')
})

afterAll(() => {
  if (project !== undefined) rmSync(project, { recursive: true, force: true })
})

describe('dead: a kind whose references are never recorded is refused, not answered', () => {
  it('refuses --kind interface instead of listing every interface as dead', () => {
    const r = tg('dead', '--kind', 'interface')
    const text = out(r)
    expect(r.status, 'an unanswerable question is not a successful answer').toBe(1)
    expect(text).toContain('Cannot assess deadness for kind')
    expect(text).toContain('never type annotations')
    // The misleading forms. `UsedShapeZq` is what the old code printed; "No dead symbols found." is the opposite failure, a false-clean verdict.
    expect(text, 'the pre-fix output listed the interface as dead').not.toContain('UsedShapeZq')
    expect(text, 'refusing must not be spelled as a clean codebase').not.toContain('No dead symbols found')
  })

  it('still answers the kinds it can, and discloses the excluded one rather than dropping it silently', () => {
    const r = tg('dead', '--kind', 'interface,function')
    const text = out(r)
    expect(r.status).toBe(0)
    // Must-not-drop: the answerable half of the request still produces its real answer.
    expect(r.stdout, 'the function half of the request must still be answered').toContain('tsUnusedZq')
    expect(text, 'the exclusion must be disclosed').toContain("Note: 'interface' excluded")
    expect(text, 'a silent exclusion is the same defect wearing the opposite sign').toContain('never type annotations')
    expect(r.stdout, 'the excluded kind must not contribute rows').not.toContain('UsedShapeZq')
  })

  it('names the exclusion in --json too, where a bare items list cannot carry prose', () => {
    const r = tg('dead', '--kind', 'interface,function', '--json')
    const parsed = JSON.parse(r.stdout) as { excludedKinds?: string[]; excludedKindsReason?: string; items: Array<{ name: string }> }
    expect(parsed.excludedKinds).toEqual(['interface'])
    expect(parsed.excludedKindsReason).toContain('never type annotations')
    expect(parsed.items.map((i) => i.name), 'the excluded kind must not appear among the rows').not.toContain('UsedShapeZq')
  })

  it('skips symbols in a language whose call sites are never indexed, and says how many', () => {
    // The second axis of the same defect: even for an assessable KIND, a C# method has no ref rows at all, so listing it as dead would report the indexer's blindness as a property of the code.
    const r = tg('dead', '--kind', 'method')
    const text = out(r)
    expect(r.status).toBe(0)
    expect(text, 'the skipped population must be disclosed').toMatch(/Note: \d+ symbols? skipped/)
    expect(text, 'the reason must name the index, not the code').toContain('token-goat does not index')
    expect(r.stdout, 'a C# method must not be listed as dead').not.toContain('ComputeZq')
    expect(r.stdout, 'nor its uncalled sibling, which is equally unassessable').not.toContain('GoZq')
  })

  it('reports the language skip in --json, where the prose note is not emitted', () => {
    const r = tg('dead', '--kind', 'method', '--json')
    const parsed = JSON.parse(r.stdout) as { unassessableByLanguage?: number; items: Array<{ name: string }> }
    expect(parsed.unassessableByLanguage, 'the two C# methods must be counted, not silently dropped').toBeGreaterThanOrEqual(2)
    expect(parsed.items.map((i) => i.name)).not.toContain('ComputeZq')
  })

  // Control. Without this, the two tests above are satisfied by a `dead` that refuses everything.
  it('leaves an answerable kind untouched: no refusal, no exclusion note, real rows', () => {
    const r = tg('dead', '--kind', 'function')
    const text = out(r)
    expect(r.status).toBe(0)
    expect(r.stdout, 'a genuinely unreferenced function is still reported dead').toContain('tsUnusedZq')
    expect(r.stdout, 'a called function is still not reported dead').not.toContain('tsComputeZq')
    expect(text).not.toContain('Cannot assess deadness')
    expect(text).not.toContain('excluded --')
  })
})

describe('refs and its siblings: a language whose call sites are never indexed says so', () => {
  // Control pair. These two prove the probe can produce a positive AND that the pre-existing honest message for a genuinely unreferenced symbol is not collateral damage of the fix.
  it('CONTROL: a referenced TypeScript symbol still resolves its references', () => {
    const r = tg('refs', 'widget.ts::tsComputeZq')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('tsCallerZq')
  })

  it('CONTROL: a genuinely unreferenced TypeScript symbol keeps the old, correct message', () => {
    const r = tg('refs', 'widget.ts::tsUnusedZq')
    const text = out(r)
    expect(r.status).toBe(1)
    expect(text).toContain("No references found for 'tsUnusedZq'")
    expect(text, 'a ref-indexed language must not be reported as unindexed').not.toContain('call sites are not indexed')
  })

  it('refs names the language instead of returning a flat zero', () => {
    const r = tg('refs', 'Widget.cs::ComputeZq')
    const text = out(r)
    expect(r.status).toBe(1)
    expect(text).toContain('C# call sites are not indexed')
    expect(text).toContain('not evidence the symbol is unreferenced')
    expect(text, 'the misleading message must be replaced, not merely accompanied').not.toContain('No references found')
  })

  it('callers names the language too, since it reads the same empty ref rows', () => {
    const r = tg('callers', 'ComputeZq')
    const text = out(r)
    expect(r.status).toBe(1)
    expect(text).toContain('C# call sites are not indexed')
    expect(text).not.toContain('No references found')
  })

  it('impact names the language too', () => {
    const r = tg('impact', 'ComputeZq')
    const text = out(r)
    expect(r.status).toBe(1)
    expect(text).toContain('C# call sites are not indexed')
    expect(text, 'a BFS over empty rows must not report absence as a finding').not.toContain('No callers found')
  })

  it('call-chain names the language, the one sibling whose empty answer exits 0', () => {
    const r = tg('call-chain', 'ComputeZq')
    const text = out(r)
    expect(text).toContain('C# call sites are not indexed')
    expect(r.stdout, 'the bare "(no callers)" verdict must not be presented for a symbol nobody looked for callers of').not.toContain('(no callers)\n')
    expect(r.stdout).toContain('(no callers recorded)')
  })

  it('CONTROL: call-chain still prints the plain verdict for a ref-indexed language', () => {
    const r = tg('call-chain', 'tsUnusedZq')
    const text = out(r)
    expect(r.stdout).toContain('(no callers)')
    expect(text).not.toContain('call sites are not indexed')
  })

  // The three tests above call callers/impact with a BARE name, the one input shape where `opts.symbol` and the bare symbol name are the same string -- so a notice built from the spec reads correctly there and the defect is invisible. Driven with the `file::symbol` form instead, the suggested command came back as `rg -n -w Widget.cs::ComputeZq`, which matches nothing and sends the caller to a dead end at exactly the moment the tool has admitted it cannot answer. Asserting the negative as well as the positive, since a message that happens to contain the bare name as a substring of the spec would satisfy the positive alone.
  it.each([['callers'], ['impact']])('%s suggests a runnable search when given a file::symbol spec, not the spec itself', (cmd) => {
    const text = out(tg(cmd, 'Widget.cs::ComputeZq'))
    expect(text).toContain('C# call sites are not indexed')
    expect(text, 'the suggested command must be runnable').toContain('rg -n -w ComputeZq')
    expect(text, 'rg takes a pattern, and `Widget.cs::ComputeZq` matches no line in any file').not.toContain('rg -n -w Widget.cs::ComputeZq')
  })

  it('emits no control characters, which a bare \\b inside a template literal would silently produce', () => {
    const text = out(tg('refs', 'Widget.cs::ComputeZq'))
    // Built from char codes rather than written as a regex literal: eslint's no-control-regex bans the literal form, and the point here is to detect exactly those characters in shipped output.
    const control = [...text].some((ch) => { const c = ch.charCodeAt(0); return c < 32 && c !== 9 && c !== 10 && c !== 13 })
    expect(control, `control character in: ${JSON.stringify(text)}`).toBe(false)
  })
})

describe('refs and its siblings: a kind whose usages are never recorded says so too', () => {
  it('refs refuses an interface instead of reporting a confident absence', () => {
    const r = tg('refs', 'widget.ts::UsedShapeZq')
    const text = out(r)
    expect(r.status, 'an unanswerable question is not a successful answer').toBe(1)
    expect(text).toContain("'UsedShapeZq' is an interface")
    expect(text).toContain('never type annotations')
    expect(text, 'the alternative must be runnable as printed').toContain('rg -n -w UsedShapeZq')
    expect(text, 'the misleading message must be replaced, not merely accompanied').not.toContain('No references found')
  })

  it('callers refuses it too, since it reads the same empty ref rows', () => {
    const r = tg('callers', 'widget.ts::UsedShapeZq')
    const text = out(r)
    expect(r.status).toBe(1)
    expect(text).toContain("'UsedShapeZq' is an interface")
    expect(text).not.toContain('No references found')
  })

  it('impact refuses it too: a BFS from a type declaration starts on an empty frontier', () => {
    const r = tg('impact', 'widget.ts::UsedShapeZq')
    const text = out(r)
    expect(r.status).toBe(1)
    expect(text).toContain("'UsedShapeZq' is an interface")
    expect(text, 'a BFS over empty rows must not report absence as a finding').not.toContain('No callers found')
  })

  it('call-chain says so, the one sibling whose empty answer exits 0 and so reads as a verdict', () => {
    const r = tg('call-chain', 'widget.ts::UsedShapeZq')
    const text = out(r)
    expect(text).toContain("'UsedShapeZq' is an interface")
    expect(r.stdout, 'the bare "(no callers)" verdict must not be presented for a symbol nobody could have looked for callers of').not.toContain('(no callers)\n')
    expect(r.stdout).toContain('(no callers recorded)')
  })

  it('call-chain --json carries the disclosure in a field, since the prose goes to stderr', () => {
    const r = tg('call-chain', 'widget.ts::UsedShapeZq', '--json')
    const parsed = JSON.parse(r.stdout) as { chains: string[][]; refBlindKinds?: string[] }
    expect(parsed.refBlindKinds, 'an empty envelope with no field reads as a settled "no callers"').toEqual(['interface'])
    expect(parsed.chains, 'the chain rendering keeps its shape; the field is added, never substituted').toEqual([['UsedShapeZq']])
  })

  it('call-chain --json carries the LANGUAGE disclosure too, not only the kind one', () => {
    // The kind field above was added and its language counterpart was not, so an envelope for a C#-defined root read as a settled `(no callers)` while text mode said on stderr that C# call sites are never indexed. Asserting the field's contents, not merely its presence: a field carrying the wrong language sends the caller to the wrong conclusion just as confidently.
    const r = tg('call-chain', 'Widget.cs::ComputeZq', '--json')
    const parsed = JSON.parse(r.stdout) as { chains: string[][]; refBlindLanguage?: { language: string; definedIn: string } }
    expect(parsed.refBlindLanguage?.language, 'an empty envelope with no field reads as a settled "no callers"').toBe('csharp')
    expect(parsed.refBlindLanguage?.definedIn).toContain('Widget.cs')
    expect(parsed.chains, 'the chain rendering keeps its shape; the field is added, never substituted').toEqual([['ComputeZq']])
  })

  it('CONTROL: a TypeScript root with real callers carries neither blind-spot field', () => {
    // Without this, the test above is satisfied by an envelope that always carries the field.
    const r = tg('call-chain', 'widget.ts::tsComputeZq', '--json')
    const parsed = JSON.parse(r.stdout) as { chains: string[][]; refBlindLanguage?: unknown; refBlindKinds?: unknown }
    expect(parsed.refBlindLanguage).toBeUndefined()
    expect(parsed.refBlindKinds).toBeUndefined()
    expect(parsed.chains.length, 'and the control must actually have callers, or it proves nothing').toBeGreaterThan(0)
  })

  it('answers a mixed-kind name for the half it can, and discloses the half it cannot', () => {
    const r = tg('refs', 'MixedZq')
    const text = out(r)
    expect(r.status).toBe(1)
    // Must-not-drop: the assessable definition was genuinely searched, so its honest empty answer survives rather than being swallowed by a wholesale refusal.
    expect(text, 'the function definition WAS searched, so its real answer must still be given').toContain("No references found for 'MixedZq'")
    expect(text, 'the exclusion must be counted, not dropped').toContain("Note: 1 of 2 definitions of 'MixedZq' ('interface')")
    expect(text).toContain('never type annotations')
    expect(text, 'a partial answer must not be refused wholesale').not.toContain('Cannot determine references')
  })

  it('gives the language message, not the kind message, when a symbol is blind both ways', () => {
    const r = tg('refs', 'Widget.cs::IShapeZq')
    const text = out(r)
    expect(r.status).toBe(1)
    expect(text, 'naming the file and language is the more actionable of the two').toContain('C# call sites are not indexed')
    expect(text, 'only one notice, or the caller is told two different mechanisms for one absence').not.toContain('is an interface')
  })

  // Control. Without this, every test above is satisfied by a `refs` that refuses everything.
  it('CONTROL: a function keeps both its real answers, hits and honest zero alike', () => {
    const hit = tg('refs', 'widget.ts::tsComputeZq')
    expect(hit.status).toBe(0)
    expect(hit.stdout).toContain('tsCallerZq')
    const zero = tg('refs', 'widget.ts::tsUnusedZq')
    const text = out(zero)
    expect(zero.status).toBe(1)
    expect(text).toContain("No references found for 'tsUnusedZq'")
    expect(text, 'a value-position kind must not be reported as unassessable').not.toContain('never type annotations')
    expect(text).not.toContain('Note:')
  })

  it('emits no control characters, which a bare \\b inside a template literal would silently produce', () => {
    const text = out(tg('refs', 'widget.ts::UsedShapeZq')) + out(tg('refs', 'MixedZq'))
    // Built from char codes rather than written as a regex literal: eslint's no-control-regex bans the literal form, and the point here is to detect exactly those characters in shipped output.
    const control = [...text].some((ch) => { const c = ch.charCodeAt(0); return c < 32 && c !== 9 && c !== 10 && c !== 13 })
    expect(control, `control character in: ${JSON.stringify(text)}`).toBe(false)
  })
})

describe('structural guards against the two lists drifting', () => {
  it('REF_INDEXED_LANGUAGES mirrors REF_LANGUAGES in src/parser.ts, which cannot be imported without changing PARSER_FINGERPRINT', () => {
    const src = readFileSync(join(ROOT, 'src', 'parser.ts'), 'utf8')
    const start = src.indexOf('const REF_LANGUAGES')
    expect(start, 'REF_LANGUAGES must still exist in src/parser.ts under that name, or this guard scans nothing').toBeGreaterThan(-1)
    const end = src.indexOf('])', start)
    expect(end).toBeGreaterThan(start)
    const declared = [...src.slice(start, end).matchAll(/'([a-z+#]+)'/g)].map((m) => m[1])
    // Population guard: a rename or reformat that emptied this list would otherwise let the equality below pass forever against two empty sets.
    expect(declared.length, 'the parsed REF_LANGUAGES population must be non-empty').toBeGreaterThanOrEqual(5)
    expect([...declared].sort()).toEqual([...REF_INDEXED_LANGUAGES].sort())
  })

  it('REF_BLIND_KINDS covers every type-declaration kind, so a new one cannot become assessable-looking by omission', () => {
    expect(TYPE_KINDS.length, 'the TYPE_KINDS population must be non-empty').toBeGreaterThan(5)
    // Population guard for the derived list itself: the four single-symbol gates test membership in REF_BLIND_KINDS, and an emptied list would make every one of them silently stop firing while all the "answers correctly" controls still passed.
    expect(REF_BLIND_KINDS.length, 'the REF_BLIND_KINDS population must be non-empty, or every kind gate silently stops firing').toBeGreaterThan(5)
    for (const k of TYPE_KINDS) {
      expect(REF_BLIND_KINDS, `type kind '${k}' must be treated as unassessable by dead`).toContain(k)
    }
    expect(REF_BLIND_KINDS, 'Rust impl blocks are named for the type they implement, so their name only ever occurs in type position').toContain('impl')
    expect(REF_BLIND_KINDS, 'a class is constructed with `new`, a value position the index does record').not.toContain('class')
    expect(REF_BLIND_KINDS, 'functions are the one kind dead is unambiguously able to assess').not.toContain('function')
  })
})
