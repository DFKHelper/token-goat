/** Temporarily override process.stdout.write to capture everything written synchronously during `fn()`, restoring the original write afterward even if `fn` throws. Returns the captured text. Centralizes a pattern duplicated across many test files (each redeclaring its own `origWrite`/override/try-finally). Captured text is swallowed, not forwarded: forwarding made one run of tests/graph_commands.test.ts print 2.3 MB, mostly `types --json` output (65 KB without it), which buried the vitest summary. Buffer chunks are captured too; the forwarding version passed them through and left them out of the returned text. */
export function captureStdout(fn: () => void): string {
  let captured = ''
  const origWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const cb = rest.find((r): r is () => void => typeof r === 'function')
    if (cb) cb()
    return true
  }) as typeof process.stdout.write
  try {
    fn()
  } finally {
    process.stdout.write = origWrite
  }
  return captured
}
