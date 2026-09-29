/** The hook half of `token-goat doctor --probe`. doctor starts a harness headless with {@link PROBE_NONCE_ENV} set; when that harness runs its session_start and user_prompt_submit hooks, this adds one marker line to what those hooks hand the model and leaves a receipt file saying the hook ran. doctor then asks the model to repeat the marker, so the answer says whether the hook fired and, separately, whether its words reached the model. The marker rides the real output path (serializeOutput for the detected harness), so the probe tests the same channel a real session uses rather than a stand-in. Nothing happens without the variable: a real session never carries it, so the fs write here is gated on it. */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { dataDir } from './constants.js'
import type { HookEventName, HookOutput } from './types.js'
import { ensureDirSync } from './util.js'

/** The variable doctor sets on the harness it starts. Hex only, so a stray value can never name a path outside the probe directory. */
export const PROBE_NONCE_ENV = 'TOKEN_GOAT_PROBE_NONCE'
const NONCE_RE = /^[a-f0-9]{16,32}$/

/** The events a probe covers, and the tag each one's marker and receipt carry. */
export const PROBE_EVENT_TAGS: Readonly<Partial<Record<HookEventName, 'S' | 'P'>>> = { session_start: 'S', user_prompt_submit: 'P' }

/** Where receipts for this data directory land: `<dataDir>/probe/<nonce>.<tag>`. */
export function probeDir(): string {
  return path.join(dataDir(), 'probe')
}

export function probeMarkerLine(nonce: string, tag: string): string {
  return `token-goat probe marker: ${nonce}-${tag}`
}

/** `output` with the probe marker added, when this call belongs to a probe; `output` unchanged otherwise. A `pass` becomes a context output carrying only the marker, keeping its user notice; a deny or rewrite is left alone, since neither event produces one. Fail-soft: a receipt that cannot be written still leaves the marker, which doctor reads as "reached the model" regardless. */
export function applyProbeMarker(eventName: HookEventName, output: HookOutput, env: NodeJS.ProcessEnv = process.env): HookOutput {
  const nonce = env[PROBE_NONCE_ENV]
  const tag = PROBE_EVENT_TAGS[eventName]
  if (nonce === undefined || tag === undefined || !NONCE_RE.test(nonce)) return output
  try {
    ensureDirSync(probeDir())
    writeFileSync(path.join(probeDir(), `${nonce}.${tag}`), '')
  } catch {
    // fail-soft: the marker below still goes out
  }
  const line = probeMarkerLine(nonce, tag)
  if (output.hookType === 'context') return { ...output, context: `${output.context}\n\n${line}` }
  if (output.hookType === 'pass') return output.notice === undefined ? { hookType: 'context', context: line } : { hookType: 'context', context: line, notice: output.notice }
  return output
}
