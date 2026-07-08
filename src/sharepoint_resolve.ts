/**
 * Best-effort resolution of a SharePoint/OneDrive sharing URL to a local synced file
 * path, so `token-goat` can read a document an agent was only given a share link for
 * instead of failing outright. Purely local: no network call, no Graph API, no
 * credentials -- OneDrive's local sync-folder layout is undocumented, so this makes a
 * conservative attempt and reports honestly when it can't find a match.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface ParsedShareUrl {
  tenant: string
  siteType: 'site' | 'personal'
  siteName: string
  libraryPath: string
}

const TENANT_HOST_RE = /^([a-z0-9-]+?)(-my)?\.sharepoint\.com$/i

/** Parses a SharePoint/OneDrive-for-Business sharing URL into its tenant/site/path
 * pieces. Strips the `/:x:/r/`-style view-mode prefix Office adds to "open in app"
 * links. Throws for URLs this project doesn't have enough local context to resolve
 * (short `1drv.ms` links need a network redirect to expand, which this stays out of). */
export function parseShareUrl(url: string): ParsedShareUrl {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`not a valid URL: ${url}`)
  }

  if (/^1drv\.ms$/i.test(u.hostname)) {
    throw new Error(`${url} is a shortened OneDrive link; it needs a network redirect to expand, which this tool doesn't follow -- use the full sharepoint.com/onedrive.live.com URL instead`)
  }

  const tenantMatch = TENANT_HOST_RE.exec(u.hostname)
  if (!tenantMatch) {
    throw new Error(`not a SharePoint/OneDrive URL: ${url}`)
  }
  const tenant = tenantMatch[1] as string

  let pathname = decodeURIComponent(u.pathname)
  pathname = pathname.replace(/^\/:[a-z]:\/[a-z]\//i, '/')
  const segments = pathname.split('/').filter(Boolean)

  const personalIdx = segments.indexOf('personal')
  if (personalIdx !== -1) {
    const siteName = segments[personalIdx + 1] ?? ''
    const libraryPath = segments.slice(personalIdx + 2).join('/')
    return { tenant, siteType: 'personal', siteName, libraryPath }
  }

  const sitesIdx = segments.indexOf('sites')
  if (sitesIdx !== -1) {
    const siteName = segments[sitesIdx + 1] ?? ''
    const libraryPath = segments.slice(sitesIdx + 2).join('/')
    return { tenant, siteType: 'site', siteName, libraryPath }
  }

  throw new Error(`could not find a /sites/ or /personal/ segment in URL: ${url}`)
}

const LIBRARY_ALIASES: Record<string, string> = {
  'shared documents': 'documents',
}

function normalizeLibrarySegment(seg: string): string {
  return LIBRARY_ALIASES[seg.toLowerCase()] ?? seg
}

function candidateRoots(env: NodeJS.ProcessEnv, home: string): string[] {
  const roots: string[] = []
  const commercial = env['OneDriveCommercial']
  const personal = env['OneDrive']
  if (commercial !== undefined) roots.push(commercial)
  if (personal !== undefined && personal !== commercial) roots.push(personal)
  try {
    for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
      if (entry.isDirectory() && /onedrive/i.test(entry.name)) {
        const full = path.join(home, entry.name)
        if (!roots.includes(full)) roots.push(full)
      }
    }
  } catch {
    // best-effort; an unreadable/missing home dir just means no scan-based candidates
  }
  return roots
}

export interface ResolveResult {
  resolvedPath: string | null
  triedPaths: string[]
}

/** Best-effort match of a parsed share URL against locally-synced OneDrive/SharePoint
 * folders. Tries each candidate sync root with the library path joined as-is, then
 * with the default document library's local alias ("Shared Documents" syncs locally
 * as "Documents"), then -- for a team site -- scans the root for a subfolder whose
 * name contains the site name (multi-site sync roots nest one folder per site). */
export function resolveLocalPath(
  parsed: ParsedShareUrl,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): ResolveResult {
  const roots = candidateRoots(env, home)
  const libSegments = parsed.libraryPath.split('/').filter(Boolean)
  const triedPaths: string[] = []

  for (const root of roots) {
    const rawJoined = path.join(root, ...libSegments)
    triedPaths.push(rawJoined)
    if (fs.existsSync(rawJoined)) return { resolvedPath: rawJoined, triedPaths }

    if (libSegments.length > 0) {
      const aliasedFirst = normalizeLibrarySegment(libSegments[0] as string)
      if (aliasedFirst !== libSegments[0]) {
        const aliasedJoined = path.join(root, aliasedFirst, ...libSegments.slice(1))
        triedPaths.push(aliasedJoined)
        if (fs.existsSync(aliasedJoined)) return { resolvedPath: aliasedJoined, triedPaths }
      }
    }

    if (parsed.siteType === 'site' && parsed.siteName.length > 0) {
      try {
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.toLowerCase().includes(parsed.siteName.toLowerCase())) {
            const siteJoined = path.join(root, entry.name, ...libSegments.slice(1))
            triedPaths.push(siteJoined)
            if (fs.existsSync(siteJoined)) return { resolvedPath: siteJoined, triedPaths }
          }
        }
      } catch {
        // best-effort; an unreadable root just means no site-subfolder candidates
      }
    }
  }

  return { resolvedPath: null, triedPaths }
}
