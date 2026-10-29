import { quotedArg, quotedArgs } from "./hint_suggestion_guard.js";
import { markHintShown, wasHintShown } from "./session.js";

export interface HintItem {
  text: string;
  hint_priority: number;
}

export const HINT_PRIORITY_MEDIUM = 3;

export interface ShowHintOnceOptions {
  /** Namespace of the hint, e.g. a HINT_CATEGORIES member; keeps two hint kinds with the same key apart. */
  category: string;
  /** The thing the hint points at, e.g. a file path. */
  key: string;
  /** Fingerprint of the state the hint describes; a changed trigger shows the hint again. */
  trigger: string;
}

/** True the first time a (category, key, trigger) triple is seen this session, and again whenever the trigger changes. The trigger lives inside the stored session key, so the persisted hintsShown shape is unchanged. */
export function showHintOnce(options: ShowHintOnceOptions): boolean {
  const hintKey = "hint_once:" + JSON.stringify([options.category, options.key, options.trigger]);
  if (wasHintShown(hintKey)) return false;
  markHintShown(hintKey);
  return true;
}

/** `shown` is the display-safe path the suggested commands must name; the basename test still runs on `file_path`. */
export function buildPackageManifestHint(options: {
  file_path: string;
  shown: string;
}): HintItem | null {
  try {
    const fname = _sanitizeHintPath(options.file_path.split(/[/\\]/).pop() ?? "");
    const basenameLower = fname.toLowerCase();

    if (basenameLower === "package.json") {
      const text = `\`${fname}\` is a package manifest. Run \`token-goat json-query ${quotedArgs(options.shown, "dependencies").join(" ")}\` or \`token-goat json-query ${quotedArgs(options.shown, "devDependencies").join(" ")}\` for focused reads, or \`token-goat json-outline ${quotedArg(options.shown)}\` for every top-level key.`;
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
