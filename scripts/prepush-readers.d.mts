export function readTrackedTests(root: string): Map<string, string>
export function readTrackedSupport(root: string): Map<string, string>
export function textReaderTiers(texts: Map<string, string>, changed: string[], srcChanged: boolean, support?: Map<string, string>): string[][]
export function readerTiersForRepo(root: string, changed: string[], srcChanged: boolean): string[][]
export function withoutCommentsOrUrls(text: string): string
