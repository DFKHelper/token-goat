// Batch A increment 2 golden tests — bespoke runners pytest + go-test. Ported faithfully from the Python suite (tests/test_bash_compress.py: TestPytestFilter, TestGoTestFilter). These are the regression spec for src/tool_filters/pytest.ts and src/tool_filters/go_test.ts. They mirror the Python tests' choice of `.compress()` (raw string) vs `.apply()` (full pipeline) call sites exactly, so any divergence flags a port infidelity.

import { describe, expect, it } from 'vitest'

import {
  detectFromCommand,
  goTestFilter,
  pytestFilter,
  selectFilter,
  TOOL_FILTERS,
} from '../src/tool_filters/index.js'

describe('pytest filter', () => {
  it('drops the dots/percent progress line, keeps FAILED', () => {
    const out = pytestFilter.compress('...... [100%]\nFAILED test_a\n', '', 0, ['pytest'])
    expect(out).not.toContain('[100%]')
    expect(out).toContain('FAILED test_a')
  })

  it('keeps failures and the final tally', () => {
    const text =
      '= test session starts =\n' +
      'collected 100 items\n' +
      'FAILED tests/test_x.py::test_one\n' +
      '= 1 failed, 99 passed in 1.2s =\n'
    const result = pytestFilter.apply(text, '', 1, ['pytest'])
    expect(result.text).toContain('FAILED tests/test_x.py::test_one')
    expect(result.text).toContain('1 failed, 99 passed')
  })

  it('collapses PASSED lines to a count', () => {
    const text = Array.from({ length: 50 }, (_, i) => `PASSED tests/test_${i}.py::test_x`).join('\n')
    const result = pytestFilter.apply(text, '', 0, ['pytest'])
    expect(result.text).not.toContain('PASSED tests/test_0.py')
    expect(result.text).toContain('collapsed 50 PASSED')
  })

  it('strips constant banner lines but keeps real signal', () => {
    const text =
      'platform linux -- Python 3.12.0, pytest-8.1.0\n' +
      'cachedir: /tmp/pytest-cache\n' +
      'rootdir: /home/user/project\n' +
      'configfile: pyproject.toml\n' +
      'plugins: xdist-3.5.0, cov-5.0.0\n' +
      '= test session starts =\n' +
      'collected 5 items\n' +
      'FAILED tests/test_x.py::test_one\n' +
      '= 1 failed, 4 passed in 0.5s =\n'
    const result = pytestFilter.apply(text, '', 1, ['pytest'])
    expect(result.text).not.toContain('platform linux')
    expect(result.text).not.toContain('cachedir:')
    expect(result.text).not.toContain('rootdir:')
    expect(result.text).not.toContain('configfile:')
    expect(result.text).not.toContain('plugins:')
    expect(result.text).toContain('FAILED tests/test_x.py::test_one')
    expect(result.text).toContain('1 failed, 4 passed')
  })

  it('strips pytest-xdist [gwN] worker prefixes, collapses PASSED, keeps FAILED', () => {
    const text =
      '[gw0] [ 25%] PASSED tests/test_a.py::test_one\n' +
      '[gw1] [ 50%] PASSED tests/test_b.py::test_two\n' +
      '[gw0] [ 75%] FAILED tests/test_c.py::test_three\n' +
      '[gw1] [100%] PASSED tests/test_d.py::test_four\n' +
      '= 1 failed, 3 passed in 2.1s =\n'
    const result = pytestFilter.apply(text, '', 1, ['pytest', '-n', '2'])
    expect(result.text).not.toContain('PASSED tests/test_a')
    expect(result.text).toContain('collapsed')
    expect(result.text).toContain('FAILED tests/test_c.py::test_three')
    expect(result.text).not.toContain('[gw0]')
    expect(result.text).not.toContain('[gw1]')
  })

  it('collapses pytest-cov per-file rows but keeps TOTAL', () => {
    const covHeader = 'Name                    Stmts   Miss  Cover\n'
    const sep = '----------------------------------------------\n'
    const rows = Array.from({ length: 20 }, (_, i) => `src/module_${i}.py          100      0   100%`).join('\n')
    const total = 'TOTAL                    2000      0   100%\n'
    const text = covHeader + sep + rows + '\n' + sep + total
    const result = pytestFilter.apply(text, '', 0, ['pytest', '--cov'])
    expect(result.text).toContain('TOTAL')
    expect(result.text).not.toContain('src/module_0.py')
    expect(result.text).toContain('collapsed')
  })

  it('keeps the first 5 slow durations and collapses the rest', () => {
    const header = '= slowest 20 durations =\n'
    const durations = Array.from({ length: 20 }, (_, i) =>
      `${(20 - i).toFixed(2)}s call tests/test_${i}.py::test_slow`,
    ).join('\n')
    const text = header + durations + '\n= 0 failed, 20 passed in 25.5s =\n'
    const result = pytestFilter.apply(text, '', 0, ['pytest', '--durations=20'])
    expect(result.text).toContain('20.00s call')
    expect(result.text).toContain('16.00s call')
    expect(result.text).toContain('collapsed')
    expect(result.text).toContain('0 failed, 20 passed')
  })

  it('closes the slow-durations section when a coverage table interjects with no blank line, so later matching content is not swallowed by stale state', () => {
    const slowHeader = '= slowest 5 durations =\n'
    const durations =
      '5.00s call tests/test_a.py::test_one\n' +
      '4.00s call tests/test_b.py::test_two\n' +
      '3.00s call tests/test_c.py::test_three\n' +
      '2.00s call tests/test_d.py::test_four\n' +
      '1.00s call tests/test_e.py::test_five\n'
    const covSep = '---------- coverage: platform linux, python 3.12.0-final-0 -----------\n'
    const covHeader = 'Name                    Stmts   Miss  Cover\n'
    const covRows =
      'src/module_a.py            100      0   100%\n' + 'src/module_b.py             50      0   100%\n'
    const covTotal = 'TOTAL                       150      0   100%\n'
    const failuresBody =
      '_________________________________ test_something _________________________________\n' +
      'captured stdout call:\n' +
      '1.50s call something\n' +
      'E   AssertionError: boom\n'
    const tally = '= 1 failed, 5 passed in 12.3s =\n'
    const text = slowHeader + durations + covSep + covHeader + covRows + covTotal + failuresBody + tally
    const result = pytestFilter.apply(text, '', 1, ['pytest', '--durations=5', '--cov'])
    expect(result.text).toContain('1.50s call something')
  })

  it('strips preamble lines (collecting / bringing up / cacheprovider)', () => {
    const text =
      'collecting ... collecting [100%]\n' +
      'platform linux -- Python 3.12.0\n' +
      'cachedir: /tmp/pytest-cache\n' +
      'bringing up 4 workers\n' +
      'cacheprovider-1234567890\n' +
      '= test session starts =\n' +
      'collected 5 items\n' +
      'FAILED tests/test_x.py::test_one\n' +
      '= 1 failed, 4 passed in 0.5s =\n'
    const result = pytestFilter.apply(text, '', 1, ['pytest'])
    expect(result.text).not.toContain('collecting ...')
    expect(result.text).not.toContain('bringing up')
    expect(result.text).not.toContain('cacheprovider-')
    expect(result.text).not.toContain('platform linux')
    expect(result.text).toContain('FAILED tests/test_x.py::test_one')
    expect(result.text).toContain('1 failed, 4 passed')
  })

  it('deduplicates repeated warnings and drops the Docs footer', () => {
    const text =
      '= warnings summary =\n' +
      'tests/test_a.py::test_one\n' +
      '  /usr/lib/python3.12/pkg/mod.py:123: DeprecationWarning: use new_api() instead\n' +
      '    old_api()\n' +
      'tests/test_b.py::test_two\n' +
      '  /usr/lib/python3.12/pkg/mod.py:123: DeprecationWarning: use new_api() instead\n' +
      '    old_api()\n' +
      '  -- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html\n' +
      '= 2 passed in 0.5s =\n'
    const result = pytestFilter.apply(text, '', 0, ['pytest'])
    expect(result.text).toContain('DeprecationWarning: use new_api() instead')
    expect(result.text.split('DeprecationWarning: use new_api() instead').length - 1).toBe(1)
    expect(result.text).not.toContain('Docs: https://')
    expect(result.text).toContain('collapsed')
    expect(result.text).toContain('2 passed')
  })

  it('keeps distinct warning types that share a message instead of over-collapsing', () => {
    const text =
      '= warnings summary =\n' +
      'tests/test_a.py::test_one\n' +
      '  /pkg/a.py:10: UserWarning: This is a Warning\n' +
      'tests/test_b.py::test_two\n' +
      '  /pkg/b.py:20: DeprecationWarning: This is a Warning\n' +
      '= 2 passed in 0.5s =\n'
    const result = pytestFilter.apply(text, '', 0, ['pytest'])
    expect(result.text).toContain('UserWarning: This is a Warning')
    expect(result.text).toContain('DeprecationWarning: This is a Warning')
  })

  it('drops the second group\'s node-id header when its warning message is a duplicate', () => {
    const text =
      '= warnings summary =\n' +
      'tests/test_a.py::test_one\n' +
      '  /pkg/mod.py:10: UserWarning: same message\n' +
      'tests/test_b.py::test_two\n' +
      '  /pkg/mod.py:10: UserWarning: same message\n' +
      '= 2 passed in 0.5s =\n'
    const result = pytestFilter.apply(text, '', 0, ['pytest'])
    expect(result.text).toContain('tests/test_a.py::test_one')
    expect(result.text).toContain('same message')
    expect(result.text).not.toContain('tests/test_b.py::test_two')
  })

  it('keeps the node-id header when its warning message is not a duplicate', () => {
    const text =
      '= warnings summary =\n' +
      'tests/test_a.py::test_one\n' +
      '  /pkg/mod.py:10: UserWarning: a unique message\n' +
      '= 1 passed in 0.5s =\n'
    const result = pytestFilter.apply(text, '', 0, ['pytest'])
    expect(result.text).toContain('tests/test_a.py::test_one')
    expect(result.text).toContain('a unique message')
  })

  it('drops the constant "test session starts" header but keeps collected + tally', () => {
    const text =
      '= test session starts =\n' + 'collected 10 items\n' + '..........\n' + '= 10 passed in 1.5s =\n'
    const result = pytestFilter.apply(text, '', 0, ['pytest'])
    expect(result.text).not.toContain('test session starts')
    expect(result.text).toContain('10 passed')
    expect(result.text).toContain('collected 10 items')
  })

  it('dispatches pytest and wrapped invocations to the pytest filter', () => {
    expect(selectFilter(['pytest'])?.name).toBe('pytest')
    expect(selectFilter(['py.test'])?.name).toBe('pytest')
    expect(selectFilter(['python', '-m', 'pytest'])?.name).toBe('pytest')
    expect(selectFilter(['uv', 'run', 'pytest', '-v'])?.name).toBe('pytest')
    expect(detectFromCommand('python -m pytest tests/')?.filter.name).toBe('pytest')
  })
})

describe('go-test filter', () => {
  it('preserves the panicking subtest identity when no --- FAIL: line is printed', () => {
    // A panic aborts the test binary before Go prints `--- FAIL:`, so the `=== RUN` line naming the subtest is the only marker of which case blew up. The stack shows only the parent test func, so that line must survive.
    const out = [
      '=== RUN   TestTable',
      '=== RUN   TestTable/case_3',
      'panic: runtime error: index out of range [5] with length 3',
      '',
      'goroutine 7 [running]:',
      'pkg.TestTable.func1(0xc0001)',
      '\t/src/pkg/table_test.go:42 +0x1a5',
      'FAIL\tpkg\t0.012s',
    ].join('\n')
    const result = goTestFilter.apply(out, '', 1, ['go', 'test'])
    expect(result.text).toContain('TestTable/case_3')
    expect(result.text).toContain('panic: runtime error')
  })

  it('collapses passing testcases to a count, keeps the package summary', () => {
    const lines: string[] = []
    for (let i = 0; i < 15; i++) {
      lines.push(`=== RUN   TestFunc${i}`)
      lines.push(`--- PASS: TestFunc${i} (0.00s)`)
    }
    lines.push('ok  \tgithub.com/org/repo\t0.015s')
    const result = goTestFilter.apply(lines.join('\n'), '', 0, ['go', 'test', './...'])
    expect(result.text).not.toContain('TestFunc0')
    expect(result.text).toContain('collapsed 15 PASS testcases')
    expect(result.text).toContain('ok  \tgithub.com/org/repo')
  })

  it('keeps FAIL testcases and their failure body verbatim', () => {
    const text =
      '=== RUN   TestPassing\n' +
      '--- PASS: TestPassing (0.00s)\n' +
      '=== RUN   TestBroken\n' +
      '    main_test.go:25: expected 1, got 2\n' +
      '--- FAIL: TestBroken (0.00s)\n' +
      'FAIL\tgithub.com/org/repo\t0.002s\n'
    const result = goTestFilter.apply(text, '', 1, ['go', 'test'])
    expect(result.text).toContain('TestBroken')
    expect(result.text).toContain('expected 1, got 2')
    expect(result.text).not.toContain('TestPassing')
  })

  it('drops "go: downloading" dependency lines', () => {
    const text =
      'go: downloading github.com/pkg/errors v0.9.1\n' +
      'go: downloading github.com/stretchr/testify v1.8.0\n' +
      '=== RUN   TestSomething\n' +
      '--- PASS: TestSomething (0.00s)\n' +
      'ok  \tgithub.com/org/repo\t0.10s\n'
    const result = goTestFilter.apply(text, '', 0, ['go', 'test', './...'])
    const nonNote = result.text.split('\n').filter((l) => !l.startsWith('[token-goat:'))
    expect(nonNote.some((l) => l.includes('go: downloading'))).toBe(false)
    expect(result.text).toContain('dropped')
    expect(result.text).toContain('ok  \tgithub.com/org/repo')
  })

  it('drops "=== RUN" lines outside fail blocks', () => {
    const lines: string[] = []
    for (let i = 0; i < 5; i++) {
      lines.push(`=== RUN   TestCase${i}`)
      lines.push(`--- PASS: TestCase${i} (0.00s)`)
    }
    lines.push('ok  \trepo\t0.005s')
    const result = goTestFilter.apply(lines.join('\n'), '', 0, ['go', 'test'])
    const nonNote = result.text.split('\n').filter((l) => !l.startsWith('[token-goat:'))
    expect(nonNote.some((l) => l.startsWith('=== RUN'))).toBe(false)
  })

  it('counts both normal (0.02s) and cached packages in the summary', () => {
    const text =
      '=== RUN   TestPassing\n' +
      '--- PASS: TestPassing (0.00s)\n' +
      'ok  \tgithub.com/org/normal-pkg\t0.015s\n' +
      'ok  \tgithub.com/org/cached-pkg\t(cached)\n'
    const result = goTestFilter.apply(text, '', 0, ['go', 'test', './...'])
    expect(result.text).toContain('[2 packages passed')
  })

  it('passes "go test -json" through unchanged (no compression markers)', () => {
    const jsonLines = [
      '{"Action":"run","Test":"TestFoo"}',
      '{"Action":"pass","Test":"TestFoo","Elapsed":0.001}',
      '{"Action":"run","Test":"TestBar"}',
      '{"Action":"fail","Test":"TestBar","Elapsed":0.002}',
    ].join('\n')
    const result = goTestFilter.apply(jsonLines, '', 1, ['go', 'test', '-json', './...'])
    expect(result.text).toContain('{"Action":"fail"')
    expect(result.text).toContain('{"Action":"pass"')
    expect(result.text).not.toContain('[token-goat:')
  })

  it('counts SKIP lines separately from PASS', () => {
    const text =
      '=== RUN   TestSkipped\n' +
      '    --- SKIP: TestSkipped (0.00s): not supported on this platform\n' +
      '=== RUN   TestPassing\n' +
      '--- PASS: TestPassing (0.00s)\n' +
      'ok  \tgithub.com/org/repo\t0.003s\n'
    const result = goTestFilter.apply(text, '', 0, ['go', 'test'])
    expect(result.text).toContain('collapsed 1 SKIP testcases')
    expect(result.text).toContain('collapsed 1 PASS testcases')
  })

  it('keeps a DATA RACE block verbatim with goroutine stacks collapsed', () => {
    const frames = Array.from({ length: 12 }, (_, i) => `      stackframe_${i}()`).join('\n')
    const text =
      '==================\n' +
      'WARNING: DATA RACE\n' +
      'Write at 0x00c000 by goroutine 7:\n' +
      'Goroutine 7 (running) created at:\n' +
      frames +
      '\n' +
      '==================\n' +
      'FAIL\tgithub.com/org/repo\t0.10s\n'
    const result = goTestFilter.apply(text, '', 1, ['go', 'test', '-race'])
    expect(result.text).toContain('WARNING: DATA RACE')
    expect(result.text).toContain('kept 1 DATA RACE block')
    expect(result.text).toContain('goroutine frames omitted')
  })

  it('collapses stack frames under the primary "Write at"/"Read at" headers, not just under "Goroutine N ... created at:" trailers', () => {
    // Real `go test -race` output's *first* conflicting access is reported as a bare
    // "Write at ADDR by goroutine N:" / "Read at ADDR by goroutine N:" line (no "Previous"
    // prefix) -- only the *second*, comparison access gets a "Previous read/write at ..."
    // prefix. GOROUTINE_HEADER_RE previously only matched "Goroutine N", "Previous", and
    // "Current", so the largest and most important stack in every race report (the one
    // right under the un-prefixed "Write at"/"Read at" line) was never recognized as a
    // header and its frames were never collapsed.
    const writeFrames = Array.from({ length: 10 }, (_, i) => `      write_frame_${i}()`).join('\n')
    const readFrames = Array.from({ length: 10 }, (_, i) => `      read_frame_${i}()`).join('\n')
    const text =
      '==================\n' +
      'WARNING: DATA RACE\n' +
      'Write at 0x00c0001a2010 by goroutine 7:\n' +
      writeFrames +
      '\n' +
      'Previous read at 0x00c0001a2010 by goroutine 6:\n' +
      readFrames +
      '\n' +
      'Goroutine 7 (running) created at:\n' +
      '      main.main()\n' +
      'Goroutine 6 (running) created at:\n' +
      '      main.main()\n' +
      '==================\n' +
      'FAIL\tgithub.com/org/repo\t0.10s\n'
    const result = goTestFilter.apply(text, '', 1, ['go', 'test', '-race'])
    expect(result.text).toContain('WARNING: DATA RACE')
    expect(result.text).toContain('Write at 0x00c0001a2010 by goroutine 7:')
    expect(result.text).toContain('Previous read at 0x00c0001a2010 by goroutine 6:')
    // Only the first MAX_RACE_GOROUTINE_FRAMES (5) of the 10-frame "Write at" stack survive.
    expect(result.text).toContain('write_frame_0()')
    expect(result.text).toContain('write_frame_4()')
    expect(result.text).not.toContain('write_frame_5()')
    expect(result.text).not.toContain('write_frame_9()')
    expect(result.text).toContain('read_frame_0()')
    expect(result.text).not.toContain('read_frame_5()')
  })

  it('routes "go test" to go-test but "go build" elsewhere', () => {
    expect(selectFilter(['go', 'test', './...'])?.name).toBe('go-test')
    expect(selectFilter(['go', 'build', './...'])?.name).not.toBe('go-test')
  })
})

describe('dispatch: bespoke runners registered', () => {
  it('TOOL_FILTERS contains pytest and go-test', () => {
    expect(TOOL_FILTERS.map((f) => f.name)).toEqual(expect.arrayContaining(['pytest', 'go-test']))
  })
})
