import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseShareUrl, resolveLocalPath } from '../src/sharepoint_resolve.js'

describe('parseShareUrl', () => {
  it('parses a team site "sites" URL, stripping the :x:/r/ view-mode prefix', () => {
    const parsed = parseShareUrl('https://contoso.sharepoint.com/:x:/r/sites/TeamSite/Shared%20Documents/Reports/budget.xlsx?d=abc')
    expect(parsed).toEqual({ tenant: 'contoso', siteType: 'site', siteName: 'TeamSite', libraryPath: 'Shared Documents/Reports/budget.xlsx' })
  })

  it('parses a personal OneDrive URL', () => {
    const parsed = parseShareUrl('https://contoso-my.sharepoint.com/personal/alice_contoso_com/Documents/notes.docx')
    expect(parsed).toEqual({ tenant: 'contoso', siteType: 'personal', siteName: 'alice_contoso_com', libraryPath: 'Documents/notes.docx' })
  })

  it('throws a clear error for a shortened 1drv.ms link', () => {
    expect(() => parseShareUrl('https://1drv.ms/x/s!abc123')).toThrow(/needs a network redirect/)
  })

  it('throws for onedrive.live.com (not supported by the parser)', () => {
    expect(() => parseShareUrl('https://contoso-my.onedrive.live.com/personal/alice_contoso_com/Documents/notes.docx')).toThrow(/not a SharePoint\/OneDrive URL/)
  })

  it('throws for a non-SharePoint/OneDrive URL', () => {
    expect(() => parseShareUrl('https://example.com/foo')).toThrow(/not a SharePoint\/OneDrive URL/)
  })

  it('throws for an unparseable URL', () => {
    expect(() => parseShareUrl('not a url')).toThrow(/not a valid URL/)
  })

  it('throws when neither /sites/ nor /personal/ appears in the path', () => {
    expect(() => parseShareUrl('https://contoso.sharepoint.com/foo/bar')).toThrow(/could not find a \/sites\/ or \/personal\//)
  })

  it('never echoes the query string (access material) in error messages (security regression)', () => {
    const secretToken = 'd=SECRET_ACCESS_TOKEN_12345'
    try {
      parseShareUrl(`https://contoso.sharepoint.com/foo/bar?${secretToken}`)
      expect.fail('expected parseShareUrl to throw')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      expect(message).not.toContain(secretToken)
      expect(message).not.toContain('?')
    }
  })
})

describe('resolveLocalPath', () => {
  let root: string

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sp-'))
  })

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('resolves via the raw joined library path', () => {
    const siteRoot = path.join(root, 'raw-root')
    fs.mkdirSync(path.join(siteRoot, 'Reports'), { recursive: true })
    fs.writeFileSync(path.join(siteRoot, 'Reports', 'budget.xlsx'), '')
    const parsed = parseShareUrl('https://contoso.sharepoint.com/sites/TeamSite/Reports/budget.xlsx')
    const result = resolveLocalPath(parsed, { OneDriveCommercial: siteRoot }, root)
    expect(result.resolvedPath).toBe(path.join(siteRoot, 'Reports', 'budget.xlsx'))
  })

  it('resolves "Shared Documents" via its local "Documents" alias', () => {
    const siteRoot = path.join(root, 'alias-root')
    fs.mkdirSync(path.join(siteRoot, 'Documents', 'Reports'), { recursive: true })
    fs.writeFileSync(path.join(siteRoot, 'Documents', 'Reports', 'budget.xlsx'), '')
    const parsed = parseShareUrl('https://contoso.sharepoint.com/sites/TeamSite/Shared%20Documents/Reports/budget.xlsx')
    const result = resolveLocalPath(parsed, { OneDriveCommercial: siteRoot }, root)
    expect(result.resolvedPath).toBe(path.join(siteRoot, 'Documents', 'Reports', 'budget.xlsx'))
  })

  it('resolves a team site nested under a multi-site sync root by matching the site name', () => {
    const multiRoot = path.join(root, 'multi-root')
    fs.mkdirSync(path.join(multiRoot, 'Contoso - TeamSite', 'Documents', 'Reports'), { recursive: true })
    fs.writeFileSync(path.join(multiRoot, 'Contoso - TeamSite', 'Documents', 'Reports', 'budget.xlsx'), '')
    const parsed = parseShareUrl('https://contoso.sharepoint.com/sites/TeamSite/Shared%20Documents/Reports/budget.xlsx')
    const result = resolveLocalPath(parsed, { OneDriveCommercial: multiRoot }, root)
    expect(result.resolvedPath).toBe(path.join(multiRoot, 'Contoso - TeamSite', 'Documents', 'Reports', 'budget.xlsx'))
  })

  it("normalizes away '..' segments before new URL() ever hands them to the parser (WHATWG URL spec resolves dot-segments)", () => {
    // Belt-and-braces: confirms the production entry point (parseShareUrl) can never
    // actually produce a '..'-bearing libraryPath in the first place, since new URL()
    // resolves dot-segments (RFC 3986 5.2.4) -- including percent-encoded ones -- before
    // resolveLocalPath ever sees the value.
    const parsed = parseShareUrl('https://contoso.sharepoint.com/sites/TeamSite/Documents/Reports/foo/../etc/passwd')
    expect(parsed.libraryPath).not.toContain('..')
  })

  it("rejects a literal '..'/'.' segment in libraryPath at resolveLocalPath's own boundary, in case a future caller builds ParsedShareUrl directly instead of via parseShareUrl", () => {
    const siteRoot = path.join(root, 'traversal-root')
    fs.mkdirSync(siteRoot, { recursive: true })
    const parsed = { tenant: 'contoso', siteType: 'site' as const, siteName: 'TeamSite', libraryPath: '../../../../../../etc/passwd' }
    const result = resolveLocalPath(parsed, { OneDriveCommercial: siteRoot }, root)
    for (const tried of result.triedPaths) {
      expect(tried.startsWith(siteRoot)).toBe(true)
    }
  })

  it('rejects the backslash-encoded traversal payload (%5C survives decodeURIComponent, never splits on "/", never equals ".." -- security regression)', () => {
    // https://x.sharepoint.com/sites/S/Docs/..%5C..%5C..%5CWindows%5Cwin.ini decodes to a
    // single segment '..\..\..\Windows\win.ini' that a '/'-only split never breaks apart
    // and that never literally equals '..', so the old '/'.split().filter(s => s !== '..')
    // guard let it straight through; path.win32.join then collapsed it outside the root.
    const siteRoot = path.join(root, 'backslash-traversal-root')
    fs.mkdirSync(siteRoot, { recursive: true })
    const parsed = parseShareUrl(
      'https://contoso.sharepoint.com/sites/S/Docs/..%5C..%5C..%5CWindows%5Cwin.ini',
    )
    const result = resolveLocalPath(parsed, { OneDriveCommercial: siteRoot }, root)
    expect(result.resolvedPath).toBeNull()
    for (const tried of result.triedPaths) {
      expect(tried.startsWith(siteRoot)).toBe(true)
    }
  })

  it('resolves a normal nested path unaffected by the backslash guard', () => {
    const siteRoot = path.join(root, 'backslash-normal-root')
    fs.mkdirSync(path.join(siteRoot, 'Docs', 'Sub'), { recursive: true })
    fs.writeFileSync(path.join(siteRoot, 'Docs', 'Sub', 'file.txt'), '')
    const parsed = parseShareUrl('https://contoso.sharepoint.com/sites/S/Docs/Sub/file.txt')
    const result = resolveLocalPath(parsed, { OneDriveCommercial: siteRoot }, root)
    expect(result.resolvedPath).toBe(path.join(siteRoot, 'Docs', 'Sub', 'file.txt'))
  })

  it('finds a candidate root via a home-directory scan when no env var is set', () => {
    const scanHome = path.join(root, 'scan-home')
    const scanRoot = path.join(scanHome, 'OneDrive - Contoso')
    fs.mkdirSync(path.join(scanRoot, 'Reports'), { recursive: true })
    fs.writeFileSync(path.join(scanRoot, 'Reports', 'budget.xlsx'), '')
    const parsed = parseShareUrl('https://contoso.sharepoint.com/sites/TeamSite/Reports/budget.xlsx')
    const result = resolveLocalPath(parsed, {}, scanHome)
    expect(result.resolvedPath).toBe(path.join(scanRoot, 'Reports', 'budget.xlsx'))
  })

  it('returns null with the list of tried paths when nothing matches', () => {
    const parsed = parseShareUrl('https://contoso.sharepoint.com/sites/TeamSite/Reports/budget.xlsx')
    const result = resolveLocalPath(parsed, {}, path.join(root, 'empty-home'))
    expect(result.resolvedPath).toBeNull()
    expect(result.triedPaths).toEqual([])
  })

  it('resolves via the personal OneDrive env var (OneDrive, not OneDriveCommercial)', () => {
    const personalRoot = path.join(root, 'personal-root')
    fs.mkdirSync(path.join(personalRoot, 'Documents'), { recursive: true })
    fs.writeFileSync(path.join(personalRoot, 'Documents', 'notes.docx'), '')
    const parsed = parseShareUrl('https://contoso-my.sharepoint.com/personal/alice_contoso_com/Documents/notes.docx')
    const result = resolveLocalPath(parsed, { OneDrive: personalRoot }, root)
    expect(result.resolvedPath).toBe(path.join(personalRoot, 'Documents', 'notes.docx'))
  })

  it('does not scan for a site-name subfolder for a personal (non-"site") URL, even when the root itself has no direct match', () => {
    // parsed.siteType === 'personal' here, so resolveLocalPath's site-subfolder scan (gated on
    // `parsed.siteType === 'site'`) must never run -- confirmed by there being no subfolder
    // resolution possible at all: only the raw root is ever tried.
    const personalRoot = path.join(root, 'personal-no-subfolder-root')
    fs.mkdirSync(path.join(personalRoot, 'alice_contoso_com - Documents', 'Documents'), { recursive: true })
    fs.writeFileSync(path.join(personalRoot, 'alice_contoso_com - Documents', 'Documents', 'notes.docx'), '')
    const parsed = parseShareUrl('https://contoso-my.sharepoint.com/personal/alice_contoso_com/Documents/notes.docx')
    const result = resolveLocalPath(parsed, { OneDrive: personalRoot }, root)
    expect(result.resolvedPath).toBeNull()
  })

  it('does not try the personal-OneDrive root twice when OneDrive and OneDriveCommercial point at the same directory', () => {
    const sharedRoot = path.join(root, 'shared-commercial-personal-root')
    fs.mkdirSync(sharedRoot, { recursive: true })
    const parsed = parseShareUrl('https://contoso.sharepoint.com/sites/TeamSite/Reports/budget.xlsx')
    const result = resolveLocalPath(parsed, { OneDriveCommercial: sharedRoot, OneDrive: sharedRoot }, root)
    // Every attempted path is under sharedRoot exactly once per distinct segment combination --
    // if candidateRoots failed to dedup, the same set of tried paths would appear twice.
    const uniqueTried = new Set(result.triedPaths)
    expect(uniqueTried.size).toBe(result.triedPaths.length)
  })
})
