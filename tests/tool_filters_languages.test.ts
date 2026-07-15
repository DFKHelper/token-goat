/**
 * Tests for the language-runtime compression filter family (Batch K1).
 *
 * Covers: NodeFilter, PythonFilter, RubyFilter, BunFilter, DenoFilter,
 * FlutterFilter, DartFilter, SwiftFilter, swiftLintFilter, XcodeFilter,
 * MixFilter, ZigFilter, RCmdFilter, erlangFilter, crystalFilter,
 * haskellFilter, elmFilter, juliaFilter, powerShellFilter.
 *
 * Test strategy:
 *   - Each filter gets a dispatch test (matches() / selectFilter()) to prove
 *     registration in TOOL_FILTERS survived esbuild-free import.
 *   - Each filter gets at least one compress() golden test verifying the
 *     compression logic collapses noise and preserves signal.
 */
import { describe, expect, it } from 'vitest'

import {
  NodeFilter, nodeFilter,
  PythonFilter, pythonFilter,
  RubyFilter, rubyFilter,
  BunFilter, bunFilter,
  DenoFilter, denoFilter,
  FlutterFilter, flutterFilter,
  DartFilter, dartFilter,
  SwiftFilter, swiftFilter,
  XcodeFilter, xcodeFilter,
  MixFilter, mixFilter,
  ZigFilter, zigFilter,
  RCmdFilter, rCmdFilter,
  erlangFilter,
  crystalFilter,
  haskellFilter,
  elmFilter,
  juliaFilter,
  powerShellFilter,
  LANGUAGE_FILTERS,
} from '../src/tool_filters/languages.js'
import { selectFilter } from '../src/tool_filters/dispatch.js'

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function compress(
  filter: { compress: (a: string, b: string, c: number, d: string[]) => string },
  stdout: string,
  argv: string[],
  { stderr = '', exitCode = 0 } = {},
): string {
  return filter.compress(stdout, stderr, exitCode, argv)
}

// ===========================================================================
// NodeFilter
// ===========================================================================

describe('NodeFilter dispatch', () => {
  const f = new NodeFilter()

  it('matches node -e eval', () => expect(f.matches(['node', '-e', 'console.log(1)'])).toBe(true))
  it('matches node --eval', () => expect(f.matches(['node', '--eval', 'x'])).toBe(true))
  it('matches node -p print', () => expect(f.matches(['node', '-p', '1+1'])).toBe(true))
  it('does NOT match node script.js (falls through to Generic)', () =>
    expect(f.matches(['node', 'script.js'])).toBe(false))
  it('does NOT match node with no args', () => expect(f.matches(['node'])).toBe(false))
  it('is reachable via selectFilter', () =>
    expect(selectFilter(['node', '-e', 'console.log(1)']))?.toBe(nodeFilter))
})

describe('NodeFilter compress', () => {
  it('success: caps to 500 tokens', () => {
    const long = 'line\n'.repeat(600)
    const out = compress(nodeFilter, long, ['node', '-e', 'x'])
    expect(out.split('\n').length).toBeLessThan(550)
  })

  it('failure: collapses node: internal frames', () => {
    const stdout = [
      'TypeError: Cannot read property',
      '    at Object.<anonymous> (script.js:1:1)',
      '    at Module._compile (node:internal/modules/cjs/loader:1241:30)',
      '    at Module._extensions..js (node:internal/modules/cjs/loader:1295:10)',
      '    at Module.load (node:internal/modules/cjs/loader:1091:32)',
    ].join('\n')
    const out = compress(nodeFilter, stdout, ['node', '-e', 'x'], { exitCode: 1 })
    expect(out).toContain('TypeError')
    expect(out).toContain('script.js')
    expect(out).toContain('collapsed 3 node: internal frame(s)')
    expect(out).not.toContain('node:internal/modules/cjs/loader')
  })
})

// ===========================================================================
// PythonFilter
// ===========================================================================

describe('PythonFilter dispatch', () => {
  const f = new PythonFilter()

  it('matches python', () => expect(f.matches(['python', 'foo.py'])).toBe(true))
  it('matches python3', () => expect(f.matches(['python3', 'foo.py'])).toBe(true))
  it('does NOT shadow python -m pytest', () =>
    expect(f.matches(['python', '-m', 'pytest'])).toBe(false))
  it('is reachable via selectFilter', () =>
    expect(selectFilter(['python3', 'script.py']))?.toBe(pythonFilter))
})

describe('PythonFilter compress: traceback compaction', () => {
  const frames = Array.from({ length: 12 }, (_, i) => [
    `    File "module${i}.py", line ${i + 1}, in fn${i}`,
    `      return fn${i + 1}()`,
  ]).flat()

  it('collapses long tracebacks to head+tail', () => {
    const stdout = ['Traceback (most recent call last):', ...frames, 'ValueError: bad input'].join('\n')
    const out = compress(pythonFilter, stdout, ['python', 'main.py'])
    expect(out).toContain('Traceback (most recent call last):')
    expect(out).toContain('ValueError: bad input')
    expect(out).toContain('elided by token-goat')
  })

  it('leaves short tracebacks intact', () => {
    const shortFrames = [
      '    File "a.py", line 1, in fn',
      '      pass',
    ]
    const stdout = ['Traceback (most recent call last):', ...shortFrames, 'KeyError: "x"'].join('\n')
    const out = compress(pythonFilter, stdout, ['python', 'main.py'])
    expect(out).not.toContain('elided')
    expect(out).toContain('KeyError')
  })
})

describe('PythonFilter compress: traceback frame integrity (regression)', () => {
  it('never tears a frame apart across the truncation boundary and reports the elided FRAME count, not a raw line count', () => {
    // 11 real frames: 9 plain 2-line frames, then a frame with a PEP 657
    // caret-annotation block (3 lines), then a final plain 2-line frame. The
    // caret frame sits right where a raw-LINE cut would land mid-frame, so
    // truncation (keep-all <=10 frames, else keep first 2 + last 3 frames)
    // must operate on whole frames for it to survive intact.
    const plainFrames = Array.from({ length: 9 }, (_, i) => [
      `    File "module${i}.py", line ${i + 1}, in fn${i}`,
      `      return fn${i + 1}()`,
    ])
    const caretFrame = [
      '    File "app.py", line 42, in divide',
      '      return numerator / denominator',
      '             ~~~~~~~~~^~~~~~~~~~~~~~~',
    ]
    const lastFrame = [
      '    File "main.py", line 100, in main',
      '      divide(10, 0)',
    ]
    const stdout = [
      'Traceback (most recent call last):',
      ...plainFrames.flat(),
      ...caretFrame,
      ...lastFrame,
      'ZeroDivisionError: division by zero',
    ].join('\n')

    const out = compress(pythonFilter, stdout, ['python', 'main.py'])

    const expected = [
      'Traceback (most recent call last):',
      '    File "module0.py", line 1, in fn0',
      '      return fn1()',
      '    File "module1.py", line 2, in fn1',
      '      return fn2()',
      '    ... [6 more frames elided by token-goat]',
      '    File "module8.py", line 9, in fn8',
      '      return fn9()',
      '    File "app.py", line 42, in divide',
      '      return numerator / denominator',
      '             ~~~~~~~~~^~~~~~~~~~~~~~~',
      '    File "main.py", line 100, in main',
      '      divide(10, 0)',
      'ZeroDivisionError: division by zero',
    ].join('\n')

    expect(out).toBe(expected)

    // 11 total frames - 5 kept (first 2 + last 3) = 6 elided FRAMES. The old
    // line-counting bug reported the raw remaining LINE count instead: 23
    // raw lines - 5 kept lines = 18, a materially different (wrong) number.
    expect(out).toContain('6 more frames elided by token-goat')
    expect(out).not.toContain('18 more frames elided by token-goat')

    // The caret-annotation line must never appear detached from its own
    // frame's header/source line — the frame travels together as a unit,
    // never split at the truncation boundary.
    const outLines = out.split('\n')
    const caretIdx = outLines.indexOf('             ~~~~~~~~~^~~~~~~~~~~~~~~')
    expect(caretIdx).toBeGreaterThan(1)
    expect(outLines[caretIdx - 1]).toBe('      return numerator / denominator')
    expect(outLines[caretIdx - 2]).toBe('    File "app.py", line 42, in divide')
  })
})

describe('PythonFilter compress: repeated-line dedup', () => {
  it('deduplicates 5+ identical lines', () => {
    const line = 'some output line'
    const stdout = Array(8).fill(line).join('\n')
    const out = compress(pythonFilter, stdout, ['python', 'x.py'])
    expect(out).toContain('repeated 7 more time(s)')
    expect(out.split(line).length - 1).toBe(1)
  })
})

describe('PythonFilter compress: warning dedup', () => {
  it('suppresses warnings beyond the first 3 with the same category key', () => {
    // 6 warnings with different line numbers but the same key prefix. _dedupeRepeatedLines does NOT collapse them (lines differ); _compressWarnings sees all 6.
    const suffix = ': UserWarning: deprecated API call'
    const lines = [1, 2, 3, 4, 5, 6].map((n) => `/some/file.py:${n}${suffix}`)
    const out = compress(pythonFilter, lines.join('\n'), ['python', 'x.py'])
    expect(out).toContain('3 repeated warning(s) suppressed')
  })

  it('keeps a distinct warning that shares a long leading substring with another', () => {
    // A and B are DIFFERENT DeprecationWarnings that agree for >60 chars after the class name. A fills the 3-keep quota; a truncated key would collide with B and drop it (mislabelled as a repeat). The full-message key keeps both.
    const A = 'a.py:1: DeprecationWarning: numpy.core.umath_tests is an internal NumPy module alpha'
    const B = 'b.py:9: DeprecationWarning: numpy.core.umath_tests is an internal NumPy module BETA-DIFFERENT'
    const out = compress(pythonFilter, [A, A, A, B].join('\n'), ['python', 'x.py'])
    expect(out).toContain('alpha')
    expect(out).toContain('BETA-DIFFERENT')
  })
})

// ===========================================================================
// RubyFilter
// ===========================================================================

describe('RubyFilter dispatch', () => {
  const f = new RubyFilter()
  it('matches rspec', () => expect(f.matches(['rspec', 'spec/'])).toBe(true))
  it('matches rake', () => expect(f.matches(['rake', 'test'])).toBe(true))
  it('is reachable via selectFilter', () =>
    expect(selectFilter(['rspec', 'spec/']))?.toBe(rubyFilter))
})

describe('RubyFilter compress', () => {
  it('collapses dot-progress lines', () => {
    const stdout = [
      '.............',
      'F',
      '1 example, 1 failure',
    ].join('\n')
    const out = compress(rubyFilter, stdout, ['rspec', 'spec/'])
    expect(out).toContain('collapsed')
    expect(out).toContain('1 example, 1 failure')
  })

  it('rake: squeeze blank lines only', () => {
    const stdout = 'line1\n\n\n\nline2\n'
    const out = compress(rubyFilter, stdout, ['rake', 'test'])
    expect(out.split('\n').filter((l) => l === '').length).toBeLessThanOrEqual(1)
  })
})

// ===========================================================================
// BunFilter
// ===========================================================================

describe('BunFilter dispatch', () => {
  const f = new BunFilter()
  it('matches bun install', () => expect(f.matches(['bun', 'install'])).toBe(true))
  it('matches bun test', () => expect(f.matches(['bun', 'test'])).toBe(true))
  it('matches bun build', () => expect(f.matches(['bun', 'build', 'src/index.ts'])).toBe(true))
  it('is reachable via selectFilter', () =>
    expect(selectFilter(['bun', 'install']))?.toBe(bunFilter))
})

describe('BunFilter compress: install', () => {
  it('collapses package download lines', () => {
    const stdout = [
      '  ↕ react@18.2.0',
      '  ↑ lodash@4.17.21',
      '  ↓ typescript@5.0.0',
      'Saved lockfile',
    ].join('\n')
    const out = compress(bunFilter, stdout, ['bun', 'install'])
    expect(out).toContain('Saved lockfile')
    expect(out).toContain('collapsed 3 package download/install line(s)')
  })
})

describe('BunFilter compress: build assets', () => {
  it('truncates > 10 asset lines with a note', () => {
    const assets = Array.from({ length: 15 }, (_, i) => `  chunk/file${i}.js  12.3 kB`)
    const out = compress(bunFilter, assets.join('\n'), ['bun', 'build', 'src/'])
    expect(out).toContain('5 more asset/chunk line(s) elided')
  })
})

// ===========================================================================
// DenoFilter
// ===========================================================================

describe('DenoFilter dispatch', () => {
  const f = new DenoFilter()
  it('matches deno test', () => expect(f.matches(['deno', 'test'])).toBe(true))
  it('matches deno compile', () => expect(f.matches(['deno', 'compile', 'main.ts'])).toBe(true))
  it('is reachable via selectFilter', () =>
    expect(selectFilter(['deno', 'test']))?.toBe(denoFilter))
})

describe('DenoFilter compress: compile', () => {
  it('collapses download lines', () => {
    const stdout = [
      'Download https://deno.land/std@0.208.0/fmt/colors.ts',
      'Download https://deno.land/x/oak@v12.6.1/mod.ts',
      'Compile file:///main.ts',
    ].join('\n')
    const out = compress(denoFilter, stdout, ['deno', 'compile', 'main.ts'])
    expect(out).toContain('collapsed 2 download line(s)')
    expect(out).toContain('Compile file:///main.ts')
  })
})

// ===========================================================================
// FlutterFilter
// ===========================================================================

describe('FlutterFilter dispatch', () => {
  const f = new FlutterFilter()
  it('matches flutter build', () => expect(f.matches(['flutter', 'build', 'apk'])).toBe(true))
  it('matches flutter test', () => expect(f.matches(['flutter', 'test'])).toBe(true))
  it('is reachable via selectFilter', () =>
    expect(selectFilter(['flutter', 'build', 'apk']))?.toBe(flutterFilter))
})

describe('FlutterFilter compress: build', () => {
  it('collapses Dart compilation lines', () => {
    const stdout = Array.from({ length: 5 }, (_, i) => `Compiling lib/src/widget${i}.dart`)
      .concat(['✓ Built build/app/outputs/apk/release/app-release.apk'])
      .join('\n')
    const out = compress(flutterFilter, stdout, ['flutter', 'build', 'apk'])
    expect(out).toContain('collapsed 5 Dart source compilation(s)')
    expect(out).toContain('Built build/')
  })
})

// ===========================================================================
// DartFilter
// ===========================================================================

describe('DartFilter dispatch', () => {
  const f = new DartFilter()
  it('matches dart test', () => expect(f.matches(['dart', 'test'])).toBe(true))
  it('matches dart pub get', () => expect(f.matches(['dart', 'pub'])).toBe(true))
  it('is reachable via selectFilter', () =>
    expect(selectFilter(['dart', 'test']))?.toBe(dartFilter))
})

describe('DartFilter compress: pub', () => {
  it('collapses package lines', () => {
    const stdout = [
      '+ collection 1.17.1',
      '+ crypto 3.0.3',
      'Got dependencies',
    ].join('\n')
    const out = compress(dartFilter, stdout, ['dart', 'pub', 'get'])
    expect(out).toContain('Got dependencies')
    expect(out).toContain('collapsed 2 package line(s)')
  })
})

// ===========================================================================
// SwiftFilter
// ===========================================================================

describe('SwiftFilter dispatch', () => {
  const f = new SwiftFilter()
  it('matches swift build', () => expect(f.matches(['swift', 'build'])).toBe(true))
  it('matches swift test', () => expect(f.matches(['swift', 'test'])).toBe(true))
  it('is reachable via selectFilter', () =>
    expect(selectFilter(['swift', 'build']))?.toBe(swiftFilter))
})

describe('SwiftFilter compress: build', () => {
  it('collapses CompileSwift steps', () => {
    const stdout = [
      'CompileSwift normal x86_64 Sources/App/main.swift',
      'CompileSwift normal x86_64 Sources/App/util.swift',
      '** BUILD SUCCEEDED **',
    ].join('\n')
    const out = compress(swiftFilter, stdout, ['swift', 'build'])
    expect(out).toContain('** BUILD SUCCEEDED **')
    expect(out).toContain('collapsed 2 compile/link step(s)')
  })
})


// ===========================================================================
// XcodeFilter
// ===========================================================================

describe('XcodeFilter dispatch', () => {
  const f = new XcodeFilter()
  it('matches xcodebuild', () => expect(f.matches(['xcodebuild', '-scheme', 'App'])).toBe(true))
  it('is reachable via selectFilter', () =>
    expect(selectFilter(['xcodebuild', '-scheme', 'App']))?.toBe(xcodeFilter))
})

describe('XcodeFilter compress', () => {
  it('collapses compile steps and keeps status', () => {
    const stdout = [
      'CompileSwift normal arm64 /Sources/App.swift',
      'CompileC /build/App.o App.m normal',
      '** BUILD SUCCEEDED **',
    ].join('\n')
    const out = compress(xcodeFilter, stdout, ['xcodebuild'])
    expect(out).toContain('** BUILD SUCCEEDED **')
    expect(out).toContain('collapsed 2 compile/link step(s)')
  })
})

// ===========================================================================
// MixFilter
// ===========================================================================

describe('MixFilter dispatch', () => {
  const f = new MixFilter()
  it('matches mix compile', () => expect(f.matches(['mix', 'compile'])).toBe(true))
  it('matches mix test', () => expect(f.matches(['mix', 'test'])).toBe(true))
  it('matches bare mix (no subcommand)', () => expect(f.matches(['mix'])).toBe(true))
  it('does NOT match unknown subcommands', () =>
    expect(f.matches(['mix', 'unknown_custom_task'])).toBe(false))
  it('is reachable via selectFilter', () =>
    expect(selectFilter(['mix', 'test']))?.toBe(mixFilter))
})

describe('MixFilter compress: test', () => {
  it('collapses dot-progress and keeps summary', () => {
    const stdout = [
      '............',
      'F',
      '13 tests, 1 failure',
    ].join('\n')
    const out = compress(mixFilter, stdout, ['mix', 'test'])
    expect(out).toContain('13 tests, 1 failure')
    expect(out).toContain('collapsed')
  })
})

describe('MixFilter compress: compile', () => {
  it('collapses Compiling lines and keeps Generated', () => {
    const stdout = [
      'Compiling 15 files (.ex)',
      'Compiling 3 files (.ex)',
      'Generated my_app app',
    ].join('\n')
    const out = compress(mixFilter, stdout, ['mix', 'compile'])
    expect(out).toContain('Generated my_app app')
    expect(out).toContain('collapsed 2 compilation batch(es)')
  })
})

// ===========================================================================
// ZigFilter
// ===========================================================================

describe('ZigFilter dispatch', () => {
  const f = new ZigFilter()
  it('matches zig build', () => expect(f.matches(['zig', 'build'])).toBe(true))
  it('matches zig test', () => expect(f.matches(['zig', 'test', 'src/main.zig'])).toBe(true))
  it('is reachable via selectFilter', () =>
    expect(selectFilter(['zig', 'build']))?.toBe(zigFilter))
})

describe('ZigFilter compress', () => {
  it('samples first 5 steps and adds +N more marker', () => {
    const steps = Array.from({ length: 12 }, (_, i) => `[${i + 1}/12] zig obj step${i}`)
    const stdout = [...steps, 'Build Summary: 12/12 steps succeeded'].join('\n')
    const out = compress(zigFilter, stdout, ['zig', 'build'])
    // First 5 steps should appear
    expect(out).toContain('[1/12]')
    expect(out).toContain('[5/12]')
    // Step 6 onward should be collapsed
    expect(out).not.toContain('[6/12]')
    expect(out).toContain('+7 more build step(s)')
    expect(out).toContain('Build Summary')
  })
})

// ===========================================================================
// RCmdFilter
// ===========================================================================

describe('RCmdFilter dispatch', () => {
  const f = new RCmdFilter()
  it('matches Rscript', () => expect(f.matches(['Rscript', 'foo.R'])).toBe(true))
  it('matches R CMD check', () => expect(f.matches(['R', 'CMD', 'check', 'pkg/'])).toBe(true))
  it('does NOT match bare R with no CMD', () => expect(f.matches(['R', '--version'])).toBe(false))
  it('is reachable via selectFilter (Rscript)', () =>
    expect(selectFilter(['Rscript', 'foo.R']))?.toBe(rCmdFilter))
})

describe('RCmdFilter compress', () => {
  it('collapses OK checks and keeps NOTE/WARNING/ERROR', () => {
    const stdout = [
      '* checking DESCRIPTION meta-information ... OK',
      '* checking for LF line-endings in source and make files and shell scripts ... OK',
      '* checking for empty or unneeded directories ... NOTE',
      'Status: 1 NOTE',
    ].join('\n')
    const out = compress(rCmdFilter, stdout, ['R', 'CMD', 'check', 'pkg/'])
    expect(out).toContain('collapsed 2 R CMD check-OK line(s)')
    expect(out).toContain('NOTE')
    expect(out).toContain('Status: 1 NOTE')
  })
})

// ===========================================================================
// Factory-built filters: golden output tests
// ===========================================================================

describe('erlangFilter dispatch', () => {
  it('matches rebar3 compile', () =>
    expect(selectFilter(['rebar3', 'compile']))?.toBe(erlangFilter))
})

describe('erlangFilter compress', () => {
  it('collapses Erlang module compilations', () => {
    const lines = [
      '==> myapp (compile)',
      'Compiling src/myapp.erl',
      'Compiling src/util.erl',
      '==> Done.',
    ].join('\n')
    const out = compress(erlangFilter, lines, ['rebar3', 'compile'])
    expect(out).toContain('collapsed 2 Erlang module compilation(s)')
    expect(out).toContain('==> Done.')
  })
})

describe('crystalFilter dispatch', () => {
  it('matches crystal spec', () => expect(selectFilter(['crystal', 'spec']))?.toBe(crystalFilter))
})

describe('crystalFilter compress', () => {
  it('collapses Crystal compile steps', () => {
    const lines = [
      'Compiling spec/my_spec.cr',
      'Linking crystal spec .build/spec',
      '3 examples, 0 failures',
    ].join('\n')
    const out = compress(crystalFilter, lines, ['crystal', 'spec'])
    expect(out).toContain('collapsed 2 Crystal compiling/linking step(s)')
    expect(out).toContain('3 examples, 0 failures')
  })
})

describe('haskellFilter dispatch', () => {
  it('matches cabal build', () => expect(selectFilter(['cabal', 'build']))?.toBe(haskellFilter))
  it('matches stack test', () => expect(selectFilter(['stack', 'test']))?.toBe(haskellFilter))
})

describe('haskellFilter compress', () => {
  it('collapses module compilations', () => {
    const lines = [
      '[1 of 5] Compiling Lib.Utils',
      '[2 of 5] Compiling Lib.Core',
      '[3 of 5] Compiling Main',
      'Build completed',
    ].join('\n')
    const out = compress(haskellFilter, lines, ['cabal', 'build'])
    expect(out).toContain('collapsed 3 module compilation(s)')
    expect(out).toContain('Build completed')
  })
})

describe('elmFilter dispatch', () => {
  it('matches elm make', () => expect(selectFilter(['elm', 'make', 'src/Main.elm']))?.toBe(elmFilter))
})

describe('elmFilter compress', () => {
  it('collapses downloading and compilation lines, keeps Success', () => {
    const lines = [
      'Starting downloads...',
      'Downloading elm/core (1.0.5)',
      'Compiling src/Main.elm',
      'Compiling src/Util.elm',
      'Success!',
    ].join('\n')
    const out = compress(elmFilter, lines, ['elm', 'make', 'src/Main.elm'])
    expect(out).toContain('Success!')
    expect(out).toContain('Downloaded')
    expect(out).toContain('collapsed 2 Elm source file compilation(s)')
  })
})

describe('juliaFilter dispatch', () => {
  it('matches julia script', () => expect(selectFilter(['julia', 'train.jl']))?.toBe(juliaFilter))
})

describe('juliaFilter compress', () => {
  it('collapses Pkg progress banners', () => {
    const lines = [
      '   Resolving package versions...',
      '   Updating `/path/to/Project.toml`',
      '  [7876af07] + Example v0.5.3',
      'Testing MyPkg',
    ].join('\n')
    const out = compress(juliaFilter, lines, ['julia', '-e', 'using Pkg; Pkg.test()'])
    expect(out).toContain('Testing MyPkg')
    expect(out).toContain('package operation(s)')
  })
})

describe('powerShellFilter dispatch', () => {
  it('matches pwsh', () => expect(selectFilter(['pwsh', '-File', 'build.ps1']))?.toBe(powerShellFilter))
  it('matches powershell', () =>
    expect(selectFilter(['powershell', '-Command', 'Get-Process']))?.toBe(powerShellFilter))
})

describe('powerShellFilter compress', () => {
  it('collapses VERBOSE lines', () => {
    const lines = [
      'VERBOSE: Performing operation',
      'VERBOSE: Target is process',
      'Hello, world!',
    ].join('\n')
    const out = compress(powerShellFilter, lines, ['pwsh', '-File', 'build.ps1'])
    expect(out).toContain('Hello, world!')
    expect(out).toContain('collapsed')
    expect(out).not.toContain('VERBOSE: Performing')
  })

  it('deduplicates repeated warnings', () => {
    const warn = 'WARNING: deprecated cmdlet'
    const lines = [warn, warn, warn, 'Done'].join('\n')
    const out = compress(powerShellFilter, lines, ['pwsh', '-File', 'x.ps1'])
    // Only 1 warning should pass through (maxPerKey=1 for dedupeRules)
    expect(out.split(warn).length - 1).toBe(1)
    expect(out).toContain('Done')
  })

  // Regression: the dedup key was truncated to the first 40 characters of each WARNING line,
  // so two distinct warnings sharing a long common leading substring collided and one was
  // silently dropped as a false "repeat".
  it('does not drop a distinct warning that shares its first 40 characters with another', () => {
    const w1 = 'WARNING: Failed to install package foo-service-alpha (timeout)'
    const w2 = 'WARNING: Failed to install package foo-service-beta (disk full)'
    const lines = [w1, w2, 'Done'].join('\n')
    const out = compress(powerShellFilter, lines, ['pwsh', '-File', 'x.ps1'])
    expect(out).toContain('service-alpha')
    expect(out).toContain('service-beta')
  })
})

describe('powerShellFilter compress: CommandNotFoundException ErrorRecord collapse', () => {
  it('collapses a $_-mangled CommandNotFoundException block into one summary line', () => {
    const block = [
      "gti : gti is not recognized as the name of a cmdlet, function, script file, or operable program.",
      'Check the spelling of the name, or if a path was included, verify that the path is correct and try again.',
      'At line:1 char:1',
      '+ gti status',
      '+ ~~~',
      '    + CategoryInfo          : ObjectNotFound: (gti:String) [], CommandNotFoundException',
      '    + FullyQualifiedErrorId : CommandNotFoundException',
      'Done',
    ].join('\n')
    const out = compress(powerShellFilter, block, ['pwsh', '-Command', 'gti status'])
    expect(out).toContain('Done')
    expect(out).not.toContain('CategoryInfo')
    expect(out).not.toContain('FullyQualifiedErrorId')
    expect(out).not.toContain('At line:1 char:1')
    const collapsedLine = out.split('\n').find((l) => l.includes('CommandNotFoundException'))
    expect(collapsedLine).toBeDefined()
    expect(collapsedLine).toContain("'gti' not found")
    expect(collapsedLine).toMatch(/elided \d+ lines of stack trace/)
    expect(collapsedLine).toContain('$_')
    expect(collapsedLine).toContain('backtick')
  })

  it('does not fire on unrelated PowerShell output', () => {
    const lines = ['VERBOSE: Performing operation', 'Hello, world!', 'Done'].join('\n')
    const out = compress(powerShellFilter, lines, ['pwsh', '-Command', 'Write-Host hi'])
    expect(out).not.toContain('CommandNotFoundException')
    expect(out).toContain('Hello, world!')
  })

  it('does not fire on a different exception type that superficially resembles an ErrorRecord', () => {
    const block = [
      "Get-Item : Cannot find path 'C:\\missing.txt' because it does not exist.",
      'At line:1 char:1',
      '+ Get-Item C:\\missing.txt',
      '+ ~~~~~~~~~~~~~~~~~~~~~~~~',
      '    + CategoryInfo          : ObjectNotFound: (C:\\missing.txt:String) [], ItemNotFoundException',
      '    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetItemCommand',
      'Done',
    ].join('\n')
    const out = compress(powerShellFilter, block, ['pwsh', '-Command', 'Get-Item C:\\missing.txt'])
    expect(out).not.toContain('PowerShell CommandNotFoundException')
    expect(out).toContain('ItemNotFoundException')
    expect(out).toContain('Done')
  })
})

describe('powerShellFilter dispatch: CommandNotFoundException reachability', () => {
  it('routes a $_-mangled CommandNotFoundException block to powerShellFilter (not shadowed by an earlier filter)', () => {
    const argv = ['pwsh', '-Command', 'foo']
    const filter = selectFilter(argv)
    expect(filter).toBe(powerShellFilter)

    const block = [
      "foo : foo is not recognized as the name of a cmdlet, function, script file, or operable program.",
      'Check the spelling of the name, or if a path was included, verify that the path is correct and try again.',
      'At line:1 char:1',
      '+ foo',
      '+ ~~~',
      '    + CategoryInfo          : ObjectNotFound: (foo:String) [], CommandNotFoundException',
      '    + FullyQualifiedErrorId : CommandNotFoundException',
    ].join('\n')
    const out = filter!.compress(block, '', 1, argv)
    expect(out).toContain('PowerShell CommandNotFoundException')
    expect(out).toContain("'foo' not found")
  })
})

// ===========================================================================
// LANGUAGE_FILTERS registry
// ===========================================================================

describe('LANGUAGE_FILTERS registry', () => {
  it('contains all 17 filter instances', () => {
    expect(LANGUAGE_FILTERS.length).toBe(17)
  })

  it('has no duplicate names', () => {
    const names = LANGUAGE_FILTERS.map((f) => f.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })

  it('nodeFilter is at index 0 (eval-only match; most restrictive)', () => {
    expect(LANGUAGE_FILTERS[0]).toBe(nodeFilter)
  })

  it('none of the language filter names shadow existing batch names', () => {
    const langNames = new Set(LANGUAGE_FILTERS.map((f) => f.name))
    // These are names used by test-runner / package-manager / linter / build batches
    const existingNames = ['jest', 'vitest', 'pytest', 'go-test', 'npm', 'cargo', 'eslint', 'git']
    for (const name of existingNames) {
      expect(langNames.has(name)).toBe(false)
    }
  })
})
