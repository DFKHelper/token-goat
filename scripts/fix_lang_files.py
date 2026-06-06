"""Fix css_idx.py and proto_idx.py to use strip_cstyle_comments from common.py."""
import ast
import re

CSS_FILES = [
    "src/token_goat/languages/css_idx.py",
    "src/token_goat/languages/proto_idx.py",
]
SQL_FILE = "src/token_goat/languages/sql_idx.py"


def fix_cstyle_file(fpath: str) -> None:
    with open(fpath, encoding="utf-8") as _f:
        src = _f.read()
    lines = src.splitlines(keepends=True)

    tree = ast.parse(src)

    # Find the _BLOCK_COMMENT_RE, _LINE_COMMENT_RE, and _strip_comments nodes
    remove_lines: set[int] = set()

    for node in ast.walk(tree):
        # Assignments to _BLOCK_COMMENT_RE or _LINE_COMMENT_RE
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in (
                    "_BLOCK_COMMENT_RE",
                    "_LINE_COMMENT_RE",
                ):
                    for ln in range(node.lineno, node.end_lineno + 1):
                        remove_lines.add(ln)

        # _strip_comments function definition
        if isinstance(node, ast.FunctionDef) and node.name == "_strip_comments":
            for ln in range(node.lineno, node.end_lineno + 1):
                remove_lines.add(ln)

    # Find the .common import line and add strip_cstyle_comments
    common_import_lineno = None
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == ".common":
            common_import_lineno = node.lineno
            break
        # Also check relative imports like "from .common import ..."
        if isinstance(node, ast.ImportFrom) and node.level == 1 and node.module == "common":
            common_import_lineno = node.lineno
            break

    new_lines = []
    for i, line in enumerate(lines, 1):
        if i in remove_lines:
            continue
        if i == common_import_lineno:
            # Add strip_cstyle_comments to existing import line
            stripped = line.rstrip("\n").rstrip("\r")
            new_lines.append(stripped + ", strip_cstyle_comments as _strip_comments\n")
        else:
            new_lines.append(line)

    # If common import not found, add one before the first from .  import
    if common_import_lineno is None:
        out = "".join(new_lines)
        out = re.sub(
            r"(from \.__future__)",
            "from .common import strip_cstyle_comments as _strip_comments\n\\1",
            out,
            count=1,
        )
        new_lines = [out]

    result = "".join(new_lines)

    # Remove blank lines that were left by removed lines (collapse 3+ blank to 2)
    result = re.sub(r"\n{3,}", "\n\n", result)

    ast.parse(result)  # Verify
    with open(fpath, "w", encoding="utf-8") as _f:
        _f.write(result)
    print(f"Updated {fpath}")


def fix_sql_file(fpath: str) -> None:
    """SQL uses -- for line comments, so we pass a custom line_re."""
    with open(fpath, encoding="utf-8") as _f:
        src = _f.read()
    lines = src.splitlines(keepends=True)

    tree = ast.parse(src)

    remove_lines: set[int] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in (
                    "_BLOCK_COMMENT_RE",
                    "_LINE_COMMENT_RE",
                ):
                    for ln in range(node.lineno, node.end_lineno + 1):
                        remove_lines.add(ln)

        if isinstance(node, ast.FunctionDef) and node.name == "_strip_comments":
            for ln in range(node.lineno, node.end_lineno + 1):
                remove_lines.add(ln)

    # Find the .common import
    common_import_lineno = None
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level == 1 and node.module == "common":
            common_import_lineno = node.lineno
            break

    new_lines = []
    for i, line in enumerate(lines, 1):
        if i in remove_lines:
            continue
        if i == common_import_lineno:
            stripped = line.rstrip("\n").rstrip("\r")
            new_lines.append(stripped + ", strip_cstyle_comments\n")
        else:
            new_lines.append(line)

    # SQL uses -- for line comments: add a module-level _LINE_COMMENT_RE override
    # and a module-level _strip_comments wrapper
    sql_wrapper = (
        '\n_SQL_LINE_COMMENT_RE = re.compile(r"--[^\\n]*")\n\n\n'
        "def _strip_comments(text: str) -> str:\n"
        '    """Replace SQL comment regions with whitespace, preserving line numbers."""\n'
        "    return strip_cstyle_comments(text, line_re=_SQL_LINE_COMMENT_RE)\n"
    )

    # Insert after the import block (before first non-import non-blank line at top level)
    result = "".join(new_lines)
    result = re.sub(r"\n{3,}", "\n\n", result)

    # Find the insertion point: after all imports, before module-level code
    # Simple heuristic: insert after the last import line
    m = None
    for mm in re.finditer(r"^(?:import |from )", result, re.MULTILINE):
        m = mm
    if m:
        # Find end of that line
        line_end = result.find("\n", m.start()) + 1
        result = result[:line_end] + sql_wrapper + result[line_end:]

    ast.parse(result)  # Verify
    with open(fpath, "w", encoding="utf-8") as _f:
        _f.write(result)
    print(f"Updated {fpath}")


if __name__ == "__main__":
    for f in CSS_FILES:
        fix_cstyle_file(f)
    fix_sql_file(SQL_FILE)
    print("All done.")
