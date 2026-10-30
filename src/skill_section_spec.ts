/** Resolve the skill-section `Heading#N` suffix without hiding a literal heading. */
export function parseSkillSectionSpec(
  heading: string,
  hasLiteralHeading: (candidate: string) => boolean,
): [baseHeading: string, ordinal: number] {
  const match = heading.match(/^(.*?)(?:#(\d+))?$/)
  if (!match) return [heading, 1]

  if (match[2] !== undefined && hasLiteralHeading(heading.trim())) {
    return [heading.trim(), 1]
  }

  const baseHeading = match[1] || heading
  const ordinal = match[2] ? Math.max(1, Number.parseInt(match[2], 10)) : 1
  return [baseHeading, ordinal]
}
