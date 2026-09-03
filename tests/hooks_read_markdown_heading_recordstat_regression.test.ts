import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'

// FIXTURE PROVENANCE: CAPTURE — real output from testing the markdown heading-tree branch re-read denial
const markdownContent = `# Title
Some content here

## Installation
Instructions here

### Quick Start
More details

## Usage
How to use this

### Examples
Examples here`

import { preReadHandler } from '../src/hooks_read.js'
import { recordFileRead } from '../src/session.js'
import { clearModuleCaches } from '../src/reset.js'
import { summarize } from '../src/stats.js'
import { normalizePath } from '../src/paths.js'
import { makeHookEvent } from './helpers/hook-event.js'

const tmpFiles: string[] = []

function makeMarkdownTmpFile(content: string): string {
  const p = path.join(
    os.tmpdir(),
    `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.md`,
  )
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

function readEvent(filePath: string): ReturnType<typeof makeHookEvent> {
  return makeHookEvent({
    toolName: 'Read',
    toolInput: { file_path: filePath },
    sessionId: 'test',
  })
}

describe('hooks_read markdown heading-tree recordStat regression', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  afterEach(() => {
    tmpFiles.forEach((p) => {
      try {
        fs.unlinkSync(p)
      } catch {
        // ignore
      }
    })
    tmpFiles.length = 0
  })

  it('records a session_hint stat when re-reading an already-read large markdown file with >=3 headings (regression: the markdown heading-tree branch was missing recordStat when alreadyRead was true)', () => {
    // Create a large markdown file with >=3 headings (required for the heading-tree branch)
    const p = makeMarkdownTmpFile(markdownContent + 'x'.repeat(10000))

    // Mark it as already read this session
    recordFileRead(normalizePath(p))

    // Get the stat count before the re-read
    const before = summarize(30).by_kind['session_hint']?.events ?? 0

    // Attempt to re-read the file — this should trigger the heading-tree deny branch
    const result = preReadHandler(readEvent(p))

    // Verify it's a deny
    expect(result.hookType).toBe('deny')

    // Verify the stat was recorded (it should have incremented)
    const after = summarize(30).by_kind['session_hint']?.events ?? 0
    expect(after).toBe(before + 1)
  })
})
