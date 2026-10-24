export interface RunCliIo {
  /** Directory the engine runs from; it finds the repository root from here. Defaults to the process working directory. */
  cwd?: string
  /** Receives one finding per call, without a trailing newline. Defaults to writing the line to the process stderr. */
  stderr?: (line: string) => void
}

/** Runs the architecture-doc engine and returns its exit code: 0 in sync or written, 1 drift, 2 configuration or usage error. */
export function runCli(argv: readonly string[], io?: RunCliIo): number
