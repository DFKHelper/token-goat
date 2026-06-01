"""Tests for BaseFilter ABC and filter subclass compliance.

Covers:
- BaseFilter abstract methods are properly defined
- can_handle() fails softly on exceptions
- savings_ratio property returns a float in [0.0, 1.0]
- All registered filters are BaseFilter subclasses
"""
from __future__ import annotations

import pytest

from token_goat import bash_compress as bc


class TestBaseFilterInterface:
    """Test the BaseFilter ABC interface."""

    def test_base_filter_is_abstract(self) -> None:
        """BaseFilter cannot be instantiated directly."""
        with pytest.raises(TypeError, match="abstract"):
            bc.BaseFilter()  # type: ignore[abstract]

    def test_filter_implements_base_filter(self) -> None:
        """Filter is a subclass of BaseFilter."""
        assert issubclass(bc.Filter, bc.BaseFilter)

    def test_all_filters_are_base_filter_subclasses(self) -> None:
        """Every registered filter is a BaseFilter subclass."""
        for f in bc.FILTERS:
            assert isinstance(f, bc.BaseFilter), (
                f"Filter {f.name} ({type(f).__name__}) is not a BaseFilter instance"
            )


class TestCanHandleFailSoft:
    """Test can_handle() exception handling."""

    def test_can_handle_returns_bool(self) -> None:
        """can_handle() returns a bool, never raises."""
        f = bc.PytestFilter()
        result = f.can_handle("pytest tests/")
        assert isinstance(result, bool)

    def test_can_handle_valid_command(self) -> None:
        """can_handle() returns True for commands it should handle."""
        f = bc.PytestFilter()
        assert f.can_handle("pytest tests/") is True

    def test_can_handle_invalid_command(self) -> None:
        """can_handle() returns False for commands it should not handle."""
        f = bc.PytestFilter()
        assert f.can_handle("docker run image") is False

    def test_can_handle_malformed_command(self) -> None:
        """can_handle() returns False for malformed commands without raising."""
        f = bc.PytestFilter()
        # Unbalanced quotes - shlex.split() will raise
        result = f.can_handle("pytest 'unclosed quote")
        assert isinstance(result, bool)
        # May be True or False depending on filter logic, but must not raise

    def test_can_handle_empty_command(self) -> None:
        """can_handle() handles empty command strings."""
        f = bc.PytestFilter()
        assert f.can_handle("") is False

    def test_can_handle_very_long_command(self) -> None:
        """can_handle() handles very long commands (over 64KB) without raising."""
        f = bc.PytestFilter()
        long_cmd = "pytest " + "x" * 100_000
        result = f.can_handle(long_cmd)
        assert isinstance(result, bool)
        assert result is False  # Over 65KB limit


class TestSavingsRatioProperty:
    """Test savings_ratio property."""

    def test_savings_ratio_returns_float(self) -> None:
        """savings_ratio returns a float."""
        f = bc.PytestFilter()
        ratio = f.savings_ratio
        assert isinstance(ratio, float)

    def test_savings_ratio_in_valid_range(self) -> None:
        """savings_ratio is clamped to [0.0, 1.0]."""
        for f in bc.FILTERS:
            ratio = f.savings_ratio
            assert 0.0 <= ratio <= 1.0, (
                f"{f.name} savings_ratio = {ratio}, expected in [0.0, 1.0]"
            )

    def test_savings_ratio_never_raises(self) -> None:
        """savings_ratio never raises, even for broken filters."""
        # GenericFilter should always work
        f = bc.GenericFilter()
        ratio = f.savings_ratio
        assert isinstance(ratio, float)
        assert ratio >= 0.0

    def test_savings_ratio_makes_sense(self) -> None:
        """savings_ratio for pytest is non-zero (pytest reduces output)."""
        f = bc.PytestFilter()
        ratio = f.savings_ratio
        # PytestFilter should achieve some compression on repeated output
        assert ratio > 0.0, "PytestFilter should achieve compression on sample output"

    def test_all_filters_have_valid_savings_ratio(self) -> None:
        """Every registered filter has a valid savings_ratio."""
        for f in bc.FILTERS:
            ratio = f.savings_ratio
            assert isinstance(ratio, float), (
                f"{f.name} savings_ratio is not a float: {type(ratio)}"
            )
            assert 0.0 <= ratio <= 1.0, (
                f"{f.name} savings_ratio out of range: {ratio}"
            )


class TestDetectFromCommand:
    """Test detect_from_command() method on filters."""

    def test_pytest_filter_detect_from_command_valid(self) -> None:
        """PytestFilter.detect_from_command recognizes pytest commands."""
        f = bc.PytestFilter()
        assert f.detect_from_command("pytest tests/") is True

    def test_pytest_filter_detect_from_command_invalid(self) -> None:
        """PytestFilter.detect_from_command rejects non-pytest commands."""
        f = bc.PytestFilter()
        assert f.detect_from_command("docker build .") is False

    def test_docker_filter_detect_from_command_valid(self) -> None:
        """DockerFilter.detect_from_command recognizes docker commands."""
        f = bc.DockerFilter()
        assert f.detect_from_command("docker build .") is True

    def test_docker_filter_detect_from_command_invalid(self) -> None:
        """DockerFilter.detect_from_command rejects non-docker commands."""
        f = bc.DockerFilter()
        assert f.detect_from_command("pytest tests/") is False

    def test_git_filter_detect_from_command_valid(self) -> None:
        """GitFilter.detect_from_command recognizes git commands."""
        f = bc.GitFilter()
        assert f.detect_from_command("git status") is True

    def test_git_filter_detect_from_command_invalid(self) -> None:
        """GitFilter.detect_from_command rejects non-git commands."""
        f = bc.GitFilter()
        assert f.detect_from_command("npm install") is False


class TestFilterNameProperty:
    """Test the name property/attribute."""

    def test_filter_has_name_attribute(self) -> None:
        """All filters have a name attribute."""
        for f in bc.FILTERS:
            assert hasattr(f, "name")
            assert isinstance(f.name, str)
            assert len(f.name) > 0

    def test_filter_names_are_lowercase(self) -> None:
        """Filter names should be lowercase for consistency."""
        for f in bc.FILTERS:
            # Most names are lowercase; some may have hyphens
            assert f.name.islower() or "-" in f.name, (
                f"Filter name {f.name} is not lowercase"
            )

    def test_pytest_filter_name(self) -> None:
        """PytestFilter has expected name."""
        f = bc.PytestFilter()
        assert f.name == "pytest"

    def test_docker_filter_name(self) -> None:
        """DockerFilter has expected name."""
        f = bc.DockerFilter()
        assert f.name == "docker"
