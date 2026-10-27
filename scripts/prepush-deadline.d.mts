export const DEADLINE_REASON: string
export function moduleOutcome(moduleState: string, tests: { state: string; note?: string | undefined }[], cancelled?: boolean): 'done' | 'failed' | 'unfinished'
export function isRealError(error: unknown, cancelled?: boolean): boolean
export interface DeadlineOut {
  done: string[]
  failed: string[]
  unfinished: string[]
  errors: number
  cancelled: boolean
  ended: boolean
}
export function parseOut(text: string): DeadlineOut
export function legVerdict(out: DeadlineOut): 'green' | 'red' | 'plain'
export function splitPlan(focusText: string, planText: string): { deadlineAtMs: number; floor: string[]; fill: string[] }
export function cutReport(files: string[]): string
export function summarize(outFile: string, selected?: string[]): string
