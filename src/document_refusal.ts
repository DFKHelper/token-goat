/** How long any one document's extraction may run, whatever format it is. One constant rather than one per reader because the indexer records a clock refusal against the bound that was in force (see `timeoutEmbedSha` in parser.ts), and a per-reader clock would make "the bound in force" depend on the file's extension at a point that no longer knows it. `tests/guards/document_work_clock_is_one_value.test.ts` holds the readers to it. */
export const MAX_DOCUMENT_WORK_MILLIS = 60_000

/**
 * The base every "this document is past a bound" error extends, whatever format raised it. The indexer decides from this class alone whether a file is worth opening again: a refusal is the same verdict on every run, so it is recorded as settled, while a failure to read leaves the file to be picked up later. That decision was written as a check for the PDF refusals only, which was right when PDFs were the only bounded format and quietly wrong once the dispatcher routed four. An OOXML zip bomb is exactly as deterministic as a PDF one, and it was re-paying its whole bounded-but-expensive decompression on every index pass. A shared base rather than a widened predicate, because the predicate is the thing that was forgotten: a format added later is classified by extending this, not by remembering a list.
 *
 * `transient` splits that verdict in two. A size or count refusal is a property of the bytes: the same file is past the same bound on every run, forever. A clock refusal is not -- it measures this machine under this load, and the same file can be refused while a build saturates the disk and extract in two seconds an hour later. Recording the second kind as settled is a permanent verdict from a temporary condition, the very thing the extraction-failure branch in `indexFileEmbeddings` is written to avoid. A subclass declares which kind it is here rather than the indexer matching on error names, because a name list is this repo's recurring way of silently forgetting a case a later format added.
 */
export class DocumentRefusedError extends Error {
  readonly transient: boolean

  constructor(message: string, name: string, transient = false) {
    super(message)
    this.name = name
    this.transient = transient
  }
}
