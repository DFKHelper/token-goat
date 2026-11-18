// Provenance: HAND-DERIVED from A1 walk-audit strings or their siblings; every command is data, none was run.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { preBashHandler, WALK_PREFILTER, walkRefusal } from '../src/hooks_bash.js'
import { runHook } from '../src/hook_registry.js'
import { detectUnboundedWalk, WALK_TRIGGER_NAMES, type WalkContext } from '../src/unbounded_walk.js'
import { WALKER_NAMES, WRAPPER_NAMES, XARGS_WALKERS } from '../src/unbounded_walk_xargs.js'
import { makeHookEvent } from './helpers/hook-event.js'

const POSIX: WalkContext = { windows: false, powershell: false }
const GIT_BASH_ON_WINDOWS: WalkContext = { windows: true, powershell: false }
const POWERSHELL: WalkContext = { windows: true, powershell: true }

describe("walk guard wrappers and recursion: sub", () => {
  it.each<readonly [WalkContext, string]>([
    [POSIX, "echo \"$(find / -name x)\""],
    [POSIX, "f=\"$(find / -name x)\""],
    [POSIX, "echo \"`find /`\""],
    [POSIX, "echo \"a $(echo \"$(find /)\")\""],
  ])('refuses %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).not.toBeNull()
    expect(WALK_PREFILTER.test(command)).toBe(true)
  })
  it.each<readonly [WalkContext, string]>([
    [POSIX, "echo \"$(find . -maxdepth 1 -name x)\""],
    [POSIX, "echo '$(find /)'"],
    [POSIX, "echo \"$(date)\""],
  ])('lets through %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).toBeNull()
  })
})

describe("walk guard wrappers and recursion: cd", () => {
  it.each<readonly [WalkContext, string]>([
    [POSIX, "cd / && rg foo"],
    [POSIX, "cd ~ && grep -r x ."],
    [POSIX, "cd / && du -sh"],
    [POSIX, "cd / && fd x"],
    [POSIX, "cd / && tree"],
    [POSIX, "cd / && ls -R"],
  ])('refuses %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).not.toBeNull()
    expect(WALK_PREFILTER.test(command)).toBe(true)
  })
  it.each<readonly [WalkContext, string]>([
    [POSIX, "cd /tmp && rg foo"],
    [POSIX, "cd / && rg --max-depth 2 foo"],
    [POSIX, "cd / && fd -d 2 x"],
    [POSIX, "cd / && tree -L 2"],
    [POSIX, "cd / && rg foo src"],
    [POSIX, "cd /tmp && grep -r x ."],
    [POSIX, "cd / && ls"],
  ])('lets through %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).toBeNull()
  })
})

describe("walk guard wrappers and recursion: du", () => {
  it.each<readonly [WalkContext, string]>([
    [POSIX, "du -sh /"],
    [POSIX, "du -s ~"],
    [POSIX, "du -d1 /"],
    [POSIX, "du --max-depth=1 /"],
    [POSIX, "du -sh /*"],
    [POSIX, "du -d 1 /"],
    [POSIX, "du --max-depth 1 /"],
    [POSIX, "du -sh ~/"],
    [GIT_BASH_ON_WINDOWS, "du -sh C:\\"],
  ])('refuses %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).not.toBeNull()
    expect(WALK_PREFILTER.test(command)).toBe(true)
  })
  it.each<readonly [WalkContext, string]>([
    [POSIX, "du -sh ."],
    [POSIX, "du -sh /tmp"],
    [POSIX, "du -d1 src"],
    [POSIX, "du -sh node_modules"],
  ])('lets through %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).toBeNull()
  })
})

describe("walk guard wrappers and recursion: shells", () => {
  it.each<readonly [WalkContext, string]>([
    [POSIX, "bash <<'EOF'\nfind / -name x\nEOF"],
    [POSIX, "sh <<EOF\nfind /\nEOF"],
    [POSIX, "echo 'find /' | sh"],
    [POSIX, "bash <<< \"find /\""],
    [POSIX, "cat <<EOF\n$(find /)\nEOF"],
    [POSIX, "cat <<EOF\n`find /`\nEOF"],
  ])('refuses %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).not.toBeNull()
    expect(WALK_PREFILTER.test(command)).toBe(true)
  })
  it.each<readonly [WalkContext, string]>([
    [POSIX, "cat <<'EOF'\n$(find /)\nEOF"],
    [POSIX, "cat <<EOF\nfind / -name x\nEOF"],
    [POSIX, "bash <<'EOF'\nfind . -maxdepth 2\nEOF"],
    [POSIX, "echo 'find /' | cat"],
    [POSIX, "echo 'find / -maxdepth 1' | sh"],
  ])('lets through %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).toBeNull()
  })
})

describe("walk guard wrappers and recursion: powershell", () => {
  it.each<readonly [WalkContext, string]>([
    [POWERSHELL, "Get-ChildItem C:\\ `\n-Recurse"],
    [POWERSHELL, "Get-Child`Item C:\\ -Recurse"],
    [POWERSHELL, "Get-ChildItem C:\\ -Re`curse"],
    [POWERSHELL, "gci C:\\ -Recurse -Depth"],
    [POWERSHELL, "gci C:\\ -Recurse -Depth x"],
    [POWERSHELL, "gci C:\\ -Recurse -Depth -1"],
    [POWERSHELL, "gci C:\\ -Recurse -Depth:"],
  ])('refuses %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).not.toBeNull()
    expect(WALK_PREFILTER.test(command)).toBe(true)
  })
  it.each<readonly [WalkContext, string]>([
    [POWERSHELL, "Get-ChildItem C:\\Users\\x -Recurse"],
    [POWERSHELL, "Get-ChildItem C:\\Users\\x `\n-Recurse"],
    [POWERSHELL, "gci C:\\ -Recurse -Depth 2"],
    [POWERSHELL, "gci C:\\ -Recurse -Depth:2"],
  ])('lets through %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).toBeNull()
  })
})

describe("walk guard wrappers and recursion: find -exec", () => {
  it.each<readonly [WalkContext, string]>([
    [POSIX, "find / -maxdepth 1 -exec du -s {} +"],
    [POSIX, "find ~ -maxdepth 1 -exec du -s {} +"],
    [POSIX, "find / -maxdepth 1 -execdir du -s {} \\;"],
    [POSIX, "find / -maxdepth 1 -ok grep -r x {} \\;"],
    [POSIX, "find . -maxdepth 1 -exec du -s / \\;"],
    [POSIX, "find /tmp -maxdepth 1 -exec sh -c 'find / -name x' \\;"],
  ])('refuses %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).not.toBeNull()
    expect(WALK_PREFILTER.test(command)).toBe(true)
  })
  it.each<readonly [WalkContext, string]>([
    [POSIX, "find /tmp -maxdepth 1 -exec du -s {} +"],
    [POSIX, "find . -maxdepth 2 -exec ls {} \\;"],
    [POSIX, "find / -maxdepth 1 -exec ls -d {} \\;"],
  ])('lets through %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).toBeNull()
  })
})

describe("walk guard wrappers and recursion: wrappers", () => {
  it.each<readonly [WalkContext, string]>([
    [POSIX, "time -p find /"],
    [POSIX, "command -p find /"],
    [POSIX, "env -C / find ."],
    [POSIX, "env --chdir=/ find ."],
    [POSIX, "env -S 'find /'"],
    [POSIX, "nice --adjustment=5 find /"],
    [POSIX, "sudo --user root find /"],
    [POSIX, "setsid -w find /"],
    [POSIX, "sh -c 'find \"$1\"' _ /"],
    [POSIX, "fish -c 'find /'"],
    [POSIX, "ash -c 'find /'"],
    [POSIX, "csh -c 'find /'"],
    [POSIX, "tcsh -c 'find /'"],
    [POSIX, "busybox find /"],
    [POSIX, "busybox sh -c 'find /'"],
    [POSIX, "bash -c \"echo 'unterminated\""],
    [POWERSHELL, "pwsh -Co \"gci C:\\ -r\""],
    [POWERSHELL, "powershell -c \"gci C:\\ -r\""],
    [POWERSHELL, "pwsh -enc ZwBjAGkAIABDADoAXAAgAC0AcgA="],
    [POWERSHELL, "powershell -ec ZwBjAGkAIABDADoAXAAgAC0AcgA="],
    [POWERSHELL, "pwsh -enc !!!"],
  ])('refuses %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).not.toBeNull()
    expect(WALK_PREFILTER.test(command)).toBe(true)
  })
  it.each<readonly [WalkContext, string]>([
    [POSIX, "nice --adjustment=5 find . -maxdepth 1"],
    [POSIX, "env -C /tmp find ."],
    [POSIX, "sudo --user root find /tmp -name x"],
    [POSIX, "time -p find . -name x"],
    [POSIX, "command -v find"],
    [POSIX, "busybox find . -maxdepth 1"],
    [POSIX, "fish -c 'find . -maxdepth 1'"],
    [POSIX, "sh -c 'find \"$1\" -maxdepth 1' _ /"],
    [POSIX, "bash -c \"echo 'ok'\""],
    [POWERSHELL, "pwsh -Co \"gci . -r\""],
    [POWERSHELL, "pwsh -enc ZwBjAGkAIAAuACAALQByAA=="],
  ])('lets through %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).toBeNull()
  })
})

describe("walk guard wrappers and recursion: bsd find", () => {
  it.each<readonly [WalkContext, string]>([
    [POSIX, "find -E / -regex x"],
    [POSIX, "find -s / -name x"],
    [POSIX, "find -f / -name x"],
    [POSIX, "find -X / -name x"],
  ])('refuses %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).not.toBeNull()
    expect(WALK_PREFILTER.test(command)).toBe(true)
  })
  it.each<readonly [WalkContext, string]>([
    [POSIX, "find -E . -regex x"],
    [POSIX, "find -s src -name x"],
    [POSIX, "find -E / -maxdepth 1 -regex x"],
  ])('lets through %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).toBeNull()
  })
})

describe("walk guard wrappers and recursion: numeric", () => {
  it.each<readonly [WalkContext, string]>([
    [POSIX, "find / -name -maxdepth"],
    [POSIX, "find / -path -maxdepth"],
    [POSIX, "find / -maxdepth"],
    [POSIX, "find / -maxdepth x"],
    [POSIX, "find / -maxdepth -1"],
    [POSIX, "find / -maxdepth ''"],
    [POSIX, "fd -d x pattern /"],
    [POSIX, "fd -d pattern /"],
    [POSIX, "fd --max-depth= x /"],
    [POSIX, "fd --max-depth=-1 x /"],
    [POSIX, "rg --max-depth x foo /"],
    [POSIX, "rg --max-depth= foo /"],
    [POSIX, "rg -d foo /"],
    [POSIX, "rg --max-depth -1 foo /"],
    [POSIX, "tree -L x /"],
    [POSIX, "tree -L -1 /"],
    [POSIX, "tree -L /"],
  ])('refuses %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).not.toBeNull()
    expect(WALK_PREFILTER.test(command)).toBe(true)
  })
  it.each<readonly [WalkContext, string]>([
    [POSIX, "find / -maxdepth 0"],
    [POSIX, "find / -maxdepth 2 -name x"],
    [POSIX, "find / -name x -maxdepth 2"],
    [POSIX, "find / -maxdepth 3 -name -maxdepth"],
    [POSIX, "fd -d 2 x /"],
    [POSIX, "fd -d2 x /"],
    [POSIX, "fd --max-depth=2 x /"],
    [POSIX, "fd --max-depth 2 x /"],
    [POSIX, "rg -d 2 foo /"],
    [POSIX, "rg --max-depth=2 foo /"],
    [POSIX, "rg -d2 foo /"],
    [POSIX, "rg --maxdepth 2 foo /"],
    [POSIX, "tree -L 2 /"],
    [POSIX, "tree -L2 /"],
    [POSIX, "tree -aL 2 /"],
  ])('lets through %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).toBeNull()
  })
})

describe("walk guard wrappers and recursion: rg pre", () => {
  it.each<readonly [WalkContext, string]>([
    [POSIX, "rg --pre cat foo src"],
    [POSIX, "rg --pre=cat foo src"],
    [POSIX, "rg --pre-glob '*.pdf' foo src"],
    [POSIX, "rg --pre-glob='*.pdf' foo src"],
    [POSIX, "git ls-files | xargs rg --pre cat foo"],
  ])('refuses %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).not.toBeNull()
    expect(WALK_PREFILTER.test(command)).toBe(true)
  })
  it.each<readonly [WalkContext, string]>([
    [POSIX, "rg foo src"],
    [POSIX, "rg --glob '*.ts' foo src"],
  ])('lets through %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).toBeNull()
  })
})

describe("walk guard wrappers and recursion: walkers", () => {
  it.each<readonly [WalkContext, string]>([
    [GIT_BASH_ON_WINDOWS, "where /R C:\\ x"],
    [GIT_BASH_ON_WINDOWS, "forfiles /P C:\\ /S"],
    [GIT_BASH_ON_WINDOWS, "forfiles /P C:\\ /S /M *.log"],
    [POSIX, "chmod -R 755 /"],
    [POSIX, "chown -R me ~"],
    [POSIX, "chmod --recursive 755 /"],
    [POSIX, "cp -r / dest"],
    [POSIX, "cp -a ~ backup"],
    [POSIX, "ag foo /"],
    [POSIX, "ack foo ~"],
    [POSIX, "ag --depth 3 foo /"],
    [POSIX, "dust /"],
    [POSIX, "dust -d 1 /"],
    [POSIX, "ncdu /"],
    [POSIX, "ncdu -x ~"],
    [POSIX, "eza -R /"],
    [POSIX, "eza --recurse ~"],
    [POSIX, "exa -R /"],
    [POSIX, "echo / | xargs chmod -R 755"],
    [POSIX, "echo / | xargs dust"],
  ])('refuses %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).not.toBeNull()
    expect(WALK_PREFILTER.test(command)).toBe(true)
  })
  it.each<readonly [WalkContext, string]>([
    [GIT_BASH_ON_WINDOWS, "where /R C:\\Users\\x y"],
    [GIT_BASH_ON_WINDOWS, "where x"],
    [GIT_BASH_ON_WINDOWS, "forfiles /P C:\\Users\\x /S"],
    [GIT_BASH_ON_WINDOWS, "forfiles /P C:\\"],
    [POSIX, "chmod -R 755 src"],
    [POSIX, "chmod 755 /"],
    [POSIX, "chmod -R 755 /tmp/x"],
    [POSIX, "cp -r src /"],
    [POSIX, "cp -r src dest"],
    [POSIX, "ag foo src"],
    [POSIX, "dust src"],
    [POSIX, "ncdu src"],
    [POSIX, "eza -R src"],
    [POSIX, "eza /"],
    [POSIX, "git ls-files | xargs chmod -R 755"],
    [POSIX, "git ls-files | xargs chmod +x"],
  ])('lets through %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).toBeNull()
  })
})

describe("walk guard wrappers and recursion: g12 g13", () => {
  it.each<readonly [WalkContext, string]>([
    [POSIX, "$HOME"],
    [POSIX, "ls *.ts | xargs du"],
  ])('refuses %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).not.toBeNull()
    expect(WALK_PREFILTER.test(command)).toBe(true)
  })
  it.each<readonly [WalkContext, string]>([
    [POWERSHELL, "$env:PATH"],
    [POSIX, "ls *.ts | xargs ls"],
    [POSIX, "git ls-files | xargs du -sh"],
  ])('lets through %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).toBeNull()
  })
})

describe("walk guard wrappers and recursion: loosened", () => {
  it.each<readonly [WalkContext, string]>([
    [POSIX, "git ls-files | xargs grep -nE \"foo\\|bar\" /"],
    [POSIX, "ls -a | xargs grep -rnE \"foo\\|bar\""],
    [POSIX, "git ls-files | xargs rg -n 'foo\\(' ~"],
    [POSIX, "git ls-files | xargs grep -n 'foo$HOME'"],
    [POSIX, "echo / | xargs -n1 du -sh"],
    [POSIX, "git ls-files | xargs -n1 du -sh /"],
    [POSIX, "git ls-files | xargs -I{} du -sh / {}"],
    [POSIX, "git ls-files | xargs -nx du -sh"],
    [POSIX, "git ls-files | xargs --max-args=x grep"],
    [POSIX, "echo / | xargs -I{} du -sh {}"],
    [POSIX, "git ls-files | xargs -P4x du -sh"],
  ])('refuses %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).not.toBeNull()
    expect(WALK_PREFILTER.test(command)).toBe(true)
  })
  it.each<readonly [WalkContext, string]>([
    [POSIX, "git ls-files | xargs grep -nE \"foo\\|bar\""],
    [POSIX, "git ls-files | xargs rg -n 'foo\\('"],
    [POSIX, "git ls-files | xargs -n1 du -sh"],
    [POSIX, "git ls-files | xargs -P4 du -sh"],
    [POSIX, "git ls-files | xargs -I{} grep -n x {}"],
    [POSIX, "git ls-files | xargs --null du"],
    [POSIX, "git ls-files | xargs --max-args=1 grep"],
  ])('lets through %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).toBeNull()
  })
})

describe("walk guard wrappers and recursion: rulings that replaced earlier rows", () => {
  it.each<readonly [WalkContext, string]>([
    [POSIX, "du --max-depth=1 ~"],
  ])('refuses %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).not.toBeNull()
    expect(WALK_PREFILTER.test(command)).toBe(true)
  })
  it.each<readonly [WalkContext, string]>([
    [POSIX, "git ls-files | xargs -n1 du -h"],
  ])('lets through %#', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).toBeNull()
  })
})

describe('walk guard load prefilter in hooks_bash.ts', () => {
  afterEach(() => {
    vi.doUnmock('../src/unbounded_walk.js')
    vi.resetModules()
  })

  const event = (command: string) =>
    makeHookEvent({ toolName: 'Bash', toolInput: { command }, sessionId: 'prefilter-row', raw: {} })

  it('matches every command name the guard acts on', () => {
    const names = WALK_TRIGGER_NAMES.filter((n) => /^[a-z]/i.test(n))
    expect(names.length).toBeGreaterThan(40)
    const missed = (n: string) =>
      !WALK_PREFILTER.test(n + ' x') || !WALK_PREFILTER.test('/usr/bin/' + n + '.exe x')
    expect(names.filter(missed)).toEqual([])
  })

  it('holds the prefilter and WALK_TRIGGER_NAMES to a superset of every walker, wrapper and xargs name', () => {
    const named = [...WALKER_NAMES, ...WRAPPER_NAMES, ...XARGS_WALKERS.keys()]
    expect(named.length).toBeGreaterThan(40)
    expect(named.filter((n) => !WALK_TRIGGER_NAMES.includes(n))).toEqual([])
    const missed = (n: string) =>
      !WALK_PREFILTER.test(n + ' x') || !WALK_PREFILTER.test('/usr/bin/' + n + '.exe x')
    expect(named.filter(missed)).toEqual([])
  })

  it('refuses a walk the pre-bash rewrite would also have wrapped, because the guard runs first', async () => {
    const command = 'rg -n foo /'
    const ev = makeHookEvent({ toolName: 'Bash', toolInput: { command }, sessionId: 'order-row', raw: {} })
    expect(preBashHandler(ev).hookType).toBe('rewriteInput')
    const out = await runHook(ev)
    expect(out.hookType).toBe('deny')
  })

  it('does not load the guard for a command with no walker word, quote, or expansion', async () => {
    expect(WALK_PREFILTER.test('git status')).toBe(false)
    expect(WALK_PREFILTER.test('npm run build')).toBe(false)
    expect(await walkRefusal(event('git status'))).toBeNull()
  })

  it('refuses a walk through the deferred guard', async () => {
    expect((await walkRefusal(event('find / -name x')))?.hookType).toBe('deny')
    expect(await walkRefusal(event('find src -name x'))).toBeNull()
  })

  it('answers as if the guard allowed when the guard chunk fails to load', async () => {
    vi.resetModules()
    vi.doMock('../src/unbounded_walk.js', () => {
      throw new Error('chunk missing')
    })
    const fresh = await import('../src/hooks_bash.js')
    expect(await fresh.walkRefusal(event('find / -name x'))).toBeNull()
  })
})

describe('walk guard fd and rg depth options: only what the tools accept is a bound', () => {
  // Provenance: CAPTURE of `fd 10.5.0` and `rg 15.2.0` run on a scratch dir; the first group was accepted.
  it.each<readonly [WalkContext, string]>([
    [POSIX, 'fd -d3 x /'],
    [POSIX, 'fd -d 3 x /'],
    [POSIX, 'fd -d=3 x /'],
    [POSIX, 'fd --max-depth 3 x /'],
    [POSIX, 'fd --max-depth=3 x /'],
    [POSIX, 'fd --maxdepth 3 x /'],
    [POSIX, 'fd --maxdepth=3 x /'],
    [POSIX, 'fd --exact-depth 3 x /'],
    [POSIX, 'rg -d3 x /'],
    [POSIX, 'rg -d=3 x /'],
    [POSIX, 'rg --max-depth=3 x /'],
    [POSIX, 'rg --maxdepth 3 x /'],
    [POSIX, 'rg --maxdepth=3 x /'],
  ])('lets %#: %s through', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).toBeNull()
  })

  it.each<readonly [WalkContext, string]>([
    [POSIX, 'fd --max-depth3 x /'],
    [POSIX, 'fd --maxdepth3 x /'],
    [POSIX, 'fd --exact-depth3 x /'],
    [POSIX, 'fd --max-dep 3 x /'],
    [POSIX, 'fd --maxd 3 x /'],
    [POSIX, 'fd -d 3x x /'],
    [POSIX, 'fd x / -d'],
    [POSIX, 'fd x / -d='],
    [POSIX, 'rg --max-depth3 x /'],
    [POSIX, 'rg --maxdepth3 x /'],
    [POSIX, 'rg --max-dep 3 x /'],
    [POSIX, 'rg --exact-depth 3 x /'],
    [POSIX, 'rg --exact-depth=3 x /'],
    [POSIX, 'rg x / -d abc'],
  ])('refuses %#: %s', (ctx, command) => {
    expect(detectUnboundedWalk(command, ctx)).not.toBeNull()
    expect(WALK_PREFILTER.test(command)).toBe(true)
  })
})
