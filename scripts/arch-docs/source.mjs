// Where the engine reads the repository from: the working tree, or under --staged the git index. Contract: SKILL.md "Verification Mode" (`--staged`) of the arch-doc-sync skill; the reference engine is sync_arch_docs.py, sections "git plumbing" and "source.mts".
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ArchDocError } from './config.mjs'

import { gitExecutable } from '../git-executable.mjs'

const GIT_MAX_BUFFER = 256 * 1024 * 1024
const REGULAR_MODES = new Set(['100644', '100755'])
const CAT_FILE_SIZE = /^[0-9]+$/

/** Runs git and returns its stdout, or null on a non-zero exit; `input` feeds stdin. */
export function runGit(cwd, args, input) {
  const executable = gitExecutable(cwd)
  if (executable === null) throw new ArchDocError('git executable not found on PATH')
  const result = spawnSync(executable, ['-c', 'core.quotepath=false', ...args], { cwd, input, maxBuffer: GIT_MAX_BUFFER, windowsHide: true })
  if (result.error && result.error.code === 'ENOENT') throw new ArchDocError('git executable not found on PATH')
  return result.status === 0 && !result.error ? result.stdout : null
}

export function repoRoot(cwd) {
  const out = runGit(cwd, ['rev-parse', '--show-toplevel'])
  const root = out === null ? '' : out.toString('utf8').trim()
  if (root === '') throw new ArchDocError('not inside a git work tree')
  return path.resolve(root)
}

const splitNul = (data) => data.toString('utf8').split('\0').filter((token) => token !== '')

/** Tracked paths only, never a filesystem walk: the list is the same on every machine. */
function listTracked(root) {
  const out = runGit(root, ['ls-files', '-z'])
  if (out === null) throw new ArchDocError('not inside a git work tree (git ls-files failed)')
  return [...new Set(splitNul(out))]
}

/** Contents of a regular file inside the repo, or null when it is missing or is a symlink or directory. */
function readRegularFile(root, rel) {
  const absolute = path.join(root, rel)
  try {
    return fs.lstatSync(absolute).isFile() ? fs.readFileSync(absolute, 'utf8') : null
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    throw error
  }
}

/** True when `rel` exists in the working tree as anything, a symlink included. */
export function existsOnDisk(root, rel) {
  try {
    fs.lstatSync(path.join(root, rel))
    return true
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false
    throw error
  }
}

/** Renames from `git diff --name-status -z -M`: R entries carry two paths and count, C entries carry two paths and do not. */
export function parseNameStatus(data) {
  const tokens = splitNul(data)
  const records = []
  let i = 0
  while (i < tokens.length) {
    const status = tokens[i]
    if (status.startsWith('R') && i + 2 < tokens.length) records.push({ from: tokens[i + 1], to: tokens[i + 2] })
    i += status.startsWith('R') || status.startsWith('C') ? 3 : 2
  }
  return records
}

/** Entries of `git ls-tree -r -z`, `<mode> <type> <oid><TAB><path>`; the path may itself hold tabs. */
export function parseLsTree(data) {
  const entries = new Map()
  for (const record of splitNul(data)) {
    const tab = record.indexOf('\t')
    const parts = (tab === -1 ? record.slice(0, -1) : record.slice(0, tab)).split(' ')
    if (tab === -1 || parts.length < 3) throw new ArchDocError(`unexpected git ls-tree record ${JSON.stringify(record)}`)
    entries.set(record.slice(tab + 1), { mode: parts[0], oid: parts[2] })
  }
  return entries
}

/** Entries of `git diff --raw -z`: `:<srcmode> <dstmode> <srcoid> <dstoid> <status>`, NUL, path, NUL, and a second path for R and C. */
export function parseRawDiff(data) {
  const tokens = splitNul(data)
  const changes = []
  let i = 0
  while (i < tokens.length) {
    const header = tokens[i]
    const parts = header.split(' ')
    const status = parts.length > 4 ? parts[4].slice(0, 1) : ''
    if (!header.startsWith(':') || parts.length < 4 || status === '') throw new ArchDocError(`unexpected git diff --raw record ${JSON.stringify(header)}`)
    const twoPaths = status === 'R' || status === 'C'
    const first = tokens[i + 1]
    const second = twoPaths ? tokens[i + 2] : first
    if (first === undefined || second === undefined) throw new ArchDocError('truncated git diff --raw output')
    changes.push({ status, mode: parts[1], oid: parts[3], path: second, from: twoPaths ? first : null })
    i += twoPaths ? 3 : 2
  }
  return changes
}

/** Splits `git cat-file --batch` output into one Buffer per requested object, in request order. */
export function parseCatFileBatch(data, count) {
  const blobs = []
  let offset = 0
  while (blobs.length < count) {
    const newline = data.indexOf(0x0a, offset)
    if (newline === -1) throw new ArchDocError('truncated git cat-file output')
    const parts = data.toString('utf8', offset, newline).split(' ')
    const kind = parts[1]
    const size = parts[2]
    if (kind !== 'blob' || size === undefined || !CAT_FILE_SIZE.test(size)) {
      throw new ArchDocError(`could not read object ${parts[0]}: ${kind === undefined ? 'unexpected output' : kind}`)
    }
    const start = newline + 1
    const end = start + Number(size)
    if (end >= data.length || data[end] !== 0x0a) throw new ArchDocError('truncated git cat-file output')
    blobs.push(data.subarray(start, end))
    offset = end + 1
  }
  return blobs
}

/** Blob contents for `oids`, in the same order, read with a single git process. */
function readBlobs(root, oids) {
  if (oids.length === 0) return []
  const out = runGit(root, ['cat-file', '--batch'], `${oids.join('\n')}\n`)
  if (out === null) throw new ArchDocError('could not read blob content (git cat-file failed)')
  return parseCatFileBatch(out, oids.length)
}

/** Every path in the HEAD commit with its mode and blob id; empty while HEAD is unborn. */
function headTree(root) {
  if (runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']) === null) return new Map()
  const tree = runGit(root, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'])
  if (tree === null) throw new ArchDocError('could not list HEAD (git ls-tree failed)')
  return parseLsTree(tree)
}

/** The tree the next commit would record: HEAD (empty when unborn) with the staged diff applied; intent-to-add paths are absent, as from the commit. */
function stagedSnapshot(root) {
  const entries = headTree(root)
  const diff = runGit(root, ['diff', '--cached', '--raw', '-z', '-M', '--no-abbrev', '--no-ext-diff', '--no-textconv'])
  if (diff === null) throw new ArchDocError('could not read the index (git diff --cached failed)')
  const renames = []
  for (const change of parseRawDiff(diff)) {
    if (change.status === 'U') throw new ArchDocError(`${change.path}: unmerged path; resolve the conflict before committing`)
    if (change.status === 'D') {
      entries.delete(change.path)
      continue
    }
    if (!'ACMRT'.includes(change.status)) throw new ArchDocError(`${change.path}: unexpected staged status ${change.status}`)
    if (change.status === 'R' && change.from !== null) {
      entries.delete(change.from)
      renames.push({ from: change.from, to: change.path })
    }
    entries.set(change.path, { mode: change.mode, oid: change.oid })
  }
  return { entries, renames }
}

/** HEAD contents of single files, for the auto role a renamed-away module had; the HEAD tree is listed at most once. */
export function headReader(root) {
  let tree
  return {
    text(rel) {
      tree ??= headTree(root)
      const entry = tree.get(rel)
      return entry === undefined || !REGULAR_MODES.has(entry.mode) ? null : readBlobs(root, [entry.oid])[0].toString('utf8')
    },
  }
}

/** The working tree: tracked files, renames between HEAD and the tree (staged or not), and on-disk contents. */
export function worktreeSource(root) {
  const renames = runGit(root, ['diff', '--name-status', '-z', '-M', 'HEAD'])
  return {
    name: 'working tree',
    docMissingSuffix: '',
    files: listTracked(root),
    renames: renames === null ? [] : parseNameStatus(renames),
    read: (rel) => readRegularFile(root, rel),
    readAll(wanted) {
      const texts = new Map()
      for (const rel of new Set(wanted)) {
        const text = readRegularFile(root, rel)
        if (text !== null) texts.set(rel, text)
      }
      return texts
    },
    configReader: {
      has: (rel) => fs.existsSync(path.join(root, rel)),
      read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    },
  }
}

/** The git index as the next commit would record it: staged paths, staged renames and staged blob contents. */
export function indexSource(root) {
  const { entries, renames } = stagedSnapshot(root)
  const blobs = new Map()
  const regularOid = (rel) => {
    const entry = entries.get(rel)
    if (entry === undefined) return null
    if (!REGULAR_MODES.has(entry.mode)) throw new ArchDocError(`${rel}: must be a regular file, not a symlink or submodule`)
    return entry.oid
  }
  const load = (rels) => {
    const pending = rels.filter((rel) => !blobs.has(rel))
    const contents = readBlobs(root, pending.map((rel) => entries.get(rel).oid))
    pending.forEach((rel, i) => blobs.set(rel, contents[i].toString('utf8')))
  }
  const read = (rel) => {
    if (regularOid(rel) === null) return null
    load([rel])
    return blobs.get(rel)
  }
  return {
    name: 'index',
    docMissingSuffix: ' in the index; stage it with git add',
    files: [...entries.keys()],
    renames,
    has: (rel) => entries.has(rel),
    read,
    readAll(wanted) {
      const regular = [...new Set(wanted)].filter((rel) => entries.has(rel) && REGULAR_MODES.has(entries.get(rel).mode))
      load(regular)
      return new Map(regular.map((rel) => [rel, blobs.get(rel)]))
    },
    configReader: { has: (rel) => entries.has(rel), read },
  }
}
