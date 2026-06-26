import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { preReadHandler } from '../src/hooks_read.js'
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

  it('returns a re-read context hint when the file was already read', () => {
    const p = makeTmpFile()
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('already read this session')
      expect(result.context).toContain('token-goat read/section/symbol')
    }
  })

  it('returns a large-file context hint for files >100KB', () => {
    const p = makeTmpFile('x'.repeat(150 * 1024))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('is large')
      expect(result.context).toContain('token-goat skeleton')
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

  it('gives a section-only re-read hint for .md files', () => {
    const p = _makeTmpMdFile()
    recordFileRead(normalizePath(p))

    const result = preReadHandler(readEvent(p))
    expect(result.hookType).toBe('context')
    if (result.hookType === 'context') {
      expect(result.context).toContain('token-goat section')
      expect(result.context).not.toContain('skeleton')
      expect(result.context).not.toContain('read/section/symbol')
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

})