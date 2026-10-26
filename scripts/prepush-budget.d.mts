export const LEG_BUDGET_S: Record<string, number>
export const BUDGET_ENV: Record<string, string>
export const FIXED_OVERHEAD_S: number
export const CALIBRATION: number
export const CALIBRATION_EVIDENCE: string
export const DEFAULT_FILE_MS: number
export const WORKERS: { win32: number; other: number }
export function workersFor(env: Record<string, string | undefined>, platform: string): number
export function legBudget(leg: string, env: Record<string, string | undefined>): { seconds: number; source: string }
export function costFn(table: Record<string, number>): (file: string) => number
export function workSeconds(totalMs: number, workers: number): number
export function fillBudget(a: { fixed: string[]; ordered: string[]; cost: (f: string) => number; workers: number; budgetS: number }): { kept: string[]; deferred: string[]; estimateS: number; deferredS: number }
export const HOOK_LIMIT_S: number
export const HOOK_OVERHEAD_S: number
export const MARGIN_SHARE: number
export const TOTAL_BUDGET_S: number
export const ELAPSED_ENV: string
export function coldCostMs(table: Record<string, number>): number
