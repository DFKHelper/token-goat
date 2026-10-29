import { afterEach, describe, expect, it } from 'vitest'

import { resetGitExecutableCacheForTests, runGitDiff, type ExecFileLike } from '../src/launcher'

afterEach(() => {
  resetGitExecutableCacheForTests()
})

describe('launcher cancellation', () => {
  it('passes the cancellation signal to execFile and preserves its AbortError', async () => {
    const controller = new AbortController()
    let markStarted = (): void => {}
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const fakeExecFile: ExecFileLike = (_file, _args, options, callback) => {
      expect(options.signal).toBe(controller.signal)
      markStarted()
      options.signal?.addEventListener('abort', () => {
        const error = Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR', cmd: 'git' })
        callback(error, '', '')
      }, { once: true })
    }

    const result = runGitDiff(process.cwd(), { execFileImpl: fakeExecFile, signal: controller.signal })
    await started
    controller.abort()

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  })
})
