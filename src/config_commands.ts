/**
 * D3 commands: config, project, compact-doc, fetch-image, history.
 *
 * config  <list|get|set|validate> [key] [value] [--json]
 * project <list|exclude|prune>   [path]         [--json]
 * compact-doc <path> [--heading H] [--json]
 * fetch-image <url>  [--out path]  [--json]
 * history [--limit N] [--json]
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parse } from 'smol-toml'

import { loadConfig, loadPersistedConfig, saveConfig, invalidateConfigCache, defaultConfig, CONFIG_KEY_ENV_OVERRIDES, validateNumericField, validateEnumField, getLastConfigParseError, getProjectConfigInfo, resolveConfigKeyLayer } from './config.js'
import type { ConfigKeyLayer } from './config.js'
import { compactDoc, compactPathFor, isCompactFresh, readCompactBody, buildExtractiveCompact, writeCompact } from './doc_compact.js'
import { shrinkImage } from './image_shrink.js'
import { findProject } from './project.js'
import { findSystemTempFiles, pruneSystemTempFiles } from './index_prune.js'
import { listBlobs } from './disk_cache.js'
import { BASH_OUTPUT_SUBDIR } from './bash_output_cache.js'
import { WEB_OUTPUT_SUBDIR } from './web_cache.js'
import { ensureNewline, ensureDirSync, LOCK_WAIT_MS_HARDENED, withFileLock, sleepSync, withExtension, atomicWriteBytes, requireNonNegativeStrictInt, requirePositiveStrictInt, foldPath, extractErrorMessage } from './util.js'
import { normalizePath } from './paths.js'
import { colorStdout, stripAnsi } from './render/ansi.js'
import { configPath } from './constants.js'
import { performHttpFetch } from './webfetch.js'
import { recordStat } from './stats.js'

function emit(text: string): void {
  const payload = colorStdout() ? text : stripAnsi(text)
  process.stdout.write(ensureNewline(payload))
}

function emitErr(text: string): void {
  process.stderr.write(ensureNewline(text))
}

/** Ensure the config parent directory exists then call saveConfig. */
function saveConfigSafe(cfg: Parameters<typeof saveConfig>[0]): void {
  ensureDirSync(path.dirname(configPath()))
  saveConfig(cfg)
}

// ── Levenshtein distance (capped at threshold to save time) ─────────────────

function levenshtein(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr.push(Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost))
    }
    prev.splice(0, prev.length, ...curr)
  }
  return prev[b.length] ?? cap + 1
}

function closestKeys(unknown: string, known: string[]): string[] {
  return known
    .map((k) => ({ k, d: levenshtein(unknown, k) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => x.k)
}

/** ` (did you mean: a, b?)` suffix for an unrecognized dotted config key, or '' if no near match. */
function didYouMeanKeySuffix(unknownKey: string): string {
  const knownKeys = flattenConfig(defaultConfig() as unknown as Record<string, unknown>).map(([k]) => k)
  const suggestions = closestKeys(unknownKey, knownKeys)
  return suggestions.length > 0 ? ` (did you mean: ${suggestions.join(', ')}?)` : ''
}

// ── Nested path walk helpers ─────────────────────────────────────────────────

/** Walk a dotted path over a plain object, returning the value or null on miss. */
function walkGet(obj: Record<string, unknown>, parts: string[]): { found: true; value: unknown } | { found: false } {
  let cur: unknown = obj
  for (const part of parts) {
    if (typeof cur !== 'object' || cur === null) return { found: false }
    cur = (cur as Record<string, unknown>)[part]
    if (cur === undefined) return { found: false }
  }
  return { found: true, value: cur }
}

/** Walk to the parent of the leaf path, returning a ref and the leaf key. */
function walkParent(obj: Record<string, unknown>, parts: string[]): { parent: Record<string, unknown>; leaf: string } | null {
  if (parts.length === 0) return null
  let cur: unknown = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur !== 'object' || cur === null) return null
    cur = (cur as Record<string, unknown>)[parts[i]!]
    if (typeof cur !== 'object' || cur === null) return null
  }
  const leaf = parts[parts.length - 1]!
  return { parent: cur as Record<string, unknown>, leaf }
}

/** Coerce `raw` string to the same JS type as `existing`. */
function coerce(raw: string, existing: unknown, defaultValue?: unknown): unknown {
  if (typeof existing === 'boolean') {
    if (raw === 'true' || raw === '1') return true
    if (raw === 'false' || raw === '0') return false
    throw new Error(`expected a boolean ('true', 'false', '1', or '0'), got: ${raw}`)
  }
  if (typeof existing === 'number') {
    // Number('') === 0, which is finite, so a blank value would otherwise silently coerce to
    // 0 instead of surfacing the typo -- reject it explicitly before the finite check, same
    // guard already applied to the analogous case in csv_query.ts::parseWhereSpecs.
    if (raw.trim() === '') throw new Error(`expected a number, got: ${raw}`)
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`expected a number, got: ${raw}`)
    return n
  }
  if (Array.isArray(existing)) {
    // A non-empty existing array of numbers means this field is a number list (e.g.
    // hints.backoff_thresholds) — parse each comma-separated segment as a number instead of
    // leaving it as a string, or a later load-time validator silently filters the whole list
    // down to an empty array. An empty existing array carries no element-type information of
    // its own (e.g. the field was previously cleared to []), so fall back to the default
    // config's array at this key to recover the declared type.
    const typeSample = existing.length > 0 ? existing : (Array.isArray(defaultValue) ? defaultValue : existing)
    const isNumberList = typeSample.length > 0 && typeSample.every((x) => typeof x === 'number')
    if (raw.trimStart().startsWith('[')) {
      let parsed: unknown[]
      try {
        parsed = JSON.parse(raw) as unknown[]
      } catch {
        throw new Error(`expected a JSON array, got: ${raw}`)
      }
      // Validate element types against the same type sample the comma-separated branch below
      // uses, instead of accepting any JSON array unchecked — otherwise a number-list key set
      // to a JSON array of non-numeric strings reports success here but the load-time
      // validator (validatedIntList) silently filters it down to an empty array later.
      if (isNumberList && !parsed.every((x) => typeof x === 'number' && Number.isFinite(x))) {
        throw new Error(`expected a JSON array of numbers, got: ${raw}`)
      }
      if (!isNumberList && !parsed.every((x) => typeof x === 'string')) {
        throw new Error(`expected a JSON array of strings, got: ${raw}`)
      }
      return parsed
    }
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
    if (isNumberList) {
      return parts.map((p) => {
        const n = Number(p)
        if (!Number.isFinite(n)) throw new Error(`expected a number in list, got: ${p}`)
        return n
      })
    }
    return parts
  }
  return raw
}

// ── config ───────────────────────────────────────────────────────────────────

/** Flatten a Config (plain object) into key=value pairs using dot notation. */
function flattenConfig(obj: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  const pairs: Array<[string, unknown]> = []
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      pairs.push(...flattenConfig(v as Record<string, unknown>, full))
    } else {
      pairs.push([full, v])
    }
  }
  return pairs
}

/** Render a raw config value the way both the `list` key=value lines and the annotations below spell it. */
function renderValue(v: unknown): string {
  return JSON.stringify(v)
}

/**
 * The trailing `# ...` comment naming a non-default resolving layer, or `''` for `global`.
 *
 * Single source of every user-facing attribution string: `get` and `list` both call this, so
 * they cannot drift into describing the same key differently. The empty string for `global`
 * is load-bearing — that is the dominant path and its output must stay byte-identical.
 */
function layerAnnotation(state: ConfigKeyLayer): string {
  switch (state.layer) {
    case 'global':
      return ''
    case 'env':
      return `  # from $${state.envVar}`
    case 'project':
      return '  # from .token-goat.toml'
    case 'project-invalid':
      return `  # .token-goat.toml sets ${renderValue(state.rawValue)}${state.reason !== null ? ` (${state.reason})` : ''}, not in effect; using ${renderValue(state.effectiveValue)}`
    case 'project-unparsed':
      // smol-toml's message is multi-line (it renders the offending source with a caret). A trailing `# ...` comment is a one-line suffix by construction, and `VALUE=$(token-goat config get k)` would otherwise capture several lines of it, so flatten to one line here; the full multi-line text is still available verbatim from `--json` and from the stderr warning loadConfig already emits.
      return `  # .token-goat.toml failed to parse (${state.parseError.replace(/\s+/g, ' ').trim()}); ignored`
    default: {
      const exhaustive: never = state
      return exhaustive
    }
  }
}

/** The `--json` twin of {@link layerAnnotation}: a closed `source` discriminator plus that state's extra fields. `get` spreads this beside `key`/`value`; `list` files it under `_sources[key]`. */
function layerJson(state: ConfigKeyLayer): Record<string, unknown> {
  switch (state.layer) {
    case 'global':
      return { source: 'global' }
    case 'env':
      return { source: 'env', envVar: state.envVar }
    case 'project':
      return { source: 'project', projectPath: state.path }
    case 'project-invalid':
      return { source: 'project_invalid', projectPath: state.path, projectValue: state.rawValue, reason: state.reason }
    case 'project-unparsed':
      return { source: 'project_unparsed', projectPath: state.path, parseError: state.parseError }
    default: {
      const exhaustive: never = state
      return exhaustive
    }
  }
}

export function cmdConfig(opts: { action: string; key?: string; value?: string; json?: boolean }): void {
  const { action } = opts

  if (action === 'list') {
    const cfg = loadConfig() as unknown as Record<string, unknown>
    // "What's actually in effect and why": a per-project .token-goat.toml overrides the
    // global config.toml for the keys it sets, so surface which keys (if any) came from it
    // alongside the effective values loadConfig() already merged in.
    const projectInfo = getProjectConfigInfo()
    const pairs = flattenConfig(cfg)
    if (opts.json === true) {
      const payload: Record<string, unknown> = { ...cfg }
      if (projectInfo !== null) {
        payload['_project_override'] = {
          path: projectInfo.path,
          keys: projectInfo.keys,
          parse_error: projectInfo.parseError,
        }
      }
      // Per-key layer attribution, built from the same resolver `get --json` uses so the two commands cannot disagree about a key. Only non-global keys appear: emitting a `global` entry for all ~200 keys would bury the handful that actually came from somewhere else, and its absence is what "global" means.
      const sources: Record<string, unknown> = {}
      for (const [k, v] of pairs) {
        const state = resolveConfigKeyLayer(k, v, cfg, projectInfo)
        if (state.layer !== 'global' && state.layer !== 'project-unparsed') sources[k] = layerJson(state)
      }
      if (Object.keys(sources).length > 0) payload['_sources'] = sources
      emit(JSON.stringify(payload, null, 2))
      return
    }
    for (const [k, v] of pairs) {
      const state = resolveConfigKeyLayer(k, v, cfg, projectInfo)
      // An unparsed project file is one fact about the whole file, not ~200 per-key facts: the footer below (and `_project_override.parse_error` above) states it once, so repeating it on every line would bury the per-key annotations it sits among. `config get` has no footer, so it renders that same state inline instead -- the states agree, only where each command has room to say it differs.
      emit(`${k} = ${JSON.stringify(v)}${state.layer === 'project-unparsed' ? '' : layerAnnotation(state)}`)
    }
    if (projectInfo !== null) {
      emit('')
      emit(
        projectInfo.parseError !== null
          ? `# project override ${projectInfo.path} failed to parse (${projectInfo.parseError}); ignored`
          : `# project override: ${projectInfo.path}`,
      )
    }
    return
  }

  if (action === 'get') {
    if (!opts.key) {
      throw new Error('config get requires a key (e.g. compact_assist.enabled)')
    }
    const parts = opts.key.split('.')
    const cfg = loadConfig() as unknown as Record<string, unknown>
    const result = walkGet(cfg, parts)
    if (!result.found) {
      throw new Error(`key not found: ${opts.key}${didYouMeanKeySuffix(opts.key)}`)
    }
    // Which layer this value came from, the same question `list` answers per key, resolved by the same helper so the two commands cannot drift. Without it `get` reports a bare value that silently disagrees with config.toml whenever a project .token-goat.toml or an env var is in play, and the user has no way to tell from the output that a second layer decided it.
    const getState = resolveConfigKeyLayer(opts.key, result.value, cfg, getProjectConfigInfo())
    if (opts.json === true) {
      emit(JSON.stringify({ key: opts.key, value: result.value, ...layerJson(getState) }, null, 2))
      return
    }
    // The bare value line stays byte-identical for globally-resolved keys, so `VALUE=$(token-goat config get k)` and every existing caller are unaffected; only a value some other layer decided gains an annotation.
    const rendered = typeof result.value === 'string' ? result.value : JSON.stringify(result.value)
    emit(`${rendered}${layerAnnotation(getState)}`)
    return
  }

  if (action === 'set') {
    if (!opts.key) {
      throw new Error('config set requires a key (e.g. compact_assist.enabled)')
    }
    if (opts.value === undefined) {
      throw new Error('config set requires a value')
    }
    const key = opts.key
    const value = opts.value
    const parts = key.split('.')
    // The load->mutate->save below is a genuine read-modify-write: two concurrent `config
    // set` calls (even on different keys) can each load the pre-update file, mutate their
    // own in-memory copy, and save -- whichever save lands last silently clobbers the
    // other's change, with no error. A short-lived lockfile around just this section
    // serializes concurrent setters, same pattern as session_store.ts's saveSessionState.
    // Losing the race to acquire the lock in time falls back to the old unprotected
    // read-modify-write instead of dropping the update outright.
    const applySet = (): unknown => {
      const cfg = loadPersistedConfig() as unknown as Record<string, unknown>
      // loadPersistedConfig() falls back to defaults on a parse failure exactly like it does
      // for a missing file, so without this check the save below would silently clobber a
      // corrupt-but-possibly-hand-edited config.toml with defaults + this one key, destroying
      // whatever was recoverable in it. Back up the original bytes first so nothing is lost.
      const parseErrAtLoad = getLastConfigParseError()
      if (parseErrAtLoad !== null) {
        try {
          fs.copyFileSync(configPath(), `${configPath()}.bak`)
          emitErr(`config set: warning: config.toml failed to parse (${parseErrAtLoad}); backed up the original to config.toml.bak and rewriting it from defaults`)
        } catch {
          // best-effort — e.g. the file vanished between load and copy; proceed with the set
          // regardless, since refusing outright would leave the user unable to fix a corrupt
          // config via `config set` at all.
        }
      }
      // Test-only seam: widens the load->save window so a regression test can deterministically
      // force a second concurrent `config set` to land its own load+save inside it, instead of
      // relying on OS process-start jitter to (unreliably) produce a collision. No-op unless a
      // test explicitly sets this env var; never set in normal operation.
      const testDelayMs = Number(process.env['TOKEN_GOAT_TEST_RMW_DELAY_MS'] ?? '')
      if (Number.isFinite(testDelayMs) && testDelayMs > 0) sleepSync(testDelayMs)
      const ref = walkParent(cfg, parts)
      if (!ref) {
        throw new Error(`key not found: ${key}${didYouMeanKeySuffix(key)}`)
      }
      const existing = ref.parent[ref.leaf]
      if (existing === undefined) {
        throw new Error(`key not found: ${key}${didYouMeanKeySuffix(key)}`)
      }
      if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
        throw new Error(`config set: '${key}' is a section, not a settable field — set an individual key within it instead (e.g. ${key}.<field>)`)
      }
      const defaultAtKey = walkGet(defaultConfig() as unknown as Record<string, unknown>, parts)
      const coercedValue = coerce(value, existing, defaultAtKey.found ? defaultAtKey.value : undefined)
      ref.parent[ref.leaf] = coercedValue
      if (typeof coercedValue === 'number') {
        // Validate using targeted field validator rather than rebuilding entire config tree.
        // This checks the field's documented bounds and any cross-field constraints (e.g., per-output
        // max must not exceed total max).
        const clamped = validateNumericField(key, coercedValue, cfg as unknown as Record<string, unknown>)
        if (clamped !== undefined && clamped !== coercedValue) {
          throw new Error(`config set: ${key} = ${coercedValue} is outside the allowed range (would be clamped to ${String(clamped)}); rejected`)
        }
      }
      if (typeof coercedValue === 'string') {
        // Symmetric with the numeric-bounds revalidation above, for the handful of string
        // fields whose value must come from a fixed set (e.g. compression.profile). Without
        // this, a typo like `agressive` is accepted and persisted with no error, then silently
        // falls back to a default at runtime (dispatch.ts's PROFILE_CAPS lookup) with no signal
        // to the user that their setting did nothing.
        const allowed = validateEnumField(key, coercedValue)
        if (allowed !== undefined) {
          throw new Error(`config set: ${key} = '${coercedValue}' is not valid; must be one of: ${allowed.join(', ')}`)
        }
      }
      saveConfigSafe(cfg as unknown as Parameters<typeof saveConfig>[0])
      return coercedValue
    }
    // Must exist before the lock file itself can be created (writeFileSync 'wx' throws ENOENT,
    // not EEXIST, against a missing directory -- withFileLock treats that as "can't lock at
    // all" and silently falls back to running unprotected, defeating the lock entirely on a
    // machine that has never run `config set` before).
    ensureDirSync(path.dirname(configPath()))
    const lockPath = path.join(path.dirname(configPath()), '.config.lock')
    // Same reasoning and value as session_store.ts's saveSessionState (see LOCK_WAIT_MS_HARDENED's
    // docstring in util.ts): the default withFileLock budget can plausibly be missed under real
    // machine load with no lock holder actually stuck, and falling back to an unprotected write on
    // that miss would reintroduce the exact clobber this lock exists to prevent.
    const lockResult = withFileLock(lockPath, applySet, { waitMs: LOCK_WAIT_MS_HARDENED })
    const coerced = lockResult === undefined ? applySet() : lockResult
    invalidateConfigCache()
    // The write above only ever touches the env-free persisted config, so if an env var
    // currently overrides this same key, loadConfig() (env-layered, same as `get`/`list`)
    // will keep returning the env-forced value instead of what was just saved — surface
    // that shadowing here or the user is told the change succeeded when it has no runtime
    // effect until the env var is unset.
    const envOverrides = CONFIG_KEY_ENV_OVERRIDES[key]
    if (envOverrides !== undefined) {
      const effective = walkGet(loadConfig() as unknown as Record<string, unknown>, parts)
      // "effective differs from what I just wrote" holds for ANY overriding layer, env or the project .token-goat.toml below, so it cannot on its own justify naming an env var: an unset variable used to get named via a `?? envOverrides[0]` fallback, telling the user to unset something that does not exist while the real culprit went unmentioned. Warn only about a variable actually present in the environment. Merely defined counts -- a defined-but-empty value is a real override for the string-valued keys, and for the numeric/boolean ones the parse rejects it, so the effective value matches and this branch is never reached anyway.
      if (effective.found && effective.value !== coerced) {
        const envVar = envOverrides.find((name) => process.env[name] !== undefined)
        if (envVar !== undefined) {
          emitErr(`config set: warning: ${key} was saved to config.toml, but ${envVar} is currently set and overrides it at runtime — unset ${envVar} for this change to take effect`)
        }
      }
    }
    // Exactly the same silent-no-op the env-shadowing warning above exists to prevent, via the other layer: `config set` writes the GLOBAL config.toml, so if this project's .token-goat.toml also sets this key, the save succeeds and changes nothing here. Warn with the same shape, and only when the project file actually pins this key -- a project config that sets unrelated keys is not shadowing anything.
    // Resolved by the same helper `get`/`list` use, so all three agree about which layer owns this key. Note this warns for project-invalid too, and deliberately: _buildConfig merges the project raw tree OVER the global one and validates the merged result, so even a value that gets clamped or coerced still displaces what was just saved -- the save is every bit as much a no-op here as in the clean case, just with a different value winning. The invalid case names both values so the reader is not told to look for a 4321 that `get` reports as 1000.
    const effectiveCfg = loadConfig() as unknown as Record<string, unknown>
    const setEffective = walkGet(effectiveCfg, parts)
    const setState = resolveConfigKeyLayer(key, setEffective.found ? setEffective.value : undefined, effectiveCfg, getProjectConfigInfo())
    if (setState.layer === 'project') {
      emitErr(`config set: warning: ${key} was saved to config.toml, but ${setState.path} also sets it and overrides it in this project — remove it there for this change to take effect here`)
    } else if (setState.layer === 'project-invalid') {
      emitErr(`config set: warning: ${key} was saved to config.toml, but ${setState.path} sets it to ${JSON.stringify(setState.rawValue)}${setState.reason !== null ? ` (${setState.reason})` : ''} and still overrides it in this project, taking effect as ${JSON.stringify(setState.effectiveValue)} — remove it there for this change to take effect here`)
    }
    if (opts.json === true) {
      emit(JSON.stringify({ key, value: coerced }, null, 2))
      return
    }
    emit(`${key} = ${JSON.stringify(coerced)}`)
    return
  }

  if (action === 'validate') {
    const cfgFile = configPath()
    let raw: Record<string, unknown> = {}
    let parseErr: string | null = null
    try {
      const text = fs.readFileSync(cfgFile, 'utf8')
      raw = parse(text) as Record<string, unknown>
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        parseErr = extractErrorMessage(e)
      }
    }

    const defCfg = defaultConfig() as unknown as Record<string, unknown>
    const findings: Array<{ kind: string; key: string; suggestion?: string }> = []

    if (parseErr !== null) {
      findings.push({ kind: 'parse_error', key: cfgFile, suggestion: parseErr })
    } else {
      for (const section of Object.keys(raw)) {
        const knownSecs = Object.keys(defCfg)
        if (!knownSecs.includes(section)) {
          const suggestions = closestKeys(section, knownSecs)
          const finding: { kind: string; key: string; suggestion?: string } = { kind: 'unknown_section', key: section }
          if (suggestions.length > 0) finding.suggestion = suggestions.join(', ')
          findings.push(finding)
          continue
        }
        const defSection = defCfg[section] as Record<string, unknown>
        const rawSection = raw[section]
        if (typeof rawSection !== 'object' || rawSection === null) continue
        for (const subkey of Object.keys(rawSection as Record<string, unknown>)) {
          const knownKeys = Object.keys(defSection)
          if (!knownKeys.includes(subkey)) {
            const suggestions = closestKeys(subkey, knownKeys)
            const finding: { kind: string; key: string; suggestion?: string } = { kind: 'unknown_key', key: `${section}.${subkey}` }
            if (suggestions.length > 0) finding.suggestion = suggestions.join(', ')
            findings.push(finding)
          }
        }
      }
    }

    // A project .token-goat.toml value that validation rejects or clamps is otherwise invisible: nothing errors, and it only surfaces if the user happens to `config get` that one key. `validate` is where a config problem is meant to be found, so report it here too -- via the same resolver `get`/`list`/`set` use, so all four agree about the key.
    const validateProjectInfo = getProjectConfigInfo()
    if (validateProjectInfo !== null) {
      const effCfg = loadConfig() as unknown as Record<string, unknown>
      if (validateProjectInfo.parseError !== null) {
        findings.push({ kind: 'project_parse_error', key: validateProjectInfo.path, suggestion: validateProjectInfo.parseError })
      } else {
        for (const k of validateProjectInfo.keys) {
          const eff = walkGet(effCfg, k.split('.'))
          const state = resolveConfigKeyLayer(k, eff.found ? eff.value : undefined, effCfg, validateProjectInfo)
          if (state.layer !== 'project-invalid') continue
          findings.push({ kind: 'project_value_ignored', key: k, suggestion: `${JSON.stringify(state.rawValue)}${state.reason !== null ? ` is ${state.reason}` : ' is not usable'}; in effect: ${JSON.stringify(state.effectiveValue)}` })
        }
      }
    }

    // A non-empty findings list (including a parse_error) means the config is not clean --
    // exit non-zero so `config validate` is usable as a CI/script gate, not just a human-read
    // report that always looks "successful" regardless of what it found.
    if (findings.length > 0) process.exitCode = 1

    if (opts.json === true) {
      emit(JSON.stringify({ findings, ok: findings.length === 0 }, null, 2))
      return
    }
    if (findings.length === 0) {
      emit('config validate: no issues found')
      return
    }
    for (const f of findings) {
      // "did you mean" only fits the kinds whose suggestion IS a near-miss key name. For the others the suggestion is an explanation (a parse error, a rejected value), and wrapping those in "did you mean:" asked the reader whether they meant a sentence.
      const isNearMiss = f.kind === 'unknown_section' || f.kind === 'unknown_key'
      const hint = f.suggestion === undefined ? '' : isNearMiss ? ` (did you mean: ${f.suggestion}?)` : ` (${f.suggestion})`
      emit(`[${f.kind}] ${f.key}${hint}`)
    }
    emit(`config validate: ${findings.length} issue(s) found`)
    return
  }

  throw new Error(`config: unknown action '${action}'. Use list, get, set, or validate.`)
}

// ── project ───────────────────────────────────────────────────────────────────

export function cmdProject(opts: { action: string; pathArg?: string; json?: boolean; dryRun?: boolean }): void {
  const { action } = opts

  if (action === 'list') {
    const cfg = loadConfig()
    const active = findProject(process.cwd())
    const blocked = cfg.worker.blocked_roots
    if (opts.json === true) {
      emit(JSON.stringify({ active: active ? { root: active.root, hash: active.hash, marker: active.marker } : null, blocked_roots: blocked }, null, 2))
      return
    }
    if (active) {
      emit(`Active project: ${active.root}`)
      emit(`  marker: ${active.marker}`)
    } else {
      emit('Active project: (none — not inside a recognized project root)')
    }
    if (blocked.length === 0) {
      emit('Blocked roots: (none)')
    } else {
      emit('Blocked roots:')
      for (const r of blocked) emit(`  ${r}`)
    }
    return
  }

  if (action === 'exclude') {
    if (!opts.pathArg) {
      emitErr('project exclude requires a path argument')
      throw new Error('missing path')
    }
    const target = path.resolve(opts.pathArg)
    const cfg = loadPersistedConfig()
    // Fold both sides through the same normalizePath+foldPath pipeline isUnderBlockedRoot uses,
    // or a differently-cased re-exclude of the same physical directory on a case-insensitive
    // filesystem (Windows/macOS) silently adds a duplicate blocked_roots entry instead of
    // hitting the "Already excluded" short-circuit -- blocking itself still worked (isUnderBlockedRoot
    // already folds), but the persisted list was meant to be deduplicated and wasn't.
    const targetFolded = foldPath(normalizePath(target))
    if (cfg.worker.blocked_roots.some((r) => foldPath(normalizePath(r)) === targetFolded)) {
      emit(`Already excluded: ${target}`)
      return
    }
    cfg.worker.blocked_roots = [...cfg.worker.blocked_roots, target]
    saveConfigSafe(cfg)
    invalidateConfigCache()
    if (opts.json === true) {
      emit(JSON.stringify({ excluded: target, blocked_roots: cfg.worker.blocked_roots }, null, 2))
      return
    }
    emit(`Excluded: ${target}`)
    return
  }

  if (action === 'prune') {
    const cfg = loadPersistedConfig()
    const before = cfg.worker.blocked_roots
    const after = before.filter((r) => {
      try { return fs.existsSync(r) } catch { return false }
    })
    const removed = before.length - after.length
    const stale = before.filter((r) => !after.includes(r))
    // System-temp-dir indexed files (scratch checkouts, ad hoc debugging copies -- see
    // isUnderSystemTemp's docstring) are a second, independent kind of staleness from the
    // blocked_roots existence check above: pruned by content of the `files` table itself, not by
    // whether a config-listed root still exists on disk.
    const staleTempFiles = findSystemTempFiles()

    if (opts.dryRun === true) {
      if (opts.json === true) {
        emit(JSON.stringify({ dryRun: true, wouldPrune: removed, stale, wouldPruneTempFiles: staleTempFiles.length, staleTempFiles, blocked_roots: before }, null, 2))
        return
      }
      if (removed === 0) {
        emit('Would prune 0 stale root(s). Nothing to do.')
      } else {
        emit(`Would prune ${removed} stale root(s):`)
        for (const r of stale) emit(`  ${r}`)
      }
      if (staleTempFiles.length === 0) {
        emit('Would prune 0 stale indexed temp-dir file(s). Nothing to do.')
      } else {
        emit(`Would prune ${staleTempFiles.length} stale indexed temp-dir file(s):`)
        for (const p of staleTempFiles) emit(`  ${p}`)
      }
      return
    }

    cfg.worker.blocked_roots = after
    saveConfigSafe(cfg)
    invalidateConfigCache()
    const prunedTempFiles = pruneSystemTempFiles()
    if (opts.json === true) {
      emit(JSON.stringify({ pruned: removed, blocked_roots: after, prunedTempFiles: prunedTempFiles.length }, null, 2))
      return
    }
    emit(`Pruned ${removed} stale root(s). Remaining: ${after.length}`)
    emit(`Pruned ${prunedTempFiles.length} stale indexed temp-dir file(s).`)
    return
  }

  emitErr(`project: unknown action '${action}'. Use list, exclude, or prune.`)
  throw new Error(`unknown project action: ${action}`)
}

// ── compact-doc ───────────────────────────────────────────────────────────────

// Records a surgical-read stat event for compact-doc, mirroring recordReadStat's convention in read_commands.ts (bytes saved = full on-disk source size minus the emitted text, floored at 1, tokens approximated as bytesSaved/4) -- compact-doc had no live registry entry or recordStat call at all until now, so its usage never showed up in `token-goat stats --full`.
function recordCompactDocStat(fullSourceBytes: number, emittedText: string, detail: string): void {
  const bytesSaved = Math.max(1, fullSourceBytes - Buffer.byteLength(emittedText, 'utf8'))
  recordStat('compact_doc', bytesSaved, Math.round(bytesSaved / 4), undefined, detail)
}

export function cmdCompactDoc(opts: {
  filePath: string
  heading?: string
  json?: boolean
  force?: boolean
  sentences?: string
  show?: boolean
}): void {
  const resolved = path.resolve(opts.filePath)

  // Legacy mode: extract a named section, or the content after a
  // `<!-- COMPACT_END -->` marker, straight from the source file. This
  // predates and is independent of the extractive-sidecar pipeline below —
  // --force/--sentences/--show don't apply here.
  if (opts.heading !== undefined) {
    const result = compactDoc(resolved, opts.heading)
    if (result === null) {
      emitErr(`compact-doc: could not read or compact '${resolved}'`)
      throw new Error(`could not compact: ${resolved}`)
    }
    const legacyFullBytes = fs.statSync(resolved).size
    if (opts.json === true) {
      const jsonText = JSON.stringify({ path: resolved, compact: result }, null, 2)
      emit(jsonText)
      recordCompactDocStat(legacyFullBytes, jsonText, resolved)
      return
    }
    emit(result)
    recordCompactDocStat(legacyFullBytes, result, resolved)
    return
  }

  let sentences: number | undefined
  if (opts.sentences !== undefined) {
    try {
      sentences = requirePositiveStrictInt('--sentences', opts.sentences)
    } catch (e) {
      emitErr(`compact-doc: --sentences must be a positive number, got: "${opts.sentences}"`)
      throw new Error(`invalid --sentences: ${opts.sentences}`, { cause: e })
    }
  }

  const compactPath = compactPathFor(resolved)
  const fresh = isCompactFresh(compactPath, resolved)
  let rebuilt = false
  let body: string

  // opts.sentences must also force a rebuild: isCompactFresh only tracks source-content
  // staleness (a sha in the cache header), never the sentence count the cache was built with,
  // so a fresh cache from an earlier call with a different --sentences would otherwise be
  // returned unchanged, silently ignoring the caller's explicit request.
  if (opts.force === true || opts.sentences !== undefined || !fresh) {
    let sourceText: string
    try {
      sourceText = fs.readFileSync(resolved, 'utf-8')
    } catch {
      emitErr(`compact-doc: could not read or compact '${resolved}'`)
      throw new Error(`could not compact: ${resolved}`)
    }
    body = buildExtractiveCompact(sourceText, sentences)
    writeCompact(compactPath, resolved, body)
    rebuilt = true
  } else {
    const existing = readCompactBody(compactPath)
    if (existing === null) {
      emitErr(`compact-doc: could not read or compact '${resolved}'`)
      throw new Error(`could not compact: ${resolved}`)
    }
    body = existing
  }

  const extractiveFullBytes = fs.statSync(resolved).size

  if (opts.json === true) {
    const jsonText = JSON.stringify({ path: resolved, compactPath, rebuilt, compact: body }, null, 2)
    emit(jsonText)
    recordCompactDocStat(extractiveFullBytes, jsonText, resolved)
    return
  }

  if (opts.show === true) {
    emit(body)
    recordCompactDocStat(extractiveFullBytes, body, resolved)
    return
  }

  emit(
    `Compact sidecar ${rebuilt ? 'built' : 'already fresh'} at ${compactPath} ` +
      `(source: ${resolved}). Use --show to print it, --force to rebuild.`,
  )
}

// ── fetch-image ───────────────────────────────────────────────────────────────

const MAX_FETCH_REDIRECTS = 5
const FETCH_IMAGE_TIMEOUT_SEC = 30
const FETCH_IMAGE_MAX_SIZE_BYTES = 50 * 1024 * 1024

/**
 * Fetch a URL's raw bytes for `fetch-image`.
 *
 * Reuses webfetch.ts's hardened fetch primitive instead of duplicating its
 * SSRF/size/timeout handling: performHttpFetch resolves and pins DNS through
 * ssrfPinnedLookup (blocking private/loopback/link-local targets, including
 * on every redirect hop, not just the initial request), caps the response
 * body at FETCH_IMAGE_MAX_SIZE_BYTES while it's still streaming in rather
 * than after buffering it whole, and bounds the whole request — redirects
 * included — by FETCH_IMAGE_TIMEOUT_SEC.
 */
interface FetchedImage {
  body: Buffer
  contentType: string | undefined
}

async function fetchBuffer(url: string): Promise<FetchedImage> {
  const result = await performHttpFetch(url, {
    deadlineAt: Date.now() + FETCH_IMAGE_TIMEOUT_SEC * 1000,
    timeoutSec: FETCH_IMAGE_TIMEOUT_SEC,
    maxSizeBytes: FETCH_IMAGE_MAX_SIZE_BYTES,
    requestHeaders: {},
    redirectsLeft: MAX_FETCH_REDIRECTS,
  })
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`HTTP ${result.status} for ${url}`)
  }
  const contentType = result.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
  return { body: result.body, contentType }
}

/** Maps a response `content-type` to a default file extension for `fetch-image` when the
 * caller didn't pass `--out`, so a fetched JPEG/WebP/GIF doesn't land under a hardcoded
 * `.bin` name that misrepresents its actual format. */
const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/tiff': '.tiff',
}

function extensionForContentType(contentType: string | undefined): string {
  if (contentType === undefined) return '.bin'
  return CONTENT_TYPE_EXT[contentType] ?? '.bin'
}

export async function cmdFetchImage(opts: { url: string; out?: string; json?: boolean }): Promise<void> {
  let fetched: FetchedImage
  try {
    fetched = await fetchBuffer(opts.url)
  } catch (e) {
    emitErr(`fetch-image: network error — ${extractErrorMessage(e)}`)
    throw new Error(`fetch failed: ${opts.url}`, { cause: e })
  }
  const buf = fetched.body
  // Default extension (when --out wasn't given) comes from the response content-type rather
  // than a hardcoded `.bin`, so e.g. a JPEG response lands under `.jpg` even before any shrink.
  const outPath = opts.out ?? path.join(os.tmpdir(), `tg-fetch-${Date.now()}${extensionForContentType(fetched.contentType)}`)
  const originalBytes = buf.length
  let shrunkBytes: number
  let outData: Buffer
  let wasShrunk = false
  let finalPath = outPath
  try {
    const result = await shrinkImage(buf)
    if (result !== null) {
      outData = result.data
      shrunkBytes = result.shrunkBytes
      wasShrunk = true
      // shrinkImage may re-encode to a different container format (JPEG/WebP); correct the
      // destination extension to match the actual bytes being written, rather than silently
      // writing e.g. JPEG bytes under a `.png`/`.bin` name.
      finalPath = withExtension(outPath, result.format)
    } else {
      outData = buf
      shrunkBytes = originalBytes
    }
  } catch {
    outData = buf
    shrunkBytes = originalBytes
  }
  // Atomic (temp file + rename) rather than a direct fs.writeFileSync: a bare writeFileSync
  // truncates finalPath in place, so a concurrent reader of the same --out path (two
  // overlapping fetch-image invocations, or a hook reading the file mid-write) could observe
  // a partial/truncated file. Matches the atomic write already used for this same shrink
  // pipeline's other disk-cache paths (webfetch.ts's cachePath/shrunkPath, screenshot.ts's
  // takeScreenshot).
  atomicWriteBytes(finalPath, outData)
  if (opts.json === true) {
    emit(JSON.stringify({ url: opts.url, out: finalPath, originalBytes, shrunkBytes, wasShrunk }, null, 2))
    return
  }
  const savings = wasShrunk ? ` (saved ${originalBytes - shrunkBytes} bytes)` : ' (not shrunk — already small or unsupported format)'
  emit(`Fetched ${originalBytes} bytes → ${finalPath}${savings}`)
}

// ── history ───────────────────────────────────────────────────────────────────

export function cmdHistory(opts: { limit?: string; json?: boolean }): void {
  let limit = 30
  if (opts.limit !== undefined) {
    try {
      limit = requireNonNegativeStrictInt('--limit', opts.limit)
    } catch (e) {
      emitErr(`history: --limit must be a non-negative number, got: "${opts.limit}"`)
      throw new Error(`invalid --limit: ${opts.limit}`, { cause: e })
    }
    // --limit 0 would slice the merged bash/web list down to zero entries and print "No
    // history entries found" -- an absolute claim about the cache's contents -- even when
    // entries genuinely exist. Reject explicitly instead of silently rendering that false-clean
    // result, matching runFind's own --limit validation (read_commands.ts) and
    // graph_commands.ts's --top validation for the same failure mode.
    if (limit === 0) {
      emitErr(`history: --limit must be a positive number, got: "${opts.limit}"`)
      throw new Error(`invalid --limit: ${opts.limit}`)
    }
  }

  const bashItems = listBlobs(BASH_OUTPUT_SUBDIR)
    .map(({ id, mtime, value }) => {
      if (typeof value !== 'object' || value === null) return null
      const v = value as Record<string, unknown>
      return {
        type: 'bash' as const,
        id,
        storedAt: typeof v['storedAt'] === 'number' ? v['storedAt'] : mtime,
        summary: typeof v['command'] === 'string' ? v['command'] : '',
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  const webItems = listBlobs(WEB_OUTPUT_SUBDIR)
    .map(({ id, mtime, value }) => {
      if (typeof value !== 'object' || value === null) return null
      const v = value as Record<string, unknown>
      return {
        type: 'web' as const,
        id,
        storedAt: mtime,
        summary: typeof v['url'] === 'string' ? v['url'] : '',
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  const items = [...bashItems, ...webItems]
    .sort((a, b) => b.storedAt - a.storedAt)
    .slice(0, limit)

  if (opts.json === true) {
    process.stdout.write(JSON.stringify(items, null, 2) + '\n')
    return
  }
  if (items.length === 0) {
    emit('No history entries found (no cached bash outputs or web fetches).')
    return
  }
  const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))
  emit(`${pad('type', 5)}  ${pad('id', 18)}  summary`)
  for (const item of items) {
    const preview = item.summary.length > 80 ? item.summary.slice(0, 77) + '...' : item.summary
    emit(`${pad(item.type, 5)}  ${pad(item.id, 18)}  ${preview}`)
  }
}
