/** Guard against the OEM-code-page class. Windows PowerShell 5.1 writes a pipe in the console's OEM code page unless the script sets [Console]::OutputEncoding, so a launcher path with an accented or non-Latin character came back as 0x82 or '?' from the process query and never matched the install it named (an under-kill of a worker, a stray not listed). src/windows_powershell.ts::powerShellTextQueryArgs carries the encoding prefix. This scan matches by shape, not by name: it scopes every src file that starts PowerShell by any route (a mention of powerShellCommandArgs under any alias, windowsPowerShellPath, resolvePowerShell, a literal powershell or pwsh string in a file that spawns, or a process cmdlet script) and fails one that neither imports powerShellTextQueryArgs from windows_powershell.js nor marks every such site with a reasoned exemption comment. Any mention of the bare builder outside shell.ts and windows_powershell.ts fails unless that site is marked. A spawn or exec call that names powershell or pwsh in any argument (a program, a string command, a cmd wrapper's script text) fails unless it builds its arguments with powerShellTextQueryArgs in the call or is marked, a hand-built -Command or -NoProfile literal fails in a file that starts PowerShell, and a star re-export of shell.ts fails. It proves what it scans: src files read as text, one line at a time, and not a PowerShell started through a name built at run time (a variable holding the executable, a path joined from parts). Provenance: HAND-DERIVED, the rule is read off the failure captured in tests/resident_process.test.ts (PowerShell 5.1.26100, code page 437, bytes 82 3f). */

// tg-no-regex-preload
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** The exemption a site carries when PowerShell's output is never read back as text by token-goat: `// tg-powershell-output-unread: <reason>`, on the site's own line or the line above, with a reason of at least 12 characters. */
const EXEMPTION = /\/\/\s*tg-powershell-output-unread:\s*(\S.{11,})$/

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

/** Whether the line at `index` carries an exemption, itself or on the line above. */
function isExempt(lines: readonly string[], index: number): boolean {
  return EXEMPTION.test(lines[index]?.trimEnd() ?? '') || EXEMPTION.test(lines[index - 1]?.trim() ?? '')
}

/** `code` without a literal compared against a value (`shellType === 'pwsh'`), which names a shell and starts none. */
function withoutComparisons(code: string): string {
  return code.replace(/[!=]==?\s*(['"`])(?:powershell|pwsh)(?:\.exe)?\1/g, '').replace(/(['"`])(?:powershell|pwsh)(?:\.exe)?\1\s*[!=]==?/g, '')
}

const BARE_BUILDER = /\bpowerShellCommandArgs\b/
const PATH_OR_RESOLVER = /\b(?:windowsPowerShellPath|resolvePowerShell)\b/
const LITERAL_EXE = /['"`](?:powershell|pwsh)(?:\.exe)?['"`]/
const LITERAL_EXE_ALONE = /^\s*['"`](?:powershell|pwsh)(?:\.exe)?['"`],?\s*$/
const LITERAL_EXE_ASSIGNED = /(?<![=!<>])=(?!=)\s*['"`](?:powershell|pwsh)(?:\.exe)?['"`]/

/** Whether the line hands a literal powershell or pwsh to a spawn call on the same line, holds it alone as an argument line, or assigns it to a name. A literal in a type union, a word list or a comparison names a shell and starts none. */
function isLiteralLaunch(code: string): boolean {
  return (SPAWN_CALL.test(code) && LITERAL_EXE.test(withoutComparisons(code))) || LITERAL_EXE_ALONE.test(code) || LITERAL_EXE_ASSIGNED.test(code)
}
const PROCESS_CMDLET = /\b(?:Get-CimInstance|Get-Process|Get-WmiObject)\b/
const SPAWN_CALL = /\b(?:spawn|spawnSync|spawnOwned|execSync|execFile|execFileSync)\s*\(|(?<![.\w])exec\s*\(|\b(?:cp|child_process|childProcess)\.exec\s*\(/
const TEXT_HELPER_IMPORT = /import\s*(?:type\s*)?\{[^}]*[{,]?\s*powerShellTextQueryArgs\s*(?:,|\})[^}]*\}\s*from\s*['"]\.\/windows_powershell\.js['"]/
const TEXT_HELPER_ALIASED = /\bas\s+powerShellTextQueryArgs\b/

const POWERSHELL_WORD = /\b(?:powershell|pwsh)(?:\.exe)?\b/i
const HAND_BUILT_ARGV = /['"`]-(?:Command|EncodedCommand|NoProfile|NonInteractive|File)['"`]/i
const STAR_REEXPORT_OF_SHELL = /\bexport\s*\*\s*(?:as\s+\w+\s*)?from\s*['"][^'"]*\/shell\.js['"]/
const CALL_LIMIT = 6000

interface Site {
  readonly line: string
  readonly exempt: boolean
  readonly bare: boolean
}

/** The code of `source` as lines with whole-line and trailing comments dropped, so a line keeps its number. */
function codeLines(source: string): string[] {
  return source.split(/\r?\n/).map(codeOf)
}

interface Call {
  readonly text: string
  readonly first: number
  readonly last: number
}

/** Every spawn or exec call in `lines` with its full argument text across lines, found by balancing parentheses outside string literals, and the zero-based first and last line it spans. A call whose parenthesis never closes within CALL_LIMIT characters runs to that limit. */
function spawnCalls(lines: readonly string[]): Call[] {
  const code = lines.join('\n')
  const calls: Call[] = []
  const lineAt = (offset: number): number => code.slice(0, offset).split('\n').length - 1
  for (const match of code.matchAll(new RegExp(SPAWN_CALL.source, 'g'))) {
    let depth = 0
    let quote = ''
    let end = Math.min(code.length, match.index + CALL_LIMIT)
    for (let at = match.index + match[0].length - 1; at < end; at++) {
      const char = code[at] ?? ''
      if (quote !== '') {
        if (char === '\\') at++
        else if (char === quote) quote = ''
      } else if (char === "'" || char === '"' || char === '`') quote = char
      else if (char === '(') depth++
      else if (char === ')' && --depth === 0) {
        end = at + 1
        break
      }
    }
    calls.push({ text: code.slice(match.index, end), first: lineAt(match.index), last: lineAt(end) })
  }
  return calls
}

/** Whether a spawn or exec call names PowerShell in any argument position, as a program, inside a shell wrapper's script text or in a command string, or reaches it through the path helper or the resolver. */
function callNamesPowerShell(call: Call): boolean {
  const text = withoutComparisons(call.text)
  return POWERSHELL_WORD.test(text) || PATH_OR_RESOLVER.test(text)
}

/** Every line of `source` that starts PowerShell by some route, with whether it names the bare builder and whether it carries an exemption. */
function powerShellSites(source: string): Site[] {
  const lines = source.split(/\r?\n/)
  const sites: Site[] = []
  lines.forEach((line, index) => {
    const code = codeOf(line)
    const bare = BARE_BUILDER.test(code)
    if (bare || PATH_OR_RESOLVER.test(code) || PROCESS_CMDLET.test(code) || isLiteralLaunch(code)) {
      sites.push({ line: line.trim(), exempt: isExempt(lines, index), bare })
    }
  })
  for (const call of spawnCalls(codeLines(source))) {
    if (callNamesPowerShell(call)) sites.push({ line: lines[call.first]?.trim() ?? '', exempt: isExempt(lines, call.first), bare: false })
  }
  return sites
}

/** What is wrong with `source` whatever the file: a spawn or exec call that names PowerShell and neither builds its arguments with powerShellTextQueryArgs in the call nor carries an exemption on any line it spans or the line above, and a star re-export of shell.ts, which hands out the bare builder under no name the line scan can see. */
function shapeViolations(source: string): string[] {
  const lines = source.split(/\r?\n/)
  const found: string[] = []
  for (const call of spawnCalls(codeLines(source))) {
    if (!callNamesPowerShell(call) || /\bpowerShellTextQueryArgs\(/.test(call.text)) continue
    const marked = Array.from({ length: call.last - call.first + 1 }, (_, offset) => call.first + offset).some((index) => isExempt(lines, index))
    if (!marked) found.push(`a spawn that names PowerShell without powerShellTextQueryArgs: ${lines[call.first]?.trim() ?? ''}`)
  }
  codeLines(source).forEach((code, index) => {
    if (STAR_REEXPORT_OF_SHELL.test(code) && !isExempt(lines, index)) found.push(`star re-export of the bare builder: ${lines[index]?.trim() ?? ''}`)
  })
  return found
}

/** What is wrong with `source` as a src file, or an empty list: a bare builder at an unmarked site, a hand-built PowerShell argument literal at an unmarked line, a shape violation, or a PowerShell route in a file that does not import powerShellTextQueryArgs from windows_powershell.js and call it. */
function violations(source: string): string[] {
  const sites = powerShellSites(source)
  const found = [...sites.filter((site) => site.bare && !site.exempt).map((site) => `bare builder: ${site.line}`), ...shapeViolations(source)]
  const lines = source.split(/\r?\n/)
  if (sites.length > 0) lines.forEach((line, index) => { if (HAND_BUILT_ARGV.test(codeOf(line)) && !isExempt(lines, index)) found.push(`hand-built PowerShell arguments: ${line.trim()}`) })
  const unmarked = sites.filter((site) => !site.exempt)
  if (unmarked.length === 0) return found
  const code = codeLines(source).join('\n')
  const imported = TEXT_HELPER_IMPORT.test(code) && !TEXT_HELPER_ALIASED.test(code)
  if (!imported) found.push(`no import of powerShellTextQueryArgs from ./windows_powershell.js for: ${unmarked[0]?.line ?? ''}`)
  else if (!/\bpowerShellTextQueryArgs\(/.test(code)) found.push('imports powerShellTextQueryArgs and never calls it')
  return found
}

/** Whether `source` starts PowerShell by any route, or re-exports the module that holds the bare builder. */
function startsPowerShell(source: string): boolean {
  return powerShellSites(source).length > 0 || codeLines(source).some((code) => STAR_REEXPORT_OF_SHELL.test(code))
}

describe('a PowerShell query for process text sets a UTF-8 output encoding', () => {
  // The population is files under src/ other than the tool filters and hint tables, whose cmdlet mentions are text they classify, and windows_powershell.ts and shell.ts, which define the helpers.
  const files = sourceFiles(SRC_DIR).filter((file) => !file.startsWith('tool_filters/') && !file.startsWith('hints/') && file !== 'windows_powershell.ts' && file !== 'shell.ts')
  const queryFiles = pinnedPopulation({
    what: 'src files that start PowerShell by any route',
    items: files.filter((file) => startsPowerShell(fs.readFileSync(path.join(SRC_DIR, file), 'utf8'))),
    floor: 3,
    mustIncludeExact: ['resident_process.ts', 'cli_doctor_process.ts', 'claude_hidden_rules.ts', 'bash_runner.ts'],
  })

  it('builds every such query through powerShellTextQueryArgs, or marks the site as one whose output is never read', () => {
    const wrong = queryFiles.flatMap((file) => violations(fs.readFileSync(path.join(SRC_DIR, file), 'utf8')).map((why) => `${file}: ${why}`))
    expect(wrong, 'a process query built with powerShellCommandArgs reads its output in the OEM code page; use powerShellTextQueryArgs, or mark the site with // tg-powershell-output-unread: <reason>').toEqual([])
  })

  // The shape rules reach every src file, the tool filters and hint tables too: a spawn is a spawn wherever it sits, and only the two files that define the helpers are left out.
  it('has no spawn that names PowerShell outside the helper, and no star re-export of shell.ts, in any src file', () => {
    const all = sourceFiles(SRC_DIR).filter((file) => file !== 'windows_powershell.ts' && file !== 'shell.ts')
    expect(all.length, 'the scan found too few src files to mean anything').toBeGreaterThan(200)
    const wrong = all.flatMap((file) => shapeViolations(fs.readFileSync(path.join(SRC_DIR, file), 'utf8')).map((why) => `${file}: ${why}`))
    expect(wrong, 'a spawn or exec call names PowerShell without building its arguments through powerShellTextQueryArgs; use it, or mark the call with // tg-powershell-output-unread: <reason>').toEqual([])
  })

  it('does not re-export the bare builder from windows_powershell.ts', () => {
    expect(fs.readFileSync(path.join(SRC_DIR, 'windows_powershell.ts'), 'utf8').split(/\r?\n/).map(codeOf).join('\n')).not.toMatch(/\bexport\s*\{[^}]*\bpowerShellCommandArgs\b[^}]*\}/)
  })
})

// Each shape here is one way a query was seen to slip past a name-matching scan; every one must be flagged, and the proper forms must pass.
describe('the scan flags every bypass shape and passes the proper forms', () => {
  const IMPORT_TEXT = "import { powerShellTextQueryArgs, windowsPowerShellPath } from './windows_powershell.js'\n"
  const SHAPES: ReadonlyArray<readonly [string, string]> = [
    ['an aliased bare builder under the helper name (the orchestrator mutant i)', "import { windowsPowerShellPath } from './windows_powershell.js'\nimport { powerShellCommandArgs as powerShellTextQueryArgs } from './shell.js'\nconst r = spawnSync(windowsPowerShellPath(), powerShellTextQueryArgs('x'))\n"],
    ['an aliased bare builder under another name', "import { powerShellCommandArgs as psArgs } from './shell.js'\nconst r = spawnSync('powershell.exe', psArgs('x'))\n"],
    ['a file that calls the helper once and the bare builder once', `${IMPORT_TEXT}import { powerShellCommandArgs } from './shell.js'\nspawnSync(windowsPowerShellPath(), powerShellTextQueryArgs('a'))\nspawnSync(windowsPowerShellPath(), powerShellCommandArgs('b'))\n`],
    ['a multi-line template script with another cmdlet', "import { windowsPowerShellPath } from './windows_powershell.js'\nconst script = `\n  Get-Service |\n  Select-Object Name\n`\nspawnSync(windowsPowerShellPath(), ['-Command', script])\n"],
    ['a literal powershell spawn with another cmdlet', "execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Service'])\n"],
    ['a literal pwsh spawn', "spawnSync('pwsh', ['-Command', 'x'])\n"],
    ['the resolvePowerShell route', "import { resolvePowerShell } from './shell.js'\nconst ps = resolvePowerShell()\nspawnSync(ps, ['-Command', 'x'])\n"],
    ['a namespace import of the bare builder', "import * as shell from './shell.js'\nspawnSync(windowsPowerShellPath(), shell.powerShellCommandArgs('x'))\n"],
    ['a helper import from the wrong module', "import { powerShellTextQueryArgs } from './shell.js'\nspawnSync(windowsPowerShellPath(), powerShellTextQueryArgs('x'))\n"],
    ['a helper import that is never called', `${IMPORT_TEXT}spawnSync(windowsPowerShellPath(), ['-Command', 'x'])\n`],
    ['a file that calls the helper once and spawns PowerShell with a hand-built argument array', `${IMPORT_TEXT}spawnSync(windowsPowerShellPath(), powerShellTextQueryArgs('a'))\nspawnSync(windowsPowerShellPath(), ['-Command', 'b'])\n`],
    ['a hand-built argument array handed to an executable held in a variable', `${IMPORT_TEXT}const file = windowsPowerShellPath()\nspawnSync(file, powerShellTextQueryArgs('a'))\nspawnSync(file, ['-NoProfile', '-Command', 'b'])\n`],
    ['a string command that names powershell', "execSync('powershell -NoProfile -Command \"x\"')\n"],
    ['a template string command that names pwsh', 'exec(`pwsh -c x`)\n'],
    ['a shell wrapper whose script text names powershell', "spawnSync('cmd', ['/c', 'powershell -Command x'])\n"],
    ['a spawn whose arguments span lines and name powershell after the executable', "spawnSync(\n  'cmd',\n  ['/d', '/c', 'powershell.exe -Command x'],\n  { windowsHide: true },\n)\n"],
    ['a file with a proper query that also runs a string command naming powershell', `${IMPORT_TEXT}spawnSync(windowsPowerShellPath(), powerShellTextQueryArgs('a'))\nexecSync('powershell -NoProfile -Command x')\n`],
    ['a file with a proper query that also runs a cmd wrapper naming powershell', `${IMPORT_TEXT}spawnSync(windowsPowerShellPath(), powerShellTextQueryArgs('a'))\nspawnSync('cmd', ['/c', 'powershell x'])\n`],
    ['the path helper handed arguments built by some other function', `${IMPORT_TEXT}spawnSync(windowsPowerShellPath(), powerShellTextQueryArgs('a'))\nspawnSync(windowsPowerShellPath(), buildArgs('b'))\n`],
    ['a star re-export of the module that defines the bare builder', "export * from './shell.js'\n"],
    ['a multi-line named re-export of the bare builder', "export {\n  powerShellCommandArgs,\n} from './shell.js'\n"],
  ]

  it.each(SHAPES)('flags %s', (_name, source) => {
    expect(startsPowerShell(source)).toBe(true)
    expect(violations(source)).not.toEqual([])
  })

  it('passes the proper form, a marked exemption on the line or the line above, and prose that only names the helpers', () => {
    expect(violations(`${IMPORT_TEXT}spawnSync(windowsPowerShellPath(), powerShellTextQueryArgs('x'))\n`)).toEqual([])
    expect(violations("import { resolvePowerShell, powerShellCommandArgs } from './shell.js' // tg-powershell-output-unread: runs the user's own command\n// tg-powershell-output-unread: runs the user's own command\nconst ps = resolvePowerShell()\nspawnSync(ps, powerShellCommandArgs('x')) // tg-powershell-output-unread: runs the user's own command\n")).toEqual([])
    expect(violations(`${IMPORT_TEXT}spawnSync(\n  windowsPowerShellPath(),\n  powerShellTextQueryArgs('x'),\n  { windowsHide: true },\n)\n`)).toEqual([])
    expect(violations("spawnSync('cmd', ['/c', 'powershell x']) // tg-powershell-output-unread: runs the user's own command\n")).toEqual([])
    expect(violations("// tg-powershell-output-unread: runs the user's own command\nexecSync('pwsh -c x')\n")).toEqual([])
    expect(startsPowerShell('// windowsPowerShellPath() and powerShellCommandArgs( in prose\n/** Get-Process */\n')).toBe(false)
  })

  it('rejects an exemption with no reason', () => {
    expect(violations("import { powerShellCommandArgs } from './shell.js' // tg-powershell-output-unread:\nspawnSync('pwsh', powerShellCommandArgs('x'))\n")).not.toEqual([])
  })
})
