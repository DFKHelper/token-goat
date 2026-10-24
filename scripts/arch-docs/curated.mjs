// Curated roles: which documented role is hand-written prose, and how it follows a rename, split or merge. Contract: SKILL.md "Core Invariants" item 3 of the arch-doc-sync skill; the reference engine is sync_arch_docs.py, section "curated.mts".
import { byteCompare } from './table.mjs'
import { templateRole } from './prose.mjs'

const codePoints = (text) => [...text].length

/** The documented role to keep (trimmed), or null to regenerate it when it is empty or is text the engine itself could have generated. */
export function keptRole(existing, generated) {
  const role = existing === undefined ? '' : existing.role.trim()
  return role === '' || generated.has(role) ? null : role
}

/** Notes for curated roles dropped with their module: one per obsolete row whose role is more than a template. */
export function droppedRoleNotes(documented, obsolete) {
  const notes = []
  for (const key of obsolete) {
    const row = documented.get(key)
    const role = row === undefined ? '' : row.role.trim()
    if (role === '') continue
    const template = templateRole(key, row.layer)
    if (role !== template && role !== `${template}/`) notes.push(`drop: discarded role from ${key} (module no longer exists)`)
  }
  return notes
}

/** Roles the engine could have written for `key` under its documented layer: its file and folder templates and its HEAD auto role. */
function generatedRolesOf(key, row, headAutoRole) {
  const template = templateRole(key, row.layer)
  const roles = new Set([template, `${template}/`])
  const head = headAutoRole(key, row.layer)
  if (head !== null) roles.add(head)
  return roles
}

/** The old role if it is curated for the old key and is not what the new key would get anyway. */
function carriedRole(row, generated, newAutoRole) {
  const role = row.role.trim()
  return keptRole(row, generated) === null || role === newAutoRole.trim() ? null : role
}

/** Moves where the old key is gone and documented and the new key exists (documented or not). */
function componentMoves(data) {
  const moves = new Map()
  for (const { from, to } of data.records) {
    if (from === to || !data.isComponent(from) || !data.isComponent(to)) continue
    if (data.current.has(from) || !data.current.has(to)) continue
    const row = data.documented.get(from)
    if (row === undefined) continue
    moves.set(`${from}\0${to}`, { from, to, role: carriedRole(row, generatedRolesOf(from, row, data.headAutoRole), data.autoRole(to)) })
  }
  return [...moves.values()]
}

function groupBy(moves, keyOf) {
  const groups = new Map()
  for (const move of moves) {
    const key = keyOf(move)
    groups.set(key, [...(groups.get(key) ?? []), move])
  }
  return [...groups.entries()].sort((a, b) => byteCompare(a[0], b[0]))
}

/** The documented role a rename target already holds, when it is curated: none of the roles the engine generates for it. */
function targetCuratedRole(data, to) {
  const row = data.documented.get(to)
  if (row === undefined) return null
  return keptRole(row, new Set([...generatedRolesOf(to, row, data.headAutoRole), data.autoRole(to)]))
}

/** Re-keys curated roles from renamed-away paths. `data`: documented rows by path, `current` the set of modules that exist, `records` the `{from, to}` renames, `isComponent(path)`, `autoRole(path)` and `headAutoRole(path, layer)` (the auto role the path had at HEAD, or null). A split suffixes each child's role with ` (split from <old>)`; a merge keeps the longest of the incoming roles and the target's own (ties: the target's own, then the bytewise-smaller old path). Returns the role overrides by new path, the notes, and the old paths that were renamed away. */
export function resolveRenames(data) {
  const moves = componentMoves(data)
  const bySource = groupBy(moves, (move) => move.from)
  const splitSources = new Set(bySource.filter(([, group]) => group.length > 1).map(([from]) => from))
  const notes = []
  for (const [from, group] of bySource) {
    if (splitSources.has(from) && !group.every((move) => move.role === null)) {
      notes.push(`split: ${from} -> ${group.map((move) => move.to).sort(byteCompare).join(', ')}`)
    }
  }
  const overrides = new Map()
  for (const [to, group] of groupBy(moves, (move) => move.to)) {
    const incoming = group.filter((move) => move.role !== null).map((move) => [move.from, splitSources.has(move.from) ? `${move.role} (split from ${move.from})` : move.role])
    const own = targetCuratedRole(data, to)
    const candidates = [...incoming, ...(own === null ? [] : [[to, own]])].sort(
      (a, b) => codePoints(b[1]) - codePoints(a[1]) || Number(a[0] !== to) - Number(b[0] !== to) || byteCompare(a[0], b[0]),
    )
    if (candidates.length === 0) continue
    const [keptFrom, keptText] = candidates[0]
    overrides.set(to, keptText)
    if (keptFrom !== to && !splitSources.has(keptFrom)) notes.push(`rename: ${keptFrom} -> ${to}`)
    for (const [loserFrom] of candidates.slice(1)) notes.push(`merge: discarded curated role from ${loserFrom} (kept ${keptFrom}) for ${to}`)
  }
  return { overrides, notes, renamedAway: new Set(moves.map((move) => move.from)) }
}
