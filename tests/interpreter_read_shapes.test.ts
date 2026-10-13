// Which inline Python commands the Bash hook treats as a file read into the conversation, and what it does where the capped run cannot ship. CAPTURE (session transcripts 2026-08 to 2026-10): 16 refusals of Python `open()` reads, the suggested command run 0 times and 13 routed around; three were a compound command whose quoted heredoc writes a script (`python other.py && cat > x.py <<'EOF' ... open('data.json') ... EOF` then `python x.py`), and one, in a bypassPermissions session, was `python -I -c "...open(sys.argv[1])..." "<file>" > "<out.md>"`, whose output went to a file, refused with `token-goat grep "<pattern>" ...`. The commands below are HAND-DERIVED to those shapes with the paths shortened.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { extractPythonFileRead, pythonReadFeedsParser } from '../src/bash_extractors.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { clearModuleCaches } from '../src/reset.js'
import type { HookOutput } from '../src/types.js'
import { makeHookEvent } from './helpers/hook-event.js'

type Mode = 'default' | 'bypassPermissions' | 'auto'
let seq = 0

function bash(command: string, mode: Mode): HookOutput {
  seq += 1
  return preBashHandler(makeHookEvent({ toolName: 'Bash', toolInput: { command }, sessionId: `interp-shapes-${seq}`, raw: { permission_mode: mode } }))
}

const SCRIPT_WRITTEN_THEN_RUN = "python a.py && cat > b.py <<'EOF'\nimport json\nd = json.load(open('d.json'))\nprint(len(d['rows']))\nEOF\npython b.py"
const SCRIPT_WRITTEN_AND_RUN_ON_ONE_LINE = "cd tools && python a.py && cat > b.py <<'EOF' && python b.py\nimport json\nprint(json.load(open('d.json'))['rows'][0])\nEOF"
const ARGV_READ_TO_FILE = `python -I -c "import sys; print(open(sys.argv[1], encoding='utf-8').read())" "notes.txt" > "out.md"`
const PARSED = `python -c "import json; d = json.load(open('d.json')); print(len(d['rows']))"`
const PRINTED = `python -c "print(open('d.json').read())"`

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  delete process.env['TOKEN_GOAT_BASH_COMPRESS']
  clearModuleCaches()
})

describe('a compound command whose heredoc writes a script', () => {
  it.each(['default', 'bypassPermissions'] as const)('is neither refused nor rewritten in %s mode', (mode) => {
    expect(bash(SCRIPT_WRITTEN_THEN_RUN, mode).hookType).toBe('pass')
    expect(bash(SCRIPT_WRITTEN_AND_RUN_ON_ONE_LINE, mode).hookType).toBe('pass')
  })

  it('reads no file out of a heredoc fed to anything but a Python reading its program from stdin', () => {
    expect(extractPythonFileRead(SCRIPT_WRITTEN_THEN_RUN)).toBeNull()
    expect(extractPythonFileRead("python run.py <<'EOF'\nopen('d.json') is data here\nEOF")).toBeNull()
  })

  it('still reads the heredoc a Python runs, and a later Python segment of the same command', () => {
    expect(extractPythonFileRead("python - <<'PY'\nprint(open('d.json').read())\nPY")?.filePath).toBe('d.json')
    expect(extractPythonFileRead("python3 -u <<PY\nprint(open('d.json').read())\nPY\necho done")?.filePath).toBe('d.json')
    expect(extractPythonFileRead(`python a.py && python -c "print(open('d.json').read())"`)?.filePath).toBe('d.json')
  })
})

describe('a Python read whose output goes to a file', () => {
  it.each(['default', 'bypassPermissions'] as const)('is neither refused nor rewritten in %s mode', (mode) => {
    expect(bash(ARGV_READ_TO_FILE, mode).hookType).toBe('pass')
    expect(bash(`python - <<'PY' >> log.txt\nprint(open('d.json').read())\nPY`, mode).hookType).toBe('pass')
  })

  it('still counts when only another stream is redirected, or the target is a standard stream', () => {
    expect(extractPythonFileRead(`python -c "print(open('d.json').read())" 2> err.log`)?.filePath).toBe('d.json')
    expect(extractPythonFileRead(`python -c "print(open('d.json').read())" > /dev/stdout`)?.filePath).toBe('d.json')
    expect(extractPythonFileRead(`python -c "print(open('d.json').read())" 2>&1 | head -5`)?.filePath).toBe('d.json')
    expect(extractPythonFileRead(`python -c "print(open('d.json').read() > '')"`)?.filePath).toBe('d.json')
  })

  it('without the redirect, the same command is a read', () => {
    expect(extractPythonFileRead(ARGV_READ_TO_FILE.replace(' > "out.md"', ''))?.filePath).toBe('notes.txt')
  })
})

describe('where the capped run cannot ship', () => {
  it('a read that parses the file gets advice and runs, in auto mode', () => {
    const out = bash(PARSED, 'auto')
    expect(out.hookType).toBe('context')
    if (out.hookType === 'context') expect(out.context).toContain('token-goat json-outline "d.json"')
    expect(bash(`python -c "import yaml; print(yaml.safe_load(open('c.yaml'))['jobs'])"`, 'auto').hookType).toBe('context')
  })

  it('a read that parses the file gets advice and runs when compression is switched off', () => {
    process.env['TOKEN_GOAT_BASH_COMPRESS'] = '0'
    expect(bash(PARSED, 'default').hookType).toBe('context')
  })

  it('a read that prints the raw file is still refused', () => {
    const out = bash(PRINTED, 'auto')
    expect(out.hookType).toBe('deny')
    if (out.hookType === 'deny') expect(out.message).toContain('Python `open()` file reads bypass read hooks.')
  })

  it('a parsing read still runs under the cap where the capped run can ship', () => {
    const out = bash(PARSED, 'default')
    expect(out.hookType).toBe('rewriteInput')
    if (out.hookType === 'rewriteInput') expect(String(out.updatedInput['command'])).toContain(' -f passthrough ')
  })

  it('names a command that runs as printed for a .txt file, never a grep for `<pattern>`', () => {
    const out = bash(`python -c "print(open('notes.txt').read())"`, 'auto')
    expect(out.hookType).toBe('deny')
    if (out.hookType === 'deny') {
      expect(out.message).toContain('token-goat read "notes.txt::1-80"')
      expect(out.message).not.toContain('<pattern>')
    }
  })
})

describe('pythonReadFeedsParser', () => {
  it.each([
    "import json; d = json.load(open('d.json')); print(d['a'])",
    "import json; print(json.loads(open('d.json').read())['a'])",
    "import csv\nwith open('t.txt') as f:\n    rows = list(csv.DictReader(f))\nprint(len(rows))",
    "import yaml; print(yaml.safe_load(open('c.yaml'))['jobs'])",
    "from openpyxl import load_workbook; print(load_workbook('b.xlsx').sheetnames)",
    "import pandas as pd; print(pd.read_json('d.json').shape)",
  ])('is true for a parse: %s', (snippet) => {
    expect(pythonReadFeedsParser(snippet)).toBe(true)
  })

  it.each([
    "print(open('d.json').read())",
    "import json; print(open('d.json').read()); json.loads('{}')",
    "import json\nwith open('d.json') as f:\n    for line in f:\n        print(line)\njson.loads('{}')",
    "import json\nfor line in open('d.json'):\n    print(line)\njson.loads('{}')",
    "print(len(open('d.json').read()))",
  ])('is false for a read of the raw text: %s', (snippet) => {
    expect(pythonReadFeedsParser(snippet)).toBe(false)
  })
})
