#!/usr/bin/env node
/**
 * Re-resolves `package-lock.json` for the packages a Dependabot pull request names, behind the same
 * cooldown that pull request waited out.
 *
 * Dependabot's own lock file cannot be merged here: it writes a bumped `optionalDependencies` entry
 * into `packages[""].dependencies`, which reclassifies an optional package as required and takes a
 * `--omit=optional` install from two packages to more. Three separate batches have done it, to three
 * different packages, and `tests/guards/dependency_advisory_disclosure.test.ts` fails each one
 * because it measures the tree the lock file resolves against the size SECURITY.md publishes.
 * Reported upstream as dependabot/dependabot-core#16173.
 *
 * Resolving by hand instead works, and has one trap worth automating away: a plain `npm update`
 * reaches for whatever is current, which silently opts out of the `cooldown` in
 * `.github/dependabot.yml`. That cooldown is the supply-chain control that keeps this repository out
 * of the group who install a compromised release before it is yanked, and skipping it once put a
 * package published forty-five minutes earlier into the tree. Dependabot's proposals are older than
 * a hand-resolve for exactly that reason, so newer than the pull request is a warning here.
 *
 * Usage:
 *   node scripts/refresh-dependabot-lock.mjs                    resolve the open Dependabot npm PR
 *   node scripts/refresh-dependabot-lock.mjs --packages a,b     resolve a named set instead
 *   node scripts/refresh-dependabot-lock.mjs --check            report what it would do, change nothing
 *   node scripts/refresh-dependabot-lock.mjs --verify           run the disclosure guard against the current lock file
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'
import { isDependabotPullRequest, isValidPackageName, packageNamesFromBody, summarizeGuardFailure } from './dependabot-body.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  process.stderr.write(`refresh-dependabot-lock: ${message}\n`)
  process.exit(1)
}

function run(file, args, options = {}) {
  return execFileSync(file, args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
}

/** The npm ecosystem's own cooldown, read rather than hardcoded, so changing the policy in one place changes it here too. */
function cooldownDays() {
  const config = loadYaml(fs.readFileSync(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8'))
  const npm = (config?.updates ?? []).find((entry) => entry['package-ecosystem'] === 'npm')
  const days = npm?.cooldown?.['default-days']
  if (typeof days !== 'number') fail('no npm cooldown.default-days in .github/dependabot.yml; refusing to guess a supply-chain window')
  return days
}

/** Dates only, because that is the granularity `npm update --before` accepts, and a whole extra day of cooldown is the safe rounding. */
function cutoffDate(days) {
  const now = new Date()
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days))
  return cutoff.toISOString().slice(0, 10)
}

/**
 * The pull request body lists one markdown table row per package, which is the only place the batch's
 * membership is written down.
 *
 * Which pull request counts as Dependabot's is an identity question, and a branch name is not an
 * identity. This repository is public, so anyone may open a pull request from a fork on a branch
 * called `dependabot/npm_and_yarn/anything` and write whatever table they like in the body; if theirs
 * is the only open one matching, this script would read it as Dependabot's. So the author has to be
 * the Dependabot app and the branch has to live in this repository rather than a fork. `--limit` is
 * explicit because `gh pr list` stops at thirty by default, and the real batch sitting on page two
 * would read here as no batch at all.
 */
function packagesFromOpenPullRequest() {
  let listing
  try {
    listing = run('gh', ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,headRefName,author,isCrossRepository'])
  } catch {
    fail('could not reach `gh`; pass --packages instead')
  }
  const candidates = JSON.parse(listing).filter(isDependabotPullRequest)
  if (candidates.length === 0) fail('no open Dependabot npm pull request; pass --packages to resolve a set by hand')
  if (candidates.length > 1) fail(`several open Dependabot npm pull requests (${candidates.map((pr) => `#${pr.number}`).join(', ')}); pass --packages`)
  const pr = candidates[0]
  const body = JSON.parse(run('gh', ['pr', 'view', String(pr.number), '--json', 'body'])).body ?? ''
  const names = packageNamesFromBody(body)
  if (names.length === 0) fail(`#${pr.number} lists no package rows; pass --packages`)
  return { number: pr.number, names }
}

function lockVersions(names) {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'))
  const out = new Map()
  for (const name of names) {
    const entry = lock.packages?.[`node_modules/${name}`]
    out.set(name, entry ? { version: entry.version, optional: entry.optional === true } : null)
  }
  return out
}

/**
 * Runs the guard that already owns this question rather than restating it here. A first draft of this
 * script did assert the invariant directly -- every name in `optionalDependencies` must carry
 * `optional: true` in the lock file -- and it was wrong on the very first run, flagging `sharp` and
 * `typescript` on a lock file that was correct: both are declared optional and are also reachable as
 * a required transitive dependency, so npm rightly does not mark them optional. The real invariant is
 * the resolved no-optional tree, which `dependency_advisory_disclosure` measures against the size
 * SECURITY.md publishes, and a second-rate restatement of it is worse than no second witness at all.
 */
function guardPasses() {
  try {
    run('npx', ['vitest', 'run', 'tests/guards/dependency_advisory_disclosure.test.ts'], { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    return null
  } catch (error) {
    return summarizeGuardFailure(error)
  }
}

const argv = process.argv.slice(2)
const check = argv.includes('--check')

// Separated from the resolve so the current lock file can be checked on its own, without waiting for a full suite run.
if (argv.includes('--verify')) {
  const failure = guardPasses()
  if (failure) fail(`the disclosure guard rejects the current lock file:\n${failure}`)
  process.stdout.write('the disclosure guard accepts the current lock file\n')
  process.exit(0)
}

const packagesArg = argv.find((value) => value.startsWith('--packages'))
let names
let pullRequest = null
if (packagesArg) {
  const value = packagesArg.includes('=') ? packagesArg.slice(packagesArg.indexOf('=') + 1) : argv[argv.indexOf(packagesArg) + 1]
  names = String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
  if (names.length === 0) fail('--packages needs a comma-separated list')
} else {
  const found = packagesFromOpenPullRequest()
  pullRequest = found.number
  names = found.names
}

// Before anything is measured or run, because these names reach `npm update` through a shell and a pull request body is chosen by whoever opened it. Checked for both sources: an operator typing --packages is trusted, but one code path that validates and one that does not is how the untrusted one eventually gets missed.
const rejected = names.filter((name) => !isValidPackageName(name))
if (rejected.length > 0) {
  fail(`not npm package names, refusing to put them on a command line: ${rejected.map((name) => JSON.stringify(name)).join(', ')}`)
}

const days = cooldownDays()
const cutoff = cutoffDate(days)
const before = lockVersions(names)

process.stdout.write(`${pullRequest ? `#${pullRequest}` : 'named set'}: ${names.length} package(s), cooldown ${days} days, resolving as of ${cutoff}\n`)
if (check) {
  for (const name of names) process.stdout.write(`  ${name.padEnd(24)} ${before.get(name)?.version ?? '(absent)'}\n`)
  process.stdout.write('--check: nothing written\n')
  process.exit(0)
}

// npm rewrites package-lock.json as it goes, so a failure here is not a no-op: it leaves a lock file that is neither the old one nor a resolved one, and the guard below never runs to say so. An uncaught throw would print a stack trace that says nothing about the file it just changed.
try {
  // `--` before the operands, so that even a name the check above let through cannot be read as a flag. Belt and braces: the check is the defense, this is what stops a future widening of it from becoming a cooldown bypass again.
  run('npm', ['update', `--before=${cutoff}`, '--', ...names], { stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' })
} catch (error) {
  fail(`\`npm update\` exited ${error.status ?? 'abnormally'}. package-lock.json may be half-resolved: restore it with \`git checkout -- package-lock.json\` before running anything else.`)
}

const after = lockVersions(names)
let moved = 0
for (const name of names) {
  const from = before.get(name)
  const to = after.get(name)
  const arrow = from?.version === to?.version ? '=' : '->'
  if (arrow === '->') moved += 1
  process.stdout.write(`  ${name.padEnd(24)} ${from?.version ?? '(absent)'} ${arrow} ${to?.version ?? '(absent)'}${to?.optional ? ' [optional]' : ''}\n`)
}

const failure = guardPasses()
if (failure) {
  fail(`the disclosure guard rejects the resolved lock file, which is the defect this script exists to avoid:\n${failure}\nRestore package-lock.json and investigate before committing.`)
}

process.stdout.write(`${moved} package(s) moved; the disclosure guard accepts the result. Run \`npm test\` before committing.\n`)
