"""O leitor independente aceita a fixture da clareira e recusa pacotes adulterados."""

from __future__ import annotations

import json
import subprocess
import sys
import zipfile
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parents[1] / "fixtures" / "clareira" / "package"


def make_zip(path: Path, mutate=None) -> Path:
    with zipfile.ZipFile(path, "w") as zf:
        for f in sorted(PACKAGE.rglob("*")):
            if f.is_file():
                name = f.relative_to(PACKAGE).as_posix()
                data = f.read_bytes()
                if mutate:
                    name, data = mutate(name, data)
                zf.writestr(name, data)
    return path


def run(zip_path: Path, out: Path) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(HERE / "read_portable.py"), str(zip_path), str(out)], capture_output=True, text=True, timeout=60)


def test_reconstructs_frames_with_duration_and_pivot(tmp_path):
    proc = run(make_zip(tmp_path / "p.zip"), tmp_path / "out")
    assert proc.returncode == 0, proc.stderr
    summary = json.loads((tmp_path / "out" / "summary.json").read_text())
    by_id = {e["revisionId"]: e for e in summary["entries"]}

    spark = by_id["spark-v1"]
    assert spark["pivot"] == [3, 4] and [f["durationMs"] for f in spark["frames"]] == [80, 120]
    fade = Image.open(tmp_path / "out" / spark["frames"][1]["file"])
    assert fade.size == (8, 8) and fade.getpixel((3, 2)) == (255, 230, 90, 128)

    clip = by_id["warrior-attack-osh-s-v1"]
    assert [f["durationMs"] for f in clip["frames"]] == [140, 80, 60, 160]
    assert clip["pivot"] == [32, 60]
    assert clip["frames"][2]["sockets"]["hand_right"] == [39, 34]
    assert clip["events"] == [{"frameId": "contact", "vfx": "spark-v1", "audio": "hit-sfx-v1"}]

    loadout = by_id["warrior-loadout-osh-v1"]["clips"][0]
    layers = {f["frameId"]: f["layers"] for f in loadout["frames"]}
    assert layers["windup"] == ["body", "torso", "sleeve_near"]
    assert layers["contact"] == ["body", "torso"]  # manga encoberta: célula vazia explícita

    assert by_id["grass-water-v1"]["complete"] is True
    assert by_id["hit-sfx-v1"]["durationMs"] == 100


def test_rejects_tampered_file(tmp_path):
    def tamper(name, data):
        return (name, data[:-1] + bytes([data[-1] ^ 0xFF])) if name == "textures/spark.png" else (name, data)

    proc = run(make_zip(tmp_path / "p.zip", tamper), tmp_path / "out")
    assert proc.returncode == 2 and "SHA-256" in proc.stderr


def test_rejects_unknown_major_version(tmp_path):
    def bump(name, data):
        if name == "manifest.json":
            m = json.loads(data)
            m["schemaVersion"] = 2
            return name, json.dumps(m).encode()
        return name, data

    proc = run(make_zip(tmp_path / "p.zip", bump), tmp_path / "out")
    assert proc.returncode == 2 and "versão 2" in proc.stderr


def test_rejects_zip_slip(tmp_path):
    zip_path = tmp_path / "evil.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("../fora.txt", b"x")
    proc = run(zip_path, tmp_path / "out")
    assert proc.returncode == 2 and "inseguro" in proc.stderr
    assert not (tmp_path / "fora.txt").exists()
