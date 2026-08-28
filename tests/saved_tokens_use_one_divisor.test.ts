/**
 * Every recorded saving converts bytes to tokens the same way.
 *
 * The divisor is an assumption, and this repository writes it out at roughly forty callsites. It
 * drifted: `bash_compress:generic` credited itself through `estimateTokensFromLength`, which divides
 * by three because it is an overflow guard's estimator and guessing high is that estimator's safe
 * direction. Used as a credit the safe direction reverses, so one kind was booked about a third
 * richer than every sibling inside a column that sums them together. On a real database that was
 * 469,422 tokens across 520 events.
 *
 * Provenance: HAND-DERIVED for the arithmetic, plus a source scan for the structural half. Nothing
 * here is read back out of the function it checks.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { estimateTokensFromLength } from '../src/overflow_guard.js'
import { savedTokensFromBytes } from '../src/stats.js'

describe('savedTokensFromBytes', () => {
  it('divides by four, and is strictly the more conservative of the two estimators in this repo', () => {
    // 1200 / 4 = 300 by hand; the guard's floor(1200 / 3) + 1 = 401. The point is not which number is
    // closer to a real tokenizer, since neither is one: it is that a credit must not reach for the
    // estimator built to guess high.
    expect(savedTokensFromBytes(1200)).toBe(300)
    expect(estimateTokensFromLength(1200)).toBe(401)
    for (const bytes of [100, 353, 1200, 5628764]) {
      expect(savedTokensFromBytes(bytes), `at ${bytes} bytes the savings figure must not exceed the overflow guard's`).toBeLessThan(estimateTokensFromLength(bytes))
    }
  })

  it('never returns a negative credit for a rewrite that grew', () => {
    // A negative token saving summed into a total silently cancels out real savings elsewhere, which
    // is worse than reporting zero: the total stays plausible while being wrong in both directions.
    expect(savedTokensFromBytes(-5000)).toBe(0)
    expect(savedTokensFromBytes(0)).toBe(0)
  })

  it('is what every savings callsite uses, so no kind is credited on a different scale', () => {
    // Structural half. The defect was one callsite reaching for the wrong helper, which nothing
    // failed on: both functions take a byte count and return a number, so the types agree and only
    // the scale differs. A scan is the only thing that catches the next one.
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) {
          for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
            if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue
            if (/recordStat\(/.test(line) && /estimateTokens/.test(line)) {
              offenders.push(`${path.relative(process.cwd(), full)}: ${line.trim()}`)
            }
          }
        }
      }
    }
    walk(path.join(process.cwd(), 'src'))
    expect(offenders, 'each of these credits a saving through the overflow guard\'s deliberately high estimator: use savedTokensFromBytes from src/stats.ts instead').toEqual([])
  })

  it('leaves no callsite converting bytes to tokens by hand next to recordStat', () => {
    // The scan above only catches the one wrong helper by name. It would not have caught a hand-written
    // Math.round(bytes / 3), which is the same defect typed out instead of imported, so this scan bans
    // inline byte arithmetic on a recordStat line outright rather than banning one spelling of it.
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) {
          // src/stats.ts owns the conversion, so it is the one file allowed to spell the divisor out.
          if (path.resolve(full) === path.resolve(process.cwd(), 'src', 'stats.ts')) continue
          const lines = fs.readFileSync(full, 'utf8').split('\n')
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue
            if (!/recordStat\(/.test(line)) continue
            if (!/Math\.(round|floor)\(/.test(line)) continue
            offenders.push(`${path.relative(process.cwd(), full)}:${i + 1}: ${line.trim()}`)
          }
        }
      }
    }
    walk(path.join(process.cwd(), 'src'))
    expect(
      offenders,
      'each of these converts bytes to tokens inline on a recordStat line: call savedTokensFromBytes from src/stats.ts instead. The divisor is not cosmetic. One callsite reaching for a divide-by-three estimator instead of the divide-by-four credit overstated a real database by 469,422 tokens across 520 events, and nothing typechecked or linted wrong because both take a byte count and return a number.',
    ).toEqual([])
  })
})
