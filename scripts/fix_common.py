"""Script to add strip_cstyle_comments to languages/common.py cleanly."""
import ast
import re

with open("src/token_goat/languages/common.py", encoding="utf-8") as _f:
    src = _f.read()

# Find bounds of the botched insertion
m = re.search(r"CALL_RE = re\.compile.*?\n", src)
pos_after_call_re = m.end()
m2 = re.search(r"\n\nclass AddSymbolFn", src[pos_after_call_re:])
botched_start = pos_after_call_re
botched_end = pos_after_call_re + m2.start()

# Build the clean insertion text (no escaping issues — literal string here)
lines = [
    "",
    "",
    "# Pre-compiled patterns used by strip_cstyle_comments for the common C-style",
    '# block-comment syntax (/* ... */).  Individual adapters may pass a custom',
    '# line_comment_re when their single-line delimiter differs (e.g. "--" for SQL).',
    '_CSTYLE_BLOCK_RE = re.compile(r"/\\*.*?\\*/", re.DOTALL)',
    '_CSTYLE_LINE_RE = re.compile(r"//[^\\n]*")',
    "",
    "",
    "def strip_cstyle_comments(",
    "    text: str,",
    "    *,",
    "    block_re: re.Pattern[str] = _CSTYLE_BLOCK_RE,",
    "    line_re: re.Pattern[str] = _CSTYLE_LINE_RE,",
    ") -> str:",
    '    """Replace comment regions with whitespace, preserving line numbers.',
    "",
    "    Replaces block comments (*block_re*) with the same number of newlines they",
    "    contained so that subsequent matches land on the correct 1-indexed line,",
    "    and strips line comments (*line_re*) entirely.",
    "",
    '    The defaults handle ``/* ... */`` block comments and ``//`` line comments,',
    "    shared by CSS, Proto, and many other C-family formats.  Pass *line_re* to",
    '    override the line-comment delimiter (e.g. SQL uses ``--``).',
    '    """',
    "",
    "    def _blank_block(m: re.Match[str]) -> str:",
    '        return "\\n" * m.group(0).count("\\n")',
    "",
    "    text = block_re.sub(_blank_block, text)",
    "    text = line_re.sub(\"\", text)",
    "    return text",
]
clean_insertion = "\n".join(lines)

new_src = src[:botched_start] + clean_insertion + src[botched_end:]

# Add to __all__ if not present
if '"strip_cstyle_comments"' not in new_src:
    new_src = new_src.replace(
        '    "sym_kind_str",\n]',
        '    "strip_cstyle_comments",\n    "sym_kind_str",\n]',
    )

try:
    ast.parse(new_src)
    print("AST OK")
    with open("src/token_goat/languages/common.py", "w", encoding="utf-8") as _f:
        _f.write(new_src)
    print("Written successfully")
except SyntaxError as e:
    print("SYNTAX ERROR:", e)
    lines_out = new_src.splitlines()
    for i, line in enumerate(lines_out[max(0, e.lineno - 5) : e.lineno + 3], max(0, e.lineno - 5)):
        print(f"{i + 1}: {line}")
