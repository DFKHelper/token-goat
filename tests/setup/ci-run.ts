// True only for a CI run: GitHub Actions sets CI to the string 'true'. A truthy check would also read CI=false as CI.
export function isCiRun(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.CI === 'true'
}

// For coverage guards that must fail loud: any CI value except unset, empty, 'false' or '0' counts, so CI=1 still fails closed.
export function ciSet(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.CI !== undefined && env.CI !== '' && env.CI !== 'false' && env.CI !== '0'
}
