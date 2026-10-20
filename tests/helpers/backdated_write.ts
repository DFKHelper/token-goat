import * as fs from 'node:fs'

/** Write `body` to `file`, then stamp its mtime an hour before now. The whole-file re-read denies prove a file unchanged by stat only when its mtime is at least one timestamp tick (2 s, TIMESTAMP_TICK_SEC in src/fingerprint.ts) older than the read; a file written an instant before its first read is unproven by design and is read through, so a row that expects a deny on an unchanged file starts from this. */
export function writeBackdated(file: string, body: string | Uint8Array): void {
  fs.writeFileSync(file, body)
  const earlier = new Date(Date.now() - 3_600_000)
  fs.utimesSync(file, earlier, earlier)
}
