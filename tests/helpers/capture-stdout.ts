/** Temporarily override process.stdout.write to capture everything written synchronously during `fn()`, restoring the original write afterward even if `fn` throws. Returns the captured text. Centralizes a pattern duplicated across many test files (each redeclaring its own `origWrite`/override/try-finally), which also mistyped the forwarded-args cast (`rest as Parameters<typeof origWrite>` re-included `chunk`, overshooting `write`'s real arity). */
export function captureStdout(fn: () => void): string {
  let captured = ''
  const origWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    if (typeof chunk === 'string') captured += chunk
    return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stdout.write
  try {
    fn()
  } finally {
    process.stdout.write = origWrite
  }
  return captured
}
