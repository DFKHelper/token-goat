/** Decides which build owns the freshness stamps in a shared index. Several builds can write one `global.db` at once (the global install the hooks run, the `dist` the daemon runs, a worktree or a test pointed at the real data dir), and each build's fingerprints differ. Every freshness gate treats a stamp that is not its own as stale, so two builds took turns re-marking each other's rows: one reparsed, re-embedded and re-queued the index, the other did it back, and the daemon spent hours of CPU on files nobody edited. The rule that ends it: the newest build (by version, then first to record on a tie) is the authority, and a build that is not the authority treats a foreign stamp as current instead of rewriting it. Kept out of embeddings.ts and parser_stamp.ts on purpose where possible: those are hashed into the fingerprints, so only the one call in ensureEmbeddingProvenance lives there. */

import type { SqliteDatabase } from './sqlite_driver.js'
import { getDb } from './db.js'
import { EMBED_FINGERPRINT } from './embed_fingerprint.js'
import { PARSER_FINGERPRINT } from './parser_fingerprint.js'
import { parserFingerprintForLanguage } from './parser_stamp.js'
import { VERSION } from './version.js'

const AUTHORITY_TTL_MS = 30_000

/** How a build asks for the authority: `auto` only outranks by version; `explicit` (a plain `token-goat index`) also wins a version tie, so a same-version rebuild with new fingerprints converges; `override` (`index --force`) wins whatever is recorded, a downgrade included. */
export type StampClaim = 'auto' | 'explicit' | 'override'

const identifiers = (v: string): { core: number[]; pre: string[] } => {
  const [main = '', ...rest] = v.split('+')[0]!.split('-')
  const pre = rest.join('-')
  return { core: main.split('.').map((p) => (Number.isFinite(Number(p)) ? Number(p) : 0)), pre: pre === '' ? [] : pre.split('.') }
}

/** Orders versions per semver: numeric core first, then a prerelease sorts before its release and prerelease identifiers compare numerically when both are numbers (numbers before words); build metadata is ignored; a non-numeric core part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const x = identifiers(a)
  const y = identifiers(b)
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn && Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    if (!pn && p !== q) return p < q ? -1 : 1
  }
  return 0
}

type Build = { version: string; fingerprint: string }
const ownBuild = (): Build => ({ version: VERSION, fingerprint: `${PARSER_FINGERPRINT}/${EMBED_FINGERPRINT}` })

/** Read the recorded authority and, when this build may take it, record it, inside one BEGIN IMMEDIATE so two builds cannot both read the old row and both win. Returns undefined when the table cannot be read or written (SQLITE_BUSY included), so a caller can tell a refusal from a failure. */
function tryClaim(db: SqliteDatabase, build: Build, claim: StampClaim): boolean | undefined {
  try {
    db.exec('CREATE TABLE IF NOT EXISTS stamp_authority (id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT NOT NULL, fingerprint TEXT NOT NULL)')
    const verdict = (): 'owner' | 'refused' | 'takes' => {
      const row = db.prepare('SELECT version, fingerprint FROM stamp_authority WHERE id = 1').get() as { version: string; fingerprint: string } | undefined
      const order = row === undefined ? 1 : compareVersions(build.version, row.version)
      if (row !== undefined && order === 0 && build.fingerprint === row.fingerprint) return 'owner'
      return claim === 'override' || order > 0 || (order === 0 && claim === 'explicit') ? 'takes' : 'refused'
    }
    // The common answers need no write lock, which matters because every read hook asks; only a take is re-judged inside the transaction.
    const first = verdict()
    if (first !== 'takes') return first === 'owner'
    return db
      .transaction((): boolean => {
        const again = verdict()
        if (again !== 'takes') return again === 'owner'
        db.prepare('INSERT INTO stamp_authority (id, version, fingerprint) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, fingerprint = excluded.fingerprint').run(build.version, build.fingerprint)
        return true
      })
      .immediate()
  } catch {
    return undefined
  }
}

/** Whether `build` is the authority after asking for it as `claim`. A failure to read or write answers false: the conservative answer, which treats foreign stamps as current instead of flipping rows into a mass reindex. */
export function claimStampAuthority(db: SqliteDatabase, build: Build = ownBuild(), claim: StampClaim = 'auto'): boolean {
  return tryClaim(db, build, claim) ?? false
}

const _verdicts = new WeakMap<SqliteDatabase, { holds: boolean; at: number }>()

/** Whether this process's build owns the stamps in `db`, re-asked every {@link AUTHORITY_TTL_MS} so a long-lived daemon notices a newer build taking over; a failed ask answers false and is not cached, so the next call retries. */
export function holdsStampAuthority(db: SqliteDatabase): boolean {
  const now = Date.now()
  const seen = _verdicts.get(db)
  if (seen !== undefined && now - seen.at < AUTHORITY_TTL_MS) return seen.holds
  const holds = tryClaim(db, ownBuild(), 'auto')
  if (holds === undefined) return false
  _verdicts.set(db, { holds, at: now })
  return holds
}

/** An explicit `token-goat index` is the user saying this build's view is the one to keep: it takes the authority from an equal or older build (`index --force` from any build), so a same-version rebuild with new fingerprints reparses and converges. */
export function claimAuthorityForIndex(db: SqliteDatabase, force: boolean): void {
  const holds = tryClaim(db, ownBuild(), force ? 'override' : 'explicit')
  if (holds === undefined) _verdicts.delete(db)
  else _verdicts.set(db, { holds, at: Date.now() })
}

/** Whether a stored stamp that is not this build's own counts as current: only a non-authority build accepts a foreign non-empty stamp, because the build that owns the stamps wrote it. */
export function foreignStampCurrent(db: SqliteDatabase, storedSha: string | null | undefined): boolean {
  return storedSha !== undefined && storedSha !== null && storedSha !== '' && !holdsStampAuthority(db)
}

/** Whether a row's `parser_sha` counts as current for a build deciding whether to reparse it: its own stamp always does, and a build that is not the authority also accepts any other non-empty stamp, because that stamp was written by the build that is. */
export function parserStampCurrent(dbPath: string, parserSha: string, language: string): boolean {
  if (parserSha === parserFingerprintForLanguage(language)) return true
  return foreignStampCurrent(getDb(dbPath), parserSha)
}
