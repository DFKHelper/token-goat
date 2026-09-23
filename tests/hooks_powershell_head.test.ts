import { describe, it, expect } from 'vitest'
import { extractGetContentHead, extractCatFile } from '../src/bash_extractors.js'
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
