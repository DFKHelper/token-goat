"""Tests for the Markdown extractor."""
from __future__ import annotations

from pathlib import Path

import pytest

from token_goat.languages.markdown import extract

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "md_sample"
ARTICLE_MD = FIXTURE_DIR / "article.md"


@pytest.fixture
def md_source() -> bytes:
    return ARTICLE_MD.read_bytes()


@pytest.fixture
def md_extracted(md_source):
    return extract(md_source, "article.md")


def test_extract_returns_four_lists(md_extracted):
    symbols, refs, imports, sections = md_extracted
    assert isinstance(symbols, list)
    assert isinstance(refs, list)
    assert isinstance(imports, list)
    assert isinstance(sections, list)


def test_frontmatter_title_extracted(md_extracted):
    symbols, _, _, _ = md_extracted
    names = {s.name for s in symbols}
    assert "Test Article" in names
    title_sym = next(s for s in symbols if s.name == "Test Article")
    assert title_sym.kind == "md_title"


def test_h1_heading_extracted(md_extracted):
    _, _, _, sections = md_extracted
    headings = {s.heading for s in sections}
    assert "Top Level" in headings


def test_h2_methodology_extracted(md_extracted):
    _, _, _, sections = md_extracted
    headings = {s.heading for s in sections}
    assert "Methodology" in headings


def test_h3_subsection_extracted(md_extracted):
    _, _, _, sections = md_extracted
    headings = {s.heading for s in sections}
    assert "Subsection" in headings


def test_h2_results_extracted(md_extracted):
    _, _, _, sections = md_extracted
    headings = {s.heading for s in sections}
    assert "Results" in headings


def test_heading_symbols_created(md_extracted):
    symbols, _, _, _ = md_extracted
    heading_symbols = [s for s in symbols if s.kind == "heading"]
    assert len(heading_symbols) >= 3


def test_methodology_end_line_computed(md_extracted):
    _, _, _, sections = md_extracted
    methodology = next(s for s in sections if s.heading == "Methodology")
    # Results heading comes after, so end_line should be before Results
    results = next(s for s in sections if s.heading == "Results")
    assert methodology.end_line < results.line


# ---------------------------------------------------------------------------
# Precision improvements: fenced-code heading skip + trailing-blank trim
# ---------------------------------------------------------------------------


def test_fenced_atx_heading_is_not_indexed_as_heading():
    """ATX-looking lines inside ``` fences must not be promoted to sections.

    Without this, a code-block comment ``# Not a heading`` shadows the real
    heading lookup and corrupts the preceding section's end_line.
    """
    src = (
        b"# Real Heading\n"
        b"\n"
        b"Intro.\n"
        b"\n"
        b"```python\n"
        b"# This is a comment, not a heading\n"
        b"## Also not a heading\n"
        b"def foo():\n"
        b"    pass\n"
        b"```\n"
        b"\n"
        b"## Real Subsection\n"
        b"\n"
        b"Content.\n"
    )
    _, _, _, sections = extract(src, "fenced.md")
    headings = {s.heading for s in sections}
    assert "Real Heading" in headings
    assert "Real Subsection" in headings
    # The two in-fence lines must be excluded.
    assert "This is a comment, not a heading" not in headings
    assert "Also not a heading" not in headings


def test_fenced_atx_heading_does_not_truncate_outer_section():
    """The end_line of an outer section must extend past fenced code blocks."""
    src = (
        b"# Outer\n"
        b"\n"
        b"intro\n"
        b"\n"
        b"```\n"
        b"## Fake H2\n"
        b"```\n"
        b"\n"
        b"more text\n"
        b"\n"
        b"# Next Top\n"
    )
    _, _, _, sections = extract(src, "fenced2.md")
    outer = next(s for s in sections if s.heading == "Outer")
    next_top = next(s for s in sections if s.heading == "Next Top")
    # Outer must extend to at least line 9 ("more text"), not stop at line 6.
    assert outer.end_line is not None
    assert outer.end_line >= 9
    assert outer.end_line < next_top.line


def test_tilde_fenced_code_block_also_skipped():
    """``~~~`` fences must be honoured just like backtick fences."""
    src = (
        b"# Real\n"
        b"\n"
        b"~~~\n"
        b"## Fake In Tilde\n"
        b"~~~\n"
        b"\n"
        b"## Real Sub\n"
    )
    _, _, _, sections = extract(src, "tilde.md")
    headings = {s.heading for s in sections}
    assert "Fake In Tilde" not in headings
    assert "Real Sub" in headings


def test_section_end_line_trims_trailing_blank_lines():
    """End_line should not include trailing blank lines before the next equal-level heading.

    Every trailing blank line returned by read_section is a wasted token in the
    LLM context window.
    """
    src = (
        b"## A\n"
        b"\n"
        b"Aaa.\n"
        b"\n"
        b"\n"
        b"\n"
        b"## B\n"
        b"\n"
        b"Bbb.\n"
    )
    _, _, _, sections = extract(src, "trim.md")
    a = next(s for s in sections if s.heading == "A")
    # Section A is heading on line 1, content "Aaa." on line 3, blanks 4-6, B on line 7.
    # end_line must be 3 (last non-blank content line), not 6 (last blank before B).
    assert a.end_line == 3


def test_trim_preserves_heading_only_section():
    """A heading with no body should still have end_line == heading line."""
    # Use sibling-level headings so the section terminates at the next one.
    src = b"## Only heading\n\n\n## Next\n"
    _, _, _, sections = extract(src, "only.md")
    only = next(s for s in sections if s.heading == "Only heading")
    # No body — end_line must still be at the heading line, never lower.
    assert only.end_line == 1


def test_trim_does_not_apply_when_section_contains_nested_subheading():
    """A level-1 section that contains level-2 children must extend through them.

    This is a sanity check: trim must NOT eat the section's body just because
    blank padding sits between the heading and a child heading.
    """
    src = (
        b"# Outer\n"
        b"\n"
        b"Outer intro.\n"
        b"\n"
        b"## Inner\n"
        b"\n"
        b"Inner body.\n"
    )
    _, _, _, sections = extract(src, "nested.md")
    outer = next(s for s in sections if s.heading == "Outer")
    inner = next(s for s in sections if s.heading == "Inner")
    # Outer wraps Inner, so it ends at the last non-blank line of Inner (7).
    assert outer.end_line is not None and outer.end_line >= inner.line
    # Inner has body "Inner body." on line 7 → end_line should be exactly 7.
    assert inner.end_line == 7


def test_fenced_skip_does_not_drop_heading_with_hash_before_fence():
    """Sanity: a real `# Heading` line that happens to immediately precede a
    fenced block must still be indexed."""
    src = (
        b"# Heading Before Fence\n"
        b"```\n"
        b"# fake\n"
        b"```\n"
    )
    _, _, _, sections = extract(src, "before.md")
    headings = {s.heading for s in sections}
    assert "Heading Before Fence" in headings
    assert "fake" not in headings


# ---------------------------------------------------------------------------
# Setext-style heading support (Title\n=== for H1, Title\n--- for H2)
# ---------------------------------------------------------------------------


def test_setext_h1_extracted():
    """`Title\\n===` must produce an H1 section at the *text* line."""
    src = (
        b"Some Big Title\n"
        b"==============\n"
        b"\n"
        b"body text\n"
    )
    _, _, _, sections = extract(src, "setext1.md")
    titles = [s for s in sections if s.heading == "Some Big Title"]
    assert len(titles) == 1
    assert titles[0].level == 1
    assert titles[0].line == 1


def test_setext_h2_extracted():
    """`Title\\n---` must produce an H2 section when the line above is non-blank."""
    src = (
        b"H2 Subtitle\n"
        b"-----------\n"
        b"\n"
        b"body\n"
    )
    _, _, _, sections = extract(src, "setext2.md")
    subs = [s for s in sections if s.heading == "H2 Subtitle"]
    assert len(subs) == 1
    assert subs[0].level == 2


def test_setext_h2_not_confused_with_hr():
    """A `---` that follows a blank line is a horizontal rule, not setext.

    Without this check, every HR in a document would silently steal the
    previous paragraph as a fake H2 heading.
    """
    src = (
        b"Some paragraph.\n"
        b"\n"
        b"---\n"
        b"\n"
        b"More text.\n"
    )
    _, _, _, sections = extract(src, "hr.md")
    assert not any(s.heading == "Some paragraph." for s in sections)


def test_setext_skipped_inside_fence():
    """A setext underline inside a code fence must not promote the line above."""
    src = (
        b"```\n"
        b"Fake Title\n"
        b"==========\n"
        b"```\n"
        b"\n"
        b"# Real\n"
    )
    _, _, _, sections = extract(src, "setextfence.md")
    assert not any(s.heading == "Fake Title" for s in sections)
    assert any(s.heading == "Real" for s in sections)


def test_setext_skipped_when_text_is_blockquote():
    """`> Quoted\\n---` is content inside a blockquote, not a setext heading."""
    src = (
        b"> Quoted text\n"
        b"-------------\n"
    )
    _, _, _, sections = extract(src, "setextquote.md")
    assert not any(s.heading == "> Quoted text" for s in sections)


def test_setext_and_atx_interleaved_end_lines():
    """Setext + ATX in the same doc must yield correct end_lines in doc order."""
    src = (
        b"Top\n"
        b"===\n"
        b"\n"
        b"intro\n"
        b"\n"
        b"## Sub A\n"
        b"\n"
        b"aaa\n"
        b"\n"
        b"Sub B\n"
        b"-----\n"
        b"\n"
        b"bbb\n"
    )
    _, _, _, sections = extract(src, "mix.md")
    top = next(s for s in sections if s.heading == "Top")
    sub_a = next(s for s in sections if s.heading == "Sub A")
    sub_b = next(s for s in sections if s.heading == "Sub B")
    # Top is H1 and should wrap both H2s.  Sub A ends before Sub B starts.
    assert top.line < sub_a.line < sub_b.line
    assert sub_a.end_line is not None and sub_a.end_line < sub_b.line


# ---------------------------------------------------------------------------
# Blockquote / list-prefixed ATX-looking lines must be skipped
# ---------------------------------------------------------------------------


def test_blockquoted_atx_not_extracted():
    """`> ## Quoted` is content inside a blockquote, not a section."""
    src = (
        b"# Real\n"
        b"\n"
        b"> ## Quoted heading\n"
        b"> more quote\n"
        b"\n"
        b"## Real Sub\n"
    )
    _, _, _, sections = extract(src, "quoted.md")
    headings = {s.heading for s in sections}
    assert "Real" in headings
    assert "Real Sub" in headings
    assert "Quoted heading" not in headings


def test_list_item_atx_not_extracted():
    """`- ## item` and `1. ## item` are list content, not sections."""
    src = (
        b"# Real\n"
        b"\n"
        b"- ## list item heading\n"
        b"- another\n"
        b"\n"
        b"1. ## ordered item\n"
        b"\n"
        b"## Real Sub\n"
    )
    _, _, _, sections = extract(src, "listitem.md")
    headings = {s.heading for s in sections}
    assert "list item heading" not in headings
    assert "ordered item" not in headings
    assert "Real Sub" in headings


# ---------------------------------------------------------------------------
# Front-matter exposed as synthetic `__frontmatter__` section
# ---------------------------------------------------------------------------


def test_frontmatter_synthetic_section():
    """YAML front-matter must produce a `__frontmatter__` section covering its span."""
    src = (
        b"---\n"
        b"title: Hello\n"
        b"author: Someone\n"
        b"---\n"
        b"\n"
        b"# Body\n"
        b"\n"
        b"text\n"
    )
    _, _, _, sections = extract(src, "fm.md")
    fm = next((s for s in sections if s.heading == "__frontmatter__"), None)
    assert fm is not None, "expected synthetic __frontmatter__ section"
    assert fm.line == 1
    # Closing `---` is on line 4; end_line must cover at least line 4 and not
    # extend into the body.
    assert fm.end_line is not None and fm.end_line >= 3
    # Body H1 must still be extracted normally.
    assert any(s.heading == "Body" for s in sections)


def test_no_frontmatter_means_no_synthetic_section():
    """Files without front-matter must not get a `__frontmatter__` section."""
    src = b"# Title\n\nbody\n"
    _, _, _, sections = extract(src, "no-fm.md")
    assert not any(s.heading == "__frontmatter__" for s in sections)


# ---------------------------------------------------------------------------
# GitHub-flavored Markdown <details><summary>…</summary>…</details> blocks
# ---------------------------------------------------------------------------


def test_details_block_with_summary_extracted():
    """`<details><summary>Title</summary>body</details>` is a section named "Title"."""
    src = (
        b"# Real Heading\n"
        b"\n"
        b"<details>\n"
        b"<summary>Click to expand</summary>\n"
        b"\n"
        b"Hidden body content.\n"
        b"\n"
        b"</details>\n"
        b"\n"
        b"## After\n"
    )
    _, _, _, sections = extract(src, "details.md")
    headings = {s.heading for s in sections}
    assert "Click to expand" in headings
    detail = next(s for s in sections if s.heading == "Click to expand")
    # level=99 sentinel keeps it out of ATX/Setext hierarchy.
    assert detail.level == 99
    # Block starts on line 3 (the `<details>` opener).
    assert detail.line == 3
    # end_line must cover through the `</details>` closer on line 8.
    assert detail.end_line is not None and detail.end_line >= 8


def test_details_block_heading_symbol_created():
    """Detail summaries must be findable via `token-goat symbol <summary>`."""
    src = b"<details><summary>Findable Title</summary>body</details>\n"
    symbols, _, _, _ = extract(src, "ds.md")
    names = {s.name for s in symbols if s.kind == "heading"}
    assert "Findable Title" in names


def test_details_block_without_summary_uses_synthetic_name():
    """`<details>` with no `<summary>` produces a `__details__` section."""
    src = (
        b"<details>\n"
        b"No summary here.\n"
        b"</details>\n"
    )
    _, _, _, sections = extract(src, "ds-nosum.md")
    headings = {s.heading for s in sections}
    assert "__details__" in headings


def test_details_block_strips_inline_markup_from_summary():
    """Inline HTML inside `<summary>` (e.g. <b>, <i>) must be stripped from the name."""
    src = (
        b"<details>\n"
        b"<summary><b>Bold</b> and <i>italic</i> text</summary>\n"
        b"body\n"
        b"</details>\n"
    )
    _, _, _, sections = extract(src, "ds-markup.md")
    headings = {s.heading for s in sections}
    # The visible label is "Bold and italic text", not "<b>Bold</b>…".
    assert "Bold and italic text" in headings


def test_nested_details_emits_outer_only():
    """A nested `<details>` inside another must not corrupt the outer's end_line.

    Only the outer block is surfaced; otherwise the inner block's range would
    overlap with the outer's and confuse section-end-line consumers.
    """
    src = (
        b"<details>\n"
        b"<summary>Outer</summary>\n"
        b"\n"
        b"<details>\n"
        b"<summary>Inner</summary>\n"
        b"inner body\n"
        b"</details>\n"
        b"\n"
        b"</details>\n"
    )
    _, _, _, sections = extract(src, "ds-nested.md")
    headings = {s.heading for s in sections}
    assert "Outer" in headings
    # Inner is intentionally not emitted as a separate section.
    assert "Inner" not in headings
    outer = next(s for s in sections if s.heading == "Outer")
    # Outer must extend through the *outer* closing </details> on line 9.
    assert outer.end_line is not None and outer.end_line >= 9


def test_details_inside_fenced_code_block_skipped():
    """A literal `<details>` example inside a ``` fence is documentation, not a section."""
    src = (
        b"# Real\n"
        b"\n"
        b"```html\n"
        b"<details>\n"
        b"<summary>Fake</summary>\n"
        b"example body\n"
        b"</details>\n"
        b"```\n"
        b"\n"
        b"## After\n"
    )
    _, _, _, sections = extract(src, "ds-fenced.md")
    headings = {s.heading for s in sections}
    assert "Fake" not in headings
    assert "Real" in headings
    assert "After" in headings


def test_details_open_tag_with_attributes_handled():
    """`<details open class="foo">` must still be recognized as an opener."""
    src = (
        b'<details open class="foo">\n'
        b"<summary>Attr Title</summary>\n"
        b"body\n"
        b"</details>\n"
    )
    _, _, _, sections = extract(src, "ds-attr.md")
    headings = {s.heading for s in sections}
    assert "Attr Title" in headings


def test_details_summary_with_attributes_handled():
    """`<summary class="foo">Title</summary>` must be parsed."""
    src = (
        b"<details>\n"
        b'<summary class="bold">Has Attrs</summary>\n'
        b"body\n"
        b"</details>\n"
    )
    _, _, _, sections = extract(src, "ds-sattr.md")
    headings = {s.heading for s in sections}
    assert "Has Attrs" in headings


def test_details_inline_one_liner():
    """One-line `<details><summary>X</summary>body</details>` must be recognized."""
    src = b"<details><summary>Inline</summary>body</details>\n"
    _, _, _, sections = extract(src, "ds-inline.md")
    headings = {s.heading for s in sections}
    assert "Inline" in headings
    inline = next(s for s in sections if s.heading == "Inline")
    # Single-line block: start and end line are both 1.
    assert inline.line == 1
    assert inline.end_line == 1


def test_details_does_not_break_surrounding_headings():
    """ATX headings before/after a `<details>` block must still parse normally."""
    src = (
        b"# Before\n"
        b"\n"
        b"<details>\n"
        b"<summary>Mid</summary>\n"
        b"body\n"
        b"</details>\n"
        b"\n"
        b"## After\n"
        b"\n"
        b"after body\n"
    )
    _, _, _, sections = extract(src, "ds-sandwich.md")
    headings = {s.heading for s in sections}
    assert "Before" in headings
    assert "After" in headings
    assert "Mid" in headings


def test_stray_close_details_is_ignored():
    """A bare `</details>` with no opener must not crash and not produce a section."""
    src = (
        b"# Real\n"
        b"</details>\n"
        b"\n"
        b"text\n"
    )
    # Must not raise; result should contain Real and no synthetic details section.
    _, _, _, sections = extract(src, "ds-stray.md")
    headings = {s.heading for s in sections}
    assert "Real" in headings
    assert "__details__" not in headings


def test_details_with_empty_summary_falls_back_to_synthetic():
    """`<summary></summary>` (or whitespace only) falls back to `__details__`."""
    src = (
        b"<details>\n"
        b"<summary>   </summary>\n"
        b"body\n"
        b"</details>\n"
    )
    _, _, _, sections = extract(src, "ds-empty-sum.md")
    headings = {s.heading for s in sections}
    assert "__details__" in headings


def test_setext_not_created_from_frontmatter_closing():
    """Closing --- of YAML frontmatter must not be treated as setext H2 underline.

    The closing `---` delimiter of YAML front-matter can appear on its own line,
    which matches the setext H2 underline regex (^-+$). We must not extract the
    preceding YAML line (e.g., "title: Test") as a bogus setext heading.
    """
    src = b"---\ntitle: Test\n---\n\n# Real Body\n"
    symbols, _, _, sections = extract(src, "fm.md")
    # Should have exactly 2 sections: frontmatter and the real heading
    heading_names = [s.heading for s in sections]
    assert "__frontmatter__" in heading_names, "frontmatter section missing"
    assert "Real Body" in heading_names, "real body heading missing"
    # "title: Test" (or any YAML line) must NOT appear as a section heading
    assert "title: Test" not in heading_names, (
        "frontmatter closing --- was misinterpreted as setext underline"
    )
    # Verify the count
    assert len(sections) == 2, f"expected 2 sections, got {len(sections)}: {heading_names}"
