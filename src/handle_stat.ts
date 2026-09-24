/** File identity taken through an open handle, so it can be compared against a descriptor's fstat. */
import * as fs from 'node:fs'

// O_NONBLOCK keeps the open from waiting on a FIFO for a writer that may never come. Windows has neither the flag nor the hazard.
const OPEN_FOR_STAT = process.platform === 'win32' ? fs.constants.O_RDONLY : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK

/** `fstat` of `p` through a handle opened on it, rather than a `stat` of the path. An identity that is later compared against an open descriptor's `fstat` must come from here, because on Windows the two calls do not agree under every Node release: libuv 1.49 and 1.50 answer a path `stat` from a fast path that leaves `dev` at 0 while `fstat` reports the volume serial (measured with Node 22.16.0: `stat` 0:554787179097211066, `fstat` 1862132318:554787179097211066 for one file). Taking both sides through a handle makes them the same question. Throws whatever the open throws. */
export function statThroughHandle(p: string): fs.BigIntStats {
  const fd = fs.openSync(p, OPEN_FOR_STAT)
  try {
    return fs.fstatSync(fd, { bigint: true })
  } finally {
    fs.closeSync(fd)
  }
}
