/**
 * The base every "this document is past a bound" error extends, whatever format raised it. The indexer decides from this class alone whether a file is worth opening again: a refusal is the same verdict on every run, so it is recorded as settled, while a failure to read leaves the file to be picked up later. That decision was written as a check for the PDF refusals only, which was right when PDFs were the only bounded format and quietly wrong once the dispatcher routed four. An OOXML zip bomb is exactly as deterministic as a PDF one, and it was re-paying its whole bounded-but-expensive decompression on every index pass. A shared base rather than a widened predicate, because the predicate is the thing that was forgotten: a format added later is classified by extending this, not by remembering a list.
 */
export class DocumentRefusedError extends Error {
  constructor(message: string, name: string) {
    super(message)
    this.name = name
  }
}
