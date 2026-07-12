export interface HintItem {
  text: string;
  hint_priority: number;
}

export const HINT_PRIORITY_MEDIUM = 3;

export function buildPackageManifestHint(options: {
  file_path: string;
  offset?: number | null;
  limit?: number | null;
}): HintItem | null {
  try {
    const hasOffset =
      options.offset !== null && options.offset !== undefined && options.offset >= 0
    const hasLimit =
      options.limit !== null && options.limit !== undefined && options.limit > 0

    if (hasOffset || hasLimit) {
      return null;
    }

    const fname = _sanitizeHintPath(options.file_path.split(/[/\\]/).pop() ?? "");
    const basenameLower = fname.toLowerCase();

    if (basenameLower === "package.json") {
      const text = `\`${fname}\` is a package manifest. Consider \`token-goat section package.json::dependencies\` or \`token-goat section package.json::devDependencies\` for focused reads.`;
      return {
        text,
        hint_priority: HINT_PRIORITY_MEDIUM,
      };
    }

    return null;
  } catch {
    return null;
  }
}

function _sanitizeHintPath(path: string): string {
  if (typeof path !== "string") {
    return "???";
  }
  // eslint-disable-next-line no-control-regex
  return path.replace(/[\x00]/g, "").slice(0, 200);
}
