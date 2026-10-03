/** Comment-keeping writes for the JSON settings files whose real consumer accepts comments (Gemini CLI, Qwen Code, OpenClaw): a plain `JSON.stringify` rewrite would drop every comment the user wrote. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseJsonOrJsonc, stripBom } from '../jsonc_text.js'
import { atomicWriteText, backupFile, ensureDirSync, writeJsonSettings } from '../util.js'
import { editAt } from './mcp_servers_json.js'

export interface CommentedSettingsOptions {
  /** False for a consumer that strips comments but parses strictly afterwards, so a trailing comma stays an error. */
  allowTrailingComma?: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Applies the difference between `prev` and `next` to `text` as targeted jsonc edits, so every comment and untouched byte stays where it was. Objects recurse; arrays and scalars are replaced whole when their JSON differs. */
function applyDiff(text: string, prev: Record<string, unknown>, next: Record<string, unknown>, at: string[]): string {
  let out = text
  for (const key of Object.keys(prev)) {
    if (!(key in next)) out = editAt(out, [...at, key], undefined)
  }
  for (const key of Object.keys(next)) {
    const before = prev[key]
    const after = next[key]
    if (after === undefined) {
      if (key in prev) out = editAt(out, [...at, key], undefined)
    } else if (!(key in prev)) out = editAt(out, [...at, key], after)
    else if (isPlainObject(before) && isPlainObject(after)) out = applyDiff(out, before, after, [...at, key])
    else if (JSON.stringify(before) !== JSON.stringify(after)) out = editAt(out, [...at, key], after)
  }
  return out
}

/** Writes `next` to the settings file at `p`. A missing file or one that is strict JSON goes through {@link writeJsonSettings} unchanged; a file carrying comments (or trailing commas, where the consumer allows them) is edited in place so its comments survive, with the same backup and atomic write. */
export function writeSettingsKeepingComments(p: string, next: unknown, opts: CommentedSettingsOptions = {}): void {
  let raw: string | undefined
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch {
    raw = undefined
  }
  if (raw === undefined || !isPlainObject(next)) return writeJsonSettings(p, next)
  try {
    JSON.parse(raw)
    return writeJsonSettings(p, next)
  } catch {
    // Not strict JSON: fall through to the comment-keeping edit.
  }
  const body = stripBom(raw)
  let prev: unknown
  try {
    prev = parseJsonOrJsonc(body, opts)
  } catch {
    return writeJsonSettings(p, next)
  }
  if (!isPlainObject(prev)) return writeJsonSettings(p, next)
  const edited = applyDiff(body, prev, next, [])
  ensureDirSync(path.dirname(p))
  backupFile(p)
  atomicWriteText(p, edited.endsWith('\n') ? edited : `${edited}\n`)
}
