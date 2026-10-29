import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export function writeFileAtomically(filePath, data) {
  let mode = 0o666
  try {
    const existing = fs.lstatSync(filePath)
    if (!existing.isFile()) throw new Error(`Not a regular file: ${filePath}`)
    mode = existing.mode & 0o777
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temporaryPath, data, { flag: 'wx', mode })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    fs.rmSync(temporaryPath, { force: true })
  }
}
