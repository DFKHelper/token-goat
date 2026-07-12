import { afterEach, describe, expect, it } from 'vitest'

import { CompressedOutput, ToolFilter } from '../src/tool_filters/base.js'
import {
  detectFromCommand,
  compressOutput,
  filterByName,
  selectFilter,
  TOOL_FILTERS,
  tryWrapCompoundSegments,
} from '../src/tool_filters/dispatch.js'
import { GenericFilter } from '../src/tool_filters/generic.js'
import {
  byteLength,
  capBytes,
  capLongLines,
  dedupeConsecutive,
  dedupeNumericRuns,
  hasHighEntropyToken,
  normalise,
  preserveStderrOnError,
  safeDecode,
  sanitizeControlChars,
  shlexSplit,
  squeezeBlankLines,
  stripPrefixes,
  stripProgress,
  truncateMiddle,
  truncateMiddleSmart,
} from '../src/tool_filters/helpers.js'

const NUL = String.fromCharCode(0)
const ESC = String.fromCharCode(27)

describe('helpers: encoding + normalisation', () => {
  it('safeDecode strips null bytes', () => {
    expect(safeDecode(`a${NUL}b${NUL}c`)).toBe('abc')
    expect(safeDecode('clean')).toBe('clean')
  })

  it('sanitizeControlChars removes C0/C1 controls but keeps tab/newline', () => {
    const input = `keep\ttab\nnewline${String.fromCharCode(7)}${String.fromCharCode(1)}drop`
    expect(sanitizeControlChars(input)).toBe('keep\ttab\nnewlinedrop')
  })

  it('stripProgress keeps only the segment after the last carriage return', () => {
    expect(stripProgress('10%\r50%\r100%')).toBe('100%')
    expect(stripProgress('a\nb')).toBe('a\nb')
  })

  it('normalise collapses CRLF, strips ANSI, and collapses progress', () => {
    const input = `done\r\n${ESC}[32mgreen${ESC}[0m\r\nstep1\rstep2`
    const out = normalise(input)
    expect(out).toBe('done\ngreen\nstep2')
    expect(out).not.toContain(ESC)
  })

  it('normalise can skip progress collapsing', () => {
    expect(normalise('a\rb', { skipProgress: true })).toBe('a\rb')
  })
})

describe('helpers: entropy + dedupe', () => {
  it('hasHighEntropyToken flags UUIDs, long hex, and JWTs', () => {
    expect(hasHighEntropyToken('id 550e8400-e29b-41d4-a716-446655440000 ok')).toBe(true)
    expect(hasHighEntropyToken('sha 0123456789abcdef0123456789abcdef0123')).toBe(true)
    expect(hasHighEntropyToken('eyJhbGciOi.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f')).toBe(true)
    expect(hasHighEntropyToken('a normal log line')).toBe(false)
  })

  it('dedupeConsecutive collapses runs >= minRun and leaves short runs intact', () => {
    expect(dedupeConsecutive(['x', 'x', 'x', 'y'])).toEqual(['x  (×3)', 'y'])
    expect(dedupeConsecutive(['x', 'y'])).toEqual(['x', 'y'])
  })

  it('dedupeConsecutive entropyBypass emits high-entropy lines verbatim', () => {
    const uuid = 'req 550e8400-e29b-41d4-a716-446655440000'
    const out = dedupeConsecutive([uuid, uuid, uuid], { entropyBypass: true })
    expect(out).toEqual([uuid, uuid, uuid])
  })

  it('dedupeNumericRuns collapses lines differing only in digits', () => {
    const out = dedupeNumericRuns(['line 1', 'line 2', 'line 3'], { minRun: 2 })
    expect(out[0]).toBe('line 1')
    expect(out[1]).toContain('similar lines collapsed')
  })
})

describe('helpers: capping', () => {
  it('truncateMiddle keeps head + marker + tail', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `L${i}`)
    const out = truncateMiddle(lines, 10)
    expect(out.length).toBe(11) // 10 + marker
    expect(out[0]).toBe('L0')
    expect(out[out.length - 1]).toBe('L99')
    expect(out.some((l) => l.includes('elided by token-goat'))).toBe(true)
  })

  it('truncateMiddleSmart preserves an error-signal line from the middle', () => {
    const lines = Array.from({ length: 200 }, (_, i) => (i === 120 ? 'fatal: boom' : `progress ${i}`))
    const out = truncateMiddleSmart(lines, 40)
    expect(out.join('\n')).toContain('fatal: boom')
  })

  it('capBytes truncates oversized text at a line boundary with a marker', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n')
    const out = capBytes(text, 60)
    expect(byteLength(out)).toBeLessThanOrEqual(60)
    expect(out).toContain('bytes elided by token-goat')
  })

  it('capBytes leaves text within budget unchanged', () => {
    expect(capBytes('short', 1000)).toBe('short')
  })

  it('capBytes never splits a multi-byte UTF-8 character when no newline is nearby', () => {
    // '中' is 3 bytes in UTF-8 (E4 B8 AD). No newlines, so the line-boundary
    // rescue never triggers and the raw byte cut must fall back to a
    // character-boundary-safe cut instead.
    const filler = 'a'.repeat(50)
    const text = filler + '中'.repeat(50)
    const markerLen = Buffer.byteLength('\n... [999 bytes elided by token-goat]', 'utf8')
    // Land the cut 1 byte into the first CJK character.
    const maxBytes = filler.length + 1 + markerLen
    const out = capBytes(text, maxBytes)
    expect(out).not.toContain('�')
    expect(byteLength(out)).toBeLessThanOrEqual(maxBytes)
  })

  it('capLongLines truncates an oversized line with an inline marker', () => {
    const [out] = capLongLines(['x'.repeat(500)], 400)
    expect(out).toContain('[100 chars elided]')
    expect(out.startsWith('x'.repeat(400))).toBe(true)
  })

  it('capLongLines leaves lines within budget unchanged', () => {
    expect(capLongLines(['short'], 100)).toEqual(['short'])
  })

  it('capLongLines never splits a surrogate pair at the cut boundary', () => {
    // U+1F600 (😀) is a high/low surrogate pair. A naive `slice(0, 5)` lands
    // exactly between the pair, leaving a lone high surrogate that decodes
    // as U+FFFD once the string is round-tripped through UTF-8 bytes (as
    // happens whenever this output is written to stdout or serialized).
    const line = 'ab😀😀😀'
    const [out] = capLongLines([line], 5)
    const cutPart = out.slice(0, out.indexOf('  … ['))
    expect(cutPart).toBe('ab😀')
    expect(Buffer.from(cutPart, 'utf8').toString('utf8')).not.toContain('�')
    expect(out).toContain('[4 chars elided]')
  })

  it('squeezeBlankLines collapses 3+ blank lines to one', () => {
    expect(squeezeBlankLines('a\n\n\n\nb')).toBe('a\n\nb')
  })

  it('preserveStderrOnError returns combined output only on non-zero exit with stderr', () => {
    expect(preserveStderrOnError('out', 'err', 1)).toBe('out\n---\nerr')
    expect(preserveStderrOnError('out', 'err', 0)).toBeNull()
    expect(preserveStderrOnError('out', '', 1)).toBeNull()
  })
})

describe('helpers: command parsing', () => {
  it('shlexSplit honours quotes and escapes', () => {
    expect(shlexSplit('git commit -m "hello world"')).toEqual(['git', 'commit', '-m', 'hello world'])
    expect(shlexSplit("echo 'a b' c")).toEqual(['echo', 'a b', 'c'])
  })

  it('shlexSplit throws on an unterminated quote', () => {
    expect(() => shlexSplit('echo "unterminated')).toThrow()
  })

  it('stripPrefixes resolves pass-through wrappers and multi-token launchers', () => {
    expect(stripPrefixes(['sudo', 'time', 'pytest', '-q'])).toEqual(['pytest', '-q'])
    expect(stripPrefixes(['python', '-m', 'pytest'])).toEqual(['pytest'])
    expect(stripPrefixes(['uv', 'run', 'ruff', 'check'])).toEqual(['ruff', 'check'])
    expect(stripPrefixes(['npx', 'jest'])).toEqual(['jest'])
    expect(stripPrefixes(['FOO=bar', 'eslint', '.'])).toEqual(['eslint', '.'])
  })

  it('stripPrefixes strips a leading env assignment whose value is a path', () => {
    expect(stripPrefixes(['PATH=/usr/local/bin', 'git', 'log'])).toEqual(['git', 'log'])
  })

  it('stripPrefixes strips env assignments that follow a passthrough wrapper', () => {
    expect(stripPrefixes(['env', 'FOO=bar', 'git', 'log'])).toEqual(['git', 'log'])
  })

  it('stripPrefixes treats -i as a valueless flag for sudo/env (no value to consume)', () => {
    expect(stripPrefixes(['sudo', '-i', 'docker', 'ps'])).toEqual(['docker', 'ps'])
    expect(stripPrefixes(['env', '-i', 'cargo', 'build'])).toEqual(['cargo', 'build'])
  })
})

describe('CompressedOutput', () => {
  it('computes savings, tokens, and percentage', () => {
    const co = new CompressedOutput('out', 100, 25, 'demo')
    expect(co.bytesSaved).toBe(75)
    expect(co.tokensSaved).toBe(Math.floor(75 / 3) + 1)
    expect(co.percentSaved).toBeCloseTo(75)
  })

  it('clamps savings at zero when output grew', () => {
    const co = new CompressedOutput('xxxx', 2, 4, 'demo')
    expect(co.bytesSaved).toBe(0)
    expect(co.tokensSaved).toBe(0)
    expect(co.withMarker()).toBe('xxxx') // no marker on a no-op
  })

  it('appends a marker that names the filter and the opt-out env var', () => {
    const co = new CompressedOutput('body', 1000, 100, 'generic')
    const marked = co.withMarker()
    expect(marked).toContain('generic filter -')
    expect(marked).toContain('disable via TOKEN_GOAT_BASH_COMPRESS')
  })
})

describe('GenericFilter (golden)', () => {
  it('strips ANSI/progress and dedupes consecutive lines', () => {
    const norm = normalise(`${ESC}[32mok${ESC}[0m\ndup\ndup\ndup\ndup`)
    const body = new GenericFilter().compress(norm, '', 0, [])
    expect(body).toContain('ok')
    expect(body).toContain('×4')
    expect(body).not.toContain(ESC)
  })

  it('apply() produces a smaller output with a marker for noisy input', () => {
    const raw = [`${ESC}[1mBuild${ESC}[0m`, ...Array.from({ length: 30 }, () => 'compiling...')].join('\n')
    const result = new GenericFilter().apply(raw, '', 0, [])
    expect(result.compressedBytes).toBeLessThan(result.originalBytes)
    expect(result.withMarker()).toContain('disable via TOKEN_GOAT_BASH_COMPRESS')
    expect(result.text).toContain('×')
  })

  it('apply() returns empty output for empty input', () => {
    const result = new GenericFilter().apply('', '', 0, [])
    expect(result.text).toBe('')
    expect(result.originalBytes).toBe(0)
  })
})

describe("apply(): normalisation early-exit ratio uses pre-normalisation size, not pre-truncation size", () => {
  const ENV_KEY = 'TOKEN_GOAT_FILTER_MAX_BYTES'
  const previous = process.env[ENV_KEY]

  afterEach(() => {
    if (previous === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = previous
  })

  it('does NOT early-exit on normalisation when truncation alone produced the size drop', () => {
    // maxInput is tiny relative to the raw payload, so truncation alone already
    // shrinks the stream to well under 60% of its original size. The surviving
    // text has no \r progress markers, ANSI codes, or control chars, so
    // normalise() does nothing to it beyond the truncation that already happened.
    process.env[ENV_KEY] = '200'
    const lines: string[] = []
    for (let i = 0; i < 2000; i++) lines.push(`plain distinct line number ${i} with no normalisable content`)
    const raw = lines.join('\n')
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(2000)

    const result = new GenericFilter().apply(raw, '', 0, [])
    expect(result.notes.join(' ')).not.toContain('early-exit: normalisation alone sufficient')
  })

  it('DOES early-exit on normalisation when it achieves >=40% reduction beyond truncation', () => {
    // Same tiny maxInput, but the surviving (truncated) text is dense with \r
    // progress-bar updates, so stripProgress() collapses it to just the final
    // segment -- a large reduction that truncation alone did not produce.
    process.env[ENV_KEY] = '200'
    const progress = Array.from({ length: 4000 }, (_, i) => `${i}%`).join('\r')
    const result = new GenericFilter().apply(progress, '', 0, [])
    expect(result.notes.join(' ')).toContain('early-exit: normalisation alone sufficient')
  })
})

describe('error-passthrough filters', () => {
  class PassthroughFilter extends ToolFilter {
    readonly name = 'passthrough'
    override readonly errorPassthrough = true
  }

  it('returns raw combined output on non-zero exit with stderr', () => {
    const f = new PassthroughFilter()
    const body = f.compress('partial', 'boom: failed', 1, [])
    expect(body).toBe('partial\n---\nboom: failed')
  })

  it('compresses normally on a clean exit', () => {
    const f = new PassthroughFilter()
    const body = f.compress('clean output', '', 0, [])
    expect(body).toBe('clean output')
  })
})

describe('dispatch: detection + compound handling', () => {
  class EchoFilter extends ToolFilter {
    readonly name = 'echo-test'
    override readonly binaries = new Set(['mytool'])
  }

  afterEach(() => {
    // Drop any test filters registered during a case.
    while (TOOL_FILTERS.length) TOOL_FILTERS.pop()
  })

  it('selectFilter returns a registered match after prefix stripping', () => {
    TOOL_FILTERS.push(new EchoFilter())
    expect(selectFilter(['sudo', 'mytool', '-x'])?.name).toBe('echo-test')
    expect(selectFilter(['othertool'])).toBeNull()
  })

  it('detectFromCommand rejects compound and redirected commands', () => {
    TOOL_FILTERS.push(new EchoFilter())
    expect(detectFromCommand('mytool a && mytool b')).toBeNull()
    expect(detectFromCommand('mytool a | grep x')).toBeNull()
    expect(detectFromCommand('mytool a ; mytool b')).toBeNull()
    expect(detectFromCommand('mytool a > out.txt')).toBeNull()
    expect(detectFromCommand('mytool $(date)')).toBeNull()
  })

  it('detectFromCommand resolves a simple recognised command', () => {
    TOOL_FILTERS.push(new EchoFilter())
    const det = detectFromCommand('python -m mytool run')
    expect(det?.filter.name).toBe('echo-test')
    expect(det?.argv).toEqual(['mytool', 'run'])
  })

  it('tryWrapCompoundSegments wraps each recognised && segment', () => {
    TOOL_FILTERS.push(new EchoFilter())
    const out = tryWrapCompoundSegments('mytool a && echo done', (name, seg) => `wrap[${name}](${seg})`)
    expect(out).toBe('wrap[echo-test](mytool a) && echo done')
  })

  it('tryWrapCompoundSegments returns null when no segment matches', () => {
    expect(tryWrapCompoundSegments('echo a && echo b', () => 'x')).toBeNull()
  })

  // Regression: the previous implementation split on a naive `/\s*&&\s*/` regex with no
  // quote-awareness, so a `&&` embedded inside a quoted argument (e.g. a commit message) was
  // treated as a segment boundary and corrupted on rejoin -- "a&&b" became "a && b".
  it('tryWrapCompoundSegments does not split or corrupt a && embedded inside a quoted segment argument', () => {
    TOOL_FILTERS.push(new EchoFilter())
    const out = tryWrapCompoundSegments('mytool -m "a&&b" && echo done', (name, seg) => `wrap[${name}](${seg})`)
    expect(out).toBe('wrap[echo-test](mytool -m "a&&b") && echo done')
  })
})

describe('dispatch: filterByName + profiles', () => {
  it('filterByName resolves the generic fallback and rejects unknowns', () => {
    expect(filterByName('generic')).toBeInstanceOf(GenericFilter)
    expect(filterByName('does-not-exist')).toBeNull()
  })

  it('compressOutput honours the aggressive profile line cap', () => {
    const raw = Array.from({ length: 400 }, (_, i) => `unique-line-${i}`).join('\n')
    const result = compressOutput(new GenericFilter(), raw, '', 0, [], { compressionProfile: 'aggressive' })
    expect(result.text.split('\n').length).toBeLessThanOrEqual(51) // 50 + marker line
  })
})
