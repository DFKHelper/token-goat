import { describe, it, expect } from 'vitest'
import { extractGetContentHead, extractCatFile, extractGetContentTail, extractPowerShellWrappedGetContent } from '../src/bash_extractors.js'
import { preBashHandler } from '../src/hooks_bash.js'
import { makeHookEvent } from './helpers/hook-event.js'

describe('extractGetContentHead and bounded PowerShell commands', () => {
  it('extracts filePath and line count from Get-Content with -TotalCount', () => {
    const res = extractGetContentHead('Get-Content src/auth.ts -TotalCount 40')
    expect(res).not.toBeNull()
    expect(res?.filePath).toBe('src/auth.ts')
    expect(res?.n).toBe(40)
  })

  it('extracts when flag comes before file path', () => {
    const res = extractGetContentHead('Get-Content -TotalCount 40 src/auth.ts')
    expect(res).not.toBeNull()
    expect(res?.filePath).toBe('src/auth.ts')
    expect(res?.n).toBe(40)
  })

  it('extracts -Head and -First aliases', () => {
    const resHead = extractGetContentHead('Get-Content src/auth.ts -Head 50')
    expect(resHead?.n).toBe(50)
    expect(resHead?.filePath).toBe('src/auth.ts')

    const resFirst = extractGetContentHead('gc -First 25 src/auth.ts')
    expect(resFirst?.n).toBe(25)
    expect(resFirst?.filePath).toBe('src/auth.ts')
  })

  // A hyphen inside a name is not a flag. The flag strip took every `-word` run anywhere in the argument, so `loop-ledger.md` came back as `loop.md` and a share host `tg-no-such-host` as `tg-no`, and the hint named, and the pricing stat-ed, a file the command never reads. HAND-DERIVED: names shaped like this repository's own `docs/loop-ledger.md`, and PowerShell's documented `-Raw` switch beside `-TotalCount`.
  it('keeps a hyphenated name whole and still drops a switch beside it', () => {
    expect(extractGetContentHead('Get-Content docs/loop-ledger.md -TotalCount 300')?.filePath).toBe('docs/loop-ledger.md')
    expect(extractGetContentHead('Get-Content -TotalCount 40 src/hooks-bash.ts')?.filePath).toBe('src/hooks-bash.ts')
    expect(extractGetContentHead('Get-Content -Path src/my-file.ts -Raw -TotalCount 40')?.filePath).toBe('src/my-file.ts')
    expect(extractGetContentHead('Get-Content //tg-no-such-host/share/x.ts -TotalCount 300')?.filePath).toBe('//tg-no-such-host/share/x.ts')
    expect(extractGetContentHead('Get-Content src/auth.ts -Raw -TotalCount 40')?.filePath).toBe('src/auth.ts')
  })

  it('treats <= 10 lines as already surgical and returns null from extractor', () => {
    expect(extractGetContentHead('Get-Content src/auth.ts -TotalCount 10')).toBeNull()
    expect(extractGetContentHead('Get-Content src/auth.ts -TotalCount 5')).toBeNull()
  })

  it('prevents extractCatFile from matching bounded Get-Content commands', () => {
    expect(extractCatFile('Get-Content src/auth.ts -TotalCount 40')).toBeNull()
    expect(extractCatFile('Get-Content -TotalCount 40 src/auth.ts')).toBeNull()
    expect(extractCatFile('Get-Content src/auth.ts -First 10')).toBeNull()
    expect(extractCatFile('Get-Content src/auth.ts -Head 5')).toBeNull()
    expect(extractCatFile('Get-Content src/auth.ts -Tail 20')).toBeNull()
  })

  // The guard above keeps a bounded read away from the whole-file handlers, and it matched a parameter word anywhere in the command, name included, so a whole-file read of a name holding `-first`, `-head`, `-tail` or `-totalcount` passed with no hint and went unrecorded, and a `-Tail` read was cut at the name's own `-tail`. CAPTURE (this machine, 2026-08-20, a Claude Code subagent in C:\Projects\claude-agents): `cat ~/.claude/skills/precision-first-low-promotion/SKILL.md` was denied with "`cat` loads the entire file into context. Use `token-goat section ...` to read one section." before the guard existed (7360a99f, 2026-09-22); it passed silently after. HAND-DERIVED: the other names, shaped like it.
  it('takes a read of a name holding a bounded-read parameter word as the read it is', () => {
    expect(extractCatFile('cat ~/.claude/skills/precision-first-low-promotion/SKILL.md')?.filePath).toBe('~/.claude/skills/precision-first-low-promotion/SKILL.md')
    expect(extractCatFile('cat src/page-head.tsx')?.filePath).toBe('src/page-head.tsx')
    expect(extractCatFile('Get-Content src/log-tail.ts')?.filePath).toBe('src/log-tail.ts')
    expect(extractPowerShellWrappedGetContent(`powershell -Command "Get-Content 'src/page-head.tsx' -Raw"`)?.filePath).toBe('src/page-head.tsx')
    expect(extractGetContentTail('Get-Content src/log-tail.ts -Tail 50')?.filePath).toBe('src/log-tail.ts')
  })

  it('preBashHandler denies the captured whole-file cat of a skill whose name holds -first', () => {
    const out = preBashHandler(makeHookEvent({
      toolName: 'Bash',
      toolInput: { command: 'cat ~/.claude/skills/precision-first-low-promotion/SKILL.md' },
    }))
    expect(out.hookType).toBe('deny')
    if (out.hookType === 'deny') expect(out.message).toContain('precision-first-low-promotion/SKILL.md')
  })

  it('preBashHandler does not deny bounded Get-Content -TotalCount 40', () => {
    const out = preBashHandler(makeHookEvent({
      toolName: 'Bash',
      toolInput: { command: 'Get-Content src/auth.ts -TotalCount 40' },
    }))
    // Must NOT be denied
    expect(out.hookType).not.toBe('deny')
  })

  it('preBashHandler allows surgical Get-Content -TotalCount 5 without deny', () => {
    const out = preBashHandler(makeHookEvent({
      toolName: 'Bash',
      toolInput: { command: 'Get-Content src/auth.ts -TotalCount 5' },
    }))
    expect(out.hookType).not.toBe('deny')
  })
})
