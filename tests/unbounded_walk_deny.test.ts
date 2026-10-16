// Provenance: the first positive command is a CAPTURE from this machine -- an agent's shell tool ran `find / -name modernize-uplift.md -not -path */node_modules/*`, the shell timed out and was killed, and the find survived as an orphan that kept walking the disk (the incident this rule answers; about 90 CPU-hours across sessions). Every other command string is HAND-DERIVED from the rule's own definition of a root start path and a depth bound, and from the documented option spellings of each tool (GNU findutils `-maxdepth`, fd `-d`/`--max-depth`, ripgrep `--max-depth`, du `-d`/`-s`, tree `-L`, PowerShell `Get-ChildItem -Recurse -Depth`, cmd `dir /s`, `findstr /s`); none is a wire-format claim. The hook payload envelopes (claudePayload, copilotPayload) are HAND-DERIVED inline objects: the Claude Code one uses the field names of https://code.claude.com/docs/en/hooks.md, and the Copilot one is the event after the shim in src/bridges/copilot_cli.ts has renamed its tool to Bash; no wire-format claim rests on either.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preBashHandler } from '../src/hooks_bash.js'
import { relayInProcess } from '../src/relay.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { detectUnboundedWalk, type WalkContext } from '../src/unbounded_walk.js'
import { invalidateConfigCache } from '../src/config.js'

const POSIX: WalkContext = { windows: false, powershell: false }
const GIT_BASH_ON_WINDOWS: WalkContext = { windows: true, powershell: false }
const POWERSHELL: WalkContext = { windows: true, powershell: true }

const CAPTURED = 'find / -name modernize-uplift.md -not -path */node_modules/*'

function form(command: string, ctx: WalkContext): string | null {
  return detectUnboundedWalk(command, ctx)?.form ?? null
}

describe('detectUnboundedWalk -- POSIX find', () => {
  it.each([
    [CAPTURED],
    ['find / -type f'],
    ['find /c -name x'],
    ['find /c/ -name x'],
    ['find /mnt/c -name x'],
    ['find /mnt/c/ -name x'],
    ['find C:/ -name x'],
    ['find C:\\ -name x'],
    ['find C: -name x'],
    ['find ~ -name x'],
    ['find ~/ -name x'],
    ['find $HOME -name x'],
    ['find ${HOME} -name x'],
    ['find "$HOME" -name x'],
    ['find / /tmp -name x'],
    ['find -L / -name x'],
    ['cd /tmp && find / -name x'],
    ['find / -name x | head -5'],
    ['echo start; find ~ -type f'],
    ['(find / -name x)'],
    ['ls || find / -name x'],
    ['sudo find / -name x'],
    ['timeout 30 find / -name x'],
    ['nice -n 10 find / -name x'],
    ['env LC_ALL=C find / -name x'],
    ['bash -c "find / -name x"'],
    ['/usr/bin/find / -name x'],
    ['"C:/Program Files/Git/usr/bin/find.exe" / -name x'],
    ['find / -name x\nls'],
    ['cat <<EOF > a.sh\nok\nEOF\nfind / -name x'],
    ['echo $(find / -name x)'],
  ])('refuses %s', (command) => {
    expect(form(command, POSIX)).toBe('find')
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBe('find')
  })

  it.each([
    ['find . -name x'],
    ['find src -type f'],
    ['find /tmp -name x'],
    ['find /var/log -name x'],
    ['find /c/Users/me/project -name x'],
    ['find ~/project -name x'],
    ['find $HOME/project -name x'],
    ['find / -maxdepth 2 -name x'],
    ['find / -name x -maxdepth 3'],
    ['find ~ -maxdepth 1'],
    ['find C:/ -maxdepth 1 -name x'],
    ['echo "find / -name x"'],
    ["echo 'find ~ -type f'"],
    ['grep "find / -name" notes.txt'],
    ['git log --grep="find /"'],
    ['fd x src'],
    ['finder / -name x'],
    ['rm -rf ./find /'],
    ['cat <<EOF > notes.sh\nfind / -name x\nEOF'],
    ["cat <<'EOF'\nfind ~ -type f\nEOF\nls"],
    ['cat <<-END\n\tfind / -name x\n\tEND'],
    ['cat <<< "find / -name x"'],
  ])('lets %s through', (command) => {
    expect(form(command, POSIX)).toBeNull()
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBeNull()
  })
})

// Provenance: every command string below is HAND-DERIVED from shell semantics (`cd` changes the directory of the commands after it in the same shell, a `( ... )` subshell or a pipeline stage does not leak it) and from the same root definition as the tests above; the path-less and `.`-relative starts are the ones POSIX find resolves against the working directory. None is a wire-format claim.
describe('detectUnboundedWalk -- find after a cd to a root or the home directory', () => {
  it.each([
    ['cd / && find . -name x'],
    ['cd / && find -name x'],
    ['cd / && find'],
    ['cd / && find ./x -name y'],
    ['cd / && find .'],
    ['cd / ; find . -name x'],
    ['cd / || find . -name x'],
    ['cd /\nfind . -name x'],
    ['cd ~ && find . -name x'],
    ['cd && find . -name x'],
    ['cd $HOME && find . -name x'],
    ['cd "$HOME" && find . -name x'],
    ['cd ${HOME}/ && find . -name x'],
    ['cd C:/ && find . -name x'],
    ['cd C:\\ && find . -name x'],
    ['cd /c && find . -name x'],
    ['cd /mnt/c && find . -name x'],
    ['cd -P / && find . -name x'],
    ['cd -- / && find . -name x'],
    ['pushd / && find . -name x'],
    ['pushd ~ && find . -name x'],
    ['(cd / && find .)'],
    ['(cd / && find . -name x) | head -5'],
    ['echo a; (cd / && find . -name x)'],
    ['cd /tmp && cd / && find . -name x'],
    ['cd /tmp; (cd /proj); cd / && find . -name x'],
    ['cd / && (find . -name x)'],
    ['cd / && echo a | find . -name x'],
    ['cd / && sudo find . -name x'],
    ['cd / && timeout 30 find . -name x'],
    ['cd / && echo ok && find . -name x'],
    ['cd / && bash -c "find . -name x"'],
    ['bash -c "cd / && find . -name x"'],
    ['if cd /; then find . -name x; fi'],
    ['cd / && cd .. && find . -name x'],
    ['cd /\r\nfind . -name x'],
  ])('refuses %s', (command) => {
    expect(form(command, POSIX)).toBe('find')
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBe('find')
  })

  it.each([
    ['cd / && find . -maxdepth 2 -name x'],
    ['cd / && find . -name x -maxdepth 2'],
    ['cd ~ && find . -maxdepth 1'],
    ['cd /proj && find . -name x'],
    ['cd /tmp && find'],
    ['cd ~/project && find . -name x'],
    ['cd $HOME/project && find . -name x'],
    ['cd src && find . -name x'],
    ['find . -name x'],
    ['find'],
    ['cd / && cd tmp && find . -name x'],
    ['cd / && cd /proj && find . -name x'],
    ['cd / && cd - && find . -name x'],
    ['cd / && popd && find . -name x'],
    ['cd / && cd ~/p && find . -name x'],
    ['(cd / && ls); find . -name x'],
    ['(cd /); find . -name x'],
    ['(cd /) && find . -name x'],
    ['cd / | cat; find . -name x'],
    ['cd / & find . -name x'],
    ['echo a | cd /; find . -name x'],
    ['cd /proj; (cd /; ls); find . -name x'],
    ['cd / && find src -name x'],
    ['cd / && find /proj -name x'],
    ['cd / && echo "find . -name x"'],
    ['cd / && ls'],
    ['cd / && bash -c "cd /proj && find . -name x"'],
    ['echo cd / && find . -name x'],
  ])('lets %s through', (command) => {
    expect(form(command, POSIX)).toBeNull()
    expect(form(command, GIT_BASH_ON_WINDOWS)).toBeNull()
  })

  it('gives the same reason as a find that names the root', () => {
    expect(detectUnboundedWalk('cd / && find . -name x', POSIX)?.message).toBe(detectUnboundedWalk('find / -name x', POSIX)?.message)
  })
})

describe('detectUnboundedWalk -- telling Git find from Windows find.exe', () => {
  it('lets the Windows text search through when it has something to read', () => {
    for (const command of ['find "text" file.txt', 'find /i "x" f', 'find /c "x" f', 'find /v "x" f', 'dir | find "x"', 'type f.txt | find /i "x"', 'find "x" < f.txt']) {
      expect(form(command, POWERSHELL)).toBeNull()
      expect(form(command, GIT_BASH_ON_WINDOWS)).toBeNull()
    }
  })

  it('reads a slash option as an option, not as a path, unless a POSIX primary shows it is Git find', () => {
    expect(form('find /c "x" f', POWERSHELL)).toBeNull()
    expect(form('find /c -name x', POWERSHELL)).toBe('find')
    expect(form('find /i "x" f', POWERSHELL)).toBeNull()
  })

  it('refuses the Windows text search that would wait on standard input', () => {
    for (const command of ['find "text"', 'find /i "x"', 'find /v /i "x"', 'C:\\Windows\\System32\\find.exe "x"', 'find.exe "x"']) {
      expect(form(command, POWERSHELL)).toBe('find-stdin')
    }
    expect(form('C:\\Windows\\System32\\find.exe /i "x"', GIT_BASH_ON_WINDOWS)).toBe('find-stdin')
    expect(form('dir && find "x"', POWERSHELL)).toBe('find-stdin')
  })

  it('leaves a bare find alone where it is Git find, not the Windows one', () => {
    expect(form('find "text"', GIT_BASH_ON_WINDOWS)).toBeNull()
    expect(form('find "text"', POSIX)).toBeNull()
  })

  it('refuses Git find by full path or as find.exe with a root start', () => {
    expect(form('"C:/Program Files/Git/usr/bin/find.exe" C:/ -name x', POWERSHELL)).toBe('find')
    expect(form('find.exe / -name x', GIT_BASH_ON_WINDOWS)).toBe('find')
    expect(form('find.exe C:/ -name x', POWERSHELL)).toBe('find')
  })
})

describe('detectUnboundedWalk -- other recursive tools', () => {
  it.each([
    ['fd x /', 'fd'],
    ['fd -t f x ~', 'fd'],
    ['fdfind x /', 'fd'],
    ['fd . /', 'fd'],
    ['fd --search-path / x', 'fd'],
    ['rg --files /', 'rg'],
    ['rg --files ~', 'rg'],
    ['rg foo /', 'rg'],
    ['rg -n foo C:/', 'rg'],
    ['rg -g "*.ts" foo $HOME', 'rg'],
    ['grep -r foo /', 'grep'],
    ['grep -rn foo ~', 'grep'],
    ['grep -R foo /', 'grep'],
    ['grep --recursive foo /', 'grep'],
    ['grep -e foo -r /', 'grep'],
    ['ls -R /', 'ls'],
    ['ls -lR ~', 'ls'],
    ['du /', 'du'],
    ['du -h ~', 'du'],
    ['tree /', 'tree'],
    ['tree -a ~', 'tree'],
  ])('refuses %s', (command, expected) => {
    expect(form(command, POSIX)).toBe(expected)
  })

  it.each([
    ['fd x src'],
    ['fd -d 2 x /'],
    ['fd --max-depth 2 x /'],
    ['fd --max-depth=2 x ~'],
    ['rg foo src'],
    ['rg foo'],
    ['rg --files src'],
    ['rg --max-depth 2 foo /'],
    ['rg --files --max-depth 1 ~'],
    ['rg -d 2 foo /'],
    ['rg -d2 foo /'],
    ['rg -d 1 --files /'],
    ['rg -d2 --files ~'],
    ['rg / src'],
    ['rg -g "*.ts" foo src'],
    ['grep foo /etc/hosts'],
    ['grep -r foo src'],
    ['grep -r foo .'],
    ['grep foo /'],
    ['ls /'],
    ['ls -la ~'],
    ['ls -R src'],
    ['du -sh /'],
    ['du -d 1 /'],
    ['du --max-depth=1 ~'],
    ['du -h src'],
    ['tree -L 2 /'],
    ['tree src'],
    ['tree'],
  ])('lets %s through', (command) => {
    expect(form(command, POSIX)).toBeNull()
  })

  it('still refuses rg from a root when no depth flag is given, and does not take a depth value for a path', () => {
    expect(form('rg foo /', POSIX)).toBe('rg')
    expect(form('rg -n foo /', POSIX)).toBe('rg')
    expect(form('rg -d 2 foo', POSIX)).toBeNull()
  })

  it('does not take the pattern for a start path', () => {
    expect(form('rg / src', POSIX)).toBeNull()
    expect(form('grep -r / src', POSIX)).toBeNull()
  })
})

describe('detectUnboundedWalk -- Windows listing forms', () => {
  it.each([
    ['dir /s C:\\', GIT_BASH_ON_WINDOWS, 'dir'],
    ['dir /s /b C:\\', GIT_BASH_ON_WINDOWS, 'dir'],
    ['dir C:\\*.log /s', GIT_BASH_ON_WINDOWS, 'dir'],
    ['dir /s ~', GIT_BASH_ON_WINDOWS, 'dir'],
    ['findstr /s foo C:\\*.txt', GIT_BASH_ON_WINDOWS, 'findstr'],
    ['findstr /s /i foo C:\\*.*', GIT_BASH_ON_WINDOWS, 'findstr'],
    ['findstr /s /d:C:\\ foo *.txt', GIT_BASH_ON_WINDOWS, 'findstr'],
    ['Get-ChildItem -Recurse C:\\', POWERSHELL, 'gci'],
    ['Get-ChildItem C:\\ -Recurse', POWERSHELL, 'gci'],
    ['Get-ChildItem -Path C:\\ -Recurse -Filter *.ts', POWERSHELL, 'gci'],
    ['gci -r ~', POWERSHELL, 'gci'],
    ['gci -Recurse $HOME', POWERSHELL, 'gci'],
    ['ls -r C:\\', POWERSHELL, 'gci'],
    ['dir -Recurse C:/', POWERSHELL, 'gci'],
    ['Get-ChildItem -Recurse C:\\ | Select-String foo', POWERSHELL, 'gci'],
  ] as const)('refuses %s', (command, ctx, expected) => {
    expect(form(command, ctx)).toBe(expected)
  })

  it.each([
    ['dir C:\\', GIT_BASH_ON_WINDOWS],
    ['dir /s src', GIT_BASH_ON_WINDOWS],
    ['dir /s C:\\Users\\me\\project', GIT_BASH_ON_WINDOWS],
    ['dir /b /s src\\*.ts', GIT_BASH_ON_WINDOWS],
    ['findstr /s foo src\\*.ts', GIT_BASH_ON_WINDOWS],
    ['findstr foo C:\\notes.txt', GIT_BASH_ON_WINDOWS],
    ['findstr /s foo *.ts', GIT_BASH_ON_WINDOWS],
    ['Get-ChildItem C:\\', POWERSHELL],
    ['Get-ChildItem -Recurse src', POWERSHELL],
    ['Get-ChildItem -Recurse C:\\ -Depth 2', POWERSHELL],
    ['gci -r ~ -Depth 1', POWERSHELL],
    ['gci -Recurse C:\\Users\\me\\project', POWERSHELL],
    ['ls -r src', POWERSHELL],
  ] as const)('lets %s through', (command, ctx) => {
    expect(form(command, ctx)).toBeNull()
  })

  it('keeps the cmd dir form off a POSIX host, where dir is not cmd', () => {
    expect(form('dir /s C:\\', POSIX)).toBeNull()
  })
})

describe('detectUnboundedWalk -- comments, odd quotes and PowerShell assignments', () => {
  it.each([
    ['echo ok # && find / -name x'],
    ['ls; # try: x; find / -name x'],
    ['find src -name x # find / -name y'],
    ['# find / -name x'],
    ['cat <<EOF # note\nfind / -name x\nEOF'],
    ['git commit -m "$(cat <<\'EOF\'\nTitle with "odd quote\n\nfind / -name x\nEOF\n)"'],
    ['git commit -m "$(cat <<EOF\nodd " quote\nfind / -name x\nEOF\n)"'],
  ])('lets %s through', (command) => {
    expect(form(command, POSIX)).toBeNull()
    expect(form(command, POWERSHELL)).toBeNull()
  })

  it.each([
    ['echo a#b; find / -name x'],
    ['echo $# ; find / -name x'],
    ['echo ok # note\nfind / -name x'],
    ['git commit -m "$(cat <<\'EOF\'\nbody\nEOF\n)" && find / -name x'],
    ['git commit -m "$(cat <<\'EOF\'\nodd " quote\nEOF\n)"\nfind / -name x'],
    ['echo "a << b"; find / -name x'],
  ])('still refuses %s', (command) => {
    expect(form(command, POSIX)).toBe('find')
  })

  it.each([
    ['$x = Get-ChildItem C:\\ -Recurse'],
    ['$files = gci -r ~'],
    ['$x= Get-ChildItem C:\\ -Recurse'],
    ['${env:X} = gci -Recurse $HOME'],
  ])('refuses the assigned PowerShell walk %s', (command) => {
    expect(form(command, POWERSHELL)).toBe('gci')
  })

  it('lets an assigned bounded or project-local PowerShell listing through', () => {
    expect(form('$x = Get-ChildItem C:\\ -Recurse -Depth 2', POWERSHELL)).toBeNull()
    expect(form('$x = Get-ChildItem C:\\Users\\me\\project -Recurse', POWERSHELL)).toBeNull()
  })
})

describe('detectUnboundedWalk -- the refusal text', () => {
  const samples: ReadonlyArray<readonly [string, WalkContext, string]> = [
    ['find / -name x', POSIX, 'find'],
    ['fd x /', POSIX, 'fd'],
    ['rg --files /', POSIX, 'rg'],
    ['grep -r foo /', POSIX, 'grep'],
    ['ls -R /', POSIX, 'ls'],
    ['du /', POSIX, 'du'],
    ['tree /', POSIX, 'tree'],
    ['dir /s C:\\', GIT_BASH_ON_WINDOWS, 'dir'],
    ['findstr /s foo C:\\*.txt', GIT_BASH_ON_WINDOWS, 'findstr'],
    ['Get-ChildItem -Recurse C:\\', POWERSHELL, 'gci'],
  ]

  it.each(samples)('%s explains the cost, names a bounded way out and discourages a reworded rerun', (command, ctx, expected) => {
    const hit = detectUnboundedWalk(command, ctx)
    expect(hit?.form).toBe(expected)
    const text = hit?.message ?? ''
    expect(text).toContain('burns CPU for hours')
    expect(text).toContain('do not rerun a reworded variant')
    expect(text).toContain('token-goat search')
    expect(text).toContain("rg --files --max-depth N -g '*name*' <dir>")
    expect(text).toContain('Get-ChildItem <dir> -Recurse -Depth N')
  })

  it.each(samples)('%s does not send a PowerShell shell to find, whose bare name there is find.exe', (command, ctx) => {
    const text = detectUnboundedWalk(command, ctx)?.message ?? ''
    expect(text).not.toContain('find <dir>')
  })

  it('says the rg or grep advice once', () => {
    const text = detectUnboundedWalk('grep -r foo /', POSIX)?.message ?? ''
    expect(text.split('rg --files').length - 1).toBe(1)
    expect(text).not.toContain('Search the project directory')
  })

  it('explains the hung Windows text search on its own terms', () => {
    const text = detectUnboundedWalk('find "text"', POWERSHELL)?.message ?? ''
    expect(text).toContain('standard input')
    expect(text).toContain('find "text" file.txt')
    expect(text).toContain('do not rerun a reworded variant')
  })

  it('names the bound that fits the tool', () => {
    expect(detectUnboundedWalk('find / -name x', POSIX)?.message).toContain('-maxdepth N')
    expect(detectUnboundedWalk('fd x /', POSIX)?.message).toContain('-d N')
    expect(detectUnboundedWalk('rg --files /', POSIX)?.message).toContain('--max-depth N')
    expect(detectUnboundedWalk('tree /', POSIX)?.message).toContain('-L N')
    expect(detectUnboundedWalk('Get-ChildItem -Recurse C:\\', POWERSHELL)?.message).toContain('-Depth N')
  })
})

describe('the pre_tool_use hook entry', () => {
  const realPlatform = process.platform
  let project: string
  let seq = 0

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'tg-unbounded-walk-'))
    // No clearModuleCaches here: it empties the hook registry that relay.ts's imports filled once, and the Bash handler would silently stop running. The relay seeds CLAUDE_CODE_SESSION_ID, so it is stubbed first and put back with the rest.
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', '')
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'claude-vscode')
    invalidateConfigCache()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    vi.unstubAllEnvs()
    invalidateConfigCache()
    rmSync(project, { recursive: true, force: true })
  })

  function session(): string {
    seq += 1
    return `unbounded-walk-${seq}-${Math.random().toString(36).slice(2, 10)}`
  }

  function claudePayload(command: string): Record<string, unknown> {
    return { session_id: session(), transcript_path: join(project, 'transcript.jsonl'), cwd: project, permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_unbounded_walk' }
  }

  // The shim (src/bridges/copilot_cli.ts) has already turned Copilot's `bash` and `powershell` into `Bash` by the time the relay sees the event, so this is the payload the relay receives under TOKEN_GOAT_HARNESS_OVERRIDE=copilot_cli.
  function copilotPayload(command: string): Record<string, unknown> {
    return { session_id: session(), cwd: project, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }
  }

  function setPlatform(value: string): void {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }

  // A refusal is the relay's `{ decision: 'block', reason }`, which each host shim then rewrites into its own deny form.
  function denied(out: string): boolean {
    return (JSON.parse(out) as { decision?: string }).decision === 'block'
  }

  it('denies the captured command from Claude Code and says why', async () => {
    const out = await relayInProcess('pre_tool_use', claudePayload(CAPTURED))
    expect(denied(out)).toBe(true)
    expect(out).toContain('[tg] ')
    expect(out).toContain('burns CPU for hours')
    expect(out).toContain('do not rerun a reworded variant')
  })

  it('denies a root find in a pipeline and a chain from Claude Code', async () => {
    expect(denied(await relayInProcess('pre_tool_use', claudePayload('cd /tmp && find / -name x | head -5')))).toBe(true)
    expect(denied(await relayInProcess('pre_tool_use', claudePayload('echo go; (find ~ -type f)')))).toBe(true)
  })

  it('lets a bounded or project-local walk through from Claude Code', async () => {
    for (const command of ['find . -name x', 'find src -type f', 'find / -maxdepth 2 -name x', 'echo "find / -name x"', 'fd x src']) {
      expect(denied(await relayInProcess('pre_tool_use', claudePayload(command)))).toBe(false)
    }
  })

  it('denies a root walk with each other tool from Claude Code', async () => {
    for (const command of ['fd x /', 'rg --files ~', 'grep -r foo /', 'ls -R /', 'du /', 'tree /']) {
      expect(denied(await relayInProcess('pre_tool_use', claudePayload(command)))).toBe(true)
    }
  })

  it('denies a root find from Copilot CLI through its bash tool', async () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    const out = await relayInProcess('pre_tool_use', copilotPayload(CAPTURED))
    expect(denied(out)).toBe(true)
    expect(out).toContain('do not rerun a reworded variant')
  })

  it('lets a bounded find through from Copilot CLI', async () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    expect(denied(await relayInProcess('pre_tool_use', copilotPayload('find src -name x')))).toBe(false)
  })

  it('denies a recursive listing of a drive root from Copilot CLI through its powershell tool', async () => {
    setPlatform('win32')
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    const out = await relayInProcess('pre_tool_use', copilotPayload('Get-ChildItem -Recurse C:\\'))
    expect(denied(out)).toBe(true)
    expect(out).toContain('-Depth N')
  })

  it('denies the Windows text search that would wait on standard input from Copilot CLI, and lets a piped one through', async () => {
    setPlatform('win32')
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    const refused = await relayInProcess('pre_tool_use', copilotPayload('find /i "x"'))
    expect(denied(refused)).toBe(true)
    expect(refused).toContain('rg \\"text\\" file.txt')
    expect(refused).not.toContain('command omitted')
    expect(denied(await relayInProcess('pre_tool_use', copilotPayload('dir | find "x"')))).toBe(false)
    expect(denied(await relayInProcess('pre_tool_use', copilotPayload('find "x" file.txt')))).toBe(false)
  })

  it('reads a payload tool name of powershell in any case as the PowerShell shell', () => {
    setPlatform('win32')
    const run = (toolName: string): string => preBashHandler(makeHookEvent({ toolName: 'Bash', toolInput: { command: 'find /i "x"' }, sessionId: session(), raw: { cwd: project, tool_name: toolName } })).hookType
    expect(run('powershell')).toBe('deny')
    expect(run('PowerShell')).toBe('deny')
    expect(run('Bash')).not.toBe('deny')
  })

  it('treats a bare find as the Windows one only when the shell is PowerShell, so Claude Code on Windows keeps Git find', async () => {
    setPlatform('win32')
    expect(denied(await relayInProcess('pre_tool_use', claudePayload('find "text"')))).toBe(false)
  })
})
