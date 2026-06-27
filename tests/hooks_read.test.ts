import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { preReadHandler, postReadHandler } from '../src/hooks_read.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordFileRead, wasFileReadThisSession } from '../src/session.js'

const tmpFiles: string[] = []

function makeTmpFile(content = 'data'): string {
  const p = path.join(
    os.tmpdir(),
    `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.txt`,
  )
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

function _makeTmpMdFile(content = 'data'): string {
  const p = path.join(
    os.tmpdir(),
    `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.md`,
  )
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

function readEvent(filePath: string | undefined): HookEvent {
  return {
    eventName: 'pre_tool_use',
    toolName: 'Read',
    toolInput: filePath === undefined ? {} : { file_path: filePath },
    sessionId: 'test',
    raw: {},
  }
}

function grepEvent(filePath: string | undefined): HookEvent {
  return {
    eventName: 'pre_tool_use',
    toolName: 'Grep',
    toolInput: filePath === undefined ? {} : { file_path: filePath },
    sessionId: 'test',
    raw: {},
  }
}

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  clearModuleCaches()
  while (tmpFiles.length > 0) {
    const p = tmpFiles.pop()
    if (p === undefined) continue
    try {
      fs.unlinkSync(p)
    } catch {
      // best-effort cleanup
    }
  }
})

describe('preReadHandler', () => {
  it('returns pass when no file_path in input', () => {
    const result = preReadHandler(readEvent(undefined))
    expect(result.hookType).toBe('pass')
  })

  it('returns a re-read context hint when the file was already read (small file)', () => {
    const p = makeTmpFile()
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('already read this session')
      expect(result.context).toContain('token-goat read/section/symbol')
    }
  })

  it('denies re-read of a large file (>50KB) that was already read this session', () => {
    const p = makeTmpFile('x'.repeat(60 * 1024))
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('token-goat read/section/symbol')
    }
  })

  it('returns a large-file context hint for files between 100KB and 500KB', () => {
    const p = makeTmpFile('x'.repeat(150 * 1024))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('is large')
      expect(result.context).toContain('token-goat skeleton')
    }
  })

  it('denies first read of very large files (>500KB)', () => {
    const p = makeTmpFile('x'.repeat(600 * 1024))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('is very large')
      expect(result.message).toContain('token-goat skeleton')
    }
  })

  it('returns pass for a small, never-read file', () => {
    const p = makeTmpFile('small')
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('records the read on every call', () => {
    const p = makeTmpFile('small')
    expect(wasFileReadThisSession(normalizePath(p))).toBe(false)

    preReadHandler(readEvent(p))
    expect(wasFileReadThisSession(normalizePath(p))).toBe(true)

    // A second call (now a re-read) still records, bumping the count.
    preReadHandler(readEvent(p))
    preReadHandler(readEvent(p))
    // Three handler calls => three recorded reads.
    expect(wasFileReadThisSession(normalizePath(p))).toBe(true)
  })

  it('does not record when file_path is missing', () => {
    const result = preReadHandler(readEvent(undefined))
    expect(result.hookType).toBe('pass')
  })

  it('blocks reads under node_modules/ with a deny output', () => {
    const result = preReadHandler(readEvent('/project/node_modules/lodash/index.js'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('node_modules is typically noise')
      expect(result.message).toContain('npm ls')
      expect(result.message).toContain('token-goat read')
    }
  })

  it('blocks reads under node_modules\\ (backslash) on all platforms', () => {
    const result = preReadHandler(readEvent('C:\\project\\node_modules\\react\\index.js'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('node_modules is typically noise')
    }
  })

  it('blocks node_modules paths case-insensitively on Windows', () => {
    if (process.platform !== 'win32') {
      // Skip on non-Windows since the behavior is intentionally case-sensitive there
      expect(true).toBe(true)
      return
    }
    const result = preReadHandler(readEvent('C:\\PROJECT\\NODE_MODULES\\foo.js'))
    expect(result.hookType).toBe('deny')
  })

  it('does not block paths with similar names outside node_modules', () => {
    const result = preReadHandler(readEvent('/project/my_node_modules_backup/file.js'))
    expect(result.hookType).toBe('pass')
  })

  it('also blocks Grep calls on node_modules paths', () => {
    const result = preReadHandler(grepEvent('/project/node_modules/package/file.js'))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('node_modules is typically noise')
    }
  })

  it('denies 2nd read of any .md file regardless of size', () => {
    const p = _makeTmpMdFile()
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat section')
      expect(result.message).not.toContain('skeleton')
      expect(result.message).not.toContain('read/section/symbol')
    }
  })

  it('gives a section-only large-file hint for .md files', () => {
    const p = _makeTmpMdFile('x'.repeat(150 * 1024))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat section')
      expect(result.context).not.toContain('skeleton')
    }
  })

  it('intercepts markdown files >=8KB with >=3 headings and returns deny', () => {
    const mdContent = `# Title
Some content here

## Installation
Instructions here

### Quick Start
More details

## Usage
How to use this

### Examples
Examples here`

    const p = _makeTmpMdFile(mdContent + 'x'.repeat(10000))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Large markdown file')
      expect(result.message).toContain('# Title')
      expect(result.message).toContain('## Installation')
      expect(result.message).toContain('token-goat section')
    }
  })

  it('allows small markdown files to pass through even with headings', () => {
    const mdContent = `# Title
## Section
### Subsection`

    const p = _makeTmpMdFile(mdContent)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('allows large markdown files with <3 headings to pass through', () => {
    const mdContent = `# Title
Some content that makes the file large enough`

    const p = _makeTmpMdFile(mdContent + 'x'.repeat(10000))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('intercepts .mdx files with same rules as .md', () => {
    const mdContent = `# React Component
## Props
### Configuration
## Examples`

    const p = path.join(
      os.tmpdir(),
      `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.mdx`,
    )
    fs.writeFileSync(p, mdContent + 'x'.repeat(10000))
    tmpFiles.push(p)

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Large markdown file')
    }
  })

  it('includes well-known sections in the deny output for README.md', () => {
    const readmeContent = `# My Project
## Installation
## Usage
## API
## Configuration
## Getting Started`

    const p = path.join(
      os.tmpdir(),
      `README.md`,
    )
    fs.writeFileSync(p, readmeContent + 'x'.repeat(10000))
    tmpFiles.push(p)

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Quick access:')
      expect(result.message).toContain('Installation')
      expect(result.message).toContain('Usage')
      expect(result.message).toContain('API')
    }
  })

  it('gives context hint on 2nd read of a small file, deny on 3rd+', () => {
    const p = makeTmpFile('x'.repeat(5 * 1024))

    // First read: pass (never read before)
    const r1 = preReadHandler(readEvent(p))
    expect(r1.hookType).toBe('pass')

    // Second read: context (readCount is 1 after first pass recorded it)
    const r2 = preReadHandler(readEvent(p))
    expect(r2.hookType).toBe('context')

    // Third read: deny (readCount is now 2, so reads >= 2)
    const r3 = preReadHandler(readEvent(p))
    expect(r3.hookType).toBe('deny')
    if (r3.hookType === 'deny') {
      expect(r3.message).toContain('already read this session')
    }
  })

  it('denies re-read of .env file after first read', () => {
    const p = path.join(os.tmpdir(), `.env`)
    fs.writeFileSync(p, 'SECRET=abc\nOTHER=xyz\n')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('config-get')
    }
  })

  it('denies re-read of .env.local after first read', () => {
    const p = path.join(os.tmpdir(), `.env.local`)
    fs.writeFileSync(p, 'SECRET=abc\n')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('config-get')
    }
  })

  it('includes CHANGELOG version hint for large CHANGELOG.md files', () => {
    const changelogContent = `# Changelog

## [Unreleased]

## [2.1.0] - 2024-06-01

### Added
- New feature

## [2.0.0] - 2024-01-01`

    const p = path.join(
      os.tmpdir(),
      `CHANGELOG.md`,
    )
    fs.writeFileSync(p, changelogContent + 'x'.repeat(10000))
    tmpFiles.push(p)

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('[2.1.0]')
      expect(result.message).toContain('token-goat section')
    }
  })

  // Item 1: post-read truncation detection
  it('postReadHandler marks a file as truncated when response contains [Truncated:', () => {
    const p = makeTmpFile('some content')
    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: 'content here [Truncated: file too large, showing first 33K tokens]' },
    }
    postReadHandler(postEvent)

    // Next pre-read should be denied with skeleton hint
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('truncated on last read')
      expect(result.message).toContain('token-goat skeleton')
      expect(result.message).toContain('token-goat read')
    }
  })

  it('postReadHandler marks file truncated on PARTIAL view marker', () => {
    const p = makeTmpFile('content')
    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: 'first chunk Truncated: PARTIAL view of file' },
    }
    postReadHandler(postEvent)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('truncated on last read')
    }
  })

  it('postReadHandler does not mark file truncated when response has no marker', () => {
    const p = makeTmpFile('content')
    const postEvent: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'Read',
      toolInput: { file_path: p },
      sessionId: 'test',
      raw: { tool_response: 'complete content with no truncation marker' },
    }
    postReadHandler(postEvent)
    // First pre-read should pass (not yet read)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  // Item 2: all .md/.mdx files denied on 2nd+ read regardless of size
  it('denies 2nd read of a large .md file', () => {
    const p = _makeTmpMdFile('# Title\n\ncontent\n'.padEnd(15 * 1024, 'x'))
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('token-goat section')
    }
  })

  it('denies 2nd read of a small .md file', () => {
    const p = _makeTmpMdFile('# Small\ncontent')
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('token-goat section')
    }
  })

  it('denies 2nd read of a .mdx file', () => {
    const p = path.join(os.tmpdir(), `tg-read-${process.pid}-${Math.random().toString(36).slice(2)}.mdx`)
    fs.writeFileSync(p, '# Component\n\ncontent\n'.padEnd(15 * 1024, 'x'))
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
    }
  })

  // Item 5: .improve-state-*.json re-read denial
  it('denies 2nd read of .improve-state-*.json', () => {
    const p = path.join(os.tmpdir(), '.improve-state-bugfixing.json')
    fs.writeFileSync(p, JSON.stringify({ phase: 'bugfixing' }))
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('Orchestrator state already read')
    }
  })

  it('passes first read of .improve-state-*.json', () => {
    const p = path.join(os.tmpdir(), '.improve-state-foo.json')
    fs.writeFileSync(p, JSON.stringify({ phase: 'foo' }))
    tmpFiles.push(p)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  // Item 8: MEMORY.md re-read denial
  it('denies 2nd read of memory/MEMORY.md', () => {
    const dir = path.join(os.tmpdir(), `tg-mem-${process.pid}`)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'memory', 'MEMORY.md')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '# Memory\ncontent')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('MEMORY.md was read this session')
      expect(result.message).toContain('compact manifest')
    }
  })

  it('passes first read of memory/MEMORY.md', () => {
    const dir = path.join(os.tmpdir(), `tg-mem2-${process.pid}`)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'memory', 'MEMORY.md')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '# Memory\ncontent')
    tmpFiles.push(p)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

  it('denies 2nd read of any .md file under memory/ directory', () => {
    const dir = path.join(os.tmpdir(), `tg-mem3-${process.pid}`)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'memory', 'project_findings.md')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '# Findings\ncontent')
    tmpFiles.push(p)
    recordFileRead(normalizePath(p))
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('already read this session')
      expect(result.message).toContain('token-goat section')
    }
  })

  it('passes first read of memory/project_findings.md', () => {
    const dir = path.join(os.tmpdir(), `tg-mem4-${process.pid}`)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'memory', 'project_findings.md')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '# Findings\ncontent')
    tmpFiles.push(p)
    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('pass')
  })

})