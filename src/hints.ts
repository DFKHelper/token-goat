export interface HintItem {
  text: string;
  hint_priority: number;
}

export const HINT_PRIORITY_MEDIUM = 3;

/** `shown` is the display-safe path the suggested commands must name; the basename test still runs on `file_path`. */
export function buildPackageManifestHint(options: {
  file_path: string;
  shown: string;
}): HintItem | null {
  try {
    const fname = _sanitizeHintPath(options.file_path.split(/[/\\]/).pop() ?? "");
    const basenameLower = fname.toLowerCase();

    if (basenameLower === "package.json") {
      const text = `\`${fname}\` is a package manifest. Run \`token-goat json-query "${options.shown}" "dependencies"\` or \`token-goat json-query "${options.shown}" "devDependencies"\` for focused reads, or \`token-goat json-outline "${options.shown}"\` for every top-level key.`;
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
