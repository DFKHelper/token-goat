# Entity extraction

`scripts/extract_entities.py` finds numbered activities, tasks, requirements, or steps in a document. Extraction uses regular-expression presets or a caller-supplied `--pattern`; it is not a semantic AST or schema parser. The format adapters normalize source text and preserve locations where the input format provides them.

## Run the extractor

```bash
python scripts/extract_entities.py INPUT
python scripts/extract_entities.py INPUT --type requirements --format json
python scripts/extract_entities.py INPUT --out results.jsonl
python scripts/extract_entities.py INPUT --out results.csv --dedup
```

`INPUT` is the document path. The default type is `activities`; the other presets are `tasks`, `requirements`, and `steps`. By default, the command prints a summary and up to five sample entities.

### Output formats

Use `--format summary|json|jsonl|csv` to choose a format. JSON written to standard output is an array of entity records. When writing a file with `--out`, the default summary format becomes JSON, and that JSON file is an envelope with `entities` and `summary` fields. JSON Lines writes one entity per line; CSV writes a header and one row per entity.

The output filename suffix `.jsonl` or `.csv` selects that format, even if `--format` is omitted. Other suffixes do not select a format: the command uses `--format`, changing its default `summary` to JSON when `--out` is present. For example, `--out results.json` writes the default JSON envelope. `--out` cannot refer to the input file.

`--dump-chunks` adds normalized source chunks to the JSON envelope's `chunks` field. It requires `--out` and JSON output; it cannot be used with standard output, CSV, or JSONL.

### Deduplicate records

`--dedup` keeps the first entity for each normalized `(id, content)` pair, in encounter order. Numeric IDs are normalized to integers, and entity content is whitespace-normalized before comparison. Repeated pairs are removed even if they occur in different document chunks.

## Inputs and extraction behavior

Text-like inputs are read as chunks. Markdown files with `.md`, `.markdown`, or `.mdx` extensions are grouped using ATX (`# Heading`) and Setext (`Heading` followed by `===` or `---`) headings. Tables and lists remain text that the extraction patterns can match; Markdown is not parsed into a semantic document tree.

Other text inputs, including RST, AsciiDoc, YAML, TOML, XML, HTML, source code, and stylesheets, are scanned as text with format-specific normalization. XML and HTML tags are masked while retaining source positions; YAML and TOML key/value prefixes are masked so numbered values remain matchable. This does not validate every schema or interpret every format's semantics. Use `--comments-only` to restrict matches in code and stylesheet inputs to recognized comment text.

CSV and TSV are processed record by record. JSONL is read one line at a time. General JSON files are decoded as a whole before their items are yielded. PDF and Office inputs (`.doc`, `.docx`, `.xls`, `.xlsx`, and `.xlsm`) are also handled by readers that materialize their content; these formats are not end-to-end streaming.

## Locations

Entity records include `line_start` and `line_end` when the reader can provide physical source lines. Text input reports line spans. CSV/TSV reports the physical line span of each record, including multiline records. JSON and JSONL report physical line spans for items or records.

PDF records carry page units, not physical line numbers. Office records carry document or sheet units, and their line locations are `null`. Do not treat a page, paragraph, or worksheet row as a source line number.

## Streaming and memory

`iter_document()` yields normalized chunks, and `iter_entities()` yields entity records as it processes those chunks. The `load_document()` and `extract_entities()` convenience functions materialize their respective results as lists. The command uses the iterator APIs, so it does not collect all extracted entities by default.

Streaming does not make every reader incremental: general `.json` and PDF/Office readers materialize input content, while `.jsonl` and line-oriented text readers process incrementally. With `--dedup`, memory also holds a set of normalized IDs and contents already seen. `--dump-chunks` buffers every normalized chunk for the output envelope, so memory grows with the input.

For a custom `--pattern` on a streaming continuous text chunk, if no match occurs within the 65,536-character prefix, extraction stops with an explicit error. Narrow the input into smaller document units or adjust the pattern so it can match within that prefix. The unfinished entity and each CSV/JSONL record must still fit in memory; chunking bounds batches, not the size of an individual entity or record.

## Compatibility wrapper

`scripts/process_activities.py` remains available for the older activity-extraction workflow. Its `--dedup` option removes duplicate `(id, content)` pairs and delegates extraction to the shared entity logic.
