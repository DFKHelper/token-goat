export const DEADLINE_AT_ENV: string
export const DEADLINE_OUT_ENV: string
export interface DeadlineModule {
  moduleId: string
  state: () => string
  children: { allTests: () => Iterable<{ result: () => { state: string; note?: string } }> }
}
export interface DeadlineVitest {
  config?: { root?: string }
  cancelCurrentRun: (reason: string) => Promise<void>
}
export class DeadlineReporter {
  constructor(o: { deadlineAt: number | null; outFile: string | null; now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void })
  cancelled: boolean
  onInit(vitest: DeadlineVitest): void
  onTestModuleQueued(): void
  onTestRunEnd(testModules: DeadlineModule[], unhandledErrors: unknown[]): void
}
export function optionsFromEnv(env: Record<string, string | undefined>): { deadlineAt: number | null; outFile: string | null }
export default class PrepushDeadlineReporter extends DeadlineReporter {
  constructor()
}
