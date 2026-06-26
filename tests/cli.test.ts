import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MAIN = path.join(HERE, '..', 'src', 'main.ts')

interface RunResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

function runCli(args: string[], input = ''): RunResult {
  // Invoke node with the tsx ESM loader so the TS entrypoint runs directly with
  // no build step and no shell (avoids the .cmd-shim + shell quoting on Windows).
  const res = spawnSync(process.execPath, ['--import', 'tsx', MAIN, ...args], {
    input,
    encoding: 'utf8',
  })
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

describe('token-goat CLI', () => {
  it('version exits 0 and prints a semver-ish string', () => {
    const r = runCli(['version'])
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  }, 30000)

  it('symbol --help exits 0', () => {
    const r = runCli(['symbol', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('symbol')
  }, 30000)

  it('install --help exits 0', () => {
    const r = runCli(['install', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout.toLowerCase()).toContain('install')
  }, 30000)

  it('hook pre_tool_use with empty stdin exits 0 and writes {} to stdout', () => {
    const r = runCli(['hook', 'pre_tool_use'], '')
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('{}')
  }, 30000)

  it('bash-output exits 1 for missing ID', () => {
    const r = runCli(['bash-output', 'nonexistent-id'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('no cached bash output')
  }, 30000)

  it('skill-list --help exits 0', () => {
    const r = runCli(['skill-list', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('skill')
  }, 30000)

  it('skill-body exits 1 for missing skill', () => {
    const r = runCli(['skill-body', 'nonexistent-skill'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('not found')
  }, 30000)

  it('changed --help exits 0', () => {
    const r = runCli(['changed', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('changed')
  }, 30000)

  it('bash-output --file reads from a file path', async () => {
    const tmpFile = path.join(os.tmpdir(), `tg-test-${Date.now()}.txt`)
    fs.writeFileSync(tmpFile, 'line one\nline two\nline three\n')
    try {
      const r = runCli(['bash-output', '--file', tmpFile])
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('line one')
      expect(r.stdout).toContain('line three')
    } finally {
      fs.unlinkSync(tmpFile)
    }
  }, 30000)

  it('bash-output --file --grep filters lines', async () => {
    const tmpFile = path.join(os.tmpdir(), `tg-test-${Date.now()}.txt`)
    fs.writeFileSync(tmpFile, 'test passed\ntest failed\ntest skipped\n')
    try {
      const r = runCli(['bash-output', '--file', tmpFile, '--grep', 'passed'])
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('passed')
      expect(r.stdout).not.toContain('failed')
    } finally {
      fs.unlinkSync(tmpFile)
    }
  }, 30000)

  it('bash-output --file --grep with -E prefix normalizes pattern', async () => {
    const tmpFile = path.join(os.tmpdir(), `tg-test-${Date.now()}.txt`)
    fs.writeFileSync(tmpFile, 'test passed\ntest failed\nerror here\n')
    try {
      const r = runCli(['bash-output', '--file', tmpFile, '--grep', '-E passed|failed'])
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('passed')
      expect(r.stdout).toContain('failed')
      expect(r.stdout).not.toContain('error')
    } finally {
      fs.unlinkSync(tmpFile)
    }
  }, 30000)

  it('bash-output with no id and no --file exits 1', () => {
    const r = runCli(['bash-output'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('provide an <id> or --file')
  }, 30000)

  it('bash-output --head and --tail together applies elision', async () => {
    const tmpFile = path.join(os.tmpdir(), `tg-test-${Date.now()}.txt`)
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`)
    fs.writeFileSync(tmpFile, lines.join('\n') + '\n')
    try {
      const r = runCli(['bash-output', '--file', tmpFile, '--head', '5', '--tail', '10'])
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('line 1')
      expect(r.stdout).toContain('line 5')
      expect(r.stdout).toContain('...(elided)...')
      expect(r.stdout).toContain('line 200')
      expect(r.stdout).not.toContain('line 100')
    } finally {
      fs.unlinkSync(tmpFile)
    }
  }, 30000)

  it('write-file --b64 writes decoded bytes', () => {
    const tmp = path.join(os.tmpdir(), `tg-wf-${Date.now()}.txt`)
    const content = 'hello ```world``` and """quotes""" and $VAR'
    const b64 = Buffer.from(content, 'utf8').toString('base64')
    try {
      const r = runCli(['write-file', tmp, '--b64', b64])
      expect(r.status).toBe(0)
      expect(fs.readFileSync(tmp, 'utf8')).toBe(content)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('write-file --from copies source bytes exactly', () => {
    const src = path.join(os.tmpdir(), `tg-wf-src-${Date.now()}.txt`)
    const dst = path.join(os.tmpdir(), `tg-wf-dst-${Date.now()}.txt`)
    const content = '#!/bin/sh\necho `date`\n'
    fs.writeFileSync(src, content, 'utf8')
    try {
      const r = runCli(['write-file', dst, '--from', src])
      expect(r.status).toBe(0)
      expect(fs.readFileSync(dst, 'utf8')).toBe(content)
    } finally {
      fs.rmSync(src, { force: true })
      fs.rmSync(dst, { force: true })
    }
  })

  it('write-file --help exits 0', () => {
    const r = runCli(['write-file', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('write-file')
  })
})
