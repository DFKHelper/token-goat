import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { cmdPhpLint, PHP_LINT_CONFIG, runPhpLint } from '../src/cli_structured.js'
import { buildProgram } from '../src/cli.js'

describe('php-lint command', () => {
  it('is registered in the CLI', () => {
    const names = buildProgram().commands.map((command) => command.name())
    expect(names).toContain('php-lint')
  })

  it('uses the selected runtime and php -l only for PHP files under the default root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-goat-php-lint-'))
    try {
      writeFileSync(join(root, 'main.php'), '<?php echo 1;')
      writeFileSync(join(root, 'legacy.inc'), '<?php echo 2;')
      writeFileSync(join(root, 'notes.txt'), 'not PHP')
      mkdirSync(join(root, 'node_modules'), { recursive: true })
      writeFileSync(join(root, 'node_modules', 'ignored.php'), '<?php echo 3;')

      const calls: Array<{ executable: string; args: string[] }> = []
      const result = await runPhpLint([], {
        cwd: root,
        php: 'php8.3',
        jobs: '2',
        runProcess: async (executable, args) => {
          calls.push({ executable, args })
          return { exitCode: 0, stdout: 'No syntax errors detected', stderr: '' }
        },
      })

      const expectedFiles = [join(root, 'main.php'), join(root, 'legacy.inc')].sort()
      expect(result.files).toEqual(expectedFiles)
      expect(result.exitCode).toBe(0)
      expect(calls).toHaveLength(2)
      for (const file of expectedFiles) {
        expect(calls).toContainEqual({ executable: 'php8.3', args: ['-l', file] })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts a single PHP file path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-goat-php-lint-'))
    try {
      const file = join(root, 'single.php')
      writeFileSync(file, '<?php echo 1;')

      const result = await runPhpLint([file], {
        php: 'php8.3',
        jobs: '1',
        runProcess: async (executable, args) => {
          expect(executable).toBe('php8.3')
          expect(args).toEqual(['-l', file])
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      })

      expect(result.files).toEqual([file])
      expect(result.exitCode).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('caps concurrent checks at the requested worker count', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-goat-php-lint-'))
    try {
      for (let index = 0; index < 5; index += 1) {
        writeFileSync(join(root, `file-${index}.php`), '<?php echo 1;')
      }

      let active = 0
      let maximumActive = 0
      let calls = 0
      const result = await runPhpLint([root], {
        php: 'php',
        jobs: '2',
        runProcess: async () => {
          active += 1
          calls += 1
          maximumActive = Math.max(maximumActive, active)
          await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate))
          active -= 1
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      })

      expect(maximumActive).toBe(2)
      expect(calls).toBe(5)
      expect(result.exitCode).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns a nonzero result when a PHP syntax check fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-goat-php-lint-'))
    try {
      const file = join(root, 'broken.php')
      writeFileSync(file, '<?php this is invalid')
      const result = await runPhpLint([root], {
        php: 'php',
        jobs: '1',
        runProcess: async () => ({ exitCode: 1, stdout: '', stderr: 'Parse error: synthetic failure' }),
      })

      expect(result.exitCode).toBe(1)
      expect(result.results).toEqual([
        {
          file,
          exitCode: 1,
          stdout: '',
          stderr: 'Parse error: synthetic failure',
        },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('sets the CLI exit code and prints the failing file when syntax validation fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-goat-php-lint-'))
    const file = join(root, 'broken.php')
    const priorExitCode = process.exitCode
    const errorOutput = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      writeFileSync(file, '<?php this is invalid')
      await cmdPhpLint([root], {
        php: 'php',
        jobs: '1',
        runProcess: async () => ({ exitCode: 1, stdout: '', stderr: 'Parse error: synthetic failure' }),
      })

      expect(process.exitCode).toBe(1)
      expect(errorOutput).toHaveBeenCalledWith(`token-goat: [php-lint] ${file}: Parse error: synthetic failure`)
    } finally {
      errorOutput.mockRestore()
      process.exitCode = priorExitCode
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('suppresses per-file success output and preserves runtime diagnostics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'token-goat-php-lint-'))
    const file = join(root, 'legacy.php')
    const priorExitCode = process.exitCode
    const errorOutput = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const logOutput = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      writeFileSync(file, '<?php echo 1;')
      await cmdPhpLint([root], {
        php: 'php8.3',
        jobs: '1',
        runProcess: async () => ({
          exitCode: 0,
          stdout: `Deprecated: __autoload() is deprecated\nNo syntax errors detected in ${file}\n`,
          stderr: '',
        }),
      })

      expect(errorOutput).toHaveBeenCalledWith(
        `token-goat: [php-lint] ${file}: Deprecated: __autoload() is deprecated`,
      )
      expect(logOutput).toHaveBeenCalledWith(
        '[php-lint] Checked 1 PHP files with php8.3: 1 passed, 0 failed, 1 with diagnostics.',
      )
    } finally {
      errorOutput.mockRestore()
      logOutput.mockRestore()
      process.exitCode = priorExitCode
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a worker count above the hard cap', async () => {
    await expect(
      runPhpLint([], {
        jobs: String(PHP_LINT_CONFIG.maxJobs + 1),
        runProcess: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      }),
    ).rejects.toThrow(`--jobs must be at most ${PHP_LINT_CONFIG.maxJobs}`)
  })
})
