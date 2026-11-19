"""Testes pelo protocolo real: subprocesso, JSON no stdin, pasta de trabalho isolada."""

from __future__ import annotations

import hashlib
import io
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "fixtures" / "clareira" / "package"
RESPONSE_SCHEMA = json.loads((REPO / "schemas" / "v1" / "python-response.schema.json").read_text())
REQUEST_SCHEMA = json.loads((REPO / "schemas" / "v1" / "python-request.schema.json").read_text())

LIMITS = {"maxBytes": 10_000_000, "maxWidth": 4096, "maxHeight": 4096, "maxPixels": 4096 * 4096, "maxFrames": 64}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run(workdir: Path, request: object) -> dict:
    raw = request if isinstance(request, bytes) else json.dumps(request).encode()
    proc = subprocess.run(
        [sys.executable, "-I", "-m", "pixel_pipeline"],
        input=raw,
        cwd=workdir,
        capture_output=True,
        timeout=60,
        check=True,
    )
    response = json.loads(proc.stdout)
    Draft202012Validator(RESPONSE_SCHEMA).validate(response)
    return response


def ingest(workdir: Path, data: bytes, limits: dict | None = None) -> dict:
    (workdir / "in").mkdir(exist_ok=True)
    (workdir / "in" / "source").write_bytes(data)
    request = {
        "protocolVersion": 1,
        "jobId": "job-1",
        "attemptId": "att-1",
        "operation": "ingest_inspect",
        "inputs": [{"ordinal": 0, "role": "source", "sha256": sha(data), "relPath": "in/source"}],
        "recipe": {"version": 1, "limits": limits or LIMITS},
    }
    Draft202012Validator(REQUEST_SCHEMA).validate(request)
    return run(workdir, request)


def normalized(workdir: Path) -> Image.Image:
    image = Image.open(workdir / "out" / "normalized.png")
    image.load()
    return image


def encode(image: Image.Image, fmt: str, **params) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format=fmt, **params)
    return buf.getvalue()


def test_version_flag():
    out = subprocess.run([sys.executable, "-I", "-m", "pixel_pipeline", "--version"], capture_output=True, check=True)
    assert json.loads(out.stdout)["protocolVersion"] == 1


def test_unknown_protocol_version(tmp_path):
    response = run(tmp_path, {"protocolVersion": 2, "operation": "ingest_inspect"})
    assert response["error"]["code"] == "unsupported_protocol"


def test_invalid_json(tmp_path):
    assert run(tmp_path, b"{nope")["error"]["code"] == "invalid_request"


def test_path_escape_is_rejected(tmp_path):
    request = {
        "protocolVersion": 1,
        "jobId": "j",
        "attemptId": "a",
        "operation": "ingest_inspect",
        "inputs": [{"ordinal": 0, "role": "source", "sha256": "0" * 64, "relPath": "../outside.png"}],
        "recipe": {"version": 1, "limits": LIMITS},
    }
    assert run(tmp_path, request)["error"]["code"] == "invalid_request"


def test_hash_mismatch_is_rejected(tmp_path):
    (tmp_path / "in").mkdir()
    (tmp_path / "in" / "source").write_bytes(b"x")
    request = {
        "protocolVersion": 1,
        "jobId": "j",
        "attemptId": "a",
        "operation": "ingest_inspect",
        "inputs": [{"ordinal": 0, "role": "source", "sha256": "0" * 64, "relPath": "in/source"}],
        "recipe": {"version": 1, "limits": LIMITS},
    }
    message = run(tmp_path, request)["error"]["message"]
    assert "diverge" in message["pt-BR"] and "does not match" in message["en"]


def test_fixture_png_keeps_pixels_and_partial_alpha(tmp_path):
    data = (FIXTURES / "textures" / "spark.png").read_bytes()
    response = ingest(tmp_path, data)
    assert response["status"] == "ok"
    assert response["report"]["partialAlpha"] is True
    out = normalized(tmp_path)
    assert out.mode == "RGBA" and out.size == (16, 8)
    assert out.getpixel((11, 2)) == (255, 230, 90, 128)
    assert out.getpixel((12, 3)) == (255, 230, 90, 64)
    assert response["outputs"][0]["sha256"] == sha((tmp_path / "out" / "normalized.png").read_bytes())


def test_same_bytes_same_output(tmp_path):
    data = (FIXTURES / "sprites" / "warrior-base-s.png").read_bytes()
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    first = ingest(tmp_path / "a", data)
    second = ingest(tmp_path / "b", data)
    assert first["outputs"][0]["sha256"] == second["outputs"][0]["sha256"]
    assert first["outputs"][0]["rgbaSha256"] == second["outputs"][0]["rgbaSha256"]


def test_palette_png_keeps_transparent_index(tmp_path):
    image = Image.new("P", (4, 2), 0)
    image.putpalette([0, 255, 0, 200, 30, 30] + [0] * (256 * 3 - 6))
    image.putpixel((3, 1), 1)
    data = encode(image, "PNG", transparency=0)
    response = ingest(tmp_path, data)
    assert response["report"]["originalMode"] == "P"
    out = normalized(tmp_path)
    assert out.getpixel((0, 0))[3] == 0
    assert out.getpixel((3, 1)) == (200, 30, 30, 255)


def test_jpeg_exif_orientation_is_applied(tmp_path):
    # Imagem 4×2 com marca vermelha em (0, 0); orientação 6 = girar 90° no sentido horário ao exibir.
    image = Image.new("RGB", (4, 2), (0, 0, 255))
    image.putpixel((0, 0), (255, 0, 0))
    exif = Image.Exif()
    exif[0x0112] = 6
    data = encode(image, "JPEG", quality=100, subsampling=0, exif=exif.tobytes())
    response = ingest(tmp_path, data)
    assert response["report"]["exifOrientation"] == 6
    assert response["report"]["size"] == [2, 4]
    red = normalized(tmp_path).getpixel((1, 0))
    assert red[0] > 200 and red[2] < 60


def test_truncated_png_fails_to_decode(tmp_path):
    data = (FIXTURES / "sprites" / "warrior-attack-s.png").read_bytes()
    assert ingest(tmp_path, data[: len(data) // 2])["error"]["code"] == "decode_failed"


def test_pixel_limit_checked_before_decoding(tmp_path):
    data = (FIXTURES / "tiles" / "grass-water.png").read_bytes()
    response = ingest(tmp_path, data, {**LIMITS, "maxPixels": 1000})
    assert response["error"]["code"] == "limit_exceeded"
    assert not (tmp_path / "out").exists()


def test_animated_gif_needs_frame_split(tmp_path):
    frames = [Image.new("RGB", (4, 4), c) for c in ((255, 0, 0), (0, 255, 0))]
    buf = io.BytesIO()
    frames[0].save(buf, format="GIF", save_all=True, append_images=frames[1:], duration=100)
    response = ingest(tmp_path, buf.getvalue())
    assert response["error"]["code"] == "unsupported_input"
    assert "tira PNG" in response["error"]["message"]["pt-BR"]
    assert "PNG strip" in response["error"]["message"]["en"]


def test_unrecognized_bytes(tmp_path):
    assert ingest(tmp_path, b"not an image at all")["error"]["code"] == "decode_failed"


@pytest.fixture(autouse=True)
def _isolate(tmp_path):
    yield
    shutil.rmtree(tmp_path, ignore_errors=True)
