// The pid a pre-push cleanup record names, as the test process must signal it: the Windows pid from `reaper: pid=<bash pid> winpid=<windows pid> owner=...` (prepush-reaper.sh), else the bash pid off Windows, where /proc has no winpid file and the bash pid is the pid the test sees; on win32 an empty winpid is null, since the bash pid is not a pid the test can signal there.
export function reaperRecordPid(record: string, platform: string = process.platform): number | null {
  const m = /^reaper: pid=(\d+) winpid=(\d*)(?: |$)/m.exec(record)
  if (m === null) return null
  if (m[2] !== '') return Number(m[2])
  return platform === 'win32' ? null : Number(m[1])
}
