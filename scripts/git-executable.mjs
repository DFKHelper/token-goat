import * as fs from 'node:fs'
import * as path from 'node:path'

function envValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

function absoluteDirectory(dir) {
  const absolute = path.win32.resolve(dir)
  try {
    return path.win32.resolve(fs.realpathSync.native(absolute))
  } catch {
    return absolute
  }
}

function contains(root, candidate) {
  const relative = path.win32.relative(root.toLowerCase(), candidate.toLowerCase())
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(relative))
}

function repositoryRoots(dir) {
  const roots = []
  let current = path.win32.resolve(dir)
  while (true) {
    try {
      const marker = fs.statSync(path.win32.join(current, '.git'))
      if (marker.isDirectory() || marker.isFile()) roots.push(current, absoluteDirectory(current))
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') roots.push(current, absoluteDirectory(current))
    }

    const parent = path.win32.dirname(current)
    if (parent === current) break
    current = parent
  }
  return roots
}

/** Resolve Git on Windows without searching either working directory or a repository-local PATH entry. */
export function gitExecutable(cwd, env = process.env) {
  if (process.platform !== 'win32') return 'git'

  const workingDirectories = [cwd, process.cwd()].flatMap((dir) => [
    path.win32.resolve(dir),
    absoluteDirectory(dir),
    ...repositoryRoots(dir),
  ])
  const searchPath = envValue(env, 'PATH') ?? ''

  for (const rawDir of searchPath.split(path.win32.delimiter)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1')
    if (dir === '') continue

    const lexicalDir = path.win32.resolve(cwd, dir)
    const realDir = absoluteDirectory(lexicalDir)
    if (workingDirectories.some((root) => contains(root, lexicalDir) || contains(root, realDir))) continue

    const candidate = path.win32.join(realDir, 'git.exe')
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // Try the next PATH entry.
    }
  }

  return null
}
