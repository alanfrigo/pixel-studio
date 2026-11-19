"""Read back both native animation formats independently of frame assembly."""

from __future__ import annotations

import json
import struct
import subprocess
import sys
import zlib
from pathlib import Path

import pytest
from PIL import Image, ImageSequence

from pixel_pipeline.export_animation import write_aseprite


def export(
    workdir: Path, format_name: str, documents: list[dict], *, check: bool = True,
) -> subprocess.CompletedProcess[bytes]:
    (workdir / "request.json").write_text(
        json.dumps({"sources": {"atlas": 0}, "documents": documents}), encoding="utf-8",
    )
    return subprocess.run(
        [sys.executable, "-I", "-m", "pixel_pipeline.export_animation", format_name],
        cwd=workdir, capture_output=True, timeout=60, check=check,
    )


def test_gif_transparency_timing_and_playback(tmp_path: Path) -> None:
    atlas = Image.new("RGBA", (4, 1))
    atlas.putdata([(200, 20, 10, 255), (3, 7, 220, 255), (90, 40, 50, 127), (11, 212, 80, 128)])
    atlas.save(tmp_path / "source-0.png")
    red = {"fileId": "atlas", "rect": [0, 0, 1, 1], "offset": [1, 1]}
    blue = {"fileId": "atlas", "rect": [1, 0, 1, 1], "offset": [1, 1]}
    alpha = {"fileId": "atlas", "rect": [2, 0, 2, 1], "offset": [2, 0]}
    frames = [
        {"durationMs": 15, "layers": [red, blue]},
        {"durationMs": 26, "layers": [red, blue]},  # Identical pixels, independent duration.
        {"durationMs": 1, "layers": []},
        {"durationMs": 41, "layers": [alpha]},
    ]
    export(tmp_path, "gif", [
        {"size": [4, 3], "playback": "ping_pong", "frames": frames},
        {"size": [4, 3], "playback": "once", "frames": [{**frames[3], "durationMs": 60_000}]},
    ])

    with Image.open(tmp_path / "output-0.gif") as image:
        assert image.size == (4, 3)
        assert image.info["loop"] == 0
        decoded = [(frame.info["duration"], frame.convert("RGBA")) for frame in ImageSequence.Iterator(image)]
        assert [delay for delay, _ in decoded] == [20, 30, 10, 40, 10, 30]
        for index in (0, 1, 5):
            frame = decoded[index][1]
            assert frame.getbbox() == (1, 1, 2, 2)
            assert frame.getpixel((1, 1)) == (3, 7, 220, 255)
        for index in (2, 4):
            assert decoded[index][1].getbbox() is None  # No ghost from the prior frame.
        frame = decoded[3][1]
        assert frame.getbbox() == (3, 0, 4, 1)
        assert frame.getpixel((3, 0)) == (11, 212, 80, 255)

    with Image.open(tmp_path / "output-1.gif") as image:
        assert "loop" not in image.info
        assert image.n_frames == 1
        assert image.info["duration"] == 60_000
        assert image.convert("RGBA").getbbox() == (3, 0, 4, 1)


def test_opaque_gif_keeps_whole_canvas_opaque(tmp_path):
    atlas = Image.new("RGB", (2, 1), (30, 50, 120))
    atlas.putpixel((1, 0), (200, 130, 10))
    atlas.save(tmp_path / "source-0.png")
    export(tmp_path, "gif", [{
        "size": [2, 1], "playback": "loop", "frames": [
            {"durationMs": 210, "layers": [{"fileId": "atlas", "rect": [0, 0, 2, 1], "offset": [0, 0]}]},
        ],
    }])
    with Image.open(tmp_path / "output-0.gif") as result:
        assert result.info["loop"] == 0 and result.info["duration"] == 210
        assert result.convert("RGBA").tobytes() == b"\x1e\x32\x78\xff\xc8\x82\x0a\xff"


def ase_frames(raw: bytes) -> list[tuple[int, list[tuple[int, bytes]]]]:
    file_size, magic, count, width, height, depth = struct.unpack_from("<I5H", raw)
    assert (file_size, magic, width, height, depth) == (len(raw), 0xA5E0, 6, 4, 32)
    frames = []
    offset = 128
    for _ in range(count):
        length, magic, num_chunks, duration = struct.unpack_from("<I3H", raw, offset)
        assert magic == 0xF1FA
        end = offset + length
        offset += 16
        chunks = []
        for _ in range(num_chunks):
            length, kind = struct.unpack_from("<IH", raw, offset)
            chunks.append((kind, raw[offset + 6:offset + length]))
            offset += length
        assert offset == end
        frames.append((duration, chunks))
    assert offset == len(raw)
    return frames


@pytest.mark.parametrize(("playback", "direction", "repeats"), [
    ("ping_pong", 2, 0), ("once", 0, 1), ("loop", 0, 0),
])
def test_aseprite_preserves_chunks_and_rgba_cels(tmp_path, playback, direction, repeats):
    atlas = Image.new("RGBA", (3, 1))
    atlas.putdata([(200, 20, 10, 255), (50, 70, 90, 128), (7, 9, 11, 0)])
    atlas.save(tmp_path / "source-0.png")
    doc = {
        "name": "Ação", "layerNames": ["Fundo", "Luz á"], "blendMode": "screen",
        "playback": playback, "size": [6, 4], "pivot": [6, 4],
        "frames": [
            {"durationMs": 37, "layers": [
                {"fileId": "atlas", "rect": [1, 0, 2, 1], "offset": [-1, 2], "layerIndex": 1, "zIndex": -1},
                {"fileId": "atlas", "rect": [0, 0, 1, 1], "offset": [3, 0], "layerIndex": 0, "zIndex": 1},
            ]},
            {"durationMs": 123, "layers": []},
        ],
    }
    export(tmp_path, "aseprite", [doc])
    (first_delay, chunks), (second_delay, second_chunks) = ase_frames((tmp_path / "output-0.aseprite").read_bytes())
    assert (first_delay, second_delay, second_chunks) == (37, 123, [])
    assert [kind for kind, _ in chunks] == [0x2004, 0x2004, 0x2018, 0x2022, 0x2005, 0x2005]
    for (_, payload), name in zip(chunks[:2], ["Fundo", "Luz á"], strict=True):
        assert struct.unpack_from("<6HB", payload) == (3, 0, 0, 0, 0, 2, 255)
        size, = struct.unpack_from("<H", payload, 16)
        assert size == len(payload[18:]) and payload[18:].decode() == name
    tag = chunks[2][1]
    assert struct.unpack_from("<H8xHHBH", tag) == (1, 0, 1, direction, repeats)
    assert struct.unpack_from("<H", tag, 27) == (len("Ação".encode()),)
    assert tag[29:].decode() == "Ação"
    pivot = chunks[3][1]
    assert struct.unpack_from("<IIIH5s", pivot) == (1, 2, 0, 5, b"pivot")
    assert struct.unpack_from("<IiiIIii", pivot, 19) == (0, 0, 0, 6, 4, 6, 4)
    for (_, cel), geometry, pixels in zip(chunks[4:], [
        (1, -1, 2, 255, 2, -1, 2, 1), (0, 3, 0, 255, 2, 1, 1, 1),
    ], [b"\x32\x46\x5a\x80\x07\x09\x0b\x00", b"\xc8\x14\x0a\xff"], strict=True):
        assert struct.unpack_from("<HhhBHh5xHH", cel) == geometry
        assert zlib.decompress(cel[20:]) == pixels


def test_export_rejects_out_of_bounds_crop(tmp_path):
    Image.new("RGBA", (2, 2), "red").save(tmp_path / "source-0.png")
    result = export(tmp_path, "gif", [{
        "size": [2, 2], "playback": "loop", "frames": [
            {"durationMs": 100, "layers": [{"fileId": "atlas", "rect": [1, 0, 2, 1], "offset": [0, 0]}]},
        ],
    }], check=False)
    assert result.returncode != 0
    assert b"Source rectangle outside PNG atlas" in result.stderr
    assert not (tmp_path / "output-0.gif").read_bytes()


@pytest.mark.skipif(sys.platform != "linux", reason="exercises a sparse file without allocating 4 GiB")
def test_aseprite_rejects_file_exceeding_uint32(tmp_path):
    doc = {
        "name": "Oversized", "layerNames": ["Ink"], "blendMode": "normal",
        "playback": "once", "size": [1, 1], "pivot": [0, 0],
        "frames": [{"durationMs": 100, "layers": [{"offset": [0, 0], "layerIndex": 0, "zIndex": 0}]}],
    }
    with (tmp_path / "large.aseprite").open("w+b") as fp:
        def append_pixel(_layer):
            # Model the position after preceding cels totaling nearly 4 GiB, without writing that data.
            fp.seek(0xFFFFFFFF)
            return Image.new("RGBA", (1, 1), "red")

        with pytest.raises(ValueError, match="32-bit file size limit"):
            write_aseprite(fp, doc, append_pixel)
        fp.seek(0)
        assert fp.read(6) == b"\0" * 6  # No successful final header.
