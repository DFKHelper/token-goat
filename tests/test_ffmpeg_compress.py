"""Tests for FfmpegFilter — ffmpeg / ffprobe / ffplay output compression."""
from __future__ import annotations

from token_goat.bash_compress import FfmpegFilter, select_filter

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

FFMPEG_STDERR_FULL = """\
ffmpeg version 5.1.3 Copyright (c) 2000-2022 the FFmpeg developers
  built with Apple clang version 14.0.3 (clang-1403.0.22.14.1)
  configuration: --prefix=/usr/local/Cellar/ffmpeg/5.1.4 --enable-shared --enable-pthreads --enable-version3 --cc=clang --host-cflags= --host-ldflags= --enable-ffplay --enable-gnutls --enable-gpl --enable-libaom --enable-libaribb24 --enable-libbluray --enable-libdav1d --enable-libmp3lame --enable-libopus --enable-librist --enable-librubberband --enable-libsnappy --enable-libsrt --enable-libsvtav1 --enable-libtesseract --enable-libtheora --enable-libvidstab --enable-libvmaf --enable-libvorbis --enable-libvpx --enable-libwebp --enable-libx264 --enable-libx265 --enable-libxml2 --enable-libxvid --enable-lzma --enable-libfontconfig --enable-libfreetype --enable-frei0r --enable-libass --enable-libopencore-amrnb --enable-libopencore-amrwb --enable-libopenjpeg --enable-libspeex --enable-libsoxr --enable-libzmq --enable-libzimg --disable-libjack --disable-indev=jack
  libavutil      57. 28.100 / 57. 28.100
  libavcodec     59. 37.100 / 59. 37.100
  libavformat    59. 27.100 / 59. 27.100
  libavdevice    59.  7.100 / 59.  7.100
  libavfilter     8. 44.100 /  8. 44.100
  libswscale      6.  7.100 /  6.  7.100
  libswresample   4.  7.100 /  4.  7.100
  libpostproc    56.  6.100 / 56.  6.100
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'input.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomiso2avc1mp41
    encoder         : Lavf58.76.100
    creation_time   : 2023-06-01T12:00:00.000000Z
  Duration: 00:10:00.00, start: 0.000000, bitrate: 5000 kb/s
    Stream #0:0(und): Video: h264 (High), yuv420p, 1920x1080, 4872 kb/s, 29.97 fps, 29.97 tbr, 90k tbn (default)
    Metadata:
      handler_name    : VideoHandler
      vendor_id       : [0][0][0][0]
    Stream #0:1(und): Audio: aac, 44100 Hz, stereo, fltp, 128 kb/s (default)
    Metadata:
      handler_name    : SoundHandler
      vendor_id       : [0][0][0][0]
Output #0, matroska, to 'output.mkv':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomiso2avc1mp41
    encoder         : Lavf59.27.100
  Duration: N/A, start: 0.000000, bitrate: 0 kb/s
    Stream #0:0(und): Video: h264 (High), yuv420p, 1920x1080, 4872 kb/s, 29.97 fps, 29.97 tbr, 90k tbn (default)
    Stream #0:1(und): Audio: aac, 44100 Hz, stereo, fltp, 128 kb/s (default)
Stream mapping:
  Stream #0:0 -> #0:0 (copy)
  Stream #0:1 -> #0:1 (copy)
Press [q] to quit, or [? ] for help
frame=17985 fps= 30 q=-1.0 Lsize=  375000kB time=00:09:59.90 bitrate=5000.4kbits/s speed=1.00x
video:373440kB audio:1559kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: 0.000266%
"""

FFPROBE_STDERR = """\
ffprobe version 5.1.3 Copyright (c) 2007-2022 the FFmpeg developers
  built with Apple clang version 14.0.3 (clang-1403.0.22.14.1)
  configuration: --prefix=/usr/local/Cellar/ffmpeg/5.1.4 --enable-shared
  libavutil      57. 28.100 / 57. 28.100
  libavcodec     59. 37.100 / 59. 37.100
  libavformat    59. 27.100 / 59. 27.100
  libavdevice    59.  7.100 / 59.  7.100
  libavfilter     8. 44.100 /  8. 44.100
  libswscale      6.  7.100 /  6.  7.100
  libswresample   4.  7.100 /  4.  7.100
  libpostproc    56.  6.100 / 56.  6.100
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    creation_time   : 2023-01-01T00:00:00.000000Z
  Duration: 00:01:23.45, start: 0.000000, bitrate: 2000 kb/s
    Stream #0:0(und): Video: h264 (High), yuv420p, 1280x720, 1872 kb/s, 30 fps
    Metadata:
      handler_name    : VideoHandler
    Stream #0:1(und): Audio: aac, 44100 Hz, stereo, fltp, 128 kb/s
    Metadata:
      handler_name    : SoundHandler
"""

_FILTER = FfmpegFilter()


def _compress(stderr: str = "", stdout: str = "") -> str:
    return _FILTER.compress(stdout, stderr, exit_code=0, argv=["ffmpeg", "-i", "input.mp4", "output.mkv"])


# ---------------------------------------------------------------------------
# select_filter dispatch
# ---------------------------------------------------------------------------

class TestDispatch:
    def test_ffmpeg_binary(self):
        f = select_filter(["ffmpeg", "-i", "input.mp4", "output.mkv"])
        assert f is not None
        assert f.name == "ffmpeg"

    def test_ffprobe_binary(self):
        f = select_filter(["ffprobe", "video.mp4"])
        assert f is not None
        assert f.name == "ffmpeg"

    def test_ffplay_binary(self):
        f = select_filter(["ffplay", "video.mp4"])
        assert f is not None
        assert f.name == "ffmpeg"

    def test_ffmpeg_exe_extension(self):
        f = select_filter(["ffmpeg.exe", "-i", "a.mp4", "b.mkv"])
        assert f is not None
        assert f.name == "ffmpeg"

    def test_unrelated_binary_not_matched(self):
        f = select_filter(["convert", "-resize", "50%", "input.jpg", "output.jpg"])
        # ImageMagick convert — should NOT match FfmpegFilter
        assert f is None or f.name != "ffmpeg"


# ---------------------------------------------------------------------------
# Version line handling
# ---------------------------------------------------------------------------

class TestVersionLine:
    def test_ffmpeg_version_kept(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "ffmpeg version 5.1.3" in out

    def test_ffprobe_version_kept(self):
        out = _compress(stderr=FFPROBE_STDERR)
        assert "ffprobe version 5.1.3" in out

    def test_version_line_appears_once(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert out.count("ffmpeg version") == 1


# ---------------------------------------------------------------------------
# Build-info block suppression
# ---------------------------------------------------------------------------

class TestBuildInfoDrop:
    def test_built_with_dropped(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "built with" not in out

    def test_configuration_dropped(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "configuration:" not in out

    def test_libavutil_dropped(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "libavutil" not in out

    def test_libavcodec_dropped(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "libavcodec" not in out

    def test_libswscale_dropped(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "libswscale" not in out

    def test_libpostproc_dropped(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "libpostproc" not in out

    def test_build_note_emitted(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "build-info" in out


# ---------------------------------------------------------------------------
# Container / stream information kept
# ---------------------------------------------------------------------------

class TestMediaInfoKept:
    def test_input_line_kept(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "Input #0, mov,mp4" in out

    def test_output_line_kept(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "Output #0, matroska" in out

    def test_duration_kept(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "Duration: 00:10:00.00" in out

    def test_video_stream_kept(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "Stream #0:0" in out
        assert "Video: h264" in out

    def test_audio_stream_kept(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "Stream #0:1" in out
        assert "Audio: aac" in out

    def test_stream_mapping_section_kept(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "Stream mapping:" in out

    def test_stream_mapping_content_kept(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "Stream #0:0 -> #0:0" in out
        assert "Stream #0:1 -> #0:1" in out

    def test_ffprobe_duration_kept(self):
        out = _compress(stderr=FFPROBE_STDERR)
        assert "Duration: 00:01:23.45" in out

    def test_ffprobe_video_stream_kept(self):
        out = _compress(stderr=FFPROBE_STDERR)
        assert "Stream #0:0" in out
        assert "Video: h264" in out


# ---------------------------------------------------------------------------
# Metadata sub-block suppression
# ---------------------------------------------------------------------------

class TestMetadataDrop:
    def test_major_brand_dropped(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "major_brand" not in out

    def test_minor_version_dropped(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "minor_version" not in out

    def test_compatible_brands_dropped(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "compatible_brands" not in out

    def test_handler_name_dropped(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "handler_name" not in out

    def test_vendor_id_dropped(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "vendor_id" not in out

    def test_creation_time_dropped(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "creation_time" not in out

    def test_encoder_metadata_dropped(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        # The encoder metadata KV lines should be gone (not the Output line itself)
        assert "Lavf58.76.100" not in out

    def test_metadata_section_header_dropped(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        # The bare "  Metadata:" section headers should not appear
        lines = out.splitlines()
        assert not any(ln.strip() == "Metadata:" for ln in lines)

    def test_metadata_note_emitted(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "metadata" in out


# ---------------------------------------------------------------------------
# Press-Q hint suppression
# ---------------------------------------------------------------------------

class TestPressQDrop:
    def test_press_q_dropped(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "Press [q]" not in out

    def test_press_q_counts_in_metadata_note(self):
        stderr = "Press [q] to quit, or [? ] for help\n"
        out = _compress(stderr=stderr)
        assert "metadata" in out


# ---------------------------------------------------------------------------
# Progress line collapsing
# ---------------------------------------------------------------------------

class TestProgressCollapse:
    def test_progress_lines_collapsed(self):
        stderr = (
            "ffmpeg version 5.1.3 Copyright (c) 2000-2022 the FFmpeg developers\n"
            "frame=  100 fps= 25 q=23.0 size=    512kB time=00:00:04.00 bitrate=1048.6kbits/s speed=1.00x\n"
            "frame=  200 fps= 25 q=23.0 size=   1024kB time=00:00:08.00 bitrate=1048.6kbits/s speed=1.00x\n"
            "frame=  300 fps= 25 q=23.0 size=   1536kB time=00:00:12.00 bitrate=1048.6kbits/s speed=1.00x\n"
            "video:1536kB audio:200kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: 0.001%\n"
        )
        out = _compress(stderr=stderr)
        # Only the last progress line should survive (before the final stats line)
        assert out.count("frame=") == 1
        assert "frame=  300" in out

    def test_progress_note_emitted(self):
        stderr = (
            "frame=  100 fps= 25 q=23.0 size=    512kB time=00:00:04.00 bitrate=1048.6kbits/s speed=1.00x\n"
            "frame=  200 fps= 25 q=23.0 size=   1024kB time=00:00:08.00 bitrate=1048.6kbits/s speed=1.00x\n"
        )
        out = _compress(stderr=stderr)
        assert "collapsed" in out
        assert "progress" in out

    def test_single_progress_line_kept(self):
        stderr = "frame=  500 fps= 25 q=23.0 size=   2560kB time=00:00:20.00 bitrate=1048.6kbits/s speed=1.00x\n"
        out = _compress(stderr=stderr)
        assert "frame=  500" in out

    def test_interrupted_encode_shows_last_progress(self):
        # No final stats line: last progress should still appear in output
        stderr = (
            "frame=  100 fps= 25 q=23.0 size=    512kB time=00:00:04.00 bitrate=1048.6kbits/s speed=1.00x\n"
            "frame=  200 fps= 25 q=23.0 size=   1024kB time=00:00:08.00 bitrate=1048.6kbits/s speed=1.00x\n"
        )
        out = _compress(stderr=stderr)
        assert "frame=  200" in out


# ---------------------------------------------------------------------------
# Final stats line
# ---------------------------------------------------------------------------

class TestFinalStats:
    def test_final_stats_kept(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "video:373440kB audio:1559kB" in out

    def test_final_stats_muxing_overhead_kept(self):
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        assert "muxing overhead" in out


# ---------------------------------------------------------------------------
# Error / warning lines always kept
# ---------------------------------------------------------------------------

class TestErrorWarningKept:
    def test_error_line_always_kept(self):
        stderr = (
            "ffmpeg version 5.1.3 Copyright (c) 2000-2022 the FFmpeg developers\n"
            "  libavutil      57. 28.100 / 57. 28.100\n"
            "input.mp4: No such file or directory\n"
            "Error opening input file input.mp4.\n"
        )
        out = _compress(stderr=stderr)
        assert "No such file or directory" in out
        assert "Error opening input file" in out

    def test_warning_line_always_kept(self):
        stderr = (
            "  libavutil      57. 28.100 / 57. 28.100\n"
            "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'input.mp4':\n"
            "  Duration: 00:01:00.00, start: 0.000000, bitrate: 1000 kb/s\n"
            "    Stream #0:0(und): Video: h264, yuv420p, 1280x720, 1000 kb/s\n"
            "WARNING: some frames may be missing\n"
        )
        out = _compress(stderr=stderr)
        assert "WARNING: some frames may be missing" in out

    def test_nonzero_exit_keeps_error_context(self):
        stderr = (
            "ffmpeg version 5.1.3 Copyright (c) 2000-2022 the FFmpeg developers\n"
            "  libavutil      57. 28.100 / 57. 28.100\n"
            "Error while opening encoder for output stream #0:0\n"
        )
        f = FfmpegFilter()
        out = f.compress(stdout="", stderr=stderr, exit_code=1, argv=["ffmpeg"])
        assert "Error while opening encoder" in out


# ---------------------------------------------------------------------------
# stdout fallback (when stderr is empty)
# ---------------------------------------------------------------------------

class TestStdoutFallback:
    def test_falls_back_to_stdout_when_stderr_empty(self):
        stdout = (
            "ffprobe version 5.1.3 Copyright (c) 2007-2022 the FFmpeg developers\n"
            "  libavutil      57. 28.100 / 57. 28.100\n"
            "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':\n"
            "  Duration: 00:00:10.00, start: 0.000000, bitrate: 500 kb/s\n"
            "    Stream #0:0(und): Video: h264, yuv420p, 640x360, 400 kb/s, 24 fps\n"
        )
        out = _compress(stdout=stdout, stderr="")
        assert "ffprobe version 5.1.3" in out
        assert "Duration: 00:00:10.00" in out
        assert "libavutil" not in out


# ---------------------------------------------------------------------------
# Overall compression ratio
# ---------------------------------------------------------------------------

class TestCompressionRatio:
    def test_full_ffmpeg_output_compressed(self):
        original = FFMPEG_STDERR_FULL
        out = _compress(stderr=original)
        assert len(out) < len(original), "compressed output should be shorter than original"

    def test_build_block_removal_saves_lines(self):
        # The build-info block alone is ~10 lines; compressed should have fewer lines
        original_lines = FFMPEG_STDERR_FULL.splitlines()
        out = _compress(stderr=FFMPEG_STDERR_FULL)
        compressed_lines = out.splitlines()
        assert len(compressed_lines) < len(original_lines)

    def test_ffprobe_compressed(self):
        original = FFPROBE_STDERR
        out = _compress(stderr=original)
        assert len(out) < len(original)
