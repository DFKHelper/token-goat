export function compareCodeUnits(a: string, b: string): number
export function withoutImports(text: string): string
export function relativeSpecifiers(text: string): string[]
export function resolveSpecifier(from: string, spec: string, files: Set<string>): string | null
export function importerGraph(sources: Map<string, string>): Map<string, Set<string>>
export function testDistances(importers: Map<string, Set<string>>, changed: string[]): Map<string, number>
export function readSources(root: string): Map<string, string>
export function testsImporting(root: string, changed: string[]): Map<string, number>
