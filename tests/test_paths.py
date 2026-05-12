"""Test paths module."""
from tokenwise import paths


def test_ensure_dirs_creates_all_dirs(tmp_data_dir):
    """Test that ensure_dirs creates all subdirectories idempotently."""
    paths.ensure_dirs()

    expected_dirs = [
        tmp_data_dir,
        tmp_data_dir / "projects",
        tmp_data_dir / "sessions",
        tmp_data_dir / "images",
        tmp_data_dir / "models",
        tmp_data_dir / "logs",
        tmp_data_dir / "locks",
        tmp_data_dir / "queue",
    ]

    for d in expected_dirs:
        assert d.exists(), f"Directory {d} was not created"

    # Call again to verify idempotency (should not raise)
    paths.ensure_dirs()

    for d in expected_dirs:
        assert d.exists(), f"Directory {d} was not created on second call"
