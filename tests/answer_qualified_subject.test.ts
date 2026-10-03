/** `answer` must resolve a `file::Class.method` subject the way `read`, `brief` and `callers` do, and when the qualifier still names several definitions it must list each one by a spelling that picks it alone. Before, the router looked the whole `Widget.render` text up as a bare symbol name, found nothing, and refused every qualified subject as "not an indexed symbol or file". Provenance: HAND-DERIVED. The fixtures are small TypeScript files whose class layout, overload count and call sites follow from the source text alone; they are driven through real indexing and the real router. */
import { rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { runAnswer } from '../src/answer_router.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { captureStdout } from './helpers/capture-stdout.js'

function ask(question: string): { out: string; err: string; code: number } {
  let err = ''
  const origErr = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    if (typeof chunk === 'string') err += chunk
    return true
  }) as typeof process.stderr.write
  let code = -1
  const out = captureStdout(() => {
    try {
      code = runAnswer({ question })
    } finally {
      process.stderr.write = origErr
    }
  })
  return { out, err, code }
}

describe('answer resolves a qualified symbol subject', () => {
  it('routes `file::Class.method` to the one definition, and names every overload when the qualifier is ambiguous', () => {
    const w = join(resolve('tests'), '.tg-answer-qual-widget-fixture.ts')
    const o = join(resolve('tests'), '.tg-answer-qual-over-fixture.ts')
    try {
      writeFileSync(w, 'export class ZzQualWidget {\n  zzQualRender(): string {\n    return "w"\n  }\n}\nexport class ZzQualOther {\n  zzQualRender(): string {\n    return "o"\n  }\n}\nexport function zzQualUse(x: ZzQualWidget): string {\n  return x.zzQualRender()\n}\n')
      writeFileSync(o, 'export class ZzQualOuter {\n  zzQualRun(a: string): void\n  zzQualRun(a: number): void\n  zzQualRun(a: unknown): void {\n    void a\n  }\n}\n')
      indexFileSync(normalizePath(w))
      indexFileSync(normalizePath(o))

      const unique = ask('who calls tests/.tg-answer-qual-widget-fixture.ts::ZzQualWidget.zzQualRender')
      expect(unique.err).not.toContain('not an indexed symbol')
      expect(unique.out.split('\n')[0]).toBe('via: token-goat callers tests/.tg-answer-qual-widget-fixture.ts::ZzQualWidget.zzQualRender --limit 20')

      const overloaded = ask('who calls tests/.tg-answer-qual-over-fixture.ts::ZzQualOuter.zzQualRun')
      expect(overloaded.code).toBe(1)
      expect(overloaded.out).toBe('')
      expect(overloaded.err).toContain('has 3 definitions')
      for (const line of [2, 3, 4]) expect(overloaded.err).toContain(`tests/.tg-answer-qual-over-fixture.ts::ZzQualOuter.zzQualRun@${line}`)
      expect(overloaded.err).toContain('try: token-goat callers "tests/.tg-answer-qual-over-fixture.ts::ZzQualOuter.zzQualRun@2"')

      const picked = ask('who calls tests/.tg-answer-qual-over-fixture.ts::ZzQualOuter.zzQualRun@3')
      expect(picked.err).not.toContain('not an indexed symbol')
      expect(picked.err).not.toContain('definitions')
    } finally {
      rmSync(w, { force: true })
      rmSync(o, { force: true })
    }
  })

  it('lists the two classes\' same-named methods by their parent, not by a repeated file', () => {
    const f = join(resolve('tests'), '.tg-answer-qual-two-fixture.ts')
    try {
      writeFileSync(f, 'export class ZzQualA {\n  zzQualGo(): number {\n    return 1\n  }\n}\nexport class ZzQualB {\n  zzQualGo(): number {\n    return 2\n  }\n}\n')
      indexFileSync(normalizePath(f))
      const r = ask('who calls zzQualGo')
      expect(r.code).toBe(1)
      expect(r.err).toContain('tests/.tg-answer-qual-two-fixture.ts::ZzQualA.zzQualGo')
      expect(r.err).toContain('tests/.tg-answer-qual-two-fixture.ts::ZzQualB.zzQualGo')
      expect(r.err).toContain('try: token-goat callers "tests/.tg-answer-qual-two-fixture.ts::ZzQualA.zzQualGo"')
    } finally {
      rmSync(f, { force: true })
    }
  })
})
