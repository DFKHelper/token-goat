import { spawnSync } from 'node:child_process'
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
})
