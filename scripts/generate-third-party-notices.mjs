/**
 * Write THIRD_PARTY_NOTICES.md: the copyright and permission notices of every third-party package
 * the shipping build inlines into dist/.
 *
 * dist/ is not a directory of this project's own code. esbuild's `bundle: true` copies the source
 * of roughly two dozen npm packages into the emitted chunks, and package.json's `files` ships the
 * whole directory. MIT and BSD both require their copyright notice to travel with a binary
 * redistribution, and BlueOak requires the license text or a link, so the tarball owed those
 * notices and carried almost none: esbuild's default `legalComments` mode keeps only `/*!` and
 * `@license` comments, which most of these packages do not have, so only two of them left a trace
 * in dist/ and there was no notices file at all.
 *
 * The package list is read from the build's own metafile rather than from package.json's
 * dependencies. Those are different sets in both directions: `external` keeps several declared
 * dependencies out of the bundle entirely, and a package can arrive as a transitive dependency
 * nobody declared. Only what the bundler actually inlined creates the obligation, and only the
 * metafile knows what that was.
 *
 *   node scripts/generate-third-party-notices.mjs           # write the file
 *   node scripts/generate-third-party-notices.mjs --check   # fail if the file is out of date
 */
import * as esbuild from 'esbuild'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

import { ENTRY_POINTS, EXTERNAL_NATIVE_DEPS } from './build-options.mjs'

export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.md'

/**
 * Licenses this project accepts in its bundle. Everything here is permissive: it asks for the
 * notice this file exists to give, and nothing more. A copyleft or no-grant package reaching the
 * bundle is not a notices problem to be written up, it is a dependency decision to be made
 * deliberately, so the generator stops rather than quietly documenting it. (The LGPL libvips
 * binaries behind `sharp` are not in this set and never reach here: sharp is external, optional,
 * dynamically linked and disclosed in SECURITY.md.)
 */
export const PERMISSIVE = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Unlicense',
])

const LICENSE_FILE_RE = /^(LICENSE|LICENCE|COPYING|NOTICE)/i

/** `node_modules/a/b/c` -> `a`, or `@scope/a`. Null when the input is this project's own source. */
function packageOf(input) {
  const marker = input.replaceAll('\\', '/').lastIndexOf('node_modules/')
  if (marker === -1) return null
  const parts = input.replaceAll('\\', '/').slice(marker + 'node_modules/'.length).split('/')
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

/**
 * Every third-party package the shipping build inlines, sorted.
 *
 * `write: false` because this only needs the metafile: the generator must never be able to
 * overwrite a real dist/ as a side effect of describing it.
 */
export async function bundledPackages(repoRoot = process.cwd()) {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const result = await esbuild.build({
    absWorkingDir: repoRoot,
    metafile: true,
    write: false,
    entryPoints: ENTRY_POINTS,
    bundle: true,
    splitting: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outdir: 'dist',
    entryNames: '[name]',
    chunkNames: 'token-goat-chunk-[hash]',
    outExtension: { '.js': '.mjs' },
    external: EXTERNAL_NATIVE_DEPS,
    define: { 'import.meta.env': '{}', __TG_VERSION__: JSON.stringify(pkg.version) },
  })

  const names = new Set()
  for (const input of Object.keys(result.metafile.inputs)) {
    const name = packageOf(input)
    if (name !== null) names.add(name)
  }
  return [...names].sort()
}

/**
 * The notice text for one package: its own LICENSE file when it ships one.
 *
 * A handful of packages carry the notice in the head of their source file instead of in a separate
 * file (`omggif` is the one here). Falling back to that leading comment block keeps the obligation
 * met from the package's own text, rather than from a license template this repository chose on the
 * package's behalf -- which would be this project asserting someone else's copyright line.
 */
function noticeText(dir) {
  const files = readdirSync(dir).filter((f) => LICENSE_FILE_RE.test(f)).sort()
  if (files.length > 0) return readFileSync(path.join(dir, files[0]), 'utf8').trim()

  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const main = pkg.main ?? 'index.js'
  const mainPath = path.join(dir, main)
  if (!existsSync(mainPath)) return ''

  const head = []
  for (const line of readFileSync(mainPath, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('//')) break
    head.push(line.replace(/^\/\/ ?/, ''))
  }
  return head.join('\n').trim()
}

/** The whole document, as it should appear on disk. */
export async function renderNotices(repoRoot = process.cwd()) {
  const names = await bundledPackages(repoRoot)

  const sections = []
  const unexpected = []
  for (const name of names) {
    const dir = path.join(repoRoot, 'node_modules', ...name.split('/'))
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const license = typeof pkg.license === 'string' ? pkg.license : ''
    if (!PERMISSIVE.has(license)) unexpected.push(`${name} (${license === '' ? 'no license field' : license})`)

    const text = noticeText(dir)
    if (text === '') unexpected.push(`${name} (no notice text found)`)

    sections.push(`## ${name} ${pkg.version}\n\nLicense: ${license}\n\n\`\`\`text\n${text}\n\`\`\``)
  }

  if (unexpected.length > 0) {
    throw new Error(
      `These bundled packages are not permissively licensed, or ship no notice to reproduce:\n  ${unexpected.join('\n  ')}\n\n` +
      'Take the dependency out of the bundle, or decide deliberately to accept its terms and add ' +
      'the identifier to PERMISSIVE in scripts/generate-third-party-notices.mjs.',
    )
  }

  const header = [
    '# Third-party notices',
    '',
    `Token-Goat itself is licensed separately: see [LICENSE](LICENSE). This file covers only other people's code.`,
    '',
    `\`dist/\` is a bundle. Building it copies the source of the ${names.length} packages below into the`,
    'shipped files, so their copyright and permission notices travel with this package and are',
    'reproduced here in full.',
    '',
    'This file is generated. Regenerate it with `npm run notices` after any dependency change that',
    'reaches the bundle; `tests/guards/third_party_notices.test.ts` fails if it drifts.',
    '',
    'Packages this project depends on but does not bundle are not listed here. `sharp` and the other',
    'optional native dependencies stay external and install separately from npm; the licenses that',
    'need a human answer are covered in [SECURITY.md](SECURITY.md#dependency-licenses).',
    '',
  ].join('\n')

  return `${header}\n${sections.join('\n\n')}\n`
}

// `node -e` leaves argv[1] undefined, so importing this module for its exports must not crash here.
const invokedAs = (process.argv[1] ?? '').replaceAll('\\', '/')

if (import.meta.url === `file://${invokedAs}` || invokedAs.endsWith('generate-third-party-notices.mjs')) {
  const repoRoot = process.cwd()
  const target = path.join(repoRoot, NOTICES_FILE)
  const rendered = await renderNotices(repoRoot)

  if (process.argv.includes('--check')) {
    const onDisk = existsSync(target) ? readFileSync(target, 'utf8') : ''
    if (onDisk !== rendered) {
      console.error(`${NOTICES_FILE} is out of date. Run \`npm run notices\` and commit the result.`)
      process.exitCode = 1
    } else {
      console.log(`${NOTICES_FILE} is up to date.`)
    }
  } else {
    writeFileSync(target, rendered)
    console.log(`Wrote ${NOTICES_FILE}`)
  }
}
