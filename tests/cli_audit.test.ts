import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildFeedbackCardFromClaude,
  buildFeedbackCardFromCopilot,
  formatMaintainerCard,
  runAuditCommand,
} from '../src/cli_audit.js'
import type { WasteReport } from '../src/waste.js'
import type { CopilotWasteReport } from '../src/copilot_waste.js'

describe('formatMaintainerCard', () => {
  it('formats feedback card cleanly matching standard format', () => {
    const card = {
      taskSummary: 'Unit test session',
      preAuditFindings: ['Read whole file without reuse: test.ts'],
      auditExecutionFindings: [],
      recommendedFix: ['Prefer token-goat read'],
    }
    const formatted = formatMaintainerCard(card)
    expect(formatted).toContain('Maintainer Feedback Card')
    expect(formatted).toContain('• Task Summary: Unit test session')
    expect(formatted).toContain('• Friction & Missed Savings:')
    expect(formatted).toContain('  - Read whole file without reuse: test.ts')
    expect(formatted).toContain('• Recommended Fix:')
    expect(formatted).toContain('  - Prefer token-goat read')
  })

  it('includes audit execution findings when present', () => {
    const card = {
      taskSummary: 'Audit session',
      preAuditFindings: ['Pre-audit clean'],
      auditExecutionFindings: ['Excessive shell output captured'],
      recommendedFix: ['Filter subprocess output'],
    }
    const formatted = formatMaintainerCard(card)
    expect(formatted).toContain('  - Audit Execution: Excessive shell output captured')
  })
})

describe('buildFeedbackCardFromClaude', () => {
  it('identifies unread-again files as missed savings', () => {
    const mockReport: WasteReport = {
      transcriptPath: '/fake/path.jsonl',
      totalTokens: 5000,
      tokensByTool: [],
      tokensByFile: [],
      topCalls: [],
      neverTouchedAgain: [
        { filePath: 'src/foo.ts', tokens: 1200 },
      ],
      repeatedUncompressedBash: [],
      assistantOutput: { turnCount: 1, generatedTokens: 100, resendCeilingTokens: 200 },
      residentContext: {
        totalAttachmentBytes: 0,
        attachmentClasses: [],
        latestTaskList: null,
        taskReminderCount: 0,
        taskReminderBytes: 0,
        repeatedSkillBodies: [],
        compactionCount: 0,
      },
    }
    const card = buildFeedbackCardFromClaude(mockReport)
    expect(card.preAuditFindings[0]).toContain('Whole-file reads without reuse: foo.ts')
    expect(card.recommendedFix[0]).toContain('Prefer `token-goat symbol`')
  })

  it('reports zero missed surgical reads when clean', () => {
    const mockReport: WasteReport = {
      transcriptPath: '/fake/path.jsonl',
      totalTokens: 1000,
      tokensByTool: [],
      tokensByFile: [],
      topCalls: [],
      neverTouchedAgain: [],
      repeatedUncompressedBash: [],
      assistantOutput: { turnCount: 1, generatedTokens: 10, resendCeilingTokens: 20 },
      residentContext: {
        totalAttachmentBytes: 0,
        attachmentClasses: [],
        latestTaskList: null,
        taskReminderCount: 0,
        taskReminderBytes: 0,
        repeatedSkillBodies: [],
        compactionCount: 0,
      },
    }
    const card = buildFeedbackCardFromClaude(mockReport)
    expect(card.preAuditFindings[0]).toContain('No missed surgical reads')
  })
})

describe('buildFeedbackCardFromCopilot', () => {
  it('reports repeated prompt blocks and heavy MCP tools', () => {
    const mockReport: CopilotWasteReport = {
      sessionPath: '/fake/events.jsonl',
      sessionId: 'sess-123',
      turns: 5,
      tokens: null,
      blocks: [
        { kind: 'custom_instruction', count: 5, bytes: 10000, repeatCount: 4, repeatBytes: 8000 },
      ],
      compactions: [],
      hookRecordBytes: 0,
      totalEventBytes: 15000,
      mcpTools: {
        cacheFound: true,
        servers: [
          {
            serverName: 'heavy-mcp',
            toolCount: 10,
            definitionBytes: 9000,
            estimatedTokens: 3000,
            updatedAt: '2026-09-22T00:00:00Z',
            toolNames: ['t1'],
          },
        ],
        unreadable: 0,
      },
    }
    const card = buildFeedbackCardFromCopilot(mockReport)
    expect(card.preAuditFindings[0]).toContain('Repeated prompt blocks across turns: custom_instruction')
    expect(card.preAuditFindings[1]).toContain('High fixed MCP tool definition overhead: heavy-mcp')
  })
})

describe('runAuditCommand', () => {
  it('exits with error if explicit transcript is not found', async () => {
    let captured = ''
    const origStderr = process.stderr.write
    process.stderr.write = ((str: string) => { captured += str; return true }) as typeof process.stderr.write
    try {
      await runAuditCommand({ transcript: '/nonexistent/events.jsonl' })
      expect(process.exitCode).toBe(1)
      expect(captured).toContain('transcript not found')
    } finally {
      process.stderr.write = origStderr
      process.exitCode = undefined
    }
  })

  it('runs against a Copilot transcript fixture', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-audit-copilot-'))
    let output = ''
    const origStdout = process.stdout.write
    process.stdout.write = ((str: string) => { output += str; return true }) as typeof process.stdout.write
    try {
      const eventsPath = join(dir, 'events.jsonl')
      writeFileSync(eventsPath, '{"type":"user.message","id":"1","timestamp":1,"data":{"content":"hi"}}\n', 'utf-8')
      await runAuditCommand({ transcript: eventsPath })
      expect(output).toContain('Maintainer Feedback Card')
      expect(output).toContain('Copilot CLI session')
    } finally {
      process.stdout.write = origStdout
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
