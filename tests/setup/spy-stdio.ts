import { vi } from 'vitest'

/** Spy on a writable stream's `write` (typically `process.stdout`/`process.stderr`), pushing every chunk (stringified) into `lines` and always returning `true`. Centralizes the mock-typing so callers don't each redeclare `ReturnType<typeof vi.spyOn>`, which loses the overloaded `write` signature and fails to typecheck when assigned back. */
export function spyOnWrite(stream: NodeJS.WritableStream, lines: string[]) {
  return vi.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk))
    return true
  })
}

export type WriteSpy = ReturnType<typeof spyOnWrite>
