// Experimental token-goat ask command: out-of-band codebase Q&A.
// The idea: retrieve and synthesize in token-goat's own process and return only
// a short, cited answer. The primary model pays for the answer plus citations,
// not for slice bodies.

import * as os from 'node:os'
import * as crypto from 'node:crypto'
import * as subprocess from 'node:child_process'
import { minimatch as minimatchFn } from 'minimatch'

// Default retrieval budget (tokens of slice text fed to the backend).
export const DEFAULT_BUDGET = 6000
export const DEFAULT_TOP = 8
// Terse-answer guardrails.
export const DEFAULT_ANSWER_WORDS = 200
export const MAX_ANSWER_CHARS = 4000
// Reliability knobs.
export const DEFAULT_TIMEOUT_SECS = 30
const ENV_MODEL = 'TOKEN_GOAT_ASK_MODEL'
const ENV_CMD = 'TOKEN_GOAT_ASK_CMD'
const ENV_TIMEOUT = 'TOKEN_GOAT_ASK_TIMEOUT_SECS'
// Claude Code's cheapest tier.
const CLAUDE_CHEAPEST = 'claude-haiku-4-5'

function estTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.floor(text.length / 4))
}

export class Slice {
  fileRel: string
  startLine: number
  endLine: number
  text: string
  distance: number

  constructor(fileRel: string, startLine: number, endLine: number, text: string, distance: number) {
    this.fileRel = fileRel
    this.startLine = startLine
    this.endLine = endLine
    this.text = text
    this.distance = distance
  }

  citation(): Record<string, number | string> {
    return {
      file: this.fileRel,
      start_line: this.startLine,
      end_line: this.endLine,
    }
  }

  relevancePct(): number {
    return Math.max(0, Math.round((1.0 - this.distance) * 100))
  }
}

export function retrieve(
  _projectHashObj: unknown,
  _question: string,
  _opts: { scope?: string | null; budget: number; top: number },
): Slice[] {
  // NOTE: semantic search would be imported from embeddings.ts
  // For now, return empty list to degrade gracefully
  return []
}

function _matchesScope(fileRel: string, scope: string): boolean {
  const norm = fileRel.replace(/\\/g, '/')
  const pat = scope.replace(/\\/g, '/')
  if (minimatchFn(norm, pat)) {
    return true
  }
  // A bare directory matches as substring too
  if (!/[*?[\]]/.test(pat)) {
    return norm.includes(pat)
  }
  return false
}

function normalizeQuestion(question: string): string {
  return question.toLowerCase().split(/\s+/).filter(Boolean).join(' ')
}

export function cacheKey(question: string, slices: Slice[], backendLabel: string): string {
  const sigParts = slices
    .map((s) => {
      const hash = crypto.createHash('sha256').update(s.text, 'utf8').digest('hex').slice(0, 16)
      return `${s.fileRel}:${s.startLine}-${s.endLine}:${hash}`
    })
    .sort()

  const payload = [normalizeQuestion(question), backendLabel, ...sigParts].join('\0')
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex')
}

export interface CachedAnswer {
  answer: string
  citations: Array<Record<string, number | string>>
  backend: string
  tokens_in: number
  tokens_out: number
}

export function _cacheGet(_projectHash: string, _key: string): CachedAnswer | null {
  // NOTE: would use db.openProjectReadonly to fetch from ask_cache table
  // For now, return null (miss)
  return null
}

export function _cachePut(
  _projectHash: string,
  _key: string,
  _opts: {
    question: string
    answer: string
    citations: Array<Record<string, number | string>>
    backend_label: string
    tokens_in: number
    tokens_out: number
  },
): void {
  // NOTE: would use db.openProject to insert into ask_cache table
  // For now, no-op
}

export class Backend {
  label: string
  argv: string[]

  constructor(label: string, argv: string[]) {
    this.label = label
    this.argv = argv
  }
}

export function resolveBackend(modelOverride?: string | null): Backend | null {
  const cmd = (process.env[ENV_CMD] ?? '').trim()
  if (cmd) {
    try {
      const argv = cmd.split(/\s+/).filter((s) => s.length > 0)
      if (argv.length > 0) {
        return new Backend(`custom:${argv[0]}`, argv)
      }
    } catch {
      // Fall through
    }
  }

  const model = (modelOverride ?? process.env[ENV_MODEL] ?? '').trim()
  try {
    const claudePath = subprocess.execSync('which claude', { encoding: 'utf8' }).trim()
    if (claudePath) {
      const chosen = model || CLAUDE_CHEAPEST
      return new Backend(
        `claude:${chosen}`,
        [claudePath, '--print', '--model', chosen, '--bare', '--no-session-persistence'],
      )
    }
  } catch {
    // claude not found
  }

  try {
    const codexPath = subprocess.execSync('which codex', { encoding: 'utf8' }).trim()
    if (codexPath) {
      if (model) {
        return new Backend(`codex:${model}`, [codexPath, 'exec', '--model', model])
      }
      return new Backend('codex:default', [codexPath, 'exec'])
    }
  } catch {
    // codex not found
  }

  return null
}

export function buildPrompt(question: string, slices: Slice[], opts: { maxWords?: number } = {}): string {
  const maxWords = opts.maxWords ?? DEFAULT_ANSWER_WORDS
  const blocks: string[] = []
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i]
    if (!s) continue
    blocks.push(`[${i + 1}] ${s.fileRel} L:${s.startLine}-${s.endLine}\n${s.text}`)
  }
  const slicesBlock = blocks.join('\n\n')
  return (
    `You are a precise code assistant. Answer the QUESTION using ONLY the SLICES below.\n` +
    `Be concise: at most ${maxWords} words. Do not restate the question.\n` +
    `If the slices lack the answer, say exactly what is missing. Refer to slices by their [n] tag when useful.\n\n` +
    `QUESTION:\n${question}\n\n` +
    `SLICES:\n${slicesBlock}\n\n` +
    `ANSWER:`
  )
}

export function synthesize(prompt: string, backend: Backend, opts: { timeout: number }): string {
  const env = { ...process.env }
  env['TOKEN_GOAT_NO_WORKER_SPAWN'] = '1'

  const cmdPath = backend.argv[0]
  if (!cmdPath) {
    throw new Error('backend argv[0] is undefined')
  }
  const result = subprocess.spawnSync(cmdPath, backend.argv.slice(1), {
    input: prompt,
    encoding: 'utf8',
    timeout: opts.timeout * 1000,
    cwd: os.tmpdir(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim().slice(0, 200)
    throw new Error(`backend exit ${result.status}: ${stderr}`)
  }
  const answer = (result.stdout || '').trim()
  if (!answer) {
    throw new Error('backend returned empty output')
  }
  return answer
}

function capAnswer(answer: string): string {
  if (answer.length <= MAX_ANSWER_CHARS) {
    return answer
  }
  return answer.slice(0, MAX_ANSWER_CHARS).trimEnd() + '\n… [truncated]'
}

export async function runAsk(
  question: string,
  opts: {
    scope?: string
    budget?: number
    model?: string
    json_output?: boolean
    no_cache?: boolean
    show_sources?: boolean
    top?: number
  } = {},
): Promise<void> {
  // NOTE: would find project and use it, but degrade gracefully for now
  const budget = opts.budget ?? DEFAULT_BUDGET
  const top = opts.top ?? DEFAULT_TOP

  question = question.trim()
  if (!question) {
    console.error('Question cannot be empty')
    process.exit(1)
  }

  const slices = retrieve({}, question, {
    scope: opts.scope ?? null,
    budget,
    top,
  })

  if (slices.length === 0) {
    if (opts.json_output) {
      emitJsonNoContext(question)
    } else {
      console.log('No relevant indexed context found. Run `token-goat index --embeddings` to enable semantic search.')
    }
    return
  }

  const baselineTokens = slices.reduce((sum, s) => sum + estTokens(s.text), 0)
  const backend = resolveBackend(opts.model)

  // Try cache (if backend available and cache enabled)
  if (backend && !opts.no_cache) {
    // NOTE: would call cacheGet here with cacheKey(question, slices, backendLabel)
  }

  // Try synthesis
  if (backend) {
    const prompt = buildPrompt(question, slices, { maxWords: DEFAULT_ANSWER_WORDS })
    const timeout = parseInt(process.env[ENV_TIMEOUT] ?? '') || DEFAULT_TIMEOUT_SECS

    let answer: string | null = null
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        answer = capAnswer(synthesize(prompt, backend, { timeout }))
        break
      } catch {
        // synthesis attempt failed, try next
      }
    }

    if (answer) {
      const tokensIn = estTokens(prompt)
      const tokensOut = estTokens(answer)
      const citations = slices.map((s) => s.citation())

      if (!opts.no_cache) {
        // NOTE: would call cachePut here
      }

      emitAnswer(question, {
        answer,
        citations,
        backend_label: backend.label,
        cached: false,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        baseline_tokens: baselineTokens,
        slices,
        show_sources: opts.show_sources ?? false,
        json_output: opts.json_output ?? false,
      })
      return
    }
  }

  // Degrade to slices
  emitDegraded(question, slices, {
    baseline_tokens: baselineTokens,
    synthesis_attempted: !!backend,
    show_sources: opts.show_sources ?? false,
    json_output: opts.json_output ?? false,
  })
}

function emitAnswer(
  question: string,
  opts: {
    answer: string
    citations: Array<Record<string, number | string>>
    backend_label: string
    cached: boolean
    tokens_in: number
    tokens_out: number
    baseline_tokens: number
    slices: Slice[]
    show_sources?: boolean
    json_output?: boolean
  },
): void {
  const citationText = opts.citations
    .map((c, i) => {
      const file = c['file'] ?? ''
      const startLine = c['start_line'] ?? 0
      const endLine = c['end_line'] ?? 0
      return `  [${i + 1}] ${file}  L:${startLine}-${endLine}`
    })
    .join('\n')

  const primaryTokens = estTokens(opts.answer) + estTokens(citationText)
  const saved = Math.max(0, opts.baseline_tokens - primaryTokens)

  if (opts.json_output) {
    const payload: Record<string, unknown> = {
      question,
      synthesized: true,
      cached: opts.cached,
      backend: opts.backend_label,
      answer: opts.answer,
      citations: opts.citations,
      tokens_in: opts.tokens_in,
      tokens_out: opts.tokens_out,
      primary_tokens: primaryTokens,
      baseline_tokens: opts.baseline_tokens,
      saved_tokens: saved,
    }
    if (opts.show_sources) {
      payload['sources'] = opts.slices.map((s) => ({
        ...s.citation(),
        text: s.text,
      }))
    }
    console.log(JSON.stringify(payload))
  } else {
    console.log(opts.answer)
    if (citationText) {
      console.log('\nsources:')
      console.log(citationText)
    }
    if (opts.show_sources) {
      console.log('\n--- slices ---')
      opts.slices.forEach((s, i) => {
        console.log(`[${i + 1}] ${s.fileRel}  L:${s.startLine}-${s.endLine}`)
        console.log(s.text)
      })
    }
    console.error(
      `ask: ~${primaryTokens.toLocaleString()} primary tokens · ` +
        `saved ~${saved.toLocaleString()} vs read-and-synthesize · ` +
        `backend=${opts.backend_label} · ` +
        `cached=${opts.cached ? 'yes' : 'no'}`,
    )
  }
}

function emitDegraded(
  question: string,
  slices: Slice[],
  opts: {
    baseline_tokens: number
    synthesis_attempted: boolean
    show_sources?: boolean
    json_output?: boolean
  },
): void {
  const pointers = slices.map((s) => ({
    read_cmd: `token-goat read "${s.fileRel}::${s.startLine}-${s.endLine}"`,
    file: s.fileRel,
    start_line: s.startLine,
    end_line: s.endLine,
    est_tokens: estTokens(s.text),
    relevance_pct: s.relevancePct(),
  }))

  const notice = opts.synthesis_attempted
    ? 'synthesis unavailable; returning slices'
    : "no synthesis backend (install the claude or codex CLI, or set TOKEN_GOAT_ASK_CMD); returning slices"

  if (opts.json_output) {
    const payload: Record<string, unknown> = {
      question,
      synthesized: false,
      cached: false,
      backend: null,
      answer: null,
      notice,
      citations: slices.map((s) => s.citation()),
      entries: pointers,
      baseline_tokens: opts.baseline_tokens,
    }
    if (opts.show_sources) {
      payload['sources'] = slices.map((s) => ({
        ...s.citation(),
        text: s.text,
      }))
    }
    console.log(JSON.stringify(payload))
  } else {
    console.log(notice)
    pointers.forEach((p) => {
      console.log(`  ${p['read_cmd']}  ~${p['est_tokens']} tok  ${p['relevance_pct']}% relevant`)
    })
    if (opts.show_sources) {
      console.log('\n--- slices ---')
      slices.forEach((s, i) => {
        console.log(`[${i + 1}] ${s.fileRel}  L:${s.startLine}-${s.endLine}`)
        console.log(s.text)
      })
    }
  }
}

function emitJsonNoContext(question: string): void {
  console.log(
    JSON.stringify({
      question,
      synthesized: false,
      cached: false,
      backend: null,
      answer: null,
      notice: 'no relevant indexed context',
      citations: [],
      entries: [],
      baseline_tokens: 0,
    }),
  )
}
