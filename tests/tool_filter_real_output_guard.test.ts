import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectFromCommand } from '../src/tool_filters/dispatch.js'
import { resolveMinNetSavingsBytes } from '../src/tool_filters/base.js'

/**
 * Staleness guard for tool filters, backed by real captured output.
 *
 * A filter whose matcher encodes a format its tool no longer emits is
 * invisible today: it classifies every line as pass-through, saves a handful
 * of bytes, falls under `bash_compress.min_net_savings_bytes`, and the
 * shipping path then discards the filter output wholesale and prints the raw
 * report with no note at all. Nothing fails; the filter has simply stopped
 * working. That exact state shipped for `ruff` and for `golangci-lint`.
 *
 * Every fixture below is real output from the named tool version, captured by
 * running that tool, not a sample written from the filter's own regexes. When
 * a tool changes its default report layout, the entry here goes red instead of
 * silently degrading to a pass-through.
 *
 * Decay: the fixtures pin the format as of their capture date. They do not
 * re-capture themselves, so an entry left untouched for years proves the
 * filter still handles *that* version's format, not today's. Re-capture on a
 * tool major bump is the maintenance the corpus needs; the guard's value is
 * that a re-capture immediately shows whether the filter survived it.
 */

interface Capture {
  /** Fixture file under `tests/fixtures/tool_output/`. */
  fixture: string
  /** Command line, dispatched through the real filter selector. */
  command: string
  /** Filter that must be selected. */
  filter: string
  /** How the fixture was obtained. */
  provenance: string
  /** Byte length of the fixture, pinned so a silent re-capture is visible. */
  rawBytes: number
  /** Floor on the fraction of bytes removed, well above the pass-through case. */
  minRatio: number
  /**
   * Whether a healthy filter clears `bash_compress.min_net_savings_bytes` on
   * this capture, so the shipping path actually keeps the compressed body.
   * A small report can compress well and still fall under the absolute floor
   * once it pays for its own marker, so this is recorded per capture with a
   * reason rather than assumed.
   */
  clearsShippingFloor: boolean
  /** Why `clearsShippingFloor` is false, when it is. */
  floorNote?: string
}

const CAPTURES: Capture[] = [
  {
    fixture: 'golangci-lint-2.12.2-run.txt',
    command: 'golangci-lint run ./...',
    filter: 'golangci-lint',
    provenance:
      'golangci-lint 2.12.2 (go1.26.0), run against a throwaway module with errcheck/staticcheck/unused violations, default text output on 2026-08-27',
    rawBytes: 944,
    minRatio: 0.15,
    clearsShippingFloor: false,
    floorNote:
      'the capture is only 944 bytes of nine distinct issues: 172 bytes come off, but the compression marker costs 78, leaving 94 net against a floor of 100. The filter is healthy here; the report is simply too small. Before the issued-lines fix this same capture compressed by 0 bytes.',
  },
  {
    fixture: 'ruff-0.14.14-check.txt',
    command: 'ruff check .',
    filter: 'ruff',
    provenance:
      'ruff 0.14.14, "ruff check ." against two throwaway modules with F401/F841 violations, default full output on 2026-08-27',
    rawBytes: 2625,
    minRatio: 0.5,
    clearsShippingFloor: true,
  },
  {
    fixture: 'pre-commit-4.5.1-run.txt',
    command: 'pre-commit run --all-files',
    filter: 'pre-commit',
    provenance:
      'pre-commit 4.5.1 with pre-commit-hooks v6.0.0, "pre-commit run --all-files" on a throwaway repo, captured 2026-08-27 (CRLF normalised to LF)',
    rawBytes: 1160,
    minRatio: 0.25,
    clearsShippingFloor: true,
  },
]

function fixturePath(name: string): string {
  return join(__dirname, 'fixtures', 'tool_output', name)
}

describe('tool filters against real captured tool output', () => {
  for (const cap of CAPTURES) {
    describe(`${cap.filter} (${cap.provenance})`, () => {
      const raw = readFileSync(fixturePath(cap.fixture), 'utf8')

      it('fixture is the captured bytes, unmodified', () => {
        expect(raw.length).toBe(cap.rawBytes)
        expect(raw).not.toContain('\r')
      })

      it('dispatch selects the filter under test', () => {
        const detected = detectFromCommand(cap.command)
        expect(detected?.filter.name).toBe(cap.filter)
      })

      it('compresses the real report instead of passing it through', () => {
        const detected = detectFromCommand(cap.command)
        if (!detected) throw new Error(`no filter selected for ${cap.command}`)
        const result = detected.filter.apply(raw, '', 1, detected.argv)
        const saved = raw.length - result.text.length
        const ratio = saved / raw.length
        expect(
          ratio,
          `${cap.filter} removed ${saved} of ${raw.length} bytes (ratio ${ratio.toFixed(3)}, floor ${cap.minRatio}) on real ${cap.fixture} output: a ratio near zero means the filter no longer recognises its tool's current report format and is a silent pass-through`,
        ).toBeGreaterThanOrEqual(cap.minRatio)
      })

      it(
        cap.clearsShippingFloor
          ? 'clears the net-savings floor, so the shipping path keeps the compressed body'
          : 'stays under the net-savings floor, as recorded',
        () => {
          const detected = detectFromCommand(cap.command)
          if (!detected) throw new Error(`no filter selected for ${cap.command}`)
          const result = detected.filter.apply(raw, '', 1, detected.argv)
          // `worthApplying` is the same predicate bash_runner uses to decide whether the compressed body ships at all: below it the raw report prints and the filter emits no note whatsoever.
          expect(
            result.worthApplying(resolveMinNetSavingsBytes()),
            cap.clearsShippingFloor
              ? `${cap.filter} no longer clears bash_compress.min_net_savings_bytes on real ${cap.fixture} output, so the shipping path would discard the compressed body and print the raw report with no note`
              : `${cap.filter} now clears the floor on ${cap.fixture}; update clearsShippingFloor and drop the recorded reason: ${cap.floorNote ?? '(none recorded)'}`,
          ).toBe(cap.clearsShippingFloor)
        },
      )
    })
  }
})
