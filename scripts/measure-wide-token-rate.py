"""Measure how many tokens CJK text costs, so the `wide` class in src/token_estimate.ts rests on a rerunnable number.

Usage: python scripts/measure-wide-token-rate.py FILE... (UTF-8 text files). Prints one tab-separated row per file: name, UTF-16 units, UTF-8 bytes, cl100k_base tokens, o200k_base tokens, then tokens per unit and bytes per token for each encoding, and a final range row. Needs the `tiktoken` package with its encodings already cached; it makes no network request of its own beyond what tiktoken does to fetch a missing encoding.

Only the OpenAI tokenizers are measured. Claude's tokenizer is not public and was not measured, which is why the guard prices at 0.75 of the measured bytes-per-token rate rather than at the rate itself.
"""
import sys

import tiktoken


def main(paths):
    encodings = {name: tiktoken.get_encoding(name) for name in ("cl100k_base", "o200k_base")}
    rows = []
    for path in paths:
        with open(path, encoding="utf-8") as handle:
            text = handle.read().strip()
        units = len(text.encode("utf-16-le")) // 2
        size = len(text.encode("utf-8"))
        counts = {name: len(enc.encode(text)) for name, enc in encodings.items()}
        rows.append((path, units, size, counts))
        per_unit = "\t".join(f"{counts[name] / units:.2f}" for name in encodings)
        per_token = "\t".join(f"{size / counts[name]:.2f}" for name in encodings)
        print(f"{path}\t{units}\t{size}\t{counts['cl100k_base']}\t{counts['o200k_base']}\t{per_unit}\t{per_token}")
    for name in encodings:
        units_rate = [counts[name] / units for _, units, _, counts in rows]
        bytes_rate = [size / counts[name] for _, _, size, counts in rows]
        print(f"range {name}\ttokens per unit {min(units_rate):.2f}-{max(units_rate):.2f}\tbytes per token {min(bytes_rate):.2f}-{max(bytes_rate):.2f}")


if __name__ == "__main__":
    main(sys.argv[1:])
