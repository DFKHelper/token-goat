import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { vi } from 'vitest'

/** Puts a stand-in `token-goat` first on PATH (stubbed with vi.stubEnv, so the file's vi.unstubAllEnvs restores it) and returns a cleanup that deletes it. doctor's Installation check runs whatever `token-goat` PATH resolves to, so a test that reads doctor's verdict otherwise depends on whether the machine has a global install: CI has none, and the run fails there while passing on a developer machine. `version` makes the stand-in print it and exit 0; null makes it exit 1, which the check reports the same way as no install. */
export function tokenGoatOnPath(version: string | null): () => void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-on-path-'))
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'token-goat.cmd'), `@echo off\r\n${version === null ? 'exit /b 1' : `echo ${version}`}\r\n`)
  } else {
    fs.writeFileSync(path.join(dir, 'token-goat'), `#!/bin/sh\n${version === null ? 'exit 1' : `echo ${version}`}\n`, { mode: 0o755 })
  }
  vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env['PATH'] ?? ''}`)
  return () => fs.rmSync(dir, { recursive: true, force: true })
}
