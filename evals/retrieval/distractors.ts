/** A seeded, deterministic corpus of distractor source files for the retrieval eval: placeholder functions (a body that only throws "not implemented", a TODO-only body, an empty body), near-duplicate names of the symbols the golden set asks for, and boilerplate accessors with generic doc comments. Real repositories carry plenty of all three, and a retrieval stack that ranks the right symbol first among a few hundred honest files can still lose it to a stub that shares its name. The output is a pure function of (seed, count, nearNames), so a report made with the corpus can be diffed against another run and the files never need committing. */
import { mulberry32 } from './metrics.js'

/** The seed every eval run uses unless told otherwise, so two runs on the same commit index byte-identical distractors. */
export const DISTRACTOR_SEED = 20261008

export interface DistractorFile {
  /** Repo-relative, forward slashes, under `distractors/`. */
  readonly path: string
  readonly content: string
}

const VERBS = ['load', 'drain', 'flush', 'resolve', 'collect', 'refresh', 'rebuild', 'merge', 'sync', 'prune', 'rank', 'queue']
const NOUNS = ['index', 'queue', 'session', 'cache', 'worker', 'hint', 'manifest', 'symbol', 'chunk', 'vector', 'ledger', 'snapshot']
const WORDS = ['the', 'worker', 'reindex', 'changed', 'files', 'session', 'cache', 'hook', 'read', 'symbol', 'queue', 'chunk', 'embed', 'search', 'result', 'stale', 'entry', 'path', 'project', 'batch']
const NAME_SUFFIXES = ['Impl', 'Stub', 'Legacy', 'V2', 'Fallback']

type Kind = 'throws' | 'todo' | 'empty' | 'nearStub' | 'nearReal' | 'accessor'
const KINDS: readonly Kind[] = ['throws', 'todo', 'empty', 'nearStub', 'nearReal', 'accessor']

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** `count` files of four declarations each. `nearNames` seeds the near-duplicate kinds; with none, those kinds fall back to a verb-noun name so the corpus size never depends on whether names were supplied. */
export function generateDistractors(count: number, nearNames: readonly string[] = [], seed: number = DISTRACTOR_SEED): DistractorFile[] {
  const rand = mulberry32(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T
  const sentence = (): string => `${cap(pick(WORDS))} ${Array.from({ length: 5 + Math.floor(rand() * 4) }, () => pick(WORDS)).join(' ')}.`
  const plainName = (): string => `${pick(VERBS)}${cap(pick(NOUNS))}${Math.floor(rand() * 90 + 10)}`
  const nearName = (): string => (nearNames.length === 0 ? plainName() : `${pick(nearNames)}${pick(NAME_SUFFIXES)}`)
  const files: DistractorFile[] = []
  for (let f = 0; f < count; f++) {
    const decls: string[] = []
    for (let d = 0; d < 4; d++) {
      const kind = pick(KINDS)
      const doc = `/** ${sentence()} */`
      const name = kind === 'nearStub' || kind === 'nearReal' ? nearName() : plainName()
      if (kind === 'throws' || kind === 'nearStub') decls.push(`${doc}\nexport function ${name}(input: string): string {\n  throw new Error('not implemented')\n}`)
      else if (kind === 'todo') decls.push(`${doc}\nexport function ${name}(input: string): string {\n  // TODO: implement\n  return ''\n}`)
      else if (kind === 'empty') decls.push(`${doc}\nexport function ${name}(input: string): void {}`)
      else if (kind === 'nearReal') decls.push(`${doc}\nexport function ${name}(input: string): string {\n  const parts = input.split('${pick(['/', ':', ','])}')\n  return parts.map((p) => p.trim()).filter((p) => p !== '').join('${pick(['-', '|', ';'])}')\n}`)
      else decls.push(`${doc}\nexport function ${name}(holder: { value: string }): string {\n  return holder.value\n}`)
    }
    files.push({ path: `distractors/d${String(f).padStart(4, '0')}.ts`, content: `${decls.join('\n\n')}\n` })
  }
  return files
}
