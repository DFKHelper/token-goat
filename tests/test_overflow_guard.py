"""Unit tests for token_goat.overflow_guard.

These are real regression tests: each over-budget / truncation case asserts on
both the stable marker substrings (the intentional contract) AND a bounded
output length, so removing the guard from the emit sites — or breaking the
truncation logic — fails the test rather than silently passing.

All ``guard()`` calls pass explicit ``enabled`` / ``max_tokens`` kwargs so the
unit tests never depend on config or environment state.
"""
from __future__ import annotations

from token_goat.overflow_guard import estimate_tokens, guard

# Stable contract substrings the marker MUST contain. These are asserted
# verbatim by design (see task spec) — downstream tooling keys off them.
_MARKER = "[token-goat: output capped"
_PROTECT = "to protect context"


# ---------------------------------------------------------------------------
# estimate_tokens
# ---------------------------------------------------------------------------

class TestEstimateTokens:
    def test_empty_string_clamps_to_one(self) -> None:
        """Empty input never returns 0 — the min clamp guarantees >= 1."""
        assert estimate_tokens("") == 1

    def test_three_chars_per_token_ratio(self) -> None:
        """~3 chars/token: 300 visible chars -> 300//3 + 1 == 101."""
        assert estimate_tokens("a" * 300) == 101

    def test_ansi_codes_stripped_before_counting(self) -> None:
        """ANSI color escapes do not inflate the token count.

        A red-colored string must estimate identically to its plain-text form,
        because color codes add bytes but no model-visible tokens.
        """
        plain = "hello world this is a sample line"
        colored = f"\x1b[31m{plain}\x1b[0m"
        assert estimate_tokens(colored) == estimate_tokens(plain)
        # And the colored estimate must NOT reflect the longer raw length.
        assert estimate_tokens(colored) < estimate_tokens(colored + "x" * 100)


# ---------------------------------------------------------------------------
# guard — no-op / identity paths
# ---------------------------------------------------------------------------

class TestGuardNoOp:
    def test_identity_under_budget(self) -> None:
        """Text well under budget is returned unchanged (byte-identical)."""
        text = "short body\nsecond line\n"
        assert guard(text, max_tokens=10_000, enabled=True) == text

    def test_disabled_returns_unchanged_even_when_huge(self) -> None:
        """enabled=False short-circuits before any truncation."""
        big = "\n".join(f"line {i}" for i in range(5_000))
        result = guard(big, max_tokens=10, enabled=False)
        assert result == big
        assert _MARKER not in result

    def test_max_tokens_zero_never_caps(self) -> None:
        """max_tokens <= 0 is the explicit 'never cap' sentinel."""
        big = "\n".join(f"line {i}" for i in range(5_000))
        result = guard(big, max_tokens=0, enabled=True)
        assert result == big
        assert _MARKER not in result

    def test_negative_max_tokens_never_caps(self) -> None:
        big = "\n".join(f"line {i}" for i in range(5_000))
        assert guard(big, max_tokens=-1, enabled=True) == big


# ---------------------------------------------------------------------------
# guard — over budget truncation
# ---------------------------------------------------------------------------

class TestGuardOverBudget:
    def _big_text(self, n: int = 5_000) -> str:
        return "\n".join(f"line {i}" for i in range(n))

    def test_truncates_and_emits_marker(self) -> None:
        text = self._big_text()
        result = guard(text, max_tokens=200, enabled=True)

        # Bounded: result is strictly shorter than the input.
        assert len(result) < len(text)
        # Contract substrings present (asserted verbatim — see module docstring).
        assert _MARKER in result
        assert _PROTECT in result

    def test_kept_portion_is_head_prefix(self) -> None:
        """Truncation keeps the HEAD of the input, not a tail or middle slice."""
        text = self._big_text()
        result = guard(text, max_tokens=200, enabled=True)

        # The very first line survives.
        assert "line 0" in result
        # A late line (well past any reasonable head budget) is dropped.
        assert "line 4999" not in result

    def test_marker_reports_correct_total_line_count(self) -> None:
        n = 5_000
        text = self._big_text(n)
        result = guard(text, max_tokens=200, enabled=True)
        # "showing {shown} of {total} lines" — total must be the true line count.
        assert f"of {n} lines" in result

    def test_body_ends_on_complete_line_boundary(self) -> None:
        """Everything before the marker is a sequence of WHOLE original lines.

        No mid-line cut: each kept body line must be an exact line from the
        original input (the multi-line branch keeps whole lines only).
        """
        text = self._big_text()
        result = guard(text, max_tokens=200, enabled=True)

        body, _, marker = result.rpartition("\n")
        assert marker.startswith(_MARKER)
        original_lines = set(text.split("\n"))
        for body_line in body.split("\n"):
            assert body_line in original_lines, (
                f"kept body line {body_line!r} is not a whole original line "
                "(mid-line cut detected)"
            )

    def test_result_within_token_ceiling(self) -> None:
        """The reserved 64-token margin keeps marker+body within max_tokens."""
        text = self._big_text()
        max_tokens = 200
        result = guard(text, max_tokens=max_tokens, enabled=True)
        assert estimate_tokens(result) <= max_tokens

    def test_single_giant_line_gets_marker(self) -> None:
        """A single line with no early newline is hard-sliced and gets the marker.

        The pathological case the guard exists to protect against: a minified
        blob on one line. The truncation loop hard-slices the over-budget
        leading line on the char budget so it cannot pass through whole.
        """
        giant = "x" * 100_000
        result = guard(giant, max_tokens=200, enabled=True)

        assert result.startswith("x")
        assert _MARKER in result
        assert _PROTECT in result

    def test_single_giant_line_is_bounded(self) -> None:
        """A single mega-line is bounded below the input and within the token ceiling."""
        giant = "x" * 100_000
        result = guard(giant, max_tokens=200, enabled=True)
        assert len(result) < len(giant)
        assert estimate_tokens(result) <= 200

    def test_tiny_max_tokens_still_bounds_output(self) -> None:
        """A pathologically small ceiling still produces bounded output, not passthrough.

        With max_tokens=10 the reserved marker margin underflows the body budget
        to its floor (body_budget clamps to 1), so the body is a single sliced
        line plus the marker. The marker alone exceeds 10 tokens, so an
        ``estimate_tokens(result) <= 10`` assertion would be unsatisfiable — the
        meaningful guarantee is that output stays bounded by a small constant
        instead of dumping the 100k-char input.
        """
        result = guard("x" * 100_000, max_tokens=10, enabled=True)
        assert _MARKER in result
        # Marker + a tiny sliced body — comfortably under 200 tokens (~52 in practice).
        assert estimate_tokens(result) < 200
        assert len(result) < 100_000

    def test_lone_surrogate_result_is_utf8_encodable(self) -> None:
        """Over-budget text carrying a lone surrogate must not break typer.echo.

        The emit sites call ``typer.echo`` (no fail-soft wrapper), which encodes
        on the active codepage. A lone surrogate (U+DC80–U+DCFF) in the kept body
        raises UnicodeEncodeError unless sanitize_surrogates replaced it first.
        This fails on the pre-fix code and passes after the sanitize wrap.
        """
        text = "\udce9" + "\n".join(f"line {i}" for i in range(5_000))
        result = guard(text, max_tokens=200, enabled=True)
        assert _MARKER in result
        # Must not raise — the lone surrogate has been replaced with U+FFFD.
        result.encode("utf-8")


# ---------------------------------------------------------------------------
# guard — command-specific remediation hints
# ---------------------------------------------------------------------------

class TestGuardHintVariants:
    def _marker(self, command: str) -> str:
        text = "\n".join(f"line {i}" for i in range(5_000))
        result = guard(text, command=command, max_tokens=200, enabled=True)
        assert _MARKER in result
        return result

    def test_symbol_hint_mentions_method_or_json(self) -> None:
        marker = self._marker("symbol")
        assert "--json" in marker or "::" in marker

    def test_section_hint_mentions_sub_heading(self) -> None:
        marker = self._marker("section")
        # section/heading hint points at a narrower sub-heading (e.g. 'doc.md::Section#2').
        assert "#2" in marker or "sub-heading" in marker.lower()

    def test_heading_hint_matches_section(self) -> None:
        """'heading' and 'section' share the same remediation hint."""
        section_marker = self._marker("section")
        heading_marker = self._marker("heading")
        # Both should mention the sub-heading remediation.
        assert "#2" in heading_marker or "sub-heading" in heading_marker.lower()
        # And produce the same hint text.
        assert section_marker.rpartition("showing")[2] == heading_marker.rpartition("showing")[2]

    def test_lines_hint_mentions_line_range(self) -> None:
        marker = self._marker("lines")
        # lines hint suggests a smaller line range, e.g. 'file.py::100-150'.
        assert "range" in marker.lower() or "100-150" in marker

    def test_bash_output_hint_mentions_grep_tail_section(self) -> None:
        marker = self._marker("bash-output")
        assert "--grep" in marker
        assert "--tail" in marker
        assert "--section" in marker

    def test_web_output_hint_matches_bash_output(self) -> None:
        marker = self._marker("web-output")
        assert "--grep" in marker

    def test_default_hint_differs_from_command_hints(self) -> None:
        """Unlabeled command produces the generic 'narrow your query' hint."""
        default_marker = self._marker("")
        assert "max_tokens" in default_marker or "Narrow" in default_marker
        # The default hint must NOT carry a command-specific remediation.
        assert "--grep" not in default_marker
        assert "::Class.method" not in default_marker
