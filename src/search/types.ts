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
}

export interface SearchExecutionSummary {
  readonly query: string;
  readonly durationMs: number;
  readonly totalHits: number;
  readonly activeChannels: ReadonlyArray<SearchChannel>;
  readonly channelCounts: Record<SearchChannel, number>;
  readonly degradedChannels?: ReadonlyArray<{ readonly channel: SearchChannel; readonly reason: string }> | undefined;
  readonly results: ReadonlyArray<FusedSearchResult>;
}
