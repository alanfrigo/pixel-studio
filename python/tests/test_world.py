"""Cartão T1 (plan/06): emendas, 16 máscaras, tabela lateral e losangos, pelo protocolo real."""

from __future__ import annotations

from hashlib import sha256
import random

import pytest
from PIL import Image

from pixel_pipeline import world
from pixel_pipeline.protocol import PipelineError

from test_operations import Pipeline, png

SIZE = 32


def torus_texture(seed: int, base: tuple[int, int, int], spread: int = 40, size: int = SIZE) -> Image.Image:
    """Textura natural repetível: ruído borrado com volta (toro), sem emenda por construção."""
    rng = random.Random(seed)
    raw = [[rng.randint(-spread, spread) for _ in range(size)] for _ in range(size)]
    img = Image.new("RGBA", (size, size))
    for y in range(size):
        for x in range(size):
            acc = sum(raw[(y + dy) % size][(x + dx) % size] for dx in (-1, 0, 1) for dy in (-1, 0, 1)) // 9
            img.putpixel((x, y), (max(0, min(255, base[0] + acc)), max(0, min(255, base[1] + acc)), max(0, min(255, base[2] + acc)), 255))
    return img


def broken_border(img: Image.Image) -> Image.Image:
    """Amostra com borda discrepante deliberada: a coluna direita escurece."""
    out = img.copy()
    for y in range(out.height):
        r, g, b, a = out.getpixel((out.width - 1, y))
        out.putpixel((out.width - 1, y), (r // 4, g // 4, b // 4, a))
    return out


def test_textura_repetivel_passa_e_borda_discrepante_e_destacada(tmp_path):
    p = Pipeline(tmp_path)
    stone = torus_texture(1, (120, 116, 124))
    ok = p.run("texture_seams", {"axes": {"x": True, "y": True}, "threshold": 1.5, "zoom": 4}, [("source", png(stone))])
    assert ok["status"] == "ok"
    assert ok["report"]["x"]["passed"] and ok["report"]["y"]["passed"]
    assert ok["report"]["passedAxes"] == ["x", "y"]
    assert Pipeline.image(ok, "mosaic").size == (96, 96)
    assert Pipeline.image(ok, "mosaic_lines").size == (384, 384)
    shifted = Pipeline.image(ok, "shifted")
    assert shifted.getpixel((16, 16)) == stone.getpixel((0, 0))  # emendas no centro

    bad = p.run("texture_seams", {"axes": {"x": True, "y": True}, "threshold": 1.5, "zoom": 4}, [("source", png(broken_border(stone)))])
    assert bad["status"] == "needs_review"
    assert not bad["report"]["x"]["passed"] and bad["report"]["y"]["passed"]
    assert bad["report"]["x"]["flagged"] == [{"start": 0, "end": 31, "maxDelta": bad["report"]["x"]["flagged"][0]["maxDelta"]}]
    assert bad["report"]["passedAxes"] == ["y"]
    # Destaque magenta na emenda vertical do mosaico ampliado.
    assert Pipeline.image(bad, "mosaic_lines").getpixel((32 * 4 - 1, 10)) == (255, 0, 200, 255)


def test_degrade_de_luz_e_material_transparente_nao_passam(tmp_path):
    p = Pipeline(tmp_path)
    base = torus_texture(9, (100, 100, 100), spread=20)
    gradient = base.copy()
    for y in range(SIZE):
        for x in range(SIZE):
            r, g, b, a = gradient.getpixel((x, y))
            gradient.putpixel((x, y), (min(255, r + x * 2), min(255, g + x * 2), min(255, b + x * 2), a))
    res = p.run("texture_seams", {"axes": {"x": True, "y": True}, "threshold": 1.5, "zoom": 2}, [("source", png(gradient))])
    # Degradê de luz da esquerda para a direita: a média da coluna salta na emenda X, mesmo com ruído.
    assert not res["report"]["x"]["passed"] and not res["report"]["x"]["profilePassed"]
    assert res["report"]["y"]["passed"]
    clear = Image.new("RGBA", (SIZE, SIZE), (197, 235, 1, 0))
    res2 = p.run("texture_seams", {"axes": {"x": True, "y": True}, "threshold": 1.5, "zoom": 2}, [("source", png(clear))])
    assert not res2["report"]["x"]["passed"] and not res2["report"]["y"]["passed"]
    assert any("transparência" in w["pt-BR"] for w in res2["warnings"]) and any("chapado" in w["pt-BR"] for w in res2["warnings"])


def test_um_eixo_nao_promete_o_outro(tmp_path):
    p = Pipeline(tmp_path)
    res = p.run("texture_seams", {"axes": {"x": True, "y": False}, "threshold": 1.5, "zoom": 2}, [("source", png(torus_texture(2, (90, 150, 60))))])
    assert res["report"]["y"] is None and res["report"]["mosaicGrid"] == [3, 1]
    assert Pipeline.image(res, "mosaic").size == (96, 32)


def corner_atlas(p: Pipeline) -> tuple[dict, Image.Image]:
    grass, water = torus_texture(3, (80, 150, 60)), torus_texture(4, (50, 100, 200))
    res = p.run(
        "corner_guides",
        {"cellSize": [SIZE, SIZE], "diagonals": {"mask5": "separate", "mask10": "connected"}, "bandPx": 4, "seed": 7},
        [("layer", png(grass)), ("layer", png(water))],
    )
    return res, Pipeline.image(res, "atlas")


def corner_tiles(res: dict) -> list[dict]:
    return [{"key": f"t{t['mask']}", "mask": t["mask"], "rect": t["rect"]} for t in res["report"]["tiles"]]


def test_gabaritos_por_cantos_cobrem_16_mascaras_e_encaixam_em_todos_os_pares(tmp_path):
    p = Pipeline(tmp_path)
    res, atlas = corner_atlas(p)
    assert res["status"] == "ok" and res["report"]["cornerAgreement"]
    assert atlas.size == (128, 128)
    tiles = res["report"]["tiles"]
    assert [t["mask"] for t in tiles] == list(range(16))
    assert tiles[0]["bPixels"] == 0 and tiles[15]["bPixels"] == SIZE * SIZE
    # Diagonais ambíguas seguem a decisão registrada: 10 conectada (água no centro), 5 separada (grama no centro).
    terrain = Pipeline.image(res, "terrain")
    assert terrain.getpixel((2 * SIZE + 16, 2 * SIZE + 16)) == (60, 110, 220, 255)
    assert terrain.getpixel((1 * SIZE + 16, 1 * SIZE + 16)) == (90, 170, 70, 255)
    # Lago 4×3 com ilha: chave por célula.
    sample = ["t4", "t12", "t8", "t0", "t6", "t15", "t9", "t0", "t2", "t3", "t1", "t0"]
    seams = p.run(
        "tileset_seams",
        {"layout": "corner", "cellSize": [SIZE, SIZE], "tiles": corner_tiles(res), "threshold": 1.6, "lockedBandPx": 4, "sample": {"size": [4, 3], "cells": sample}, "zoom": 2},
        [("source", png(atlas)), ("layer", png(atlas))],
    )
    report = seams["report"]
    assert report["pairs"] == {"x": 64, "y": 64}
    assert report["flagged"] == [], report["worst"][:3]
    assert report["missingMasks"] == []
    assert report["locked"]["passed"]
    assert Pipeline.image(seams, "sample").size == (128, 96)


def test_tile_com_lado_quebrado_e_mascara_ausente_sao_apontados(tmp_path):
    p = Pipeline(tmp_path)
    res, atlas = corner_atlas(p)
    broken = atlas.copy()
    for y in range(SIZE):  # borda direita do tile 0 (grama pura) vira faixa escura
        broken.putpixel((SIZE - 1, y), (10, 10, 10, 255))
    tiles = [t for t in corner_tiles(res) if t["mask"] != 9]
    seams = p.run(
        "tileset_seams",
        {"layout": "corner", "cellSize": [SIZE, SIZE], "tiles": tiles, "threshold": 1.6, "lockedBandPx": 4, "sample": {"size": [2, 1], "cells": ["t0", "t0"]}, "zoom": 1},
        [("source", png(broken)), ("layer", png(atlas))],
    )
    report = seams["report"]
    assert seams["status"] == "needs_review"
    assert report["missingMasks"] == [9]
    assert any(f["axis"] == "x" and f["a"] == "t0" for f in report["flagged"])
    assert not report["locked"]["passed"]
    assert next(t for t in report["locked"]["tiles"] if t["key"] == "t0")["bandDiffPixels"] == SIZE
    assert Pipeline.image(seams, "sample_zoom").getpixel((SIZE, 5)) == (255, 0, 200, 255)


def test_tabela_lateral_propria_e_lacunas_visiveis(tmp_path):
    p = Pipeline(tmp_path)
    configs = ["surface_middle", "surface_left", "surface_right", "interior", "wall_left", "wall_right"]
    res = p.run(
        "side_guides",
        {"cellSize": [16, 16], "configurations": configs, "surfaceDepthPx": 4, "columns": 4},
        [("layer", png(torus_texture(5, (120, 90, 60), size=16))), ("layer", png(torus_texture(6, (70, 160, 60), size=16)))],
    )
    atlas = Pipeline.image(res, "atlas")
    assert atlas.size == (64, 32)
    surface_left = res["report"]["tiles"][1]
    assert surface_left["configuration"] == "surface_left" and surface_left["exposed"] == "TL"
    assert atlas.getpixel((16, 0))[3] == 0  # canto arredondado exposto é ar
    tiles = [{"key": t["configuration"], "configuration": t["configuration"], "rect": t["rect"]} for t in res["report"]["tiles"]]
    # Plataforma com degrau: o canto interno não existe no atlas → lacuna.
    cells = ["", "", "surface_left", "surface_right", "surface_left", "surface_middle", "!inner_corner_right", "wall_right"]
    seams = p.run(
        "tileset_seams",
        {"layout": "side", "cellSize": [16, 16], "tiles": tiles, "threshold": 2.5, "lockedBandPx": 0, "sample": {"size": [4, 2], "cells": cells}, "zoom": 2},
        [("source", png(atlas))],
    )
    assert seams["report"]["gaps"] == ["inner_corner_right"]
    assert seams["report"]["pairs"]["x"] >= 2
    assert any("inner_corner_right" in w["pt-BR"] and "inner_corner_right" in w["en"] for w in seams["warnings"])


def test_mascara_de_edicao_protege_faixa_e_ar(tmp_path):
    p = Pipeline(tmp_path)
    guide = Image.new("RGBA", (32, 16), (100, 100, 100, 255))
    for x in range(16, 32):
        for y in range(16):
            guide.putpixel((x, y), (0, 0, 0, 0))
    res = p.run("tile_edit_mask", {"regions": [{"rect": [0, 0, 16, 16], "bandPx": 3}, {"rect": [16, 0, 16, 16], "bandPx": 3}], "alphaEdgePx": 0}, [("source", png(guide))])
    mask = Pipeline.image(res, "edit_mask").convert("L")
    assert res["report"]["editedPixels"] == 10 * 10
    assert mask.getpixel((2, 8)) == 0 and mask.getpixel((8, 8)) == 255 and mask.getpixel((24, 8)) == 0


def tree(width: int = 48, height: int = 96) -> Image.Image:
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for y in range(height - 30, height - 4):
        for x in range(width // 2 - 3, width // 2 + 3):
            img.putpixel((x, y), (110, 70, 40, 255))
    for y in range(4, height - 30):
        for x in range(4, width - 4):
            if (x - width / 2) ** 2 / (width / 2 - 4) ** 2 + (y - (height - 30) / 2) ** 2 / ((height - 34) / 2) ** 2 <= 1:
                img.putpixel((x, y), (50, 130, 60, 255))
    return img


def test_quatro_losangos_e_prop_alto_conservam_o_apoio(tmp_path):
    p = Pipeline(tmp_path)
    prop = tree()
    pieces = p.run("iso_pieces", {"diamond": [64, 32], "blockHeightPx": 16}, [("layer", png(torus_texture(8, (90, 150, 60)))), ("layer", png(prop))])
    atlas = Pipeline.image(pieces, "atlas")
    geometry = {g["key"]: g for g in pieces["report"]["pieces"]}
    assert geometry["floor"]["rect"] == [0, 0, 64, 32] and geometry["block"]["rect"] == [64, 0, 64, 48]
    assert geometry["prop"]["visualBase"] == [24, 92]  # sugestão de apoio: base do tronco
    # Tronco termina 4 px acima da base da imagem: apoio no centro do tronco.
    support = [24, 92]
    prop_geom = {**{k: v for k, v in geometry["prop"].items() if k != "visualBase"}, "groundOrigin": [24, 76], "supportPoint": support, "footprintCells": [1, 1], "elevation": 0}
    recipe_pieces = [
        {**geometry["floor"]},
        {**geometry["block"]},
        prop_geom,
    ]
    patch = {"size": [2, 2], "cells": [{"key": "floor", "elevation": 0}] * 4, "props": [{"key": "prop", "cell": [1, 1]}], "probes": [[0, 0], [2, 2]]}
    res = p.run("iso_check", {"diamond": [64, 32], "elevationStepPx": 16, "pieces": recipe_pieces, "patch": patch, "zoom": 2}, [("source", png(atlas))])
    report = res["report"]
    assert res["status"] == "ok", res.get("warnings")
    assert report["floors"][0]["iou"] == 1.0
    assert report["patch"]["holes"] == 0 and report["patch"]["overlaps"] == 0
    assert report["props"][0]["ok"] and report["props"][0]["dy"] == 0
    assert report["placements"][0]["ok"]

    # Um PNG quadrado com prompt "isométrico" não basta: a peça de chão não cobre o losango.
    square = Image.new("RGBA", (64, 32), (90, 150, 60, 255))
    res2 = p.run(
        "iso_check",
        {"diamond": [64, 32], "elevationStepPx": 16, "pieces": [{**geometry["floor"]}], "patch": {"size": [2, 2], "cells": [{"key": "floor", "elevation": 0}] * 4, "props": [], "probes": []}, "zoom": 1},
        [("source", png(square))],
    )
    assert res2["status"] == "needs_review"
    assert not res2["report"]["floors"][0]["ok"] and res2["report"]["patch"]["overlaps"] > 0


@pytest.mark.parametrize(
    ("size", "axes", "code", "message"),
    [
        ((1, 4), {"x": True, "y": False}, "unsupported_input", "Texture must be at least 2×2 px"),
        ((4, 4), {"x": False, "y": False}, "invalid_request", "Specify at least one repeat axis"),
    ],
)
def test_texture_seams_requires_material_area_and_a_repeat_axis(tmp_path, size, axes, code, message):
    result = Pipeline(tmp_path).run("texture_seams", {"axes": axes, "threshold": 1.5, "zoom": 1},
                                    [("source", png(Image.new("RGBA", size)))])
    assert result["error"]["code"] == code
    assert result["error"]["message"]["en"] == message


def test_texture_seams_marks_horizontal_join_on_every_repeated_column(tmp_path):
    stone = broken_border(torus_texture(1, (120, 116, 124))).transpose(Image.Transpose.TRANSPOSE)
    result = Pipeline(tmp_path).run("texture_seams", {"axes": {"x": True, "y": True}, "threshold": 1.5, "zoom": 2},
                                    [("source", png(stone))])
    assert result["status"] == "needs_review"
    assert result["report"]["passedAxes"] == ["x"]
    assert [(run["start"], run["end"]) for run in result["report"]["y"]["flagged"]] == [(0, 31)]
    marked = Pipeline.image(result, "mosaic_lines")
    assert marked.getpixel((10, 63)) == (255, 0, 200, 255)
    assert marked.getpixel((138, 127)) == (255, 0, 200, 255)


def test_corner_guides_requires_both_materials_and_warns_about_texture_period(tmp_path):
    pipe = Pipeline(tmp_path)
    red, blue = (190, 30, 10, 255), (10, 120, 220, 255)
    inputs = [("layer", png(Image.new("RGBA", (2, 2), red))), ("layer", png(Image.new("RGBA", (8, 8), blue)))]
    recipe = {"cellSize": [8, 8], "diagonals": {"mask5": "connected", "mask10": "separate"}, "bandPx": 2, "seed": 5}
    missing = pipe.run("corner_guides", recipe, inputs[:1])
    assert missing["error"]["code"] == "invalid_request"
    assert missing["error"]["message"]["en"] == "Operation requires 2 input(s) with role 'layer'"
    band = pipe.run("corner_guides", {**recipe, "bandPx": 4}, inputs)
    assert band["error"]["code"] == "invalid_request"
    assert band["error"]["message"]["en"] == "4 px band too large for the 8×8 cell"
    result = pipe.run("corner_guides", recipe, inputs)
    assert result["status"] == "needs_review"
    assert [w["en"] for w in result["warnings"]] == [
        "Texture A is 2×2, the cell 8×8: continuity between tiles depends on the texture repeating at that period",
    ]
    atlas = Pipeline.image(result, "atlas")
    assert atlas.getpixel((7, 7)) == red
    assert atlas.getpixel((24, 24)) == blue


def test_corner_guides_refuses_an_atlas_if_a_generated_corner_disagrees(tmp_path, monkeypatch):
    inputs = []
    for i, color in enumerate(((140, 80, 30, 255), (25, 65, 120, 255))):
        path = tmp_path / f"layer-{i}.png"
        data = png(Image.new("RGBA", (8, 8), color))
        path.write_bytes(data)
        inputs.append({"role": "layer", "ordinal": i, "relPath": path.name, "sha256": sha256(data).hexdigest()})
    recipe = {
        "version": 1, "cellSize": [8, 8], "bandPx": 2, "seed": 5,
        "diagonals": {"mask5": "connected", "mask10": "separate"},
    }
    rasterize = world._corner_material

    def corrupt_first_corner(mask, x, y, *args):
        return 1 if (mask, x, y) == (0, 0, 0) else rasterize(mask, x, y, *args)

    monkeypatch.setattr(world, "_corner_material", corrupt_first_corner)
    with pytest.raises(PipelineError) as raised:
        world.corner_guides({"recipe": recipe, "inputs": inputs}, tmp_path)
    assert raised.value.code == "internal"
    assert raised.value.message["en"] == "The templates disagree on the corner pixel"
    assert not (tmp_path / "out").exists()


def test_side_guides_shade_ceiling_and_inner_corners_only_on_exposed_edges(tmp_path):
    pipe = Pipeline(tmp_path)
    inputs = [
        ("layer", png(Image.new("RGBA", (8, 8), (120, 80, 40, 255)))),
        ("layer", png(Image.new("RGBA", (8, 8), (180, 150, 80, 255)))),
    ]
    recipe = {"cellSize": [8, 8], "configurations": ["ceiling_middle", "inner_corner_left", "inner_corner_right"], "surfaceDepthPx": 2, "columns": 3}
    result = pipe.run("side_guides", recipe, inputs)
    atlas = Pipeline.image(result, "atlas")
    assert atlas.getpixel((4, 7)) == (60, 40, 20, 255)
    assert atlas.getpixel((4, 5)) == (120, 80, 40, 255)
    assert atlas.getpixel((8, 1)) == (66, 44, 22, 255)
    assert atlas.getpixel((8, 2)) == (120, 80, 40, 255)
    assert atlas.getpixel((23, 1)) == (66, 44, 22, 255)
    assert atlas.getpixel((23, 2)) == (120, 80, 40, 255)
    too_deep = pipe.run("side_guides", {**recipe, "surfaceDepthPx": 8}, inputs)
    assert too_deep["error"]["code"] == "invalid_request"
    assert too_deep["error"]["message"]["en"] == "Surface deeper than the cell"
    unknown = pipe.run("side_guides", {**recipe, "configurations": ["nonexistent"]}, inputs, validate_request=False)
    assert unknown["error"]["code"] == "invalid_request"
    assert unknown["error"]["message"]["en"] == "Unknown side configuration: nonexistent"


def tileset_recipe(w, h, tiles, cells, size=(1, 1), band=0):
    return {
        "layout": "side", "cellSize": [w, h], "tiles": tiles, "threshold": 1.5,
        "lockedBandPx": band, "sample": {"size": list(size), "cells": cells}, "zoom": 1,
    }


@pytest.mark.parametrize(
    ("rect", "cells", "guide", "code", "message"),
    [
        ([0, 0, 7, 8], ["a"], False, "geometry_mismatch", "Tile a does not have the cell size"),
        ([1, 0, 8, 8], ["a"], False, "geometry_mismatch", "Rectangle [1, 0, 8, 8] exceeds 8×8"),
        ([0, 0, 8, 8], [], False, "invalid_request", "Sample cell count differs from its size"),
        ([0, 0, 8, 8], ["a"], True, "geometry_mismatch", "Template and atlas have different sizes"),
    ],
)
def test_tileset_seams_rejects_inconsistent_atlas_sample_and_guide_geometry(tmp_path, rect, cells, guide, code, message):
    recipe = tileset_recipe(8, 8, [{"key": "a", "rect": rect}], cells, band=1)
    inputs = [("source", png(Image.new("RGBA", (8, 8))))]
    if guide:
        inputs.append(("layer", png(Image.new("RGBA", (7, 8)))))
    result = Pipeline(tmp_path).run("tileset_seams", recipe, inputs)
    assert result["error"]["code"] == code
    assert result["error"]["message"]["en"] == message


def test_tileset_seams_highlights_bad_vertical_pair_in_sample_and_pair_sheet(tmp_path):
    atlas = Image.new("RGBA", (12, 6), (20, 20, 20, 255))
    atlas.paste((100, 100, 100, 255), (6, 0, 12, 6))
    tiles = [{"key": "a", "rect": [0, 0, 6, 6]}, {"key": "b", "rect": [6, 0, 6, 6]}]
    recipe = tileset_recipe(6, 6, tiles, ["a", "b"], size=(1, 2))
    result = Pipeline(tmp_path).run("tileset_seams", recipe, [("source", png(atlas))])
    assert result["report"]["flagged"] == [{"axis": "y", "a": "a", "b": "b", "interiorDelta": 1, "seamDelta": 60, "ratio": 60}]
    assert result["report"]["edgeLines"]["maxRatio"] == 0
    for role in ("sample_zoom", "pairs"):
        assert Pipeline.image(result, role).getpixel((2, 5)) == (255, 0, 200, 255)
    assert Pipeline.image(result, "sample").getpixel((2, 6)) == (100, 100, 100, 255)


def test_tileset_seams_diagnoses_visible_frame_even_when_locked_band_matches(tmp_path):
    guide = Image.new("RGBA", (12, 12), (20, 20, 20, 255))
    atlas = guide.copy()
    atlas.paste((100, 100, 100, 255), (2, 2, 10, 10))
    recipe = tileset_recipe(12, 12, [{"key": "a", "rect": [0, 0, 12, 12]}], ["a"], band=2)
    result = Pipeline(tmp_path).run("tileset_seams", recipe, [("source", png(atlas)), ("layer", png(guide))])
    assert result["status"] == "needs_review"
    assert result["report"]["pairs"] == {"x": 0, "y": 0}
    assert result["report"]["locked"] == {
        "bandPx": 2, "passed": True, "tiles": [{"key": "a", "bandDiffPixels": 0, "frameRatio": 30}],
        "frameFlagged": ["a"], "maxFrameRatio": 30,
    }
    assert result["warnings"][0]["en"].startswith("Visible border on 1 tile(s):")
    assert [o["role"] for o in result["outputs"]] == ["sample", "sample_zoom"]


def test_tile_edit_mask_expands_transparent_hole_and_rejects_uneditable_and_overflowing_regions(tmp_path):
    pipe = Pipeline(tmp_path)
    guide = Image.new("RGBA", (8, 8), (80, 120, 140, 255))
    guide.putpixel((4, 4), (80, 120, 140, 0))
    inputs = [("source", png(guide))]
    recipe = {"regions": [{"rect": [0, 0, 8, 8], "bandPx": 1}], "alphaEdgePx": 1}
    result = pipe.run("tile_edit_mask", recipe, inputs)
    mask = pipe.image(result, "edit_mask").convert("L")
    assert result["report"] == {"editedPixels": 27, "protectedPixels": 37, "size": [8, 8]}
    assert mask.crop((3, 3, 6, 6)).getbbox() is None
    assert mask.getpixel((2, 4)) == 255
    assert mask.getpixel((0, 4)) == 0

    everything_locked = pipe.run("tile_edit_mask", {**recipe, "regions": [{"rect": [0, 0, 8, 8], "bandPx": 4}]}, inputs)
    assert everything_locked["error"]["code"] == "invalid_request"
    assert everything_locked["error"]["message"]["en"] == "No editable pixel: the locked band covers the whole regions"
    out_of_bounds = pipe.run("tile_edit_mask", {**recipe, "regions": [{"rect": [1, 0, 8, 8], "bandPx": 1}]}, inputs)
    assert out_of_bounds["error"]["code"] == "geometry_mismatch"
    assert out_of_bounds["error"]["message"]["en"] == "Region outside the template"


def test_iso_pieces_without_prop_and_with_transparent_prop(tmp_path):
    pipe = Pipeline(tmp_path)
    texture = png(Image.new("RGBA", (4, 4), (80, 110, 140, 255)))
    recipe = {"diamond": [16, 8], "blockHeightPx": 0}
    result = pipe.run("iso_pieces", recipe, [("layer", texture)])
    assert [piece["key"] for piece in result["report"]["pieces"]] == ["floor", "block"]
    atlas = pipe.image(result, "atlas")
    assert atlas.size == (32, 8)
    assert atlas.crop((0, 0, 16, 8)).tobytes() == atlas.crop((16, 0, 32, 8)).tobytes()
    assert atlas.getpixel((7, 3)) == (80, 110, 140, 255)
    assert atlas.getpixel((0, 0)) == (0, 0, 0, 0)

    prop = png(Image.new("RGBA", (3, 4)))
    transparent = pipe.run("iso_pieces", recipe, [("layer", texture), ("layer", prop)])
    assert transparent["report"]["pieces"][2] == {"key": "prop", "kind": "prop", "rect": [32, 0, 3, 4], "visualBase": None}
    odd = pipe.run("iso_pieces", {**recipe, "diamond": [15, 8]}, [("layer", texture)])
    assert odd["error"]["code"] == "invalid_request"
    assert odd["error"]["message"]["en"] == "Diamond must have even width and height"


def test_iso_check_reports_floor_hole_and_empty_prop_with_unoccupied_cell(tmp_path):
    pipe = Pipeline(tmp_path)
    texture = png(Image.new("RGBA", (4, 4), (80, 110, 140, 255)))
    result = pipe.run("iso_pieces", {"diamond": [16, 8], "blockHeightPx": 0}, [
        ("layer", texture), ("layer", png(Image.new("RGBA", (3, 4)))),
    ])
    atlas = pipe.image(result, "atlas")
    atlas.putpixel((7, 3), (0, 0, 0, 0))
    floor = result["report"]["pieces"][0]
    prop = {"key": "prop", "kind": "prop", "rect": [32, 0, 3, 4], "groundOrigin": [1, 0],
            "supportPoint": [1, 4], "footprintCells": [1, 1], "elevation": 0}
    patch = {"size": [2, 1], "cells": [{"key": "floor", "elevation": 0}, {"key": None, "elevation": 0}],
             "props": [], "probes": []}
    recipe = {"diamond": [16, 8], "elevationStepPx": 0, "pieces": [floor, prop], "patch": patch, "zoom": 1}
    inputs = [("source", png(atlas))]
    check = pipe.run("iso_check", recipe, inputs)
    assert check["report"]["floors"][0]["missingPixels"] == 1
    assert check["report"]["patch"]["holes"] == 1
    assert check["report"]["patch"]["overlaps"] == 0
    assert check["report"]["props"][0]["ok"] is False
    assert check["report"]["props"][0]["reason"]["en"] == "prop has no visible pixels"
    assert check["warnings"][-1]["en"] == "Patch with 1 hole(s) and 0 overlap(s) between diamonds"
    assert pipe.image(check, "patch").getpixel((9, 5))[3] == 0

    incorrect_count = pipe.run("iso_check", {**recipe, "patch": {**patch, "size": [3, 1]}}, inputs)
    assert incorrect_count["error"]["code"] == "invalid_request"
    assert incorrect_count["error"]["message"]["en"] == "Patch cell count differs from its size"


def test_iso_check_reports_actual_rasterized_support_with_fractional_cell_center(tmp_path):
    atlas = Image.new("RGBA", (3, 4), (123, 66, 177, 255))
    result = Pipeline(tmp_path).run("iso_check", {
        "diamond": [18, 10], "elevationStepPx": 0, "zoom": 1,
        "pieces": [{"key": "wide-prop", "kind": "prop", "rect": [0, 0, 3, 4],
                    "groundOrigin": [1, 0], "supportPoint": [1, 3], "footprintCells": [2, 1], "elevation": 0}],
        "patch": {"size": [1, 1], "cells": [{"key": None, "elevation": 0}],
                  "props": [{"key": "wide-prop", "cell": [0, 0]}], "probes": []},
    }, [("source", png(atlas))])
    assert Pipeline.image(result, "patch").getbbox() == (2, 2, 5, 6)
    placement = result["report"]["placements"][0]
    assert placement["supportScreen"] == [3, 5]
    assert placement["cellCenter"] == [3.5, 5.5]
    assert placement["ok"] is False
    assert [warning["en"] for warning in result["warnings"]] == ["Prop support point off the cell center"]
