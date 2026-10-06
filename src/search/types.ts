/** Types and interfaces for token-goat parallel multi-angle search. */

export type SearchChannel = 'symbol' | 'heading' | 'text' | 'semantic';
export const ALL_CHANNELS: ReadonlyArray<SearchChannel> = ['symbol', 'heading', 'text', 'semantic'];

export interface SearchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
  readonly projectRoot?: string | undefined;
  readonly channels?: ReadonlyArray<SearchChannel> | undefined;
  readonly json?: boolean | undefined;
  readonly minScore?: number | undefined;
}

export interface ChannelHit {
  readonly channel: SearchChannel;
  readonly filePath: string;
  readonly name?: string | undefined;
  readonly kind?: string | undefined;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly preview: string;
  readonly rawScore?: number | undefined;
  readonly rank: number;
}

export interface FusedSearchResult {
  readonly filePath: string;
  readonly name?: string | undefined;
  readonly kind?: string | undefined;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly preview: string;
  readonly channels: ReadonlyArray<SearchChannel>;
  readonly score: number;
  readonly channelHits: ReadonlyArray<ChannelHit>;
  /** Line of the best text-channel hit inside the fused range, when one exists. */
  readonly matchLine?: number | undefined;
  readonly matchPreview?: string | undefined;
  /** Set when the file is gone from disk and the row is what the index last saw of it. */
  readonly deleted?: true | undefined;
}

export interface SearchLowConfidence {
  readonly closestDistance: number;
  readonly threshold: number;
}

export interface SearchExecutionSummary {
  readonly query: string;
  readonly durationMs: number;
  readonly totalHits: number;
  readonly activeChannels: ReadonlyArray<SearchChannel>;
  readonly channelCounts: Record<SearchChannel, number>;
  readonly degradedChannels?: ReadonlyArray<{ readonly channel: SearchChannel; readonly reason: string }> | undefined;
  /** What a channel that ran has to say about the relevance of what it returned: the semantic floor emptying it, or its best hit being a weak match. */
  readonly notes?: ReadonlyArray<{ readonly channel: SearchChannel; readonly note: string }> | undefined;
  /** Set when the semantic channel's best hit is above `semantic.weak_distance`, the same field `semantic --json` carries. */
  readonly lowConfidence?: SearchLowConfidence | undefined;
  readonly results: ReadonlyArray<FusedSearchResult>;
}
