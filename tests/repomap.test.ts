/**
 * Tests for repomap module.
 */

import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getTrackedFiles } from '../src/repomap.js'
import * as util from '../src/util.js'

vi.mock('../src/util.js')

describe('repomap', () => {
  describe('getTrackedFiles', () => {
    it('parses git ls-files output into paths', () => {
      const mockResult = {
        exitCode: 0,
        stdout: 'src/a.ts\nsrc/b.ts\ntests/c.ts',
        stderr: '',
      }
      vi.mocked(util.runGit).mockReturnValue(mockResult)

      const cwd = '/project'
      const files = getTrackedFiles(cwd)

      expect(util.runGit).toHaveBeenCalledWith(['ls-files'], { cwd })
      expect(files).toHaveLength(3)
      expect(files[0]).toBe(path.join(cwd, 'src/a.ts'))
      expect(files[1]).toBe(path.join(cwd, 'src/b.ts'))
      expect(files[2]).toBe(path.join(cwd, 'tests/c.ts'))
    })

    it('returns empty array on git error', () => {
      const mockResult = { exitCode: 128, stdout: '', stderr: 'not a git repo' }
      vi.mocked(util.runGit).mockReturnValue(mockResult)

      const files = getTrackedFiles('/project')

      expect(files).toEqual([])
    })

    it('skips empty lines', () => {
      const mockResult = {
        exitCode: 0,
        stdout: 'src/a.ts\n\nsrc/b.ts\n',
        stderr: '',
      }
      vi.mocked(util.runGit).mockReturnValue(mockResult)

      const files = getTrackedFiles('/project')

      expect(files).toHaveLength(2)
    })

    it('resolves a single tracked file against its own directory', () => {
      // Regression: git cannot chdir into a file, so `runGit(['ls-files'], { cwd: <file> })` exited non-zero and a genuinely tracked file was reported as "no tracked files found under '<path>' (is it a git repo?)" by `token-goat index <file>`.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-repomap-'))
      const file = path.join(dir, 'campaign-detectors.js')
      fs.writeFileSync(file, 'export const a = 1\n')
      vi.mocked(util.runGit).mockReturnValue({ exitCode: 0, stdout: 'campaign-detectors.js\n', stderr: '' })

      const files = getTrackedFiles(file)

      expect(util.runGit).toHaveBeenCalledWith(['ls-files', '--error-unmatch', '--', 'campaign-detectors.js'], { cwd: dir })
      expect(files).toEqual([file])
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('returns nothing for a single file that exists but is untracked', () => {
      // --error-unmatch is what makes an untracked path a non-zero exit rather than empty-but-successful output, so the caller still refuses instead of silently indexing nothing.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-repomap-'))
      const file = path.join(dir, 'untracked.js')
      fs.writeFileSync(file, 'export const a = 1\n')
      vi.mocked(util.runGit).mockReturnValue({ exitCode: 1, stdout: '', stderr: 'did not match any file(s) known to git' })

      expect(getTrackedFiles(file)).toEqual([])
      // Asserted explicitly: without the flag git would exit 0 and list the directory's other tracked files, so the empty result above alone does not prove the flag survived.
      expect(vi.mocked(util.runGit).mock.lastCall?.[0]).toContain('--error-unmatch')
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('handles exception gracefully', () => {
      vi.mocked(util.runGit).mockImplementation(() => {
        throw new Error('test error')
      })

      const files = getTrackedFiles('/project')

      expect(files).toEqual([])
    })
  })
})
