import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', '..', 'src')

/** A file is CLI dispatch code when it registers a commander command, found by what it does and not by its name, so the next split of `src/cli.ts` cannot move a registration out of a guard's sight. Pinned: a scan that matches nothing would let every guard built on it pass without checking anything, and `cli.ts` anchors it because the entry file always registers commands. */
export function cliDispatchFiles(): readonly string[] {
  const files = fs
    .readdirSync(SRC)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(SRC, name))
    .filter((full) => fs.readFileSync(full, 'utf8').includes(".command('"))
  return pinnedPopulation({ what: 'src/*.ts files registering commander commands', items: files, floor: 5, mustInclude: ['cli.ts'] })
}

/** Repo-relative path with forward slashes, the form a guard failure message and an allowlist use. */
export function relSrc(full: string): string {
  return path.relative(path.join(SRC, '..'), full).split(path.sep).join('/')
}

/** The registration chain of one command, from its `.command('name')` to the first `.action(`, wherever the dispatch code now lives. Fails when the command is registered nowhere or in more than one file. */
export function commandRegistration(name: string): { readonly file: string; readonly text: string } {
  const hits = cliDispatchFiles()
    .map((full) => ({ full, raw: fs.readFileSync(full, 'utf8') }))
    .filter(({ raw }) => raw.includes(`.command('${name}')`))
  if (hits.length !== 1) {
    throw new Error(`.command('${name}') must be registered in exactly one CLI dispatch file, found ${hits.length}: ${hits.map((h) => relSrc(h.full)).join(', ')}`)
  }
  const { full, raw } = hits[0]!
  const start = raw.indexOf(`.command('${name}')`)
  return { file: relSrc(full), text: raw.slice(start, raw.indexOf('.action(', start)) }
}
