import * as fs from 'node:fs'
import { parse } from 'smol-toml'

import { configPath, projectConfigPath } from './constants.js'
import { extractErrorMessage, decodeSource } from './util.js'
import { findProject } from './project.js'
import { registerReset } from './reset.js'
import type { ProjectConfigInfo } from './config_types.js'

/**
 * Config sections a per-project `.token-goat.toml` may not set.
 *
 * The per-project file is not the user's own configuration: it arrives with a repository, so it
 * is attacker-controlled the moment anyone clones an untrusted project. It merges over the
 * global config, which meant a checked-in three-line file could turn off prompt-injection
 * fencing, empty the fetch allow/deny lists, switch the Google Drive integration back on, or
 * widen the MCP root allowlist, silently, for every session opened in that directory.
 *
 * These sections are the security controls an administrator sets once and expects to hold.
 * They now come from the global config and the environment only. The environment is left alone
 * deliberately: a repository cannot set it, and the developer who exports a variable is
 * configuring their own machine.
 *
 * `screenshot` is locked as a whole section rather than key by key because both of its settings
 * decide how and where a browser process is launched, which makes the whole surface a security
 * one: `chrome_path` names the executable `takeScreenshot` hands to `puppeteer.launch`, so a
 * checked-in value pointed at a binary the repository also ships is arbitrary local code
 * execution the next time the developer runs `token-goat screenshot` for any reason; and
 * `block_private_targets = false` turns off both the private-address refusal and the
 * resolve-then-pin step that closes DNS rebinding, letting that navigation reach loopback,
 * RFC1918 and cloud-metadata addresses. A future key in this section will be about launching a
 * browser too, so it inherits the lock instead of needing to be remembered.
 *
 * Everything else -- hints, formatting, compression thresholds, worker tuning -- stays
 * project-overridable, which is what the per-project file exists for.
 */
export const PROJECT_LOCKED_SECTIONS: readonly string[] = [
  'injection',
  'webfetch',
  'gdrive',
  'redaction',
  'mcp',
  'network',
  'screenshot',
]

/**
 * Individual `section.key` entries locked without locking their whole section.
 *
 * `worker.blocked_roots` is the exclusion list a user builds with `token-goat project exclude`,
 * and `cmdIndex` / `processDirtyBatch` consult it to keep a path out of the index entirely --
 * symbols, bodies and embeddings. The rest of the `worker` section is ordinary tuning, so the
 * whole section stays project-overridable, but an empty list here is a real value that replaces
 * rather than merges: three lines in a repository's own `.token-goat.toml` were enough to put a
 * folder the user had deliberately excluded back into the index, where `symbol`, `read` and
 * `semantic` then served it. That is a protection being switched off by a checked-in file, which
 * is exactly what this list exists to prevent.
 *
 * `image_shrink.max_image_pixels` is the decompression-bomb cap: `0` means "no cap" and the schema
 * accepts it, so a repository that sets it to zero and ships a small file that decodes to billions
 * of pixels turns an ordinary `Read` of that image into an out-of-memory kill. The rest of that
 * section (quality, the OCR thresholds, the redirect switch) is ordinary tuning a repository has a
 * legitimate reason to set, so only this one key is locked rather than the whole section.
 *
 * It used to be sharp's `limitInputPixels`, which libvips enforced inside the decode. It is now a
 * check on the dimensions in the file's header, run before token-goat's own decoders in
 * `image_engine.ts`, which is a weaker position: it sees `width * height` and nothing else, so it
 * says nothing about an animation's frame count or how far a compressed stream expands. Those are
 * bounded separately by `MAX_DECODED_BYTES` in that file, which is not configurable and is not
 * meant to be -- setting this key to `0` does not lift it.
 */
export const PROJECT_LOCKED_KEYS: readonly string[] = [
  // A repository must not be able to decide how much of its own source an agent gets to see. Turning this on folds function bodies out of every Read of this project's files, so a checked-in `.token-goat.toml` setting it true would shrink what a reviewing agent is shown of the very code it came to review -- and the fold is silent about intent, so it reads as normal output. The user's own global config and TOKEN_GOAT_FOLD_CODE_BODIES still set it freely; only the project-supplied layer is refused.
  'hints.fold_code_bodies',
  // Same reasoning as the body fold above, on the comments rather than the code: a checked-in project file must not be able to fold a repository's own explanatory comments out of what a reviewing agent is shown, which is precisely where an intent that disagrees with the code would be written down. The user's global config and TOKEN_GOAT_FOLD_COMMENT_BLOCKS still set it freely.
  'hints.fold_comment_blocks',
  // Same reasoning one document over: a repository must not be able to fold its own README or changelog out of what a reviewing agent is shown. The user's global config and TOKEN_GOAT_FOLD_PROSE_PARAGRAPHS still set it freely.
  'hints.fold_prose_paragraphs',
  // Same reasoning again: a repository must not be able to hide its own documentation's structure from a reviewing agent by disabling the heading-tree replacement, nor -- more to the point here -- by leaving it on to shrink what a reviewing agent sees of a doc the repo itself ships. The user's global config and TOKEN_GOAT_OUTLINE_LARGE_DOCUMENTS still set it freely.
  'hints.outline_large_documents',
  // Same reasoning one file type over: a repository must not be able to decide, from its own checked-in config, how much of its source a reviewing agent is shown -- neither by turning the skeleton off to bury a declaration in a wall of bodies, nor by leaving it on to withhold the bodies themselves. The user's global config and TOKEN_GOAT_SKELETON_LARGE_SOURCES still set it freely.
  'hints.skeleton_large_sources',
  // The widest blast radius of anything on this list. The fold keys above decide how much of a file an agent is shown; this decides how much of the whole session survives compaction. A checked-in `.token-goat.toml` setting it to a handful of characters would ask the summarizer to discard the session's accumulated state at every compaction boundary, and the loss is silent -- what comes back is a well-formed short summary, not an error. The user's own global config still sets it freely; only the project-supplied layer is refused.
  'compact_assist.summary_budget_chars',
  'image_shrink.max_image_pixels',
  // The same principle as the four fold keys above, applied one layer earlier and with a wider blast radius: those decide how much of an indexed file is shown, these decide whether it is indexed at all. A checked-in `.token-goat.toml` adding its own attack surface to `skip_dirs` -- or dropping `large_file_skip_kb` to a handful of kilobytes -- removes those files from `symbol`, `read`, `refs`, `semantic` and `graph` for a reviewing agent, and every one of them then answers "not found" in the same words it uses for a name that genuinely does not exist. There is no notice to read, because from the index's point of view nothing was hidden. The user's own global config still sets all three freely; only the project-supplied layer is refused.
  'indexing.skip_dirs',
  'indexing.skip_files',
  'indexing.large_file_skip_kb',
  'indexing.large_file_symbol_only_kb',
  'indexing.cross_project_symbols',
  'worker.blocked_roots',
]

let _lastProjectConfigLockedKeys: string[] = []

/**
 * Dotted names the most recent {@link loadConfig} ignored because a per-project `.token-goat.toml`
 * tried to set a locked security setting, or `[]` if it did not. Intended for a CLI entry point to
 * surface, the same way {@link getLastProjectConfigParseError} is.
 */
export function lastProjectConfigLockedKeys(): readonly string[] {
  return _lastProjectConfigLockedKeys
}

export function setLastProjectConfigLockedKeys(keys: string[]): void {
  _lastProjectConfigLockedKeys = keys
}

export function resetLastProjectConfigLockedKeys(): void {
  _lastProjectConfigLockedKeys = []
}

/**
 * Drop every locked entry from a parsed per-project config, returning the cleaned tree and the
 * dotted names that were dropped.
 *
 * Dropping, not rejecting: an unreadable or hostile project file must never stop token-goat from
 * running, exactly as a malformed one does not. The dropped names are recorded so a CLI entry
 * point can say what was ignored rather than leaving the author wondering why a setting had no
 * effect.
 */
export function stripLockedProjectKeys(projectRaw: Record<string, unknown>): {
  cleaned: Record<string, unknown>
  dropped: string[]
} {
  const cleaned: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [section, value] of Object.entries(projectRaw)) {
    if (PROJECT_LOCKED_SECTIONS.includes(section)) {
      dropped.push(section)
      continue
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const kept: Record<string, unknown> = {}
      for (const [key, keyValue] of Object.entries(value as Record<string, unknown>)) {
        if (PROJECT_LOCKED_KEYS.includes(`${section}.${key}`)) dropped.push(`${section}.${key}`)
        else kept[key] = keyValue
      }
      cleaned[section] = kept
      continue
    }
    cleaned[section] = value
  }
  return { cleaned, dropped }
}

/** Dotted `section.key` names set at the top two levels of a raw TOML tree (section-only entries report just the section name). */
export function flattenRawKeys(raw: Record<string, unknown>): string[] {
  const keys: string[] = []
  for (const [sectionName, val] of Object.entries(raw)) {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      for (const sub of Object.keys(val as Record<string, unknown>)) {
        keys.push(`${sectionName}.${sub}`)
      }
    } else {
      keys.push(sectionName)
    }
  }
  return keys
}

/** Dotted `section.key` -> raw value for the top two levels of a raw TOML tree, the value-carrying twin of {@link flattenRawKeys}. */
export function flattenRawValues(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [sectionName, val] of Object.entries(raw)) {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      for (const [sub, v] of Object.entries(val as Record<string, unknown>)) {
        out[`${sectionName}.${sub}`] = v
      }
    } else {
      out[sectionName] = val
    }
  }
  return out
}

/** Read a config file as text, honouring the byte-order mark the editor that wrote it left behind. */
export function readConfigSource(p: string): string {
  return decodeSource(fs.readFileSync(p))
}

/**
 * Read and parse `p` as TOML, distinguishing "file does not exist" (not an error — returns
 * `{}` with no message) from a genuine parse/read failure (returns `{}` with the error
 * message).
 */
export function readConfigToml(p: string): { raw: Record<string, unknown>; parseError: string | null } {
  try {
    return { raw: parse(readConfigSource(p)) as Record<string, unknown>, parseError: null }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { raw: {}, parseError: null }
    return { raw: {}, parseError: extractErrorMessage(e) }
  }
}

/**
 * Read `p` as UTF-8 text for cache-fingerprinting purposes, distinguishing "file does not
 * exist" from a genuine read error (e.g. permission denied). Returns `null` text on any
 * failure, with `readError` populated on non-ENOENT failures so loadConfig can surface it.
 */
export function readConfigText(p: string): { text: string | null; readError: string | null } {
  try {
    return { text: readConfigSource(p), readError: null }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { text: null, readError: null }
    return { text: null, readError: extractErrorMessage(e) }
  }
}

/**
 * Layer a per-project `.token-goat.toml` override on top of the global config.toml's raw TOML
 * tree.
 *
 * Merges one level deep: keys inside a section in `override` replace or add to the matching
 * section in `base`, rather than wiping the whole section back to defaults. Unmentioned
 * sections and unmentioned keys inside mentioned sections retain their base values.
 */
export function mergeRawConfig(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, overrideVal] of Object.entries(override)) {
    if (overrideVal !== null && typeof overrideVal === 'object' && !Array.isArray(overrideVal)) {
      const baseVal = base[key]
      const baseSection = baseVal !== null && typeof baseVal === 'object' && !Array.isArray(baseVal)
        ? (baseVal as Record<string, unknown>)
        : {}
      merged[key] = { ...baseSection, ...(overrideVal as Record<string, unknown>) }
    } else {
      // A value at a section-level key that is not a plain object (a project file that writes `hints = 5`, or a `[[hints]]` array-of-tables, which TOML parses to an array) is not a valid section shape: section() maps it to {} at build time, so it can never carry a legitimate override. Assigning it here would still replace whatever the global config.toml holds at that key, wiping the whole section back to defaults -- including the individual keys stripLockedProjectKeys exists to keep a project file from setting at all. Keep the global section instead and ignore the malformed project value.
      const baseVal = base[key]
      if (baseVal !== null && typeof baseVal === 'object' && !Array.isArray(baseVal)) continue
      merged[key] = overrideVal
    }
  }
  return merged
}

let _projectRootCache: { cwd: string; root: string } | null = null

/**
 * Resolve the project root to check for a per-project `.token-goat.toml` override, for callers
 * of {@link loadConfig} that don't pass one explicitly — almost every hook and CLI command.
 * Deliberately uses the cheap, subprocess-free `findProject()` marker walk rather than
 * `resolveProjectRoot()`'s `git rev-parse` step: loadConfig() is called from the hot hook path
 * (every Read/Grep/Bash/... hook invocation), where hooks already avoid spawning git for this
 * exact reason (see hooks_read.ts's own findProject() usage). Memoized per `process.cwd()`,
 * matching constants.ts's DATA_DIR memoization rationale — cwd does not change within a hook or
 * CLI process's lifetime.
 */
export function resolveConfigProjectRoot(): string {
  const cwd = process.cwd()
  if (_projectRootCache !== null && _projectRootCache.cwd === cwd) return _projectRootCache.root
  const project = findProject(cwd)
  const root = project !== null ? project.root : cwd
  _projectRootCache = { cwd, root }
  return root
}

// Registered so batch_serve, which runs many requests in one process and calls clearModuleCaches()
// after each, does not hand a later request a root cached by an earlier one. The memoization note
// above is accurate for the CLI but not for that mode, which is neither one-shot nor fixed-cwd:
// keying on cwd covers a request that runs somewhere else, not a project root at a fixed path
// changing shape between two requests.
registerReset(() => {
  _projectRootCache = null
})

/**
 * Report what (if anything) a project's `.token-goat.toml` override file contributes, for
 * `token-goat config list`'s "what's actually in effect and why" display (see cmdConfig in
 * config_commands.ts). Returns `null` if no such file exists at the resolved project root.
 * A malformed or unreadable file returns an empty `keys` list with `parseError` set — matching
 * loadConfig()'s fail-open handling of the same file — so the caller can still show the
 * effective (global-only) config alongside a note that the override itself is broken.
 */
export function getProjectConfigInfo(projectRoot?: string): ProjectConfigInfo | null {
  const root = projectRoot ?? resolveConfigProjectRoot()
  const p = projectConfigPath(root)
  if (!fs.existsSync(p)) return null
  const { raw, parseError } = readConfigToml(p)
  if (parseError !== null) return { path: p, keys: [], values: {}, parseError }
  return { path: p, keys: flattenRawKeys(raw), values: flattenRawValues(raw), parseError }
}

/**
 * Whether the user has explicitly set `compact_assist.auto_trigger_multiplier` in their raw
 * config.toml (or per-project .token-goat.toml), as opposed to it merely holding the
 * (indistinguishable) default value. loadConfig()'s merged Config object can't tell these two
 * cases apart, so this reads and parses the raw file text directly to check for the key's real
 * presence. Checks both the global config.toml and any per-project override (mirroring
 * loadConfig()'s own two-file layering), since a project that sets the field solely via
 * .token-goat.toml would otherwise be misread as still holding the default.
 */
export function isAutoTriggerMultiplierExplicit(): boolean {
  const setsMultiplier = (text: string): boolean => {
    const raw = parse(text) as Record<string, unknown>
    const ca_raw = raw['compact_assist']
    if (ca_raw === null || typeof ca_raw !== 'object' || Array.isArray(ca_raw)) {
      return false
    }
    return (ca_raw as Record<string, unknown>)['auto_trigger_multiplier'] !== undefined
  }
  try {
    if (setsMultiplier(readConfigSource(configPath()))) return true
  } catch {
    // no readable global config.toml -- fall through to the per-project check
  }
  try {
    return setsMultiplier(readConfigSource(projectConfigPath(resolveConfigProjectRoot())))
  } catch {
    return false
  }
}
