/**
 * z/OS JCL adapter: the JOB (to the next JOB, a `//` null statement, or the end of the file), PROC procedures (an in-stream
 * one to its PEND), and the named EXEC steps of each, a step running to the line before the next step. `//*` comment lines,
 * in-stream data after `DD *` or `DD DATA` (to `/*`, the DLM= delimiter, or for `DD *` the next `//` statement), and JES
 * control statements never produce symbols. Operation keywords are matched case-insensitively. Imports are INCLUDE MEMBER=.
 */

import type { AdapterImport } from './common.js'
import { SpanCollector, type StatementAdapterResult } from './span_collector.js'

/** The name field (columns 3-10, possibly `step.ddname`) and the operation of a `//` statement. */
const STATEMENT_RE = /^\/\/(\S*)\s+(\S+)/
const DLM_RE = /\bDLM=(?:'([^']{2})'|([^,\s]{2}))/i
const MEMBER_RE = /\bMEMBER=([A-Za-z@#$][\w@#$]*)/i

export function extractJcl(content: string, filePath: string): StatementAdapterResult {
  const imports: AdapterImport[] = []
  const spans = new SpanCollector(filePath)
  if (content.includes('\0')) return { symbols: [], imports }
  const rawLines = content.split(/\r?\n/)
  let job: number | undefined
  let proc: number | undefined
  let step: number | undefined
  // In-stream data: the delimiter that ends it, and whether a `//` statement ends it too.
  let dataDelimiter = ''
  let dataEndsAtStatement = false
  let previous = 0

  const endStep = (end: number): void => {
    spans.close(step, end)
    step = undefined
  }
  const endProc = (end: number): void => {
    endStep(end)
    spans.close(proc, end)
    proc = undefined
  }
  const endJob = (end: number): void => {
    endProc(end)
    spans.close(job, end)
    job = undefined
  }

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!.slice(0, 72)
    const line = i + 1
    if (dataDelimiter !== '') {
      if (raw.startsWith(dataDelimiter)) {
        dataDelimiter = ''
        previous = line
        continue
      }
      if (!(dataEndsAtStatement && raw.startsWith('//'))) {
        previous = line
        continue
      }
      dataDelimiter = ''
    }
    if (!raw.startsWith('//') || raw.startsWith('//*')) continue
    if (raw.trim() === '//') {
      endJob(previous)
      continue
    }
    const m = STATEMENT_RE.exec(raw)
    if (!m) continue
    const name = m[1]!
    const op = m[2]!.toUpperCase()
    const operands = raw.slice(m[0].length).trim()
    if (op === 'JOB') {
      endJob(previous)
      job = spans.open(name, 'job', line)
    } else if (op === 'PROC') {
      endProc(previous)
      proc = spans.open(name, 'procedure', line, spans.name(job))
    } else if (op === 'PEND') {
      endProc(line)
    } else if (op === 'EXEC') {
      endStep(previous)
      if (name !== '') step = spans.open(name, 'step', line, spans.name(proc ?? job))
    } else if (op === 'INCLUDE') {
      const member = MEMBER_RE.exec(operands)
      if (member) imports.push({ kind: 'include', target: member[1]!, line })
    } else if (op === 'DD') {
      const kind = /^(\*|DATA)(?=$|[,\s])/i.exec(operands)
      if (kind) {
        const dlm = DLM_RE.exec(operands)
        dataDelimiter = dlm ? (dlm[1] ?? dlm[2])! : '/*'
        dataEndsAtStatement = kind[1] === '*' && !dlm
      }
    }
    previous = line
  }
  endJob(previous)
  return { symbols: spans.finish(rawLines), imports }
}
