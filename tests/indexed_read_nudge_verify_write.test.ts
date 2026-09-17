import { describe, it, expect } from 'vitest'
import { preReadHandler } from '../src/hooks_read.js'
import { indexFileSync } from '../src/parser.js'
import { globalDbPath } from '../src/constants.js'
import { getFileEntry } from '../src/index_reader.js'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

describe('Indexed File >80% Read Nudge & bash-output --verify-last-write', () => {
  it('triggers a surgical nudge when reading >80% of an indexed substantial file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-indexed-nudge-'))
    const filePath = path.join(tmpDir, 'service.ts')
    // Generate a 120-line file
    const lines = ['export class OrderService {']
    for (let i = 1; i <= 120; i++) {
      lines.push(`  calculateLineItem${i}() { return ${i} }`)
    }
    lines.push('}')
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8')

    // Index the file into the DB
    indexFileSync(filePath, globalDbPath())
    const entry = getFileEntry(filePath)
    expect(entry).not.toBeNull()

    try {
      // 1. Unranged read (100% of the file)
      const event1 = {
        sessionId: 'test-session',
        agentId: 'test-agent',
        eventName: 'pre_tool_use' as const,
        toolName: 'Read',
        toolInput: { file_path: filePath },
        raw: {},
      }
      const output1 = preReadHandler(event1)
      const text1 = JSON.stringify(output1)
      expect(text1).toContain('token-goat has this file indexed')
      expect(text1).toContain('surgical read first')

      // 2. Ranged read spanning >80% (100 lines out of 122) on fresh file
      const filePath2 = path.join(tmpDir, 'service2.ts')
      fs.writeFileSync(filePath2, lines.join('\n'), 'utf8')
      indexFileSync(filePath2, globalDbPath())

      const event2 = {
        sessionId: 'test-session',
        agentId: 'test-agent',
        eventName: 'pre_tool_use' as const,
        toolName: 'Read',
        toolInput: { file_path: filePath2, offset: 1, limit: 110 },
        raw: {},
      }
      const output2 = preReadHandler(event2)
      const text2 = JSON.stringify(output2)
      expect(text2).toContain('token-goat has this file indexed')
      expect(text2).toContain('>80% read')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('detects stale file modifications in bash-output --verify-last-write', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stale-write-'))
    const logPath = path.join(tmpDir, 'output.log')
    fs.writeFileSync(logPath, 'Terminal command output line 1\nLine 2', 'utf8')

    // Set mtime to 120 seconds in the past
    const pastTime = (Date.now() - 120 * 1000) / 1000
    fs.utimesSync(logPath, pastTime, pastTime)

    try {
      const cliEntry = path.resolve(__dirname, '../dist/token-goat.mjs')
      // If built bundle exists, test with CLI
      if (fs.existsSync(cliEntry)) {
        // Strict mode should exit non-zero
        expect(() => {
          execFileSync('node', [cliEntry, 'bash-output', '--file', logPath, '--verify-last-write', '30', '--strict'], {
            encoding: 'utf8',
            stdio: 'pipe',
          })
        }).toThrow()

        // Non-strict mode should succeed and warn on stderr
        const proc = execFileSync('node', [cliEntry, 'bash-output', '--file', logPath, '--verify-last-write', '30'], {
          encoding: 'utf8',
          stdio: 'pipe',
        })
        expect(proc).toContain('Terminal command output line 1')
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
