/** Guard against the OEM-code-page class. Windows PowerShell 5.1 writes a pipe in the console's OEM code page unless the script sets [Console]::OutputEncoding, so a launcher path with an accented or non-Latin character came back as 0x82 or '?' from the process query and never matched the install it named (an under-kill of a worker, a stray not listed). src/windows_powershell.ts::powerShellTextQueryArgs carries the encoding prefix; this scan fails a source file that runs a PowerShell query for process text (it starts the executable windowsPowerShellPath() names, or holds a Get-CimInstance, Get-Process or Get-WmiObject script) and builds its arguments any other way. A query whose output is never read back as text does not exist in src today, and a file that runs a user's command (src/bash_runner.ts, through resolvePowerShell) is not a query and is not in the population. Provenance: HAND-DERIVED, the rule is read off the failure captured in tests/resident_process.test.ts (PowerShell 5.1.26100, code page 437, bytes 82 3f). */

// tg-no-regex-preload
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** Every `.ts` file under `dir` as a path relative to src, with `/` separators. */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(child)
    return child.endsWith('.ts') ? [path.relative(SRC_DIR, child).split(path.sep).join('/')] : []
  })
}

/** The code half of a line: a whole-line comment is dropped and a trailing `//` comment is cut off, so prose that names a cmdlet or a helper never matches. */
function codeOf(line: string): string {
  const trimmed = line.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
  const at = line.search(/\s\/\/\s/)
  return at === -1 ? line : line.slice(0, at)
}

/** Whether `source` runs a PowerShell query for process text: it calls windowsPowerShellPath(), or a script line names a process cmdlet inside a string. */
function runsProcessQuery(source: string): boolean {
  return source.split(/\r?\n/).some((line) => {
    const code = codeOf(line)
    return /\bwindowsPowerShellPath\(/.test(code) || /['"`][^'"`]*\b(?:Get-CimInstance|Get-Process|Get-WmiObject)\b/.test(code)
  })
}

/** The lines of `source` that build PowerShell arguments with the bare helper, which sets no output encoding. */
function bareArgumentLines(source: string): string[] {
  return source.split(/\r?\n/).filter((line) => /\bpowerShellCommandArgs\(/.test(codeOf(line)))
}

describe('a PowerShell query for process text sets a UTF-8 output encoding', () => {
  // The population is files under src/ other than the tool filters and hint tables, whose Get-CimInstance mentions are text they classify, and windows_powershell.ts and shell.ts, which define the helpers.
  const files = sourceFiles(SRC_DIR).filter((file) => !file.startsWith('tool_filters/') && !file.startsWith('hints/') && file !== 'windows_powershell.ts' && file !== 'shell.ts')
  const queryFiles = pinnedPopulation({
    what: 'src files that run a PowerShell query for process text',
    items: files.filter((file) => runsProcessQuery(fs.readFileSync(path.join(SRC_DIR, file), 'utf8'))),
    floor: 3,
    mustIncludeExact: ['resident_process.ts', 'cli_doctor_process.ts', 'claude_hidden_rules.ts'],
  })

  it('builds every such query through powerShellTextQueryArgs', () => {
    const bare = queryFiles.flatMap((file) => bareArgumentLines(fs.readFileSync(path.join(SRC_DIR, file), 'utf8')).map((line) => `${file}: ${line.trim()}`))
    expect(bare, 'a process query built with powerShellCommandArgs reads its output in the OEM code page; use powerShellTextQueryArgs').toEqual([])
  })

  it('uses the helper at each of those files', () => {
    const without = queryFiles.filter((file) => !/\bpowerShellTextQueryArgs\(/.test(fs.readFileSync(path.join(SRC_DIR, file), 'utf8')))
    expect(without, 'a file that runs a PowerShell process query never calls powerShellTextQueryArgs').toEqual([])
  })
})
