"""Normalization, limits, and color-profile artifacts through the ingest CLI."""

from __future__ import annotations

import struct

import pytest
from PIL import Image, ImageCms

from test_protocol import LIMITS, encode, ingest, normalized, run


@pytest.mark.parametrize(("recipe", "message"), [
    ({"version": 2, "limits": LIMITS}, "requires recipe.version = 1"),
    ({"version": 1, "limits": LIMITS | {"maxPixels": 0}}, "Required limits:"),
    ({"version": 1, "limits": {"maxBytes": 1}}, "Required limits:"),
])
def test_ingest_rejects_invalid_limit_recipe(tmp_path, recipe, message):
    response = run(tmp_path, {"protocolVersion": 1, "operation": "ingest_inspect", "recipe": recipe})
    assert response["error"]["code"] == "invalid_request"
    assert message in response["error"]["message"]["en"]
    assert not (tmp_path / "out").exists()


@pytest.mark.parametrize(("overrides", "message"), [
    ({"maxBytes": 8}, "exceeds the 8 limit"),
    ({"maxWidth": 3}, "Image 4×3 exceeds the dimension/pixel limits"),
    ({"maxHeight": 2}, "Image 4×3 exceeds the dimension/pixel limits"),
    ({"maxPixels": 10}, "Image exceeds the pixel limit"),
])
def test_ingest_rejects_oversized_file_or_canvas(tmp_path, overrides, message):
    data = encode(Image.new("RGB", (4, 3)), "PNG")
    response = ingest(tmp_path, data, LIMITS | overrides)
    assert response["error"]["code"] == "limit_exceeded"
    assert message in response["error"]["message"]["en"]
    assert (tmp_path / "in" / "source").read_bytes() == data
    assert not (tmp_path / "out").exists()


def test_ingest_rejects_frame_count_over_limit(tmp_path):
    first = Image.new("RGB", (2, 2), "red")
    second = Image.new("RGB", (2, 2), "blue")
    data = encode(first, "GIF", save_all=True, append_images=[second])
    response = ingest(tmp_path, data, LIMITS | {"maxFrames": 1})
    assert response["error"]["code"] == "limit_exceeded"
    assert response["error"]["message"]["en"] == "Image with 2 frames exceeds the limit of 1"
    assert not (tmp_path / "out").exists()


@pytest.mark.parametrize(("mode", "fmt", "samples", "expected"), [
    ("I;16", "PNG", [0, 0x2000, 0x8000, 0xFFFF], [0, 32, 128, 255]),
    ("F", "TIFF", [-5.0, 42.0, 128.0, 300.0], [0, 42, 128, 255]),
])
def test_ingest_normalizes_high_depth_grayscale(tmp_path, mode, fmt, samples, expected):
    source = Image.new(mode, (4, 1))
    for x, value in enumerate(samples):
        source.putpixel((x, 0), value)
    data = encode(source, fmt)
    response = ingest(tmp_path, data)
    assert response["status"] == "ok"
    assert response["report"]["originalMode"] == mode
    assert response["report"]["hasAlpha"] is False
    assert response["report"]["partialAlpha"] is False
    assert normalized(tmp_path).tobytes() == bytes(channel for v in expected for channel in (v, v, v, 255))
    assert (tmp_path / "in" / "source").read_bytes() == data


@pytest.mark.parametrize("valid", [True, False], ids=["valid-srgb", "unreadable"])
def test_ingest_embedded_rgb_profile_preserves_alpha(tmp_path, valid):
    source = Image.new("RGBA", (2, 1))
    source.putdata([(90, 40, 10, 127), (32, 64, 96, 0)])
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes() if valid else b"not an ICC profile"
    response = ingest(tmp_path, encode(source, "PNG", icc_profile=profile))
    assert response["status"] == ("ok" if valid else "needs_review")
    assert response["report"]["iccConverted"] is valid
    assert response["report"]["partialAlpha"] is True
    assert normalized(tmp_path).tobytes() == source.tobytes()
    if not valid:
        assert "Unreadable ICC profile" in response["warnings"][0]["en"]


def cmyk_gray_profile() -> bytes:
    """Minimal ICC v2 input profile: a CMYK-to-Lab LUT mapping ink coverage to neutral shades."""
    linear = bytes(range(256))
    # Two samples on each of four input axes, with K varying fastest.
    grid = b"".join(bytes((255 - 60 * i.bit_count(), 128, 128)) for i in range(16))
    lut = (
        b"mft1\0\0\0\0\x04\x03\x02\0"
        + struct.pack(">9i", 65536, 0, 0, 0, 65536, 0, 0, 0, 65536)
        + linear * 4 + grid + linear * 3
    )
    header = bytearray(128)
    struct.pack_into(
        ">I4xI4s4s4s6H4s", header, 0, 144 + len(lut), 0x02100000,
        b"scnr", b"CMYK", b"Lab ", 2026, 1, 1, 0, 0, 0, b"acsp",
    )
    struct.pack_into(">3i", header, 68, 63190, 65536, 54061)  # D50
    return bytes(header) + struct.pack(">I4sII", 1, b"A2B0", 144, len(lut)) + lut


def test_ingest_uses_cmyk_profile_instead_of_uncalibrated_conversion(tmp_path):
    source = Image.new("CMYK", (2, 1))
    source.putpixel((1, 0), (255, 0, 0, 0))
    data = encode(source, "TIFF", icc_profile=cmyk_gray_profile())
    response = ingest(tmp_path, data)
    assert response["status"] == "ok"
    assert response["report"]["originalMode"] == "CMYK"
    assert response["report"]["iccConverted"] is True
    result = normalized(tmp_path)
    white, gray = result.getpixel((0, 0)), result.getpixel((1, 0))
    assert white[3] == 255 and min(white[:3]) >= 250
    r, g, b, a = gray
    assert a == 255 and 170 < r < 215 and max(r, g, b) - min(r, g, b) < 5
