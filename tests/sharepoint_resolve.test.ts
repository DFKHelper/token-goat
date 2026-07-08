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

  it('throws for a non-SharePoint/OneDrive URL', () => {
    expect(() => parseShareUrl('https://example.com/foo')).toThrow(/not a SharePoint\/OneDrive URL/)
  })

  it('throws for an unparseable URL', () => {
    expect(() => parseShareUrl('not a url')).toThrow(/not a valid URL/)
  })

  it('throws when neither /sites/ nor /personal/ appears in the path', () => {
    expect(() => parseShareUrl('https://contoso.sharepoint.com/foo/bar')).toThrow(/could not find a \/sites\/ or \/personal\//)
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
    expect(result.resolvedPath).toBe(path.join(siteRoot, 'documents', 'Reports', 'budget.xlsx'))
  })

  it('resolves a team site nested under a multi-site sync root by matching the site name', () => {
    const multiRoot = path.join(root, 'multi-root')
    fs.mkdirSync(path.join(multiRoot, 'Contoso - TeamSite', 'Reports'), { recursive: true })
    fs.writeFileSync(path.join(multiRoot, 'Contoso - TeamSite', 'Reports', 'budget.xlsx'), '')
    const parsed = parseShareUrl('https://contoso.sharepoint.com/sites/TeamSite/Shared%20Documents/Reports/budget.xlsx')
    const result = resolveLocalPath(parsed, { OneDriveCommercial: multiRoot }, root)
    expect(result.resolvedPath).toBe(path.join(multiRoot, 'Contoso - TeamSite', 'Reports', 'budget.xlsx'))
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
})
