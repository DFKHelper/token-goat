// A module-customization hooks file: registered by a --import preload, it appends the URL of every module the run loads to the file named in `initialize`'s data. Lets a test see which built chunks an import really pulled in.
import { appendFileSync } from 'node:fs'

let logPath = ''

export function initialize(data) {
  logPath = data.logPath
}

export async function load(url, context, nextLoad) {
  appendFileSync(logPath, `${url}\n`)
  return nextLoad(url, context)
}
