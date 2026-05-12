"""Shared test fixtures."""
from unittest.mock import patch

import pytest

import tokenwise.paths as paths


@pytest.fixture
def tmp_data_dir(tmp_path):
    """Monkeypatch tokenwise.paths.data_dir to a temporary directory."""
    with patch.object(paths, 'data_dir', return_value=tmp_path):
        yield tmp_path
