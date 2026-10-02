import type { SemanticConfig } from '../config_types.js'

// These mirror the private constants in embeddings.ts::_pathPriorityPenalty (which this slice may not edit); tests/guards/search_path_weight_mirrors_embeddings.test.ts fails if they drift.
export const ARCHIVE_PATH_SEGMENTS: ReadonlySet<string> = new Set(['archive', 'archived', 'old', 'deprecated', 'plans', 'drafts'])
export const ARCHIVE_FILE_RE = /(^changelog|\.bak$|\.orig$)/i
export const DOCS_FILE_RE = /\.md$/i
export const DOCS_DIR_SEGMENT = 'docs'

/** Multiplier in (0, 1] for a fused search score: archive_weight for archival paths, docs_weight for docs paths, 1 for live source. Archive wins when a path is both. */
export function pathPriorityWeight(filePath: string, semantic: Pick<SemanticConfig, 'archive_weight' | 'docs_weight'>): number {
  const segments = filePath.split(/[/\\]+/)
  const basename = segments[segments.length - 1] ?? filePath
  if (ARCHIVE_FILE_RE.test(basename) || segments.some((seg) => ARCHIVE_PATH_SEGMENTS.has(seg.toLowerCase()))) return semantic.archive_weight
  if (DOCS_FILE_RE.test(basename) || segments.some((seg) => seg.toLowerCase() === DOCS_DIR_SEGMENT)) return semantic.docs_weight
  return 1
}
