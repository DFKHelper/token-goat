import { execSync, spawnSync } from 'node:child_process'
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

  it('write-file stdin writes exact bytes', () => {
    const tmp = path.join(os.tmpdir(), `tg-wf-stdin-${Date.now()}.txt`)
    const content = 'stdin content with ```backticks``` and $VAR'
    try {
      const r = runCli(['write-file', tmp], content)
      expect(r.status).toBe(0)
      expect(fs.readFileSync(tmp, 'utf8')).toBe(content)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('write-file --b64 empty payload writes empty file', () => {
    const tmp = path.join(os.tmpdir(), `tg-wf-empty-${Date.now()}.txt`)
    try {
      const r = runCli(['write-file', tmp, '--b64', ''])
      expect(r.status).toBe(0)
      expect(fs.readFileSync(tmp)).toHaveLength(0)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('write-file --b64 binary bytes round-trip', () => {
    const tmp = path.join(os.tmpdir(), `tg-wf-bin-${Date.now()}.bin`)
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x1f, 0xfe, 0xd8])
    const b64 = bytes.toString('base64')
    try {
      const r = runCli(['write-file', tmp, '--b64', b64])
      expect(r.status).toBe(0)
      expect(fs.readFileSync(tmp)).toEqual(bytes)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('write-file --b64 with invalid base64 exits 1 with helpful message', () => {
    const tmp = path.join(os.tmpdir(), `tg-wf-bad-${Date.now()}.txt`)
    try {
      const r = runCli(['write-file', tmp, '--b64', 'not$valid!base64'])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('non-base64')
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('write-file --from missing source exits 1 with helpful message', () => {
    const tmp = path.join(os.tmpdir(), `tg-wf-dst-missing-${Date.now()}.txt`)
    const r = runCli(['write-file', tmp, '--from', '/no/such/file/ever.txt'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('not found')
  })

  it('write-file overwrites existing file', () => {
    const tmp = path.join(os.tmpdir(), `tg-wf-overwrite-${Date.now()}.txt`)
    fs.writeFileSync(tmp, 'original content', 'utf8')
    const b64 = Buffer.from('new content', 'utf8').toString('base64')
    try {
      const r = runCli(['write-file', tmp, '--b64', b64])
      expect(r.status).toBe(0)
      expect(fs.readFileSync(tmp, 'utf8')).toBe('new content')
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('write-file --from and --b64 together exits 1', () => {
    const r = runCli(['write-file', '/tmp/nope', '--from', '/tmp/a', '--b64', 'dGVzdA=='])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('cannot use --from and --b64 together')
  })

  it('write-file --from overwrites existing file atomically', () => {
    const src = path.join(os.tmpdir(), `tg-wf-src-ow-${Date.now()}.txt`)
    const dst = path.join(os.tmpdir(), `tg-wf-dst-ow-${Date.now()}.txt`)
    fs.writeFileSync(src, 'source content', 'utf8')
    fs.writeFileSync(dst, 'old content', 'utf8')
    try {
      const r = runCli(['write-file', dst, '--from', src])
      expect(r.status).toBe(0)
      expect(fs.readFileSync(dst, 'utf8')).toBe('source content')
    } finally {
      fs.rmSync(src, { force: true })
      fs.rmSync(dst, { force: true })
    }
  })

  it('write-file --b64 accepts url-safe base64 (- and _)', () => {
    const tmp = path.join(os.tmpdir(), `tg-wf-urlsafe-${Date.now()}.bin`)
    // bytes that produce + and / in standard base64
    const bytes = Buffer.from([0xfb, 0xff, 0xfe])
    const urlSafe = bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
    try {
      const r = runCli(['write-file', tmp, '--b64', urlSafe])
      expect(r.status).toBe(0)
      expect(fs.readFileSync(tmp)).toEqual(bytes)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('write-file dest is a directory exits 1 with readable message', () => {
    const r = runCli(['write-file', os.tmpdir(), '--b64', 'dGVzdA=='])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('directory')
  })

  it('write-file --from where source is a directory exits 1 with "source" in message', () => {
    const dst = path.join(os.tmpdir(), `tg-wf-dst-isdir-${Date.now()}.txt`)
    const r = runCli(['write-file', dst, '--from', os.tmpdir()])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('source')
    expect(r.stderr).toContain('directory')
  })

  it('write-file non-existent dest directory exits 1 without .tmp in message', () => {
    const r = runCli(['write-file', '/nonexistent-dir-xyz/file.txt', '--b64', 'dGVzdA=='])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('nonexistent-dir-xyz')
    expect(r.stderr).not.toContain('.tmp.')
  })

  it('write-file --from self-overwrite preserves content', () => {
    const tmp = path.join(os.tmpdir(), `tg-wf-self-${Date.now()}.txt`)
    fs.writeFileSync(tmp, 'self-overwrite content', 'utf8')
    try {
      const r = runCli(['write-file', tmp, '--from', tmp])
      expect(r.status).toBe(0)
      expect(fs.readFileSync(tmp, 'utf8')).toBe('self-overwrite content')
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('write-file stdin empty write produces zero-byte file', () => {
    const tmp = path.join(os.tmpdir(), `tg-wf-stdin-empty-${Date.now()}.txt`)
    try {
      const r = runCli(['write-file', tmp], '')
      expect(r.status).toBe(0)
      expect(fs.readFileSync(tmp)).toHaveLength(0)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('write-file --help mentions stdin', () => {
    const r = runCli(['write-file', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('stdin')
  })

  it('write-file empty dest exits 1 with helpful message', () => {
    const r = runCli(['write-file', '', '--b64', 'dGVzdA=='])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('empty')
  })

  it('write-file --b64 multi-line base64 (openssl-style) writes correctly', () => {
    const tmp = path.join(os.tmpdir(), `tg-wf-multiline-${Date.now()}.bin`)
    const content = 'hello world from multiline base64'
    // simulate openssl enc -base64 output: newline every 64 chars
    const flat = Buffer.from(content, 'utf8').toString('base64')
    const multiline = flat.match(/.{1,64}/g)!.join('\n')
    try {
      const r = runCli(['write-file', tmp, '--b64', multiline])
      expect(r.status).toBe(0)
      expect(fs.readFileSync(tmp, 'utf8')).toBe(content)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('write-file stdin size limit exits 1 with helpful message', () => {
    const tmp = path.join(os.tmpdir(), `tg-wf-limit-${Date.now()}.bin`)
    // 2 MB of data with 1 MB limit
    const big = Buffer.alloc(2 * 1024 * 1024, 0x41)
    try {
      const env = { ...process.env, TOKEN_GOAT_MAX_STDIN_MB: '1' }
      const r = spawnSync(process.execPath, ['--import', 'tsx', MAIN, 'write-file', tmp], {
        input: big,
        encoding: 'buffer',
        env,
      })
      expect(r.status).toBe(1)
      expect(r.stderr.toString()).toContain('exceeds size limit')
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('write-file stdin rejects invalid TOKEN_GOAT_MAX_STDIN_MB', () => {
    const tmp = path.join(os.tmpdir(), `tg-wf-invalid-mb-${Date.now()}.txt`)
    const data = Buffer.from('test')
    try {
      const env = { ...process.env, TOKEN_GOAT_MAX_STDIN_MB: 'not-a-number' }
      const r = spawnSync(process.execPath, ['--import', 'tsx', MAIN, 'write-file', tmp], {
        input: data,
        encoding: 'buffer',
        env,
      })
      expect(r.status).toBe(1)
      expect(r.stderr.toString()).toContain('TOKEN_GOAT_MAX_STDIN_MB must be a positive integer')
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('write-file stdin rejects zero or negative TOKEN_GOAT_MAX_STDIN_MB', () => {
    const tmp = path.join(os.tmpdir(), `tg-wf-zero-mb-${Date.now()}.txt`)
    const data = Buffer.from('test')
    try {
      const env = { ...process.env, TOKEN_GOAT_MAX_STDIN_MB: '0' }
      const r = spawnSync(process.execPath, ['--import', 'tsx', MAIN, 'write-file', tmp], {
        input: data,
        encoding: 'buffer',
        env,
      })
      expect(r.status).toBe(1)
      expect(r.stderr.toString()).toContain('TOKEN_GOAT_MAX_STDIN_MB must be a positive integer')
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  })

  it('write-file --from empty string exits 1', function () {
    const tmp = path.join(os.tmpdir(), `tg-wf-fromempty-${Date.now()}.txt`)
    const r = runCli(['write-file', tmp, '--from', ''])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('--from path cannot be empty')
  })

  it('write-file --b64 whitespace-only exits 1', function () {
    const tmp = path.join(os.tmpdir(), `tg-wf-wsonly-${Date.now()}.txt`)
    const r = runCli(['write-file', tmp, '--b64', '   '])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('whitespace')
  })

  it.skipIf(process.platform === 'win32')('write-file --from FIFO exits 1', function () {
    const tmpDir = os.tmpdir()
    const fifo = path.join(tmpDir, `tg-wf-fifo-${Date.now()}.fifo`)
    execSync(`mkfifo ${fifo}`)
    try {
      const r = runCli(['write-file', path.join(tmpDir, `tg-wf-fifo-out-${Date.now()}.txt`), '--from', fifo])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('special file')
    } finally {
      fs.rmSync(fifo, { force: true })
    }
  })

  it('write-file --b64 single-char payload (length%4===1) exits 1', function () {
    const tmp = path.join(os.tmpdir(), `tg-wf-b64trunc-${Date.now()}.txt`)
    const r = runCli(['write-file', tmp, '--b64', 'd'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('payload length is invalid')
  })

  it.skipIf(process.platform === 'win32')('write-file --from symlink-to-FIFO exits 1', function () {
    const tmpDir = os.tmpdir()
    const fifo = path.join(tmpDir, `tg-wf-fifo2-${Date.now()}.fifo`)
    const link = path.join(tmpDir, `tg-wf-fifolink-${Date.now()}`)
    execSync(`mkfifo ${fifo}`)
    fs.symlinkSync(fifo, link)
    try {
      const r = runCli(['write-file', path.join(tmpDir, `tg-wf-fifo2-out-${Date.now()}.txt`), '--from', link])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('special file')
    } finally {
      fs.rmSync(fifo, { force: true })
      fs.rmSync(link, { force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('write-file replaces symlink at dest rather than writing through it', function () {
    const tmpDir = os.tmpdir()
    const target = path.join(tmpDir, `tg-wf-target-${Date.now()}.txt`)
    const link = path.join(tmpDir, `tg-wf-link-${Date.now()}.txt`)
    fs.writeFileSync(target, 'original', 'utf8')
    fs.symlinkSync(target, link)
    const b64 = Buffer.from('new content', 'utf8').toString('base64')
    try {
      const r = runCli(['write-file', link, '--b64', b64])
      expect(r.status).toBe(0)
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(false)
      expect(fs.readFileSync(link, 'utf8')).toBe('new content')
      expect(fs.readFileSync(target, 'utf8')).toBe('original')
    } finally {
      fs.rmSync(link, { force: true })
      fs.rmSync(target, { force: true })
    }
  })
})
