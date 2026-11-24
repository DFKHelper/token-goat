export function hasUnparenthesizedCaseInCommandSubstitution(source: string): boolean {
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
  for (const match of code.matchAll(/\$\(([^)]*)\)/gs)) {
    if (/\bcase\b[\s\S]*?\bin\s*(?!\s*\()/.test(match[1] ?? '')) return true
  }
  return false
}
