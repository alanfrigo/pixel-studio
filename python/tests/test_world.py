"""Cartão T1 (plan/06): emendas, 16 máscaras, tabela lateral e losangos, pelo protocolo real."""

from __future__ import annotations

import random

from PIL import Image

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
    assert any("transparência" in w for w in res2["warnings"]) and any("chapado" in w for w in res2["warnings"])


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
        {"layout": "corner", "cellSize": [SIZE, SIZE], "tiles": tiles, "threshold": 1.6, "lockedBandPx": 4, "sample": {"size": [1, 1], "cells": ["t0"]}, "zoom": 1},
        [("source", png(broken)), ("layer", png(atlas))],
    )
    report = seams["report"]
    assert seams["status"] == "needs_review"
    assert report["missingMasks"] == [9]
    assert any(f["axis"] == "x" and f["a"] == "t0" for f in report["flagged"])
    assert not report["locked"]["passed"]
    assert next(t for t in report["locked"]["tiles"] if t["key"] == "t0")["bandDiffPixels"] == SIZE


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
    assert any("inner_corner_right" in w for w in seams["warnings"])


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
