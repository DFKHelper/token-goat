/**
 * Tests for repomap module.
 */

import { describe, it, expect, vi } from 'vitest'
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

    it('handles exception gracefully', () => {
      vi.mocked(util.runGit).mockImplementation(() => {
        throw new Error('test error')
      })

      const files = getTrackedFiles('/project')

      expect(files).toEqual([])
    })
  })
})
