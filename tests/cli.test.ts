import { execSync, spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { BUNDLE, runCli, type RunResult } from './helpers/bundle.js'

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

  it('stats --help exits 0', () => {
    const r = runCli(['stats', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('stats')
  }, 30000)

  it('stats --json outputs valid JSON', () => {
    const r = runCli(['stats', '--json'])
    expect(r.status).toBe(0)
    const output = JSON.parse(r.stdout)
    expect(typeof output.total_events).toBe('number')
  }, 30000)

  it('context-stats --help exits 0', () => {
    const r = runCli(['context-stats', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('context')
  }, 30000)

  it('context-stats --json outputs valid JSON', () => {
    const r = runCli(['context-stats', '--json'])
    expect(r.status).toBe(0)
    const output = JSON.parse(r.stdout)
    expect(typeof output.total_tokens).toBe('number')
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
    expect(r.stderr).toContain('--file')
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

  it('write-file --from validates TOKEN_GOAT_MAX_STDIN_MB', () => {
    const srcFile = path.join(os.tmpdir(), `tg-src-${Date.now()}.txt`)
    const destFile = path.join(os.tmpdir(), `tg-dest-${Date.now()}.txt`)
    fs.writeFileSync(srcFile, 'test content')
    try {
      const res = spawnSync(process.execPath, [BUNDLE, 'write-file', destFile, '--from', srcFile], {
        env: { ...process.env, TOKEN_GOAT_MAX_STDIN_MB: 'invalid' },
        encoding: 'utf8',
      })
      expect(res.status).not.toBe(0)
      expect((res.stderr ?? '').toLowerCase()).toContain('positive integer')
    } finally {
      try { fs.unlinkSync(srcFile) } catch { /* ok */ }
      try { fs.unlinkSync(destFile) } catch { /* ok */ }
    }
  }, 30000)

  it('write-file --from exceeding size limit quotes the source path via the shared readFileBoundedRaw helper (regression: cmdWriteFile used to re-inline this check with drifted wording -- "--from source exceeds..." instead of quoting the actual path)', () => {
    const srcFile = path.join(os.tmpdir(), `tg-wf-toolarge-${Date.now()}.bin`)
    const destFile = path.join(os.tmpdir(), `tg-wf-toolarge-dest-${Date.now()}.bin`)
    fs.writeFileSync(srcFile, Buffer.alloc(2 * 1024 * 1024, 0x41))
    try {
      const res = spawnSync(process.execPath, [BUNDLE, 'write-file', destFile, '--from', srcFile], {
        env: { ...process.env, TOKEN_GOAT_MAX_STDIN_MB: '1' },
        encoding: 'utf8',
      })
      expect(res.status).not.toBe(0)
      expect(res.stderr).toContain(`--from '${srcFile}' exceeds size limit`)
    } finally {
      try { fs.unlinkSync(srcFile) } catch { /* ok */ }
      try { fs.unlinkSync(destFile) } catch { /* ok */ }
    }
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

  it('bash-output --file --grep --max-matches caps matching lines', () => {
    const tmpFile = path.join(os.tmpdir(), `tg-maxmatch-${Date.now()}.txt`)
    const lines = Array.from({ length: 10 }, (_, i) => `MATCH line ${i}`).join('\n')
    fs.writeFileSync(tmpFile, lines, 'utf8')
    try {
      const r = runCli(['bash-output', '--file', tmpFile, '--grep', 'MATCH', '--max-matches', '3'])
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('showing first 3 of 10 matching lines')
      expect(r.stdout).toContain('MATCH line 0')
      expect(r.stdout).toContain('MATCH line 2')
      expect(r.stdout).not.toContain('MATCH line 9')
    } finally {
      fs.rmSync(tmpFile, { force: true })
    }
  }, 30000)

  it('bash-output --file --grep alone (no --head/--tail) still applies default elision on a large match set', () => {
    const tmpFile = path.join(os.tmpdir(), `tg-grep-only-elide-${Date.now()}.txt`)
    const lines = Array.from({ length: 200 }, (_, i) => `MATCH line ${i + 1}`).join('\n')
    fs.writeFileSync(tmpFile, lines, 'utf8')
    try {
      const r = runCli(['bash-output', '--file', tmpFile, '--grep', 'MATCH'])
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('...(elided)...')
      expect(r.stdout).toContain('MATCH line 1')
      expect(r.stdout).toContain('MATCH line 200')
      expect(r.stdout).not.toContain('MATCH line 100')
    } finally {
      fs.rmSync(tmpFile, { force: true })
    }
  }, 30000)

  it('bash-output --file --transcript keeps only assistant text from a JSONL transcript', () => {
    const tmpFile = path.join(os.tmpdir(), `tg-transcript-${Date.now()}.jsonl`)
    const jsonl = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'do it' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'HIDDEN' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'inspecting the file' }, { type: 'tool_use', name: 'Read' }] } }),
      'corrupt line not json',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'the answer is 42' }] } }),
    ].join('\n')
    fs.writeFileSync(tmpFile, jsonl + '\n', 'utf8')
    try {
      const r = runCli(['bash-output', '--file', tmpFile, '--transcript'])
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('inspecting the file')
      expect(r.stdout).toContain('the answer is 42')
      expect(r.stdout).not.toContain('HIDDEN')
      expect(r.stdout).not.toContain('do it')
    } finally {
      fs.rmSync(tmpFile, { force: true })
    }
  }, 30000)

  it('bash-output --file --transcript with --grep composes after transcript extraction', () => {
    const tmpFile = path.join(os.tmpdir(), `tg-transcript-grep-${Date.now()}.jsonl`)
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'alpha line' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'beta line' }] } }),
    ].join('\n')
    fs.writeFileSync(tmpFile, jsonl + '\n', 'utf8')
    try {
      const r = runCli(['bash-output', '--file', tmpFile, '--transcript', '--grep', 'beta'])
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('beta line')
      expect(r.stdout).not.toContain('alpha line')
    } finally {
      fs.rmSync(tmpFile, { force: true })
    }
  }, 30000)

  it('bash-output with no id and no --file exits 1', () => {
    const r = runCli(['bash-output'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('provide an <id> or --file')
  }, 30000)

  it.skipIf(process.platform === 'win32')('bash-output --file rejects a FIFO (special file)', () => {
    const tmpDir = os.tmpdir()
    const fifo = path.join(tmpDir, `tg-bo-fifo-${Date.now()}`)
    try {
      execSync(`mkfifo ${JSON.stringify(fifo)}`)
    } catch {
      return
    }
    try {
      const r = runCli(['bash-output', '--file', fifo])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('special file')
    } finally {
      fs.rmSync(fifo, { force: true })
    }
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

  it('bash-output --head and --tail does not apply elision when output size would not shrink', () => {
    const tmpFile = path.join(os.tmpdir(), `tg-test-edge-${Date.now()}.txt`)
    const lines = Array.from({ length: 16 }, (_, i) => `line ${i + 1}`)
    fs.writeFileSync(tmpFile, lines.join('\n'))
    try {
      const r = runCli(['bash-output', '--file', tmpFile, '--head', '5', '--tail', '10'])
      expect(r.status).toBe(0)
      expect(r.stdout).not.toContain('...(elided)...')
      expect(r.stdout).toContain('line 1')
      expect(r.stdout).toContain('line 16')
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

  describe('replace', () => {
    it('replace --help exits 0', () => {
      const r = runCli(['replace', '--help'])
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('replace')
    })

    it('replace --old-from/--new-from replaces a unique match', () => {
      const tmp = path.join(os.tmpdir(), `tg-rpl-from-${Date.now()}.txt`)
      const oldFile = path.join(os.tmpdir(), `tg-rpl-old-${Date.now()}.txt`)
      const newFile = path.join(os.tmpdir(), `tg-rpl-new-${Date.now()}.txt`)
      fs.writeFileSync(tmp, 'alpha beta gamma', 'utf8')
      fs.writeFileSync(oldFile, 'beta', 'utf8')
      fs.writeFileSync(newFile, 'delta', 'utf8')
      try {
        const r = runCli(['replace', tmp, '--old-from', oldFile, '--new-from', newFile])
        expect(r.status).toBe(0)
        expect(fs.readFileSync(tmp, 'utf8')).toBe('alpha delta gamma')
        expect(r.stdout).toContain(tmp)
        expect(r.stdout).toContain('replaced 1 occurrence')
      } finally {
        fs.rmSync(tmp, { force: true })
        fs.rmSync(oldFile, { force: true })
        fs.rmSync(newFile, { force: true })
      }
    })

    it('replace --old-b64/--new-b64 replaces a unique match', () => {
      const tmp = path.join(os.tmpdir(), `tg-rpl-b64-${Date.now()}.txt`)
      const oldText = 'needle'
      const newText = 'thread'
      const oldB64 = Buffer.from(oldText, 'utf8').toString('base64')
      const newB64 = Buffer.from(newText, 'utf8').toString('base64')
      fs.writeFileSync(tmp, 'haystack needle haystack', 'utf8')
      try {
        const r = runCli(['replace', tmp, '--old-b64', oldB64, '--new-b64', newB64])
        expect(r.status).toBe(0)
        expect(fs.readFileSync(tmp, 'utf8')).toBe('haystack thread haystack')
        expect(r.stdout).toContain(tmp)
        expect(r.stdout).toContain('replaced 1 occurrence')
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    })

    it('replace zero matches exits 1', () => {
      const tmp = path.join(os.tmpdir(), `tg-rpl-zero-${Date.now()}.txt`)
      const oldText = 'needle'
      const newText = 'thread'
      const oldB64 = Buffer.from(oldText, 'utf8').toString('base64')
      const newB64 = Buffer.from(newText, 'utf8').toString('base64')
      fs.writeFileSync(tmp, 'haystack only', 'utf8')
      try {
        const r = runCli(['replace', tmp, '--old-b64', oldB64, '--new-b64', newB64])
        expect(r.status).toBe(1)
        expect(r.stderr).toContain('old string not found')
        expect(fs.readFileSync(tmp, 'utf8')).toBe('haystack only')
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    })

    it('replace zero matches reports a trailing-newline near-match diagnostic instead of a bare "not found"', () => {
      const tmp = path.join(os.tmpdir(), `tg-rpl-trail-${Date.now()}.txt`)
      const oldFile = path.join(os.tmpdir(), `tg-rpl-trail-old-${Date.now()}.txt`)
      const newFile = path.join(os.tmpdir(), `tg-rpl-trail-new-${Date.now()}.txt`)
      fs.writeFileSync(tmp, 'alpha\nbeta\ngamma', 'utf8')
      fs.writeFileSync(oldFile, 'beta\ngamma\n', 'utf8')
      fs.writeFileSync(newFile, 'BETA\nGAMMA', 'utf8')
      try {
        const r = runCli(['replace', tmp, '--old-from', oldFile, '--new-from', newFile])
        expect(r.status).toBe(1)
        expect(r.stderr).toContain('old string not found')
        expect(r.stderr).toContain('near-match')
        expect(r.stderr).toContain('trailing newline')
        expect(fs.readFileSync(tmp, 'utf8')).toBe('alpha\nbeta\ngamma')
      } finally {
        fs.rmSync(tmp, { force: true })
        fs.rmSync(oldFile, { force: true })
        fs.rmSync(newFile, { force: true })
      }
    })

    it('replace zero matches reports a CRLF-vs-LF near-match diagnostic', () => {
      const tmp = path.join(os.tmpdir(), `tg-rpl-crlf-${Date.now()}.txt`)
      const oldFile = path.join(os.tmpdir(), `tg-rpl-crlf-old-${Date.now()}.txt`)
      const newFile = path.join(os.tmpdir(), `tg-rpl-crlf-new-${Date.now()}.txt`)
      fs.writeFileSync(tmp, 'alpha\r\nbeta\r\ngamma\r\n', 'utf8')
      fs.writeFileSync(oldFile, 'beta\ngamma', 'utf8')
      fs.writeFileSync(newFile, 'BETA\nGAMMA', 'utf8')
      try {
        const r = runCli(['replace', tmp, '--old-from', oldFile, '--new-from', newFile])
        expect(r.status).toBe(1)
        expect(r.stderr).toContain('old string not found')
        expect(r.stderr).toContain('near-match')
        expect(r.stderr).toContain('line endings')
        expect(r.stderr).toContain('CRLF')
        // Diagnostic only — the file must be left untouched.
        expect(fs.readFileSync(tmp, 'utf8')).toBe('alpha\r\nbeta\r\ngamma\r\n')
      } finally {
        fs.rmSync(tmp, { force: true })
        fs.rmSync(oldFile, { force: true })
        fs.rmSync(newFile, { force: true })
      }
    })

    it('replace zero matches reports a CRLF-vs-LF near-match diagnostic (opposite direction)', () => {
      const tmp = path.join(os.tmpdir(), `tg-rpl-crlf-opp-${Date.now()}.txt`)
      const oldFile = path.join(os.tmpdir(), `tg-rpl-crlf-opp-old-${Date.now()}.txt`)
      const newFile = path.join(os.tmpdir(), `tg-rpl-crlf-opp-new-${Date.now()}.txt`)
      fs.writeFileSync(tmp, 'alpha\nbeta\ngamma\n', 'utf8')
      fs.writeFileSync(oldFile, 'beta\r\ngamma', 'utf8')
      fs.writeFileSync(newFile, 'BETA\r\nGAMMA', 'utf8')
      try {
        const r = runCli(['replace', tmp, '--old-from', oldFile, '--new-from', newFile])
        expect(r.status).toBe(1)
        expect(r.stderr).toContain('old string not found')
        expect(r.stderr).toContain('near-match')
        expect(r.stderr).toContain('line endings')
        expect(r.stderr).toContain('LF')
        // Diagnostic only — the file must be left untouched.
        expect(fs.readFileSync(tmp, 'utf8')).toBe('alpha\nbeta\ngamma\n')
      } finally {
        fs.rmSync(tmp, { force: true })
        fs.rmSync(oldFile, { force: true })
        fs.rmSync(newFile, { force: true })
      }
    })

    it('replace multiple matches without --all exits 1', () => {
      const tmp = path.join(os.tmpdir(), `tg-rpl-multi-${Date.now()}.txt`)
      fs.writeFileSync(tmp, 'red blue red blue red', 'utf8')
      try {
        const r = runCli(['replace', tmp, '--old-b64', Buffer.from('red', 'utf8').toString('base64'), '--new-b64', Buffer.from('green', 'utf8').toString('base64')])
        expect(r.status).toBe(1)
        expect(r.stderr).toContain('appears 3 times')
        expect(r.stderr).toContain('--all')
        expect(fs.readFileSync(tmp, 'utf8')).toBe('red blue red blue red')
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    })

    it('replace --all replaces every occurrence', () => {
      const tmp = path.join(os.tmpdir(), `tg-rpl-all-${Date.now()}.txt`)
      fs.writeFileSync(tmp, 'cat dog cat bird cat', 'utf8')
      try {
        const r = runCli(['replace', tmp, '--old-b64', Buffer.from('cat', 'utf8').toString('base64'), '--new-b64', Buffer.from('fox', 'utf8').toString('base64'), '--all'])
        expect(r.status).toBe(0)
        expect(fs.readFileSync(tmp, 'utf8')).toBe('fox dog fox bird fox')
        expect(r.stdout).toContain('replaced 3 occurrences')
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    })

    it('replace does not corrupt non-UTF-8 bytes elsewhere in the file', () => {
      // Regression test: the target file used to be read via fs.readFileSync(path, 'utf8') — a
      // lossy decode that silently rewrites ANY invalid UTF-8 byte in the whole file to U+FFFD,
      // then re-encodes on write, permanently corrupting it to ef bf bd — even though the edit
      // itself only targets a small, unrelated span elsewhere in the file.
      const tmp = path.join(os.tmpdir(), `tg-rpl-nonutf8-${Date.now()}.txt`)
      const strayByte = 0xe9 // a lone byte that is not valid UTF-8 on its own when followed by ASCII
      const content = Buffer.concat([
        Buffer.from('START-', 'utf8'),
        Buffer.from([strayByte]),
        Buffer.from('-MIDDLE needle END', 'utf8'),
      ])
      const strayIndex = Buffer.from('START-', 'utf8').length
      fs.writeFileSync(tmp, content)
      try {
        const oldB64 = Buffer.from('needle', 'utf8').toString('base64')
        const newB64 = Buffer.from('thread', 'utf8').toString('base64')
        const r = runCli(['replace', tmp, '--old-b64', oldB64, '--new-b64', newB64])
        expect(r.status).toBe(0)
        expect(r.stdout).toContain('replaced 1 occurrence')

        const result = fs.readFileSync(tmp) // raw Buffer — no utf8 decode, so corruption would be visible
        // The stray non-UTF-8 byte, unrelated to the edit, must survive completely untouched.
        expect(result[strayIndex]).toBe(strayByte)
        // The intended, unrelated replacement must still have happened correctly.
        const expected = Buffer.concat([
          Buffer.from('START-', 'utf8'),
          Buffer.from([strayByte]),
          Buffer.from('-MIDDLE thread END', 'utf8'),
        ])
        expect(result.equals(expected)).toBe(true)
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    })

    it('replace preserves non-UTF-8 bytes supplied via --new-b64 in the replacement text', () => {
      // Regression test: --old-b64/--new-b64 used to be decoded via decodeBase64Text, which base64-
      // decodes the payload then calls .toString('utf8') on it; the byte-exact match/replace logic
      // then re-encoded that string back to bytes via Buffer.from(text, 'utf8'). Any invalid-UTF-8
      // byte in the b64 payload itself (as opposed to elsewhere in the target file, covered above)
      // got silently rewritten by that round-trip to the 3-byte U+FFFD sequence (ef bf bd) — so the
      // replacement text the caller explicitly supplied byte-for-byte came out corrupted on disk.
      const tmp = path.join(os.tmpdir(), `tg-rpl-newb64-nonutf8-${Date.now()}.txt`)
      const strayByte = 0xe9 // valid Windows-1252/Latin-1 but invalid as a standalone UTF-8 byte
      const newRaw = Buffer.concat([Buffer.from('BE', 'utf8'), Buffer.from([strayByte]), Buffer.from('TA', 'utf8')])
      fs.writeFileSync(tmp, 'alpha NEEDLE gamma', 'utf8')
      try {
        const oldB64 = Buffer.from('NEEDLE', 'utf8').toString('base64')
        const newB64 = newRaw.toString('base64')
        const r = runCli(['replace', tmp, '--old-b64', oldB64, '--new-b64', newB64])
        expect(r.status).toBe(0)
        expect(r.stdout).toContain('replaced 1 occurrence')

        const result = fs.readFileSync(tmp) // raw Buffer — no utf8 decode, so corruption would be visible
        const expected = Buffer.concat([Buffer.from('alpha ', 'utf8'), newRaw, Buffer.from(' gamma', 'utf8')])
        expect(result.equals(expected)).toBe(true)
        // The stray byte itself must land at its exact expected position, unchanged.
        const strayIndex = Buffer.from('alpha BE', 'utf8').length
        expect(result[strayIndex]).toBe(strayByte)
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    })

    it('replace target file not found exits 1 with a mapFsError-style message', () => {
      const tmp = path.join(os.tmpdir(), `tg-rpl-missing-${Date.now()}.txt`)
      const oldB64 = Buffer.from('old', 'utf8').toString('base64')
      const newB64 = Buffer.from('new', 'utf8').toString('base64')
      const r = runCli(['replace', tmp, '--old-b64', oldB64, '--new-b64', newB64])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('not found')
    })

    // regression: cmdReplace read the whole file, computed the snippet replacement in memory,
    // then rewrote the WHOLE file via atomicWriteBuffer. The snippet match only protects the
    // matched region -- a concurrent write to any OTHER part of the file between the initial
    // read and the final rename was silently lost (last-writer-wins over the entire file), even
    // though the snippet match itself succeeded and reported no error. This forces that window
    // open with the TOKEN_GOAT_TEST_REPLACE_DELAY_MS test-only seam (same pattern as
    // config_commands.ts's TOKEN_GOAT_TEST_RMW_DELAY_MS), races a real concurrent write into it
    // from this test process, and asserts replace aborts instead of clobbering the concurrent
    // change.
    it('replace aborts with a clear error instead of silently clobbering a concurrent modification', async () => {
      const tmp = path.join(os.tmpdir(), `tg-rpl-race-${Date.now()}.txt`)
      fs.writeFileSync(tmp, 'alpha beta gamma', 'utf8')
      const oldB64 = Buffer.from('beta', 'utf8').toString('base64')
      const newB64 = Buffer.from('delta', 'utf8').toString('base64')
      try {
        const child = spawn(process.execPath, [BUNDLE, 'replace', tmp, '--old-b64', oldB64, '--new-b64', newB64], {
          env: { ...process.env, TOKEN_GOAT_TEST_REPLACE_DELAY_MS: '500' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        let sawReady = false
        const readyPromise = new Promise<void>((resolveReady) => {
          child.stderr.on('data', (d: Buffer) => {
            const chunk = d.toString()
            stderr += chunk
            if (!sawReady && chunk.includes('TOKEN_GOAT_TEST_REPLACE_DELAY_READY')) {
              sawReady = true
              resolveReady()
            }
          })
        })
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })

        // Wait for the child's deterministic readiness signal (emitted right as its delay
        // window opens), then land a concurrent write to an UNRELATED part of the file --
        // guaranteed to land after the child's initial read/stat but before its re-stat+rename,
        // regardless of how long CLI startup itself takes.
        await readyPromise
        fs.writeFileSync(tmp, 'alpha beta gamma -- concurrent edit', 'utf8')

        const exitCode: number | null = await new Promise((resolve, reject) => {
          child.on('error', reject)
          child.on('exit', resolve)
        })

        expect(exitCode).toBe(1)
        expect(stderr).toContain('changed on disk')
        expect(stderr).toContain('NOT applied')
        // The concurrent writer's content must survive untouched -- replace must not have overwritten it.
        expect(fs.readFileSync(tmp, 'utf8')).toBe('alpha beta gamma -- concurrent edit')
        void stdout
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    }, 15_000)

    // regression: atomicWriteBuffer always created its temp file at 0o600 and renamed it
    // over dest, so a `replace` against a committed executable (chmod +x hook script, binary)
    // silently dropped the exec bit -- git would then record a 100755->100644 mode change.
    it.skipIf(process.platform === 'win32')('replace preserves the exec bit on a chmod +x target file', () => {
      const tmp = path.join(os.tmpdir(), `tg-rpl-exec-${Date.now()}.txt`)
      fs.writeFileSync(tmp, '#!/bin/sh\necho old\n', 'utf8')
      fs.chmodSync(tmp, 0o755)
      try {
        const oldB64 = Buffer.from('old', 'utf8').toString('base64')
        const newB64 = Buffer.from('new', 'utf8').toString('base64')
        const r = runCli(['replace', tmp, '--old-b64', oldB64, '--new-b64', newB64])
        expect(r.status).toBe(0)
        expect(fs.readFileSync(tmp, 'utf8')).toContain('echo new')
        const mode = fs.statSync(tmp).mode
        expect(mode & 0o111).not.toBe(0)
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    })
  })

  // regression: same atomicWriteBuffer/atomicWriteCore mode-drop bug, exercised via
  // write-file --from (the other caller that rewrites an existing destination file).
  it.skipIf(process.platform === 'win32')('write-file --from preserves the exec bit on a chmod +x destination file', () => {
    const dst = path.join(os.tmpdir(), `tg-wf-exec-${Date.now()}.txt`)
    const src = path.join(os.tmpdir(), `tg-wf-exec-src-${Date.now()}.txt`)
    fs.writeFileSync(dst, '#!/bin/sh\necho old\n', 'utf8')
    fs.chmodSync(dst, 0o755)
    fs.writeFileSync(src, '#!/bin/sh\necho new\n', 'utf8')
    try {
      const r = runCli(['write-file', dst, '--from', src])
      expect(r.status).toBe(0)
      expect(fs.readFileSync(dst, 'utf8')).toBe('#!/bin/sh\necho new\n')
      const mode = fs.statSync(dst).mode
      expect(mode & 0o111).not.toBe(0)
    } finally {
      fs.rmSync(dst, { force: true })
      fs.rmSync(src, { force: true })
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
      const r = spawnSync(process.execPath, [BUNDLE, 'write-file', tmp], {
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
      const r = spawnSync(process.execPath, [BUNDLE, 'write-file', tmp], {
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
      const r = spawnSync(process.execPath, [BUNDLE, 'write-file', tmp], {
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

  it('write-file retries past a transient lock on the destination instead of failing immediately (regression: cli.ts atomicWriteBuffer had no retry-on-EPERM/EBUSY, unlike every other atomic write path in util.ts)', async () => {
    const dest = path.join(os.tmpdir(), `tg-wf-lock-${Date.now()}.txt`)
    const src = path.join(os.tmpdir(), `tg-wf-lock-src-${Date.now()}.txt`)
    const holderScript = path.join(os.tmpdir(), `tg-wf-lock-holder-${Date.now()}.mjs`)
    fs.writeFileSync(dest, 'original')
    fs.writeFileSync(src, 'new content')
    // A second real process holding an open handle on `dest` reliably makes a concurrent rename
    // onto it fail with EPERM on Windows -- exactly the transient AV-scanner/search-indexer lock
    // atomicWriteCore already retries around. It has to be a genuinely separate process (not just
    // another thread in this test process) because the CLI command below runs in its own spawned
    // process; the holder's own setTimeout keeps running independently of this test's event loop.
    fs.writeFileSync(
      holderScript,
      "import { openSync } from 'node:fs'\n" +
        "const fd = openSync(process.argv[2], 'r+')\n" +
        "void fd\n" +
        "process.stdout.write('LOCKED\\n')\n" +
        "setTimeout(() => { process.exit(0) }, Number(process.argv[3]))\n",
    )

    const holdMs = 400
    const holder = spawn(process.execPath, [holderScript, dest, String(holdMs)], { stdio: ['ignore', 'pipe', 'ignore'] })

    try {
      // Deterministic handshake: don't start the real command until the holder has genuinely
      // opened the handle, instead of guessing a fixed pre-delay.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('lock holder never signaled ready')), 5000)
        holder.stdout?.on('data', (chunk: Buffer) => {
          if (chunk.toString('utf8').includes('LOCKED')) {
            clearTimeout(timer)
            resolve()
          }
        })
      })

      const r = spawnSync(process.execPath, [BUNDLE, 'write-file', dest, '--from', src], { encoding: 'utf8' })

      expect(r.status).toBe(0)
      expect(fs.readFileSync(dest, 'utf8')).toBe('new content')
    } finally {
      holder.kill()
      fs.rmSync(dest, { force: true })
      fs.rmSync(src, { force: true })
      fs.rmSync(holderScript, { force: true })
    }
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


describe('skill-compact --path / skill-list --json (isolated data dir)', () => {
  // These drive the REAL built bundle. dataDir() is computed once at module load
  // from LOCALAPPDATA (win32) / XDG_DATA_HOME (linux), so pointing both at a fresh
  // temp dir isolates the skill cache from the user's real one - the exact pollution
  // that masked the original bug. `skill-compact --path` bypasses name resolution,
  // so no ~/.claude/skills override is needed.
  function runIsolated(args: string[], dataDir: string, extraEnv?: Record<string, string>): RunResult {
    const res = spawnSync(process.execPath, [BUNDLE, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: dataDir,
        USERPROFILE: dataDir,
        LOCALAPPDATA: dataDir,
        XDG_DATA_HOME: dataDir,
        ...extraEnv,
      },
    })
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
  }

  // Data dir layout under LOCALAPPDATA/XDG_DATA_HOME nests platform-specific
  // subdirectories (e.g. dfk-helper/token-goat on Windows), so walk recursively
  // for a cache filename instead of assuming a fixed depth.
  function findFileNamesRecursive(dir: string): string[] {
    if (!fs.existsSync(dir)) return []
    const names: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        names.push(...findFileNamesRecursive(full))
      } else {
        names.push(entry.name)
      }
    }
    return names
  }

  function makeSkill(): { dataDir: string; skillFile: string; cleanup: () => void } {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-skillcli-'))
    const dataDir = path.join(base, 'data')
    const skillDir = path.join(base, 'skills', 'myskill')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.mkdirSync(skillDir, { recursive: true })
    const skillFile = path.join(skillDir, 'SKILL.md')
    fs.writeFileSync(skillFile, 'Compact line\n<!-- COMPACT_END -->\nfull body details')
    return { dataDir, skillFile, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) }
  }

  it('caches a compact from --path and derives the name from the parent dir', () => {
    const { dataDir, skillFile, cleanup } = makeSkill()
    try {
      const r = runIsolated(['skill-compact', '--path', skillFile], dataDir)
      expect(r.status).toBe(0)
      expect(r.stdout).toContain("Cached compact for skill 'myskill'")
    } finally {
      cleanup()
    }
  }, 30000)

  // Regression for the acceptance test: after `skill-compact`, `skill-list` must show
  // the skill. Pre-fix skill-compact wrote only a -compact file (no meta), and listSkills
  // iterates metas, so the entry was invisible. skill-compact now also writes the body meta.
  it('skill-list --json surfaces the compacted skill with a skill_name field', () => {
    const { dataDir, skillFile, cleanup } = makeSkill()
    try {
      const compact = runIsolated(['skill-compact', '--path', skillFile], dataDir)
      expect(compact.status).toBe(0)

      const list = runIsolated(['skill-list', '--json'], dataDir)
      expect(list.status).toBe(0)
      const parsed = JSON.parse(list.stdout) as Array<{ name: string; skill_name: string }>
      const entry = parsed.find((e) => e.name === 'myskill')
      expect(entry).toBeDefined()
      expect(entry!.skill_name).toBe('myskill')
    } finally {
      cleanup()
    }
  }, 30000)

  it('skill-compact with neither name nor --path exits 1', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-skillcli-'))
    try {
      const r = runIsolated(['skill-compact'], path.join(base, 'data'))
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('requires a <name> or --path')
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  }, 30000)

  // Regression for SKILLCOMPACT-SESSIONID: cmdSkillCompact used to derive its
  // cache-scoping session id from `Array.from(getSessionFiles().keys())[0]`, which
  // is the first *file path* read this process (or 'default' when none were read -
  // always true for a plain CLI invocation, since only the `hook` relay path loads
  // persisted session state into that map). That silently ignored CLAUDE_CODE_SESSION_ID
  // and always wrote the compact to a hardcoded 'default' bucket, so two different
  // sessions compacting the same skill collided into one cache entry.
  it('skill-compact scopes the compact cache file to CLAUDE_CODE_SESSION_ID, not an arbitrary session', () => {
    const { dataDir, skillFile, cleanup } = makeSkill()
    try {
      const first = runIsolated(['skill-compact', '--path', skillFile], dataDir, {
        CLAUDE_CODE_SESSION_ID: 'sess-alpha',
      })
      expect(first.status).toBe(0)

      const second = runIsolated(['skill-compact', '--path', skillFile], dataDir, {
        CLAUDE_CODE_SESSION_ID: 'sess-beta',
      })
      expect(second.status).toBe(0)

      const fileNames = findFileNamesRecursive(dataDir)
      expect(fileNames).toContain('sess-alpha@myskill@compact')
      expect(fileNames).toContain('sess-beta@myskill@compact')
      expect(fileNames).not.toContain('default@myskill@compact')
    } finally {
      cleanup()
    }
  }, 30000)
})
