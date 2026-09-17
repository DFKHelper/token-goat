import { describe, it, expect } from 'vitest'
import { extractShellBannerHeading, findShellBannerHeaders, readSection } from '../src/section_reader.js'
import { extractBash } from '../src/languages/bash_idx.js'

describe('Shell script heading comment banner detection & section extraction', () => {
  it('extracts heading titles from common procedural script banner formats', () => {
    expect(extractShellBannerHeading('## Pre-flight Checks')?.heading).toBe('Pre-flight Checks')
    expect(extractShellBannerHeading('### Detailed Step')?.heading).toBe('Detailed Step')
    expect(extractShellBannerHeading('# -- Check Git Status --')?.heading).toBe('Check Git Status')
    expect(extractShellBannerHeading('# === Phase 1: Linting ===')?.heading).toBe('Phase 1: Linting')
    expect(extractShellBannerHeading('# [1. Contract Check]')?.heading).toBe('1. Contract Check')
    expect(extractShellBannerHeading('# REGION: Validation Rules')?.heading).toBe('Validation Rules')
    expect(extractShellBannerHeading('# SECTION: Workspace Cleanup')?.heading).toBe('Workspace Cleanup')

    // Normal non-banner comments should return null
    expect(extractShellBannerHeading('#!/bin/bash')).toBeNull()
    expect(extractShellBannerHeading('# Just a regular single-line comment')).toBeNull()
    expect(extractShellBannerHeading('# SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"')).toBeNull()
  })

  it('finds shell banner headers in a procedural script', () => {
    const lines = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '',
      '# -- Setup Environment --',
      'ROOT="$(pwd)"',
      'FAIL=0',
      '',
      '## 1. Verify Contracts',
      'if [ ! -f "contract.json" ]; then',
      '  echo "Missing contract"',
      '  FAIL=1',
      'fi',
      '',
      '# [2. Clean Up]',
      'rm -rf /tmp/scratch',
    ]

    const headers = findShellBannerHeaders(lines)
    expect(headers.length).toBe(3)
    expect(headers[0]?.heading).toBe('Setup Environment')
    expect(headers[0]?.level).toBe(1)
    expect(headers[0]?.index).toBe(3)

    expect(headers[1]?.heading).toBe('1. Verify Contracts')
    expect(headers[1]?.level).toBe(2)
    expect(headers[1]?.index).toBe(7)

    expect(headers[2]?.heading).toBe('2. Clean Up')
    expect(headers[2]?.level).toBe(1)
    expect(headers[2]?.index).toBe(13)
  })

  it('reads sections by banner heading in a shell script', () => {
    const content = [
      '#!/usr/bin/env bash',
      '# -- Section A --',
      'echo "in A"',
      '# -- Section B --',
      'echo "in B 1"',
      'echo "in B 2"',
    ].join('\n')

    const resA = readSection('script.bash', 'Section A', () => content)
    expect(resA?.heading).toBe('Section A')
    expect(resA?.content).toContain('echo "in A"')
    expect(resA?.content).not.toContain('echo "in B 1"')

    const resB = readSection('script.bash', 'Section B', () => content)
    expect(resB?.heading).toBe('Section B')
    expect(resB?.content).toContain('echo "in B 1"')
    expect(resB?.content).toContain('echo "in B 2"')
  })

  it('extractBash extracts heading symbols with spans between banners', () => {
    const script = [
      '#!/usr/bin/env bash',
      'SCRIPT_DIR="/path"',
      '',
      '# -- Check Dependencies --',
      'command -v git >/dev/null || exit 1',
      '',
      '## Run Verification',
      'pytest tests/',
      '',
      'helper_fn() {',
      '  echo "helper"',
      '}',
    ].join('\n')

    const symbols = extractBash(script, 'tools/lint.sh')
    const headings = symbols.filter((s) => s.kind === 'heading')
    expect(headings.length).toBe(2)
    expect(headings[0]?.name).toBe('Check Dependencies')
    expect(headings[0]?.lineStart).toBe(4) // 1-based line 4
    expect(headings[0]?.lineEnd).toBe(6) // ends before line 7

    expect(headings[1]?.name).toBe('Run Verification')
    expect(headings[1]?.lineStart).toBe(7)
    expect(headings[1]?.lineEnd).toBe(9) // ends before helper_fn at line 10

    const fn = symbols.find((s) => s.name === 'helper_fn')
    expect(fn).toBeDefined()
    expect(fn?.kind).toBe('function')
  })
})
