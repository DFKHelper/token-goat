import * as fs from 'node:fs'
import * as path from 'node:path'

import { CliError, out } from './cli.js'
import { buildLineDiff } from './hooks_read.js'
import { displaySafeJson, displaySafeText } from './paths.js'
import { didYouMean, filterSimilarHeadings, findSpecSeparator, listSections } from './read_commands.js'
import { getSessionId } from './session.js'
import {
  contentHash,
  extractCompactFromMarker,
  extractNamedSection,
  formatAge,
  getSkillFilePath,
  incrementSkillHit,
  listOutputs,
  listSkills,
  skillOutputsDir,
  storeCompact,
  storeOutput,
} from './skill_cache.js'
import { formatLocalTimestamp, recordStat, savedTokensFromBytes } from './stats.js'
import { decodeSource, extractErrorMessage, stripLower } from './util.js'

export async function cmdSkillBody(name: string, opts: { compact?: boolean }): Promise<void> {
  const filePath = await getSkillFilePath(name)
  if (filePath === null) {
    throw new CliError(`skill '${name}' not found`)
  }

  const body = decodeSource(fs.readFileSync(filePath))
  if (opts.compact === true) {
    const emitted = extractCompactFromMarker(body) ?? body
    out(emitted)
    const bytesSaved = Buffer.byteLength(body, 'utf8') - Buffer.byteLength(emitted, 'utf8')
    if (bytesSaved > 0) recordStat('skill_body:compact', bytesSaved, savedTokensFromBytes(bytesSaved), undefined, name)
  } else {
    out(body)
  }
  await incrementSkillHit(name)
}

export async function cmdSkillCompact(name: string | undefined, opts: { path?: string; all?: boolean }): Promise<void> {
  const sessionId = getSessionId()

  if (opts.all === true) {
    const skills = await listSkills(sessionId)
    let regenerated = 0
    let skipped = 0
    let noMarker = 0
    let unresolvable = 0
    for (const skill of skills) {
      const filePath = await getSkillFilePath(skill.name)
      if (!filePath) {
        unresolvable++
        continue
      }
      let body: string
      try {
        body = decodeSource(fs.readFileSync(filePath))
      } catch {
        unresolvable++
        continue
      }
      const compact = extractCompactFromMarker(body)
      if (compact === null) {
        noMarker++
        continue
      }
      const sourceSha = contentHash(body)
      if (skill.compactStale === false) {
        skipped++
      } else {
        await storeCompact(sessionId, skill.name, compact, sourceSha)
        regenerated++
      }
    }
    const parts = [`Regenerated ${regenerated}, skipped ${skipped} (fresh)`]
    if (noMarker > 0) parts.push(`no marker ${noMarker}`)
    if (unresolvable > 0) parts.push(`unresolvable ${unresolvable}`)
    out(`${parts.join(', ')}, total ${skills.length}.`)
    if (noMarker > 0) {
      out(`${noMarker} cached skill${noMarker === 1 ? ' has' : 's have'} no COMPACT_END marker and cannot be compacted; run \`token-goat skill-size\` for per-skill marker recommendations.`)
    }
    return
  }

  let body: string
  let cacheName: string
  let sourcePath: string

  if (opts.path !== undefined && opts.path !== '') {
    if (!opts.path.trim()) {
      throw new CliError('--path cannot be empty')
    }
    if (!fs.existsSync(opts.path)) {
      throw new CliError(`skill file not found: ${opts.path}`)
    }
    try {
      body = fs.readFileSync(opts.path, 'utf-8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CliError(`skill file not found: ${opts.path}`)
      }
      throw new CliError(`failed to read skill file '${opts.path}': ${extractErrorMessage(e)}`)
    }
    cacheName = name ?? path.basename(path.dirname(path.resolve(opts.path)))
    sourcePath = path.resolve(opts.path)
  } else {
    if (name === undefined || !name.trim()) {
      throw new CliError('skill-compact requires a <name> or --path <file>')
    }
    const filePath = await getSkillFilePath(name)
    if (filePath === null) {
      throw new CliError(`skill '${name}' not found`)
    }
    body = fs.readFileSync(filePath, 'utf-8')
    cacheName = name
    sourcePath = filePath
  }

  await storeOutput(sessionId, cacheName, body, { sourcePath })
  const compact = extractCompactFromMarker(body)
  if (compact === null) {
    out(`Skill '${cacheName}' has no COMPACT_END marker — nothing to compact.`)
    return
  }
  const sourceSha = contentHash(body)
  await storeCompact(sessionId, cacheName, compact, sourceSha)
  out(`Cached compact for skill '${cacheName}'.`)
}

async function countSkillsHiddenBySession(sessionId: string | undefined): Promise<number> {
  if (sessionId === undefined) return 0
  return (await listSkills()).length
}

export async function cmdSkillList(opts: { json?: boolean; sessionId?: string }): Promise<void> {
  const skills = await listSkills(opts.sessionId)
  if (opts.json === true) {
    const json = skills.map((s) => ({
      name: s.name,
      skill_name: s.name,
      body_bytes: s.bodyLen,
      compact_bytes: s.compactLen,
      has_marker: s.hasMarker,
      compact_stale: s.compactStale,
      hit_count: s.hitCount,
      age_ms: s.ageMs,
    }))
    out(displaySafeJson(json))
  } else {
    const lines = skills.map((s) => {
      const bodyKb = (s.bodyLen / 1024).toFixed(1)
      const compactKb = s.compactLen > 0 ? (s.compactLen / 1024).toFixed(1) : '-'
      const marker = s.hasMarker ? 'yes' : 'no'
      const staleStatus = s.compactLen === 0 ? '[no-compact]' : (s.compactStale === true ? '[stale]' : s.compactStale === false ? '[fresh]' : '[unknown]')
      const age = formatAge(s.ageMs)
      return `${s.name.padEnd(25)} ${bodyKb.padStart(6)}K  ${compactKb.padStart(6)}K  ${marker}  ${s.hitCount.toString().padStart(3)}  ${age.padStart(3)}  ${staleStatus}`
    })
    const header = `${'Name'.padEnd(25)} ${'Body'.padStart(6)}  ${'Compact'.padStart(6)}  Marker  Hits  Age  Status`
    if (skills.length === 0) {
      const hidden = await countSkillsHiddenBySession(opts.sessionId)
      if (hidden > 0) {
        out(`No skills cached for session '${opts.sessionId}' (${hidden} cached under other sessions).`)
        return
      }
      out('No skills cached yet.')
      return
    }
    out([header, ...lines].join('\n'))
  }
}

export async function cmdSkillSize(opts: { sessionId?: string }): Promise<void> {
  const skills = await listSkills(opts.sessionId)
  let totalBody = 0
  let totalCompact = 0
  for (const skill of skills) {
    totalBody += skill.bodyLen
    totalCompact += skill.compactLen
  }
  const lines = [
    `# token-goat skill cache (${skills.length} skills)`,
    `Body:    ${totalBody} bytes`,
    `Compact: ${totalCompact} bytes`,
  ]
  const hiddenBySession = skills.length === 0 ? await countSkillsHiddenBySession(opts.sessionId) : 0
  if (hiddenBySession > 0) {
    lines.push(`(${hiddenBySession} cached under other sessions, hidden by --session-id ${opts.sessionId})`)
  }

  if (skills.length > 0) {
    lines.push('')
    lines.push('## Per-skill breakdown')
  }
  for (const skill of skills) {
    const bodyKb = (skill.bodyLen / 1024).toFixed(1)
    const compactKb = skill.compactLen > 0 ? (skill.compactLen / 1024).toFixed(1) : '-'
    lines.push(`  ${displaySafeText(skill.name).padEnd(25)} body: ${bodyKb.padStart(6)}K  compact: ${compactKb.padStart(6)}K`)
  }

  const noCompactLargeSkills = skills.filter((s) => s.compactLen === 0 && s.bodyLen > 6000)
  if (noCompactLargeSkills.length > 0) {
    lines.push('')
    lines.push('## Recommendations')
    for (const skill of noCompactLargeSkills) {
      const estimatedTokens = Math.floor(skill.bodyLen / 4)
      lines.push(`  ${displaySafeText(skill.name)}: add <!-- COMPACT_END --> marker (body ~${estimatedTokens}tok, no compact slice)`)
    }
  }

  out(lines.join('\n'))
}

export async function cmdSkillHistory(opts: { json?: boolean }): Promise<void> {
  const metas = (await listOutputs())
    .map((m) => ({ outputId: m.outputId, skillName: m.skillName, bytes: m.bodyBytes, truncated: m.truncated, ts: m.ts }))
    .sort((a, b) => b.ts - a.ts)

  if (opts.json === true) {
    const json = metas.map((m) => ({
      output_id: m.outputId,
      skill_name: m.skillName,
      bytes: m.bytes,
      truncated: m.truncated,
      timestamp: m.ts,
    }))
    out(displaySafeJson(json))
  } else {
    const lines = metas.map((m) => {
      const timeStr = formatLocalTimestamp(new Date(m.ts))
      const truncMarker = m.truncated ? ' [truncated]' : ''
      return `${m.outputId.padEnd(40)} ${m.skillName.padEnd(25)} ${m.bytes.toString().padStart(8)} bytes  ${timeStr}${truncMarker}`
    })
    const header = `${'Output ID'.padEnd(40)} ${'Skill'.padEnd(25)} ${'Bytes'.padStart(8)}  Timestamp`
    if (metas.length === 0) {
      out('No cached skill versions yet.')
      return
    }
    out([header, ...lines].join('\n'))
  }
}

export async function cmdSkillDiff(name: string): Promise<void> {
  if (!name || !name.trim()) {
    throw new CliError('skill-diff requires a <name>')
  }
  const dir = skillOutputsDir()
  const versions = (await listOutputs())
    .filter((m) => m.skillName === name)
    .sort((a, b) => b.ts - a.ts)

  if (versions.length === 0) {
    out(`no cached versions of '${name}'`)
    return
  }
  if (versions.length < 2) {
    out(`only one cached version of '${name}'`)
    return
  }

  const newer = versions[0]!
  const older = versions[1]!
  const newerBody = await fs.promises.readFile(path.resolve(dir, `${newer.outputId}.txt`), 'utf-8').catch(() => null)
  const olderBody = await fs.promises.readFile(path.resolve(dir, `${older.outputId}.txt`), 'utf-8').catch(() => null)
  if (newerBody === null || olderBody === null) {
    out(`a cached version of '${name}' was evicted while diffing -- try again`)
    return
  }
  const diff = buildLineDiff(olderBody, newerBody, name)
  out(diff)
}

export async function cmdSkillSection(nameHeading: string, headingArg?: string): Promise<void> {
  if (!nameHeading) {
    throw new CliError('skill-section requires "<name>::<heading>" or <name> <heading>')
  }
  let skillName: string
  let heading: string
  if (headingArg) {
    skillName = nameHeading
    heading = headingArg
  } else {
    const sepIdx = findSpecSeparator(nameHeading)
    if (sepIdx === -1) {
      throw new CliError('skill-section requires "<name>::<heading>" format or <name> <heading> arguments')
    }
    skillName = nameHeading.slice(0, sepIdx)
    heading = nameHeading.slice(sepIdx + 2)
  }

  const filePath = await getSkillFilePath(skillName)
  if (!filePath) {
    throw new CliError(`skill '${skillName}' not found`)
  }
  const body = decodeSource(fs.readFileSync(filePath))
  const extracted = extractNamedSection(body, heading)
  if (!extracted) {
    const allHeadings = listSections(filePath)
    const wanted = stripLower(heading)
    if (allHeadings.some((h) => stripLower(h) === wanted)) {
      throw new CliError(`Section '${heading}' in skill '${skillName}' is present but empty`)
    }
    const messages = [`Section '${heading}' not found in skill '${skillName}'`]
    const available = filterSimilarHeadings(allHeadings, heading)
    if (available.length > 0) messages.push(didYouMean(available))
    else if (allHeadings.length === 0) messages.push(`skill '${skillName}' has no headings`)
    else messages.push(`Try: token-goat outline ${filePath}`)
    throw new CliError(messages.join('\n'))
  }
  out(extracted)
}
