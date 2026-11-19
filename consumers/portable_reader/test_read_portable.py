"""O leitor independente aceita a fixture da clareira e recusa pacotes adulterados."""

from __future__ import annotations

import hashlib
import io
import json
import subprocess
import sys
import zipfile
from pathlib import Path

from PIL import Image
import pytest

from read_portable import Images, Rejected, meter_fill, render_meter, render_text, safe_extract

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parents[1] / "fixtures" / "clareira" / "package"


def make_zip(path: Path, mutate=None, *, extra=None) -> Path:
    with zipfile.ZipFile(path, "w") as zf:
        for f in sorted(PACKAGE.rglob("*")):
            if f.is_file():
                name = f.relative_to(PACKAGE).as_posix()
                data = f.read_bytes()
                if mutate:
                    name, data = mutate(name, data)
                if name is not None:
                    zf.writestr(name, data)
        for name, data in (extra or {}).items():
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


def test_reconstructs_two_loadouts_sharing_one_clip_without_overwriting(tmp_path):
    def add_unequipped_loadout(name, data):
        if name != "manifest.json":
            return name, data
        manifest = json.loads(data)
        equipped = next(e for e in manifest["entries"] if e["revisionId"] == "warrior-loadout-osh-v1")
        manifest["entries"].append({
            **equipped,
            "assetId": "warrior-unarmored",
            "revisionId": "warrior-unarmored-v1",
            "dependencies": [d for d in equipped["dependencies"] if d["role"] != "overlay"],
            "payload": {**equipped["payload"], "overlayRevisionIds": []},
        })
        return name, json.dumps(manifest).encode()

    out = tmp_path / "out"
    proc = run(make_zip(tmp_path / "loadouts.zip", add_unequipped_loadout), out)
    assert proc.returncode == 0, proc.stderr
    assets = {e["revisionId"]: e for e in json.loads((out / "summary.json").read_text())["entries"]}
    base = assets["warrior-attack-osh-s-v1"]["frames"]
    armor = assets["warrior-loadout-osh-v1"]["clips"][0]["frames"]
    unarmored = assets["warrior-unarmored-v1"]["clips"][0]["frames"]
    for original, equipped, plain in zip(base, armor, unarmored, strict=True):
        assert original["frameId"] == equipped["frameId"] == plain["frameId"]
        with (
            Image.open(out / original["file"]) as original_png,
            Image.open(out / equipped["file"]) as armor_png,
            Image.open(out / plain["file"]) as plain_png,
        ):
            assert plain_png.tobytes() == original_png.tobytes()
            assert armor_png.tobytes() != original_png.tobytes()


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


def package_zip(path, manifest, extra=None):
    def replace_manifest(name, data):
        return (name, json.dumps(manifest).encode()) if name == "manifest.json" else (name, data)

    return make_zip(path, replace_manifest, extra=extra)


def entry(manifest, revision_id):
    return next(e for e in manifest["entries"] if e["revisionId"] == revision_id)


def add_entry(manifest, revision_id, family, kind, payload, **dependencies):
    manifest["entries"].append({
        "assetId": revision_id,
        "revisionId": revision_id,
        "family": family,
        "kind": kind,
        "name": revision_id,
        "dependencies": [{"role": role, "revisionId": target} for role, target in dependencies.items()],
        "payload": payload,
    })


def add_file(manifest, files, file_id, path, data, *, mime, **metadata):
    files[path] = data
    manifest["files"].append({
        "fileId": file_id,
        "path": path,
        "mime": mime,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        **metadata,
    })


def add_png(manifest, files, file_id, image):
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    add_file(manifest, files, file_id, f"test/{file_id}.png", buf.getvalue(),
             mime="image/png", width=image.width, height=image.height)


@pytest.fixture
def manifest():
    return json.loads((PACKAGE / "manifest.json").read_text())


def read_entries(tmp_path, manifest, extra=None):
    out = tmp_path / "out"
    proc = run(package_zip(tmp_path / "p.zip", manifest, extra), out)
    assert proc.returncode == 0, proc.stderr
    report = json.loads((out / "summary.json").read_text())
    return out, {e["revisionId"]: e for e in report["entries"]}


def assert_rejected(tmp_path, path, reason):
    out = tmp_path / "out"
    proc = run(path, out)
    assert proc.returncode == 2, proc.stderr
    assert reason in proc.stderr
    assert not (out / "summary.json").exists()


def test_cli_without_paths_prints_usage():
    proc = subprocess.run([sys.executable, str(HERE / "read_portable.py")], capture_output=True,
                          text=True, timeout=60)
    assert proc.returncode == 64
    assert "Uso: python read_portable.py pacote.zip pasta_de_saida" in proc.stderr
    assert not proc.stdout


@pytest.mark.parametrize(
    ("members", "reason"),
    [
        (["empty/"], "manifest.json ausente na raiz"),
        (["sprites/wood.png", "sprites/WOOD.png"], "caminho duplicado"),
        (["sprites/alias.png"], "link simbólico recusado"),
    ],
    ids=["directory-without-manifest", "case-collision", "symlink"],
)
def test_rejects_incomplete_or_unsafe_archive(tmp_path, members, reason):
    path = tmp_path / "p.zip"
    with zipfile.ZipFile(path, "w") as zf:
        for name in members:
            member = zipfile.ZipInfo(name)
            if name == "sprites/alias.png":
                member.create_system = 3
                member.external_attr = 0o120777 << 16
            zf.writestr(member, b"" if name.endswith("/") else b"wood.png")
    assert_rejected(tmp_path, path, reason)


def test_extraction_refuses_to_write_through_a_link_in_the_destination(tmp_path, monkeypatch):
    dest = tmp_path / "extracted"
    outside = tmp_path / "neighbor"
    outside.mkdir()
    archive = tmp_path / "p.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("assets/wood.png", b"wood")
    original = zipfile.ZipFile.infolist

    def list_with_destination_link(zf):
        # Simulate a destination path changing after the extraction folder was created.
        (dest / "assets").symlink_to(outside, target_is_directory=True)
        return original(zf)

    monkeypatch.setattr(zipfile.ZipFile, "infolist", list_with_destination_link)
    with pytest.raises(Rejected, match="caminho fora da pasta"):
        safe_extract(archive, dest)
    assert not (outside / "wood.png").exists()


def test_rejects_missing_payload_file(tmp_path):
    path = make_zip(tmp_path / "p.zip", lambda name, data: (None, data) if name == "textures/spark.png" else (name, data))
    assert_rejected(tmp_path, path, "arquivo ausente: textures/spark.png")


@pytest.mark.parametrize(
    ("file_id", "field", "value", "reason"),
    [
        ("spark-texture", "bytes", 900, "manifesto diz 900"),
        ("spark-texture", "width", 17, "PNG (16, 8), manifesto 17×8"),
        ("hit-wav", "frameCount", 2206, "metadados de áudio divergem"),
        ("hit-wav", "channels", 2, "metadados de áudio divergem"),
        ("hit-wav", "sampleRate", 44100, "metadados de áudio divergem"),
        ("spark-texture", "fileId", "chainmail-atlas", "fileId duplicado: chainmail-atlas"),
    ],
)
def test_rejects_declared_file_metadata_that_disagrees(tmp_path, manifest, file_id, field, value, reason):
    next(f for f in manifest["files"] if f["fileId"] == file_id)[field] = value
    assert_rejected(tmp_path, package_zip(tmp_path / "p.zip", manifest), reason)


def test_rejects_two_assets_using_one_revision_id(tmp_path, manifest):
    entry(manifest, "spark-v1")["revisionId"] = "warrior-base-v1"
    assert_rejected(tmp_path, package_zip(tmp_path / "p.zip", manifest), "revisionId duplicado: warrior-base-v1")


def test_rejects_missing_dependency_even_when_the_clip_payload_is_untouched(tmp_path, manifest):
    manifest["entries"].remove(entry(manifest, "spark-v1"))
    reason = "warrior-attack-osh-s-v1 depende de spark-v1 (vfx), ausente"
    assert_rejected(tmp_path, package_zip(tmp_path / "p.zip", manifest), reason)


def test_rejects_cycle_through_existing_revisions(tmp_path, manifest):
    entry(manifest, "warrior-base-v1")["dependencies"].append({
        "role": "reference", "revisionId": "warrior-attack-osh-s-v1",
    })
    assert_rejected(tmp_path, package_zip(tmp_path / "p.zip", manifest), "ciclo de dependências em warrior-base-v1")


@pytest.mark.parametrize("rect", [[12, 0, 8, 8], [-1, 0, 8, 8], [0, -1, 8, 8], [0, 0, 0, 8], [0, 0, 8, -1]])
def test_rejects_out_of_bounds_atlas_region(tmp_path, manifest, rect):
    entry(manifest, "spark-v1")["payload"]["frames"][0]["rect"] = rect
    assert_rejected(tmp_path, package_zip(tmp_path / "p.zip", manifest), "fora de spark-texture (16×8)")


def test_rejects_declared_font_coverage_without_a_glyph(tmp_path, manifest):
    entry(manifest, "mini-font-v1")["payload"]["declaredCoverage"].append(937)
    assert_rejected(tmp_path, package_zip(tmp_path / "p.zip", manifest), "cobertura declarada sem glyph: [937]")


def test_preserves_verified_engine_data_without_treating_it_as_media(tmp_path, manifest):
    data = b'{"type":"map","width":3}'
    files = {}
    add_file(manifest, files, "tile-editor-data", "tiled/map.tmj", data,
             mime="application/json", purpose="tiled_map")
    out, by_id = read_entries(tmp_path, manifest, files)
    assert by_id["grass-water-v1"]["masks"] == list(range(16))
    assert (out / "extracted" / "tiled" / "map.tmj").read_bytes() == data
    assert json.loads((out / "summary.json").read_text())["files"] == 11


TRANSPARENT = (0, 0, 0, 0)
RED = (220, 20, 30, 255)
BLUE = (35, 70, 230, 255)
GREEN = (30, 200, 60, 255)
GOLD = (240, 180, 10, 255)


def region(file_id, x, y, width, height):
    return {"fileId": file_id, "rect": [x, y, width, height]}


def pixel_row(*colors):
    image = Image.new("RGBA", (len(colors), 1))
    image.putdata(colors)
    return image


def test_empty_vfx_frame_preserves_its_time_and_logical_cell(tmp_path, manifest):
    payload = entry(manifest, "spark-v1")["payload"]
    payload["frames"].append({
        "frameId": "rest", "fileId": None, "rect": None, "sourceOffset": [0, 0], "durationMs": 220,
    })
    out, by_id = read_entries(tmp_path, manifest)
    rest = by_id["spark-v1"]["frames"][2]
    assert (rest["frameId"], rest["durationMs"]) == ("rest", 220)
    with Image.open(out / rest["file"]) as image:
        assert image.size == (8, 8) and image.getbbox() is None


def test_rigid_view_anchors_to_socket_and_draw_order_matches_flat_sheet(tmp_path, manifest):
    clip_id = "warrior-attack-osh-s-v1"
    overlay_id = "chainmail-v1"
    clip = entry(manifest, clip_id)["payload"]
    overlay = entry(manifest, overlay_id)["payload"]
    loadout = entry(manifest, "warrior-loadout-osh-v1")["payload"]
    files = {}
    add_png(manifest, files, "test-gear", pixel_row(RED, GREEN, GOLD, BLUE))
    anchors = {f["frameId"]: f["sockets"][0]["at"] for f in clip["frames"]}
    for frame in clip["frames"]:
        frame["layers"] = [{**region("test-gear", 3, 0, 1, 1), "offset": anchors[frame["frameId"]], "partId": "body"}]
    overlay["parts"] = [{
        "partId": "torso",
        "coverage": [{
            "clipRevisionId": clip_id, "frameId": "windup", "drawIndex": 1,
            "layer": {**region("test-gear", 3, 0, 1, 1), "offset": [42, 28]},
        }],
    }]
    overlay["rigidViews"] = [{
        **region("test-gear", 0, 0, 3, 1), "viewId": "blade",
        "grips": [{"socketId": "hand_right", "at": [0, 0]}], "mirrorAllowed": True,
    }]
    overlay["rigidPlacements"] = [
        {"clipRevisionId": clip_id, "frameId": frame, "viewId": view, "anchorSocketId": "hand_right",
         "drawIndex": -1, "mirrored": mirrored}
        for frame, view, mirrored in [("windup", "blade", True), ("advance", "blade", False), ("contact", None, False)]
    ]
    loadout["drawOrder"] = [{
        "clipRevisionId": clip_id, "frameId": "windup",
        "layers": [
            {"kind": "base", "partId": "body"},
            {"kind": "rigid", "overlayRevisionId": overlay_id},
            {"kind": "part", "overlayRevisionId": overlay_id, "partId": "torso"},
        ],
    }]
    sheet = Image.new("RGBA", (256, 64))
    sheet.paste(pixel_row(GOLD, BLUE, RED), (41, 28))
    sheet.paste(pixel_row(BLUE, GREEN, GOLD), (64 + 42, 30))
    # Deliberately leave contact empty: the reader must identify only this discrepant cell.
    rx, ry = anchors["recover"]
    sheet.putpixel((3 * 64 + rx, ry), BLUE)
    add_png(manifest, files, "test-flat", sheet)
    loadout["sheets"] = [{
        "clipRevisionId": clip_id, "fileId": "test-flat",
        "frames": [{"frameId": f["frameId"], "rect": [64 * i, 0, 64, 64]} for i, f in enumerate(clip["frames"])],
    }]

    out, by_id = read_entries(tmp_path, manifest, files)
    equipped = by_id["warrior-loadout-osh-v1"]
    assert equipped["sheets"] == [{
        "clipRevisionId": clip_id, "frames": 4, "matches": False, "mismatchedFrames": ["contact"],
    }]
    windup, advance, contact, _ = equipped["clips"][0]["frames"]
    assert windup["layers"] == ["body", "rigid:blade", "torso"]
    assert advance["layers"] == ["rigid:blade", "body"]
    assert contact["layers"] == ["body"]
    with (
        Image.open(out / windup["file"]) as mirrored,
        Image.open(out / advance["file"]) as regular,
        Image.open(out / contact["file"]) as hidden,
    ):
        assert list(mirrored.crop((40, 28, 45, 29)).get_flattened_data()) == [TRANSPARENT, GOLD, BLUE, RED, TRANSPARENT]
        assert list(regular.crop((41, 30, 46, 31)).get_flattened_data()) == [TRANSPARENT, BLUE, GREEN, GOLD, TRANSPARENT]
        assert hidden.getbbox() == (39, 34, 40, 35)


def tilemap(projection, size, cell_size, terrain, *, objects=()):
    return {
        "projection": projection, "size": size, "cellSize": cell_size, "terrain": terrain, "seed": 1,
        "objects": list(objects), "collisions": [], "regions": [], "entrances": [], "passages": [],
        "units": {"cell": "cell", "offset": "px", "polygon": "px"},
    }


def map_prop(image, *, shadow=None):
    return {
        **image, "projection": "top_down", "logicalSize": image["rect"][2:], "supportPoint": [0, 0],
        "footprintCells": [1, 1], "collision": [], "occlusionAboveY": None, "shadow": shadow,
    }


def test_corner_map_uses_tile_keys_and_sorts_clipped_objects_by_support(tmp_path, manifest):
    files = {}
    add_png(manifest, files, "props", pixel_row(RED, GREEN, BLUE, GOLD))
    add_entry(manifest, "gate", "map", "object", map_prop(
        region("props", 0, 0, 3, 1), shadow={**region("props", 3, 0, 1, 1), "offset": [3, 0]},
    ))
    bench = map_prop(region("props", 3, 0, 1, 1))
    bench["supportPoint"] = [1, 1]
    add_entry(manifest, "bench", "map", "object", bench)
    terrain = {
        "mode": "corner", "rule": "corner-v1", "tilesetRevisionId": "grass-water-v1",
        "vertices": [0] * 8, "walkable": [True, False], "overrides": [],
        "resolved": ["grass-water-3", None, "not-in-atlas"],
    }
    objects = [
        {"objectId": "bench-1", "objectRevisionId": "bench", "pieceKey": None, "cell": [0, 0], "offsetPx": [-14, 1]},
        {"objectId": "gate-1", "objectRevisionId": "gate", "pieceKey": None, "cell": [0, 0], "offsetPx": [-17, 0]},
    ]
    payload = tilemap("top_down", [3, 1], [32, 32], terrain, objects=objects)
    payload["entrances"] = [
        {"entranceId": "west", "name": "West", "cell": [0, 0], "side": "W"},
        {"entranceId": "east", "name": "East", "cell": [2, 0], "side": "E"},
    ]
    payload["passages"] = [{"from": "west", "to": "east"}]
    add_entry(manifest, "courtyard", "map", "tilemap", payload,
              tileset="grass-water-v1", gate="gate", bench="bench")

    out, by_id = read_entries(tmp_path, manifest, files)
    result = by_id["courtyard"]
    assert result["projection"] == "top_down" and result["objects"] == 2 and result["missingTiles"] == 1
    assert result["entrances"] == ["west", "east"] and result["passages"] == [{"from": "west", "to": "east"}]
    assert by_id["gate"]["shadow"] and not by_id["bench"]["shadow"]
    with (
        Image.open(out / result["file"]) as rendered,
        Image.open(PACKAGE / "tiles" / "grass-water.png") as atlas,
    ):
        assert rendered.size == (96, 32)
        assert rendered.crop((0, 0, 32, 16)).tobytes() == atlas.crop((96, 0, 128, 16)).tobytes()
        assert rendered.crop((32, 0, 96, 32)).getbbox() is None
        assert list(rendered.crop((0, 16, 3, 17)).get_flattened_data()) == [GREEN, GOLD, GOLD]


def test_side_map_uses_primary_configuration_variant_and_leaves_gaps(tmp_path, manifest):
    files = {}
    add_png(manifest, files, "side-atlas", pixel_row(RED, BLUE))
    add_entry(manifest, "ledge-tiles", "tileset", "sidescroller", {
        "projection": "side", "cellSize": [1, 1], "complete": False, "walkableLineY": 0,
        "platformMaterial": "stone", "surfaceMaterial": "grass",
        "atlas": {"fileId": "side-atlas", "margin": 0, "spacing": 0},
        "requiredConfigurations": ["surface_single", "interior"],
        "tiles": [
            {"tileKey": key, "configuration": "surface_single", "variant": variant,
             "rect": [variant, 0, 1, 1], "weight": 1, "frames": []}
            for key, variant in [("single", 0), ("alt", 1)]
        ],
    })
    add_entry(manifest, "ledge-map", "map", "tilemap", tilemap("side", [3, 1], [1, 1], {
        "mode": "side", "rule": "side-v1", "tilesetRevisionId": "ledge-tiles",
        "solid": [1, 0, 1], "resolved": ["surface_single", None, "interior"],
    }), tileset="ledge-tiles")

    out, by_id = read_entries(tmp_path, manifest, files)
    tiles = by_id["ledge-tiles"]
    assert not tiles["complete"] and tiles["configurations"] == ["surface_single"] and tiles["missing"] == ["interior"]
    assert by_id["ledge-map"]["missingTiles"] == 1
    with Image.open(out / by_id["ledge-map"]["file"]) as rendered:
        assert rendered.size == (3, 1)
        assert list(rendered.get_flattened_data()) == [RED, TRANSPARENT, TRANSPARENT]


def test_isometric_prop_shifts_relative_to_its_elevated_cell(tmp_path, manifest):
    files = {}
    atlas = Image.new("RGBA", (6, 4))
    atlas.paste(GREEN, (0, 0, 2, 2))
    atlas.paste(RED, (2, 0, 4, 2))
    atlas.paste(BLUE, (4, 0, 6, 4))
    add_png(manifest, files, "iso-atlas", atlas)
    add_entry(manifest, "iso-tiles", "tileset", "isometric", {
        "projection": "isometric", "groundDiamondSize": [4, 4], "logicalCellSize": [4, 4],
        "elevationStepPx": 2, "sortRule": "depth_ij_elevation_v1",
        "atlas": {"fileId": "iso-atlas", "margin": 0, "spacing": 0},
        "pieces": [
            {"pieceKey": "step", "name": "step", "kind": "block", "rect": [0, 0, 2, 2],
             "logicalSize": [2, 2], "footprintCells": [1, 1], "groundOrigin": [0, 0], "supportPoint": [0, 2],
             "elevation": 1, "occluderRect": None, "blocksMovement": False},
            {"pieceKey": "lamp", "name": "lamp", "kind": "prop", "rect": [2, 0, 2, 2],
             "logicalSize": [2, 2], "footprintCells": [1, 1], "groundOrigin": [0, 0], "supportPoint": [0, 2],
             "elevation": 0, "occluderRect": None, "blocksMovement": True},
            {"pieceKey": "arch", "name": "arch", "kind": "prop", "rect": [4, 0, 2, 4],
             "logicalSize": [2, 4], "footprintCells": [2, 1], "groundOrigin": [0, 1], "supportPoint": [1, 4],
             "elevation": 0, "occluderRect": None, "blocksMovement": True},
        ],
    })
    # A standalone map object in a legacy package is retained as data, not
    # interpreted as a tileset prop. Its art must not enter this canvas.
    add_entry(manifest, "legacy-prop", "map", "object", {
        **map_prop({"fileId": "iso-atlas", "rect": [4, 0, 2, 4]}), "projection": "isometric",
    })
    objects = [
        {"objectId": "lamp-1", "objectRevisionId": None, "pieceKey": "lamp", "cell": [0, 0], "offsetPx": [1, 0]},
        {"objectId": "arch-1", "objectRevisionId": None, "pieceKey": "arch", "cell": [0, 0], "offsetPx": [2, 2]},
        {"objectId": "legacy", "objectRevisionId": "legacy-prop", "pieceKey": None, "cell": [1, 1], "offsetPx": [0, 0]},
    ]
    terrain = {
        "mode": "isometric", "rule": "iso-v1", "tilesetRevisionId": "iso-tiles",
        "cells": [{"pieceKey": key, "elevation": elevation} for key, elevation in [
            ("step", 1), ("step", 0), (None, 0), ("retired", 0),
        ]],
    }
    add_entry(manifest, "iso-map", "map", "tilemap", tilemap(
        "isometric", [2, 2], [4, 4], terrain, objects=objects,
    ), tileset="iso-tiles", object="legacy-prop")

    out, by_id = read_entries(tmp_path, manifest, files)
    assert by_id["iso-tiles"]["diamond"] == [4, 4]
    assert by_id["iso-tiles"]["pieces"]["arch"]["footprintCells"] == [2, 1]
    assert by_id["iso-map"]["objects"] == 3 and by_id["iso-map"]["missingTiles"] == 1
    with Image.open(out / by_id["iso-map"]["file"]) as rendered:
        assert rendered.size == (8, 24)
        # The lamp sits on the raised step. The wider arch sorts on the front of
        # its footprint; the later (1, 0) step stays behind it where they overlap.
        assert list(rendered.crop((4, 15, 8, 16)).get_flattened_data()) == [GREEN, RED, BLUE, BLUE]
        assert rendered.getpixel((6, 18)) == BLUE
        assert rendered.getpixel((6, 19)) == GREEN
        assert rendered.getpixel((4, 22)) == TRANSPARENT


def test_layered_scene_repeats_both_axes_and_moves_front_plan_by_parallax(tmp_path, manifest):
    files = {}
    art = Image.new("RGBA", (6, 3))
    art.paste(pixel_row(BLUE, GREEN), (0, 0))
    art.putpixel((2, 0), RED)
    art.paste(pixel_row(GREEN, BLUE, GREEN), (3, 0))
    art.paste(pixel_row(GREEN, BLUE, RED), (3, 1))
    art.paste(pixel_row(GREEN, BLUE, GREEN), (3, 2))
    add_png(manifest, files, "scene-art", art)
    continuous = {"method": "edge_delta", "threshold": 3, "seamDelta": 0, "interiorDelta": 0, "passed": True}
    for revision, depth, rect, repeats in [
        ("sky", "sky", [0, 0, 2, 1], True), ("sign", "near", [2, 0, 1, 1], False),
    ]:
        add_entry(manifest, revision, "map", "scene_layer", {
            "fileId": "scene-art", "rect": rect, "logicalSize": rect[2:], "depth": depth, "obtained": "imported",
            "repeat": {"x": repeats, "y": repeats}, "requestedRepeat": {"x": repeats, "y": repeats},
            "continuity": dict.fromkeys(("x", "y"), continuous if repeats else None),
            "derivation": None, "groundLineY": None,
        })
    flat = {
        "outputKind": "flat_image", "projection": "side", "logicalSize": [3, 3],
        "image": region("scene-art", 3, 0, 3, 3), "layers": [], "cameraTest": None, "characterScale": None,
        "groundLineY": None, "supportPoints": [{"pointId": "entry", "label": "Entry", "at": [1, 2]}],
        "editable": {"map": False, "collisions": False, "objects": False},
    }
    add_entry(manifest, "vista-flat", "map", "scene", flat)
    add_entry(manifest, "vista-moving", "map", "scene", {
        **flat, "outputKind": "layers",
        "layers": [
            {"layerId": "sky", "name": "Sky", "layerRevisionId": "sky", "offset": [1, 1],
             "parallax": {"x": 0, "y": 0}, "repeat": {"x": True, "y": True}},
            {"layerId": "sign", "name": "Sign", "layerRevisionId": "sign", "offset": [2, 1],
             "parallax": {"x": 0.5, "y": 0}, "repeat": {"x": False, "y": False}},
        ],
        "cameraTest": {"spanPx": 6, "steps": 3, "uncoveredFrames": 0, "loopPassed": True, "groundContinuous": None},
    }, sky="sky", sign="sign")

    out, by_id = read_entries(tmp_path, manifest, files)
    result = by_id["vista-moving"]
    assert result["supportPoints"] == [[1, 2]]
    assert result["editable"] == {"map": False, "collisions": False, "objects": False}
    assert result["cameraSpan"] == 6 and result["matchesImage"]
    assert by_id["vista-flat"]["outputKind"] == "flat_image" and "frames" not in by_id["vista-flat"]
    assert by_id["sky"]["depth"] == "sky" and by_id["sky"]["repeat"] == {"x": True, "y": True}
    for path, middle_row in zip(result["frames"], [(GREEN, BLUE, RED), (GREEN, RED, GREEN), (GREEN, BLUE, GREEN)], strict=True):
        with Image.open(out / path) as image:
            assert image.size == (3, 3)
            assert image.getpixel((0, 0)) == image.getpixel((2, 2)) == GREEN
            assert tuple(image.crop((0, 1, 3, 2)).get_flattened_data()) == middle_row


def test_room_draws_background_then_furniture_then_walls_and_keeps_connections(tmp_path, manifest):
    files = {}
    add_png(manifest, files, "room-art", pixel_row(BLUE, BLUE, BLUE, BLUE, BLUE, RED, GOLD, GREEN, RED, GREEN, GOLD))
    cabinet = map_prop(region("room-art", 5, 0, 3, 1), shadow={
        **region("room-art", 8, 0, 1, 1), "offset": [3, 0],
    })
    stool = map_prop(region("room-art", 9, 0, 1, 1))
    stool["supportPoint"] = [0, 1]
    add_entry(manifest, "cabinet", "map", "object", cabinet)
    add_entry(manifest, "stool", "map", "object", stool)
    room = {
        "projection": "top_down", "theme": "Blue stone", "floorPlan": {"size": [2, 1], "cells": [True, False]},
        "tileSize": 32, "cellPx": [32, 32], "gridOrigin": [0, 0], "walkable": [], "route": "imported",
        "picture": region("room-art", 0, 0, 5, 1), "background": None, "overlay": None,
        "styleRoomRevisionId": None, "sourceRoomRevisionId": None, "connections": [], "furniture": [], "exposedAreas": [],
        "doors": [{"doorId": "entry", "cell": [0, 0], "side": "W", "anchorPx": None, "arrivePx": None, "triggerPx": None}],
    }
    add_entry(manifest, "front-room", "map", "room", room)
    overlay = Image.new("RGBA", (5, 1))
    overlay.putpixel((2, 0), GOLD)
    add_png(manifest, files, "room-wall", overlay)
    add_entry(manifest, "furnished-room", "map", "room", {
        **room, "background": room["picture"], "overlay": region("room-wall", 0, 0, 5, 1),
        "connections": [{"doorId": "entry", "toRoomRevisionId": "front-room", "toDoorId": "entry"}],
        "furniture": [
            {"placementId": "stool", "objectRevisionId": "stool", "supportAtPx": [1, 1]},
            {"placementId": "cabinet", "objectRevisionId": "cabinet", "supportAtPx": [0, 0]},
            {"placementId": "outside", "objectRevisionId": "stool", "supportAtPx": [-2, 1]},
        ],
    }, cabinet="cabinet", stool="stool", connection="front-room")

    out, by_id = read_entries(tmp_path, manifest, files)
    result = by_id["furnished-room"]
    assert result["connections"] == [["entry", "front-room", "entry"]]
    assert result["doors"] == {"entry": "W"} and result["floorCells"] == 1
    assert result["furniture"] == ["stool", "cabinet", "outside"]
    with (
        Image.open(out / result["file"]) as image,
        Image.open(out / by_id["front-room"]["file"]) as painted,
    ):
        assert list(image.get_flattened_data()) == [RED, GREEN, GOLD, RED, BLUE]
        assert list(painted.get_flattened_data()) == [BLUE] * 5


def add_portrait(manifest, files):
    add_png(manifest, files, "faces", pixel_row(BLUE, GREEN, RED))
    add_entry(manifest, "speaker", "portrait", "portrait", {
        **region("faces", 0, 0, 1, 1), "logicalSize": [1, 1], "faceAnchor": [0, 0],
        "faceRect": [0, 0, 1, 1], "mouthRect": [0, 0, 1, 1], "characterRevisionId": "warrior-base-v1",
    })
    add_entry(manifest, "speaker-calm", "portrait", "expression", {
        "portraitRevisionId": "speaker", "expressionKey": "calm", "grid": {"columns": 2, "rows": 1, "cell": [1, 1]},
        "visemes": [
            {**region("faces", 1, 0, 1, 1), "visemeId": "rest"},
            {**region("faces", 2, 0, 1, 1), "visemeId": "ai"},
        ],
    }, portrait="speaker")


@pytest.mark.parametrize("second", ["ai", "not-defined"])
def test_speech_resolves_visemes_in_its_expression_and_accumulates_explicit_time(tmp_path, manifest, second):
    files = {}
    add_portrait(manifest, files)
    add_entry(manifest, "sample", "portrait", "speech", {
        "textKey": "dialogue.hi", "language": "pt-BR", "sampleText": "A!", "expressionRevisionId": "speaker-calm",
        "timeline": [
            {"visemeId": "rest", "durationMs": 35, "textPosition": 0},
            {"visemeId": second, "durationMs": 80, "textPosition": 0},
            {"visemeId": "rest", "durationMs": 55, "textPosition": 2},
        ],
    }, expression="speaker-calm")
    if second == "not-defined":
        assert_rejected(tmp_path, package_zip(tmp_path / "p.zip", manifest, files),
                        "sample: viseme not-defined ausente na expressão speaker-calm")
        return

    out, by_id = read_entries(tmp_path, manifest, files)
    assert by_id["speaker"]["character"] == "warrior-base-v1" and by_id["speaker"]["faceAnchor"] == [0, 0]
    assert by_id["speaker-calm"]["visemes"] == ["rest", "ai"]
    result = by_id["sample"]
    assert result["language"] == "pt-BR" and result["text"] == "A!" and result["totalMs"] == 170
    start, syllable, end = result["sequence"]
    assert [(v["startMs"], v["durationMs"], v["textPosition"]) for v in result["sequence"]] == [
        (0, 35, 0), (35, 80, 0), (115, 55, 2),
    ]
    assert start["file"] == end["file"] != syllable["file"]
    with Image.open(out / syllable["file"]) as frame:
        assert frame.getpixel((0, 0)) == RED


def test_bitmap_text_normalizes_accents_and_resets_kerning_on_new_lines(tmp_path):
    path = tmp_path / "glyphs.png"
    pixel_row(RED, GREEN).save(path)
    images = Images({"letters": {"abs": path}})
    font = {
        "glyphs": [
            {**region("letters", 0, 0, 1, 1), "codepoint": ord("Á"), "bearingX": 1, "bearingY": -2, "advanceX": 4},
            {**region("letters", 1, 0, 1, 1), "codepoint": ord("V"), "bearingX": 0, "bearingY": -2, "advanceX": 3},
        ],
        "kerning": [{"left": ord("Á"), "right": ord("V"), "amount": -1}],
        "metrics": {"spaceAdvance": 2, "lineHeight": 4, "ascent": 2},
    }
    canvas, info = render_text(images, font, "A\u0301V ?\nA\u0301")
    assert info == {"width": 12, "lines": 2, "missing": [{"char": "?", "position": 3}]}
    assert canvas.size == (12, 8)
    assert canvas.getpixel((1, 0)) == canvas.getpixel((1, 4)) == RED
    assert canvas.getpixel((3, 0)) == GREEN
    assert canvas.getpixel((8, 1)) == canvas.getpixel((10, 1)) == (255, 0, 80, 255)
    assert canvas.getpixel((9, 1)) == TRANSPARENT


@pytest.mark.parametrize(("axis", "direction", "value", "expected"), [
    ("vertical", "forward", 50, [2, 7, 8, 3]),
    ("vertical", "reverse", 50, [2, 4, 8, 3]),
    ("horizontal", "reverse", 49, [7, 4, 3, 6]),
    ("vertical", "forward", -10, [2, 10, 8, 0]),
    ("vertical", "forward", 110, [2, 4, 8, 6]),
])
def test_meter_fill_rounds_down_clamps_and_respects_direction(axis, direction, value, expected):
    assert meter_fill(value, {"min": 0, "max": 100}, [2, 4, 8, 6], axis, direction) == expected


def test_vertical_meter_composites_the_frame_over_the_visible_fill(tmp_path):
    path = tmp_path / "meter.png"
    atlas = Image.new("RGBA", (3, 4))
    atlas.paste(BLUE, (0, 0, 1, 4))
    atlas.paste(GREEN, (1, 0, 2, 3))
    atlas.putpixel((2, 3), RED)
    atlas.save(path)
    images = Images({"vertical": {"abs": path}})
    meter = {
        "logicalSize": [1, 4], "axis": "vertical", "direction": "forward", "range": {"min": 0, "max": 8},
        "usefulRect": [0, 0, 1, 4], "track": region("vertical", 0, 0, 1, 4),
        "fill": {**region("vertical", 1, 0, 1, 3), "offset": [0, 0]},
        "frame": region("vertical", 2, 0, 1, 4),
    }
    image, visible = render_meter(images, meter, 4)
    assert visible == 1
    assert list(image.get_flattened_data()) == [BLUE, BLUE, GREEN, RED]


def screen_instance(instance_id, component, order, rect, *, parent="root", anchors=(0, 0, 0, 0),
                    hidden=False, **overrides):
    x, y, width, height = rect
    sides = ("left", "top", "right", "bottom")
    return {
        "instanceId": instance_id, "componentRevisionId": component, "parentId": parent, "order": order,
        "anchors": dict(zip(sides, anchors, strict=True)),
        "offsets": dict(zip(sides, (x, y, x + width, y + height), strict=True)),
        "hidden": hidden, "overrides": overrides,
    }


def test_screen_layout_scales_nine_slice_and_resolves_menu_slot_and_portrait_art(tmp_path, manifest):
    files = {}
    art = Image.new("RGBA", (11, 3), BLUE)
    art.paste(pixel_row(RED, GREEN, GOLD), (0, 0))
    art.paste(GREEN, (2, 1, 3, 3))
    art.paste(GOLD, (6, 0, 9, 3))
    art.putpixel((9, 0), RED)
    add_png(manifest, files, "hud-art", art)
    add_portrait(manifest, files)
    insets = {"left": 1, "top": 1, "right": 1, "bottom": 0}
    panel = {
        "logicalSize": [3, 3], "image": region("hud-art", 0, 0, 3, 3), "nineSlice": insets,
        "contentPadding": insets, "minSize": [3, 3], "stretch": {"center": "stretch", "edges": "stretch"},
    }
    add_entry(manifest, "window", "ui", "panel", panel)
    add_entry(manifest, "skin-template", "ui", "template", {
        "logicalSize": [3, 3], "image": panel["image"], "flattened": True, "proposals": [],
        "cells": [{"localId": "panel", "componentId": "panel", "componentType": "panel", "meterPart": None,
                   "cell": [0, 0, 3, 3], "requiredStates": ["normal"]}],
    })
    add_entry(manifest, "satchel", "ui", "slot", {
        "logicalSize": [3, 3], "nineSlice": None, "iconRect": [0, 0, 3, 3], "counterAnchor": [2, 2],
        "counterAlign": "end", "complete": True, "requiredStates": ["empty", "occupied"],
        "states": [
            {**region("hud-art", 3, 0, 3, 3), "state": "empty", "origin": {"kind": "imported"}},
            {**region("hud-art", 6, 0, 3, 3), "state": "occupied"},
        ],
    })
    add_entry(manifest, "ruby", "item", "consumable", {
        "itemKey": "ruby", "representations": [{
            **region("hud-art", 9, 0, 1, 1), "role": "icon", "state": "default",
            "logicalSize": [1, 1], "sourceOffset": [0, 0], "pivot": [0, 0],
        }],
    })
    button = entry(manifest, "button-metal-v1")["payload"]
    add_entry(manifest, "tiny-button", "ui", "button", {
        **button, "logicalSize": [1, 1], "focus": None, "interactiveRect": None, "nineSlice": None,
        "contentPadding": dict.fromkeys(insets, 0), "complete": False,
        "states": [{**region("hud-art", 9, 0, 1, 1), "state": "hover"}],
    }, font="mini-font-v1")
    add_entry(manifest, "use-menu", "ui", "menu_item", {
        "buttonRevisionId": "tiny-button", "iconRevisionId": None, "actionId": "use",
        "text": button["text"], "shortcut": "U", "selectable": True,
    }, button="tiny-button")
    add_entry(manifest, "hud-backdrop", "map", "scene_layer", {
        **region("hud-art", 10, 0, 1, 3), "logicalSize": [1, 3], "depth": "sky", "obtained": "imported",
        "repeat": {"x": False, "y": False}, "requestedRepeat": {"x": False, "y": False},
        "continuity": {"x": None, "y": None}, "derivation": None, "groundLineY": None,
    })
    add_entry(manifest, "ui-gallery", "ui", "screen", {
        "referenceResolution": [16, 10], "testedResolutions": [[16, 10], [24, 10]],
        "background": {"revisionId": "hud-backdrop", "exported": True},
        "textCatalog": {"languages": ["pt-BR"], "entries": [{"key": "inventory.use", "text": {"pt-BR": "Usar"}}]},
        "focusOrder": ["menu"],
        "instances": [
            screen_instance("root", None, 0, (0, 0, 0, 0), parent=None, anchors=(0, 0, 1, 1)),
            screen_instance("window", "window", 0, (1, 0, 6, 4)),
            screen_instance("slot-full", "satchel", 1, (1, 5, 3, 3), iconRevisionId="ruby"),
            screen_instance("slot-empty", "satchel", 2, (5, 5, 3, 3)),
            screen_instance("hero", "warrior-base-v1", 3, (7, 9, 1, 1)),
            screen_instance("speaker", "speaker", 4, (9, 5, 1, 1)),
            screen_instance("expression", "speaker-calm", 5, (10, 5, 1, 1)),
            screen_instance("menu", "use-menu", 6, (-2, 0, 2, 2), anchors=(1, 0, 1, 0), textKey="inventory.use"),
            screen_instance("hidden-group", None, 7, (1, 8, 1, 1), hidden=True),
            screen_instance("hidden-icon", "ruby", 0, (0, 0, 1, 1), parent="hidden-group"),
        ],
    }, panel="window", slot="satchel", icon="ruby", character="warrior-base-v1", portrait="speaker",
        expression="speaker-calm", menu="use-menu", background="hud-backdrop")

    out, by_id = read_entries(tmp_path, manifest, files)
    panel = by_id["window"]
    with Image.open(out / panel["grown"]) as enlarged:
        assert enlarged.size == (9, 6)
        assert list(enlarged.crop((0, 0, 9, 1)).get_flattened_data()) == [RED, *([GREEN] * 7), GOLD]
    slot = by_id["satchel"]
    assert slot["origins"] == {"empty": "imported", "occupied": None} and slot["counterAnchor"] == [2, 2]
    assert by_id["use-menu"]["button"] == "tiny-button" and by_id["use-menu"]["shortcut"] == "U"
    assert by_id["skin-template"]["kind"] == "template"
    gallery = by_id["ui-gallery"]
    assert gallery["states"] == {"slot-full": "occupied", "slot-empty": "empty", "menu": "hover"}
    assert gallery["languages"] == ["pt-BR"] and gallery["textKeys"] == ["inventory.use"]
    assert gallery["focusOrder"] == ["menu"]
    assert gallery["layouts"]["16x10"]["menu"] == [14, 0, 2, 2]
    assert gallery["layouts"]["24x10"]["menu"] == [22, 0, 2, 2]
    assert gallery["layouts"]["24x10"]["hidden-icon"] == [1, 8, 1, 1]
    with Image.open(out / gallery["files"]["24x10"]) as image:
        assert image.getpixel((0, 0)) == BLUE  # exported background
        assert image.getpixel((1, 0)) == RED and image.getpixel((6, 0)) == GOLD  # nine-slice corners
        assert image.getpixel((2, 6)) == RED and image.getpixel((3, 6)) == GOLD  # centered icon
        assert image.getpixel((6, 6)) == BLUE  # empty slot
        assert image.getpixel((9, 5)) == BLUE and image.getpixel((10, 5)) == TRANSPARENT  # portrait only
        assert image.getpixel((22, 0)) == RED and image.getpixel((23, 0)) == TRANSPARENT  # unstretched button
        assert image.getpixel((1, 8)) == TRANSPARENT  # hidden ancestor


def test_screen_keeps_art_when_background_revision_has_no_drawable_region(tmp_path, manifest):
    # This reference can arrive in a package from outside Studio: the
    # character stores directional views, not a single background image.
    screen = entry(manifest, "hud-v1")
    backdrop = {"revisionId": "warrior-base-v1", "exported": True}
    screen["payload"]["background"] = backdrop
    screen["dependencies"].append({"role": "background", "revisionId": backdrop["revisionId"]})

    out, by_id = read_entries(tmp_path, manifest)
    hud = by_id["hud-v1"]
    assert hud["background"] == backdrop
    icon = next(r for r in by_id["potion-v1"]["representations"] if r["role"] == "icon")
    with (
        Image.open(out / hud["files"]["320x180"]) as image,
        Image.open(out / icon["file"]) as sprite,
    ):
        assert image.getpixel((0, 0)) == TRANSPARENT
        assert image.crop((256, 156, 272, 172)).tobytes() == sprite.tobytes()
