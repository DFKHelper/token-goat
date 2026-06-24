import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { atomicWriteBytes, atomicWriteText, runGit, sleepSync } from '../src/util.js'

describe('sleepSync', () => {
  it('blocks for approximately the requested duration', () => {
    const start = Date.now()
    sleepSync(120)
    const elapsed = Date.now() - start
    // Allow generous slack for scheduler jitter, but it must actually sleep.
    expect(elapsed).toBeGreaterThanOrEqual(90)
  })

  it('returns immediately for non-positive durations', () => {
    const start = Date.now()
    sleepSync(0)
    sleepSync(-50)
    expect(Date.now() - start).toBeLessThan(50)
  })
})

describe('atomic writes', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tg-util-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('atomicWriteText creates the file with the given content', () => {
    const target = path.join(dir, 'note.txt')
    atomicWriteText(target, 'hello goat')
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf-8')).toBe('hello goat')
  })

  it('atomicWriteText leaves no temp files behind', () => {
    const target = path.join(dir, 'note.txt')
    atomicWriteText(target, 'data')
    // Directory should contain only the final file, no *.tmp siblings.
    const entries = readdirSync(dir)
    expect(entries).toEqual(['note.txt'])
  })

  it('atomicWriteText does not double newlines (no CRLF expansion)', () => {
    const target = path.join(dir, 'crlf.txt')
    atomicWriteText(target, 'a\r\nb\n')
    const bytes = readFileSync(target)
    expect(bytes.toString('latin1')).toBe('a\r\nb\n')
  })

  it('atomicWriteBytes creates the file with the given bytes', () => {
    const target = path.join(dir, 'blob.bin')
    const payload = Buffer.from([0x00, 0x01, 0x0d, 0x0a, 0xff])
    atomicWriteBytes(target, payload)
    expect(existsSync(target)).toBe(true)
    const read = readFileSync(target)
    expect(Buffer.compare(read, payload)).toBe(0)
  })
})

describe('runGit', () => {
  it('runs git --version and returns exit code 0', () => {
    const result = runGit(['--version'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toLowerCase()).toContain('git version')
  })

  it('returns a non-zero exit code for an invalid subcommand', () => {
    const result = runGit(['definitely-not-a-real-subcommand'])
    expect(result.exitCode).not.toBe(0)
  })
})
