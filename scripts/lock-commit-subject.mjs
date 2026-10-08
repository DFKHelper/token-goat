#!/usr/bin/env node
/** A commit that changes a package-lock.json must say so in its subject: `chore(deps...)` for a dependency change, `release`/`chore(release)` for a version bump. The lock is the file `npm install` rewrites as a side effect (npm on Windows drops the `libc` fields from optional platform packages, and a stale nested map is rewritten on the next install), so a lock change tucked into a `fix(...)` commit reads as incidental churn and reaches review unexamined. One predicate, two callers: the lefthook commit-msg hook runs this file with the message path, and `tests/guards/lock_changes_only_in_dependency_commits.test.ts` applies `lockSubjectProblem` to every unpushed commit, which also covers a rebase, an amend or a clone with no hooks. */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { pathToFileURL } from 'node:url'

/** The subjects this repository's own history uses: `chore(deps): ...` and Dependabot's `chore(deps-dev): ...`, `release: 2.9.30`, and the older `chore(release): 2.9.19`. */
const DEPENDENCY_OR_RELEASE = /^(?:chore\(deps[a-z-]*\)|chore\(release\)|release)!?:/

export function isLockFile(file) {
  return file === 'package-lock.json' || file.endsWith('/package-lock.json')
}

/** Null when the commit may change a lock; otherwise a sentence naming the lock files and the subjects that are allowed. A merge commit is exempt: its diff is the other branch's, whose own commits were checked. */
export function lockSubjectProblem(subject, changedFiles) {
  const locks = changedFiles.filter(isLockFile)
  if (locks.length === 0) return null
  if (DEPENDENCY_OR_RELEASE.test(subject) || /^Merge /.test(subject)) return null
  return `this commit changes ${locks.join(', ')}, so its subject must start with chore(deps), chore(release) or release; got: ${subject}`
}

function subjectOf(messageFile) {
  const lines = fs.readFileSync(messageFile, 'utf8').split(/\r?\n/)
  return lines.find((line) => line.trim() !== '' && !line.startsWith('#')) ?? ''
}

function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\0').filter(Boolean)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const messageFile = process.argv[2]
  if (!messageFile || !fs.existsSync(messageFile)) process.exit(0)
  let files
  try {
    files = stagedFiles()
  } catch (error) {
    process.stderr.write(`commit-msg: could not list the staged files (${error.message}), so a lock file change was not checked. Refusing the commit.\n`)
    process.exit(1)
  }
  const problem = lockSubjectProblem(subjectOf(messageFile), files)
  if (problem) {
    process.stderr.write(`commit-msg: ${problem}\nMove the lock change into its own chore(deps) commit, or reword the subject if it is a dependency change.\n`)
    process.exit(1)
  }
}
