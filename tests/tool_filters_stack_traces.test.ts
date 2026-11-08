import { describe, expect, it } from 'vitest'

import { dotnetFilter, jestFilter, pytestFilter, selectFilter, vitestFilter } from '../src/tool_filters/index.js'

describe('failed test stack traces', () => {
  it('keeps application frames and summarizes hidden Jest/Node framework frames', () => {
    const text = [
      'FAIL src/service.test.ts',
      '  Error: expected value',
      '    at serviceFailure (src/service.ts:12:3)',
      '    at runTest (C:\\repo\\node_modules\\jest-runner\\build\\index.js:20:5)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
      '',
      'Tests: 1 failed, 1 total',
    ].join('\n')

    const result = jestFilter.apply(text, '', 1, ['jest'])

    expect(result.text).toContain('serviceFailure (src/service.ts:12:3)')
    expect(result.text).not.toContain('jest-runner')
    expect(result.text).not.toContain('node:internal')
    expect(result.text).toContain('collapsed 2 external stack frames')
  })

  it('keeps Vitest application locations while hiding its dependency frames', () => {
    const text = [
      ' FAIL tests/service.test.ts',
      '  AssertionError: expected value',
      ' ❯ src/service.ts:12:3',
      ' ❯ node_modules/.pnpm/vitest@5.0.4/node_modules/vitest/dist/runner.js:400:7',
      '      Tests  1 failed (1)',
    ].join('\n')

    const result = vitestFilter.apply(text, '', 1, ['vitest'])

    expect(result.text).toContain('❯ src/service.ts:12:3')
    expect(result.text).not.toContain('node_modules/.pnpm')
    expect(result.text).toContain('collapsed 1 external stack frame')
    expect(result.text).toContain('Tests  1 failed (1)')
  })

  it('keeps pytest application frames and summarizes site-packages frames', () => {
    const text = [
      '=================================== FAILURES ===================================',
      '____________________________ test_service ____________________________',
      'Traceback (most recent call last):',
      '  File "src/service.py", line 5, in service',
      '  File "/venv/lib/python3.12/site-packages/_pytest/runner.py", line 20, in call',
      'AssertionError: expected value',
      '========================= 1 failed in 0.1s =========================',
    ].join('\n')

    const result = pytestFilter.apply(text, '', 1, ['pytest'])

    expect(result.text).toContain('File "src/service.py", line 5')
    expect(result.text).not.toContain('site-packages')
    expect(result.text).toContain('collapsed 1 external stack frame')
    expect(result.text).toContain('1 failed in 0.1s')
  })

  it('keeps dotnet application frames and summarizes framework frames', () => {
    const text = [
      'Failed ServiceTests.StartsService [2 ms]',
      '  Assert.True() Failure',
      '     at App.Service.Run() in C:\\repo\\src\\Service.cs:line 12',
      '     at System.Private.CoreLib.System.RuntimeMethodHandle.InvokeMethod(Object target)',
      '     at System.Threading.Tasks.TaskAwaiter.ThrowForNonSuccess(Task task)',
      'Total tests: 1',
      '     Failed: 1',
    ].join('\n')

    const result = dotnetFilter.apply(text, '', 1, ['dotnet', 'test'])

    expect(result.text).toContain('App.Service.Run() in C:\\repo\\src\\Service.cs:line 12')
    expect(result.text).not.toContain('System.Private.CoreLib')
    expect(result.text).not.toContain('System.Threading.Tasks')
    expect(result.text).toContain('collapsed 2 external stack frames')
    expect(result.text).toContain('Failed: 1')
  })

  it('selects the Node test runner and distills its failure frames', () => {
    const filter = selectFilter(['node', '--test'])

    expect(filter?.name).toBe('node-test')
    expect(selectFilter(['node', 'app.js'])?.name).not.toBe('node-test')
    if (!filter) return

    const text = [
      '✖ test at tests/service.test.js:1:1',
      'AssertionError: expected value',
      '    at serviceFailure (file:///repo/src/service.js:12:3)',
      '    at TestContext.<anonymous> (node:internal/test_runner/test:800:12)',
      'ℹ tests 1',
      'ℹ pass 0',
      'ℹ fail 1',
      'ℹ duration_ms 10',
    ].join('\n')
    const result = filter.apply(text, '', 1, ['node', '--test'])

    expect(result.text).toContain('serviceFailure (file:///repo/src/service.js:12:3)')
    expect(result.text).not.toContain('node:internal')
    expect(result.text).toContain('collapsed 1 external stack frame')
    expect(result.text).toContain('ℹ fail 1')
  })
})
