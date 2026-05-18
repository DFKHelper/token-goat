"""Tests for the Dockerfile language extractor + basename dispatch."""
from __future__ import annotations

from token_goat.languages import dockerfile_idx


class TestDockerfileExtractor:
    def test_named_stages(self):
        src = b"""FROM python:3.11 AS builder
RUN pip install build
COPY . /app

FROM python:3.11-slim AS runtime
COPY --from=builder /app /app
CMD ["python", "main.py"]
"""
        symbols, refs, imps, sections = dockerfile_idx.extract(src, "Dockerfile")
        assert refs == [] and imps == []
        headings = [s.heading for s in sections]
        assert headings == ["builder", "runtime"]
        builder = next(s for s in sections if s.heading == "builder")
        runtime = next(s for s in sections if s.heading == "runtime")
        assert builder.line == 1
        assert runtime.line > builder.line
        assert builder.end_line is not None and builder.end_line < runtime.line

    def test_unnamed_stage_uses_image_ref(self):
        src = b"FROM alpine:3.18\nRUN apk add curl\n"
        _, _, _, sections = dockerfile_idx.extract(src, "Dockerfile")
        assert [s.heading for s in sections] == ["alpine:3.18"]

    def test_case_insensitive_keyword(self):
        """``from`` and ``FROM`` and ``From`` are all recognised."""
        src = b"from node:20\n"
        _, _, _, sections = dockerfile_idx.extract(src, "Dockerfile")
        assert [s.heading for s in sections] == ["node:20"]

    def test_comments_after_from(self):
        src = b"FROM python:3.11 AS builder  # build stage\n"
        _, _, _, sections = dockerfile_idx.extract(src, "Dockerfile")
        assert [s.heading for s in sections] == ["builder"]

    def test_no_from_yields_empty(self):
        src = b"# nothing here\nRUN echo hi\n"
        _, _, _, sections = dockerfile_idx.extract(src, "Dockerfile")
        assert sections == []


class TestBasenameDispatch:
    """Verify Dockerfile-family files dispatch through the basename table.

    The file path passed to ``index_file`` is built off ``canonicalize(tmp_path)``
    rather than the raw ``tmp_path`` so the drive-letter case matches the
    project root on Windows.  Without this, ``Path.relative_to`` on Windows
    raises ``ValueError`` when the cases differ (it is case-sensitive even
    though the FS is not), which would make ``index_file`` return ``None``
    and the test fail with an unhelpful "result is None" assertion.
    """

    def test_dockerfile_resolves_via_basename(self, tmp_data_dir, tmp_path):
        from token_goat import parser
        from token_goat.project import Project, canonicalize, project_hash

        root = canonicalize(tmp_path)
        df = root / "Dockerfile"
        df.write_text(
            "FROM python:3.11 AS builder\nRUN pip install build\n",
            encoding="utf-8",
        )
        proj = Project(root=root, hash=project_hash(root), marker=".git")
        result = parser.index_file(proj, df)
        assert result is not None
        assert result.language == "dockerfile"
        assert [s.heading for s in result.sections] == ["builder"]

    def test_containerfile_resolves_via_basename(self, tmp_data_dir, tmp_path):
        from token_goat import parser
        from token_goat.project import Project, canonicalize, project_hash

        root = canonicalize(tmp_path)
        cf = root / "Containerfile"
        cf.write_text("FROM alpine\n", encoding="utf-8")
        proj = Project(root=root, hash=project_hash(root), marker=".git")
        result = parser.index_file(proj, cf)
        assert result is not None
        assert result.language == "dockerfile"

    def test_dockerfile_suffix_resolves(self, tmp_data_dir, tmp_path):
        from token_goat import parser
        from token_goat.project import Project, canonicalize, project_hash

        root = canonicalize(tmp_path)
        df = root / "service.dockerfile"
        df.write_text("FROM busybox\n", encoding="utf-8")
        proj = Project(root=root, hash=project_hash(root), marker=".git")
        result = parser.index_file(proj, df)
        assert result is not None
        assert result.language == "dockerfile"
