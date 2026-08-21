/**
 * Guard: every variable in the hand-maintained env fingerprint list must actually be read.
 *
 * `configEnvFingerprint` unions a hand-maintained `ENV_KEYS` array with the derived
 * `CONFIG_KEY_ENV_OVERRIDES` map. The array's past failures were all the dangerous direction --
 * a variable read by `_buildConfig` but missing from the list, so the config cache never noticed
 * it change -- and the derived half was added to close exactly that. The opposite direction was
 * left unguarded, and one entry sat there: `TOKEN_GOAT_CURATOR`, whose feature was removed,
 * leaving a name that appeared exactly once in the whole repository, in the list itself.
 *
 * A stub like that costs nothing at runtime, which is why it survived: it just contributes a
 * always-undefined value to a hash and gets cleared and restored by `withoutConfigEnv` for no
 * reason. It matters as a signal. The list is meant to be a statement about what this program
 * reads from the environment, and a name in it that nothing reads makes the list unreliable as
 * an answer to that question, for a person and for the drift guards built on top of it.
 *
 * Why didn't a test catch it: every existing test on this list checks that a variable which IS
 * read reaches `loadConfig` and busts its cache. Reading is the precondition of all of them, so
 * an entry nothing reads is invisible to the entire set -- it can never fail a test that starts
 * by setting it and expecting an effect.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '..', '..', 'src')
const CONFIG_SRC = path.join(SRC, 'config.ts')

/** The literal entries of the hand-maintained array, and the source span it occupies. */
function envKeysBlock(src: string): { keys: string[]; block: string } {
  const start = src.indexOf('const ENV_KEYS = [')
  if (start === -1) throw new Error('the ENV_KEYS array literal moved or was renamed; update this guard deliberately')
  const end = src.indexOf('\n]', start)
  if (end === -1) throw new Error('could not find the end of the ENV_KEYS array literal')
  const block = src.slice(start, end + 2)
  return { keys: [...block.matchAll(/'([A-Z_0-9]+)'/g)].map((m) => m[1]!), block }
}

/** Every .ts file under src/, so a reader in any module counts, not only in config.ts. */
function allSrcFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) allSrcFiles(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('env fingerprint list names only variables the program reads', () => {
  const configSrc = fs.readFileSync(CONFIG_SRC, 'utf8')
  const { keys, block } = envKeysBlock(configSrc)

  // The array itself is removed from the corpus, so an entry cannot vouch for its own existence.
  const corpus = allSrcFiles(SRC)
    .map((f) => (f === CONFIG_SRC ? configSrc.replace(block, '') : fs.readFileSync(f, 'utf8')))
    .join('\n')

  it('finds a non-trivial list, so this guard is not vacuously green', () => {
    expect(keys.length, 'the ENV_KEYS array parsed as empty -- the guard would pass on anything').toBeGreaterThan(10)
  })

  for (const key of keys) {
    it(`${key} is read somewhere in src/`, () => {
      expect(
        corpus.includes(key),
        `${key} is in the env fingerprint list but nothing in src/ reads it, so it only pads the cache key and gets cleared and restored for nothing -- remove the entry, or wire up the reader it is waiting for`,
      ).toBe(true)
    })
  }
})
