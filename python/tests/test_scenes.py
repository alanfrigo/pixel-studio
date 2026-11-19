"""Cartão T2 (plan/06): planos de paralaxe, câmera, guia da planta e recorte de móveis, pelo protocolo real."""

from __future__ import annotations

import pytest
from PIL import Image

from test_operations import Pipeline, png
from test_world import broken_border, torus_texture


def layer_band(width: int, height: int, top: int, color: tuple[int, int, int]) -> Image.Image:
    """Plano com transparência em cima e faixa opaca contínua (morros/chão) repetível em x."""
    tex = torus_texture(3, color, 20, size=width)
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for y in range(top, height):
        for x in range(width):
            img.putpixel((x, y), tex.getpixel((x, y % width)))
    return img


def test_plano_repetivel_passa_e_borda_discrepante_e_reprovada(tmp_path):
    p = Pipeline(tmp_path)
    ground = layer_band(32, 32, 20, (90, 140, 60))
    ok = p.run("scene_layer_check", {"axes": {"x": True, "y": False}, "threshold": 1.5, "groundLineY": 20, "zoom": 2}, [("source", png(ground))])
    assert ok["status"] == "ok", ok.get("warnings")
    assert ok["report"]["x"]["passed"] and ok["report"]["y"] is None
    assert ok["report"]["ground"] == {"y": 20, "gaps": 0, "firstGap": None, "continuous": True}
    assert p.image(ok, "mosaic").size == (96, 32)

    bad = p.run("scene_layer_check", {"axes": {"x": True, "y": False}, "threshold": 1.5, "groundLineY": None, "zoom": 2}, [("source", png(broken_border(torus_texture(5, (120, 120, 130)))))])
    assert bad["status"] == "needs_review"
    assert bad["report"]["x"]["passed"] is False


def test_camera_rola_duas_larguras_sem_buraco_e_chao_continuo(tmp_path):
    p = Pipeline(tmp_path)
    sky = Image.new("RGBA", (64, 48), (120, 150, 210, 255))
    for x in range(64):
        sky.putpixel((x, 5), (200, 210, 230, 255))
    hills = layer_band(32, 48, 24, (70, 110, 60))
    ground = layer_band(32, 48, 38, (110, 80, 50))
    layers = [
        {"inputOrdinal": 0, "offset": [0, 0], "parallax": {"x": 0.25, "y": 0}, "repeat": {"x": True, "y": False}},
        {"inputOrdinal": 1, "offset": [0, 0], "parallax": {"x": 0.5, "y": 0}, "repeat": {"x": True, "y": False}},
        {"inputOrdinal": 2, "offset": [0, 0], "parallax": {"x": 1, "y": 0}, "repeat": {"x": True, "y": False}},
    ]
    span = 2 * 64 * 4  # o céu (fator 0,25) percorre duas larguras próprias
    res = p.run(
        "scene_compose",
        {"canvas": [80, 48], "layers": layers, "spanPx": span, "steps": 8, "groundLineY": 40, "zoom": 1},
        [("layer", png(sky)), ("layer", png(hills)), ("layer", png(ground))],
    )
    assert res["status"] == "ok", res.get("warnings")
    r = res["report"]
    assert r["uncoveredFrames"] == 0 and r["groundContinuous"] is True
    assert [f["camera"] for f in r["frames"]][-1] == span
    img = p.image(res, "image")
    assert img.size == (80, 48) and img.getpixel((70, 45))[3] == 255
    # Repetido em x: com a câmera em uma largura/fator, o plano volta ao mesmo lugar (loop).
    strip = p.image(res, "strip")
    assert strip.size == (80, 9 * 50)

    # Plano sem repetição que sai da tela deixa buraco: o teste aponta.
    gap = [dict(layers[0], repeat={"x": False, "y": False})]
    res2 = p.run("scene_compose", {"canvas": [80, 48], "layers": gap, "spanPx": 128, "steps": 4, "groundLineY": None, "zoom": 1}, [("layer", png(sky))])
    assert res2["status"] == "needs_review" and res2["report"]["uncoveredFrames"] > 0


def test_personagem_em_escala_nos_pontos_de_apoio(tmp_path):
    p = Pipeline(tmp_path)
    scene = Image.new("RGBA", (64, 40), (100, 120, 90, 255))
    hero = Image.new("RGBA", (8, 12), (0, 0, 0, 0))
    for y in range(2, 12):
        for x in range(2, 6):
            hero.putpixel((x, y), (200, 40, 40, 255))
    res = p.run("scene_overlay", {"points": [[10, 30], [50, 36]], "character": {"logicalSize": [8, 12], "rect": [0, 0, 8, 12], "offset": [0, 0], "pivot": [4, 12]}, "zoom": 2}, [("source", png(scene)), ("layer", png(hero))])
    assert res["report"]["characterHeightPx"] == 10
    out = p.image(res, "overlay")
    assert out.getpixel((10, 29))[:3] == (200, 40, 40)  # pé logo acima do ponto de apoio
    assert out.getpixel((10, 30))[:3] == (100, 120, 90)
    assert p.image(res, "overlay_zoom").size == (128, 80)


def test_guia_da_planta_marca_piso_paredes_rocha_e_portas(tmp_path):
    p = Pipeline(tmp_path)
    cells = [True] * 42
    for c in range(4, 7):
        cells[c] = cells[7 + c] = False  # sala em L: rocha no canto superior direito
    colors = {"floor": "#c8c8c8", "wall": "#404040", "rock": "#ff00ff", "door": "#ffc800"}
    res = p.run(
        "room_guide",
        {"projection": "top_down", "pictureSize": [256, 256], "cellPx": [32, 32], "gridOrigin": [16, 48], "size": [7, 6], "cells": cells, "doors": [{"cell": [3, 5], "side": "S"}, {"cell": [0, 2], "side": "W"}], "colors": colors},
        [],
    )
    g = p.image(res, "guide").convert("RGBA")
    assert res["report"]["floorCells"] == 36
    assert g.getpixel((16 + 16, 48 + 16)) == (200, 200, 200, 255)  # piso (0,0)
    assert g.getpixel((16 + 5 * 32 + 16, 48 + 16)) == (255, 0, 255, 255)  # rocha (5,0)
    assert g.getpixel((16 + 16, 48 - 8)) == (64, 64, 64, 255)  # parede do fundo acima de (0,0)
    assert g.getpixel((16 + 3 * 32 + 16, 48 + 6 * 32 + 2)) == (255, 200, 0, 255)  # porta S embaixo de (3,5)
    iso = p.run(
        "room_guide",
        {"projection": "isometric", "pictureSize": [240, 168], "cellPx": [32, 16], "gridOrigin": [112, 56], "size": [7, 6], "cells": [True] * 42, "doors": [{"cell": [3, 0], "side": "N"}], "colors": colors},
        [],
    )
    assert p.image(iso, "guide").convert("RGBA").getpixel((112, 56 + 8)) == (200, 200, 200, 255)  # centro do losango (0,0)


def room_with_table() -> tuple[Image.Image, Image.Image, Image.Image]:
    """Sala 64×48: piso de madeira, mesa 16×10 apoiada em (30, 32), sombra embaixo e à direita."""
    room = torus_texture(7, (150, 110, 70), 15, size=64).crop((0, 0, 64, 48))
    for y in range(0, 4):
        for x in range(64):
            room.putpixel((x, y), (0, 0, 0, 0))  # rocha transparente em cima
    mask = Image.new("L", room.size, 0)
    shadow = Image.new("L", room.size, 0)
    for y in range(22, 32):
        for x in range(22, 38):
            room.putpixel((x, y), (90, 50, 30, 255))
            mask.putpixel((x, y), 255)
    for y in range(32, 35):
        for x in range(24, 41):
            shadow.putpixel((x, y), 255)
    return room, mask, shadow


def test_recorte_da_mesa_separa_sombra_e_aponta_reconstrucao(tmp_path):
    p = Pipeline(tmp_path)
    room, mask, shadow = room_with_table()
    res = p.run("room_cutout", {"dilatePx": 1, "contextRingPx": 2, "alphaThreshold": 128}, [("source", png(room)), ("editMask", png(mask)), ("removeMask", png(shadow))])
    r = res["report"]
    assert r["pieceRect"] == [22, 22, 16, 10]
    assert r["shadowRect"] == [24, 32, 17, 3] and r["shadowOffset"] == [2, 10]
    assert r["footY"] == 9 and r["suggestedSupport"] == [8, 10]
    assert r["needsReconstruction"] is True and r["contextOpaque"] == 1.0
    assert res["status"] == "needs_review" and "inpainting" in res["warnings"][0]["pt-BR"] and "inpainting" in res["warnings"][0]["en"]
    piece = p.image(res, "piece")
    assert piece.size == (16, 10) and piece.getpixel((0, 0)) == (90, 50, 30, 255)
    sh = p.image(res, "shadow")
    assert sh.size == (17, 3) and sh.getpixel((0, 0)) == (0, 0, 0, 96)
    area = p.image(res, "area_mask")
    assert area.mode == "L" and area.getpixel((21, 21)) == 255 and area.getpixel((10, 10)) == 0
    holed = p.image(res, "holed")
    assert holed.getpixel((30, 25))[3] == 0 and holed.getpixel((10, 10))[3] == 255

    # Peça sobre rocha transparente: não há o que reconstruir.
    rock = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    m = Image.new("L", (32, 32), 0)
    for y in range(10, 20):
        for x in range(10, 20):
            rock.putpixel((x, y), (200, 200, 200, 255))
            m.putpixel((x, y), 255)
    clean = p.run("room_cutout", {"dilatePx": 0, "contextRingPx": 2, "alphaThreshold": 128}, [("source", png(rock)), ("editMask", png(m))])
    assert clean["status"] == "ok" and clean["report"]["needsReconstruction"] is False and clean["report"]["shadowRect"] is None


def test_mascara_vazia_e_recusada(tmp_path):
    p = Pipeline(tmp_path)
    room, _, _ = room_with_table()
    res = p.run("room_cutout", {"dilatePx": 1, "contextRingPx": 2, "alphaThreshold": 128}, [("source", png(room)), ("editMask", png(Image.new("L", room.size, 0)))])
    assert res["status"] == "error" and res["error"]["code"] == "geometry_mismatch"


def test_sala_montada_desenha_sombra_e_movel_com_recorte(tmp_path):
    p = Pipeline(tmp_path)
    base = Image.new("RGBA", (40, 30), (150, 110, 70, 255))
    table = Image.new("RGBA", (10, 6), (90, 50, 30, 255))
    shadow = Image.new("RGBA", (10, 3), (0, 0, 0, 96))
    res = p.run(
        "room_compose",
        {"canvas": [40, 30], "items": [{"inputOrdinal": 2, "at": [6, 14]}, {"inputOrdinal": 1, "at": [5, 10]}, {"inputOrdinal": 1, "at": [36, 2]}], "zoom": 2},
        [("source", png(base)), ("layer", png(table)), ("layer", png(shadow))],
    )
    out = p.image(res, "room")
    assert out.getpixel((7, 11)) == (90, 50, 30, 255)
    assert out.getpixel((14, 15)) != (150, 110, 70, 255)  # sombra escurece o piso
    assert out.getpixel((39, 3)) == (90, 50, 30, 255)  # móvel na borda, recortado


def test_ajuste_da_cena_recorta_o_centro_sem_faixas(tmp_path):
    p = Pipeline(tmp_path)
    wide = Image.new("RGBA", (64, 32), (10, 10, 10, 255))
    for y in range(32):
        for x in range(16, 48):
            wide.putpixel((x, y), (200, 100, 50, 255))
    res = p.run("scene_fit", {"targetSize": [16, 16], "alphaThreshold": None}, [("source", png(wide))])
    assert res["report"]["cropRect"] == [16, 0, 32, 32] and res["report"]["method"] == "nearest_integer"
    out = p.image(res, "fitted")
    assert out.size == (16, 16) and out.getpixel((0, 0)) == (200, 100, 50, 255)
    assert res["status"] == "needs_review"  # outra proporção sempre pede revisão do enquadramento


def test_scene_layer_reports_ground_gap_and_draws_vertical_repeat_seams(tmp_path):
    pipe = Pipeline(tmp_path)
    layer = Image.new("RGBA", (4, 4), (80, 100, 120, 255))
    layer.putpixel((1, 1), (20, 30, 40, 0))
    recipe = {"axes": {"x": False, "y": True}, "threshold": 1.5, "groundLineY": 1, "zoom": 2}
    inputs = [("source", png(layer))]
    result = pipe.run("scene_layer_check", recipe, inputs)
    assert result["status"] == "needs_review"
    assert result["report"]["y"]["passed"] is True
    assert result["report"]["ground"] == {"y": 1, "gaps": 1, "firstGap": 1, "continuous": False}
    assert result["warnings"][0]["en"] == "Ground line (y=1) broken over 1 px"
    assert pipe.image(result, "mosaic").size == (4, 12)
    assert pipe.image(result, "mosaic").getpixel((1, 5))[3] == 0
    lines = pipe.image(result, "mosaic_lines")
    assert lines.getpixel((3, 2)) == (255, 200, 0, 255)
    assert lines.getpixel((3, 8)) == (0, 220, 255, 255)

    out_of_range = pipe.run("scene_layer_check", {**recipe, "groundLineY": 4}, inputs)
    assert out_of_range["error"]["code"] == "geometry_mismatch"
    assert out_of_range["error"]["message"]["en"] == "Ground line 4 outside the 4 px layer"


def test_scrolling_non_repeating_layer_leaves_precisely_measured_holes(tmp_path):
    pipe = Pipeline(tmp_path)
    layer = Image.new("RGBA", (4, 3), (80, 100, 120, 255))
    recipe = {
        "canvas": [4, 3], "spanPx": 8, "steps": 2, "groundLineY": 2, "zoom": 1,
        "layers": [{"inputOrdinal": 0, "offset": [0, 0], "parallax": {"x": 1, "y": 0}, "repeat": {"x": False, "y": False}}],
    }
    inputs = [("layer", png(layer))]
    result = pipe.run("scene_compose", recipe, inputs)
    assert result["status"] == "needs_review"
    assert result["report"]["frames"] == [
        {"camera": 0, "uncoveredPixels": 0, "groundGaps": 0},
        {"camera": 4, "uncoveredPixels": 12, "groundGaps": 4},
        {"camera": 8, "uncoveredPixels": 12, "groundGaps": 4},
    ]
    assert result["report"]["groundContinuous"] is False
    assert result["warnings"][1]["en"] == "The ground line breaks in some scroll frame"
    strip = pipe.image(result, "strip")
    assert strip.getpixel((0, 0)) == (80, 100, 120, 255)
    assert strip.getpixel((0, 5)) == (200, 200, 200, 255)

    bad_ground = pipe.run("scene_compose", {**recipe, "groundLineY": 3}, inputs)
    assert bad_ground["error"]["code"] == "geometry_mismatch"
    assert bad_ground["error"]["message"]["en"] == "Ground line 3 outside the 3 px scene"

    missing = pipe.run("scene_compose", {**recipe, "layers": [dict(recipe["layers"][0], inputOrdinal=2)]}, inputs)
    assert missing["error"]["code"] == "invalid_request"
    assert missing["error"]["message"]["en"] == "Layer 0 references missing input 2"


def test_overlay_requires_character_and_view_inside_its_sheet(tmp_path):
    pipe = Pipeline(tmp_path)
    scene = png(Image.new("RGBA", (8, 8)))
    hero = png(Image.new("RGBA", (4, 4)))
    recipe = {
        "points": [[4, 6]],
        "character": {"logicalSize": [4, 4], "rect": [2, 0, 4, 4], "offset": [0, 0], "pivot": [2, 4]},
        "zoom": 1,
    }
    missing = pipe.run("scene_overlay", recipe, [("source", scene)])
    assert missing["error"]["code"] == "invalid_request"
    assert missing["error"]["message"]["en"] == "Overlay requires the character as a 'layer' input"
    bad_view = pipe.run("scene_overlay", recipe, [("source", scene), ("layer", hero)])
    assert bad_view["error"]["code"] == "geometry_mismatch"
    assert bad_view["error"]["message"]["en"] == "View [2, 0, 4, 4] outside the 4×4 character file"


def test_room_guide_renders_north_and_east_doors_and_checks_cell_count(tmp_path):
    pipe = Pipeline(tmp_path)
    recipe = {
        "projection": "oblique", "pictureSize": [64, 64], "cellPx": [16, 16],
        "gridOrigin": [16, 16], "size": [1, 1], "cells": [True],
        "doors": [{"cell": [0, 0], "side": "N"}, {"cell": [0, 0], "side": "E"}],
        "colors": {"floor": "#c8c8c8", "wall": "#404040", "rock": "#ff00ff", "door": "#ffc800"},
    }
    result = pipe.run("room_guide", recipe, [])
    assert result["report"] == {"pictureSize": [64, 64], "floorCells": 1, "doors": 2, "projection": "oblique"}
    guide = pipe.image(result, "guide")
    assert guide.getpixel((23, 14)) == (255, 200, 0, 255)
    assert guide.getpixel((34, 23)) == (255, 200, 0, 255)
    assert guide.getpixel((22, 19)) == (200, 200, 200, 255)
    assert guide.getpixel((16, 14)) == (64, 64, 64, 255)
    error = pipe.run("room_guide", {**recipe, "size": [2, 1]}, [])
    assert error["error"]["code"] == "invalid_request"
    assert error["error"]["message"]["en"] == "Floor plan must have 2 cells"


def test_room_compose_reports_the_missing_item_ordinal(tmp_path):
    pipe = Pipeline(tmp_path)
    result = pipe.run("room_compose", {"canvas": [8, 8], "items": [{"inputOrdinal": 1, "at": [3, 4]}], "zoom": 1},
                      [("source", png(Image.new("RGBA", (8, 8))))])
    assert result["error"]["code"] == "invalid_request"
    assert result["error"]["message"]["en"] == "Item 0 references missing input 1"


def test_scene_fit_crops_tall_source_and_binarizes_native_grid_alpha(tmp_path):
    pipe = Pipeline(tmp_path)
    source = Image.new("RGBA", (2, 4), (20, 30, 40, 255))
    source.paste((90, 100, 120, 127), (0, 1, 2, 2))
    source.paste((90, 100, 120, 128), (0, 2, 2, 3))
    result = pipe.run("scene_fit", {"targetSize": [2, 2], "alphaThreshold": 128}, [("source", png(source))])
    assert result["report"] == {"sourceSize": [2, 4], "cropRect": [0, 1, 2, 2], "targetSize": [2, 2], "method": "identity"}
    assert result["warnings"][0]["en"] == "Response 2×4 has a different aspect ratio: center crop 2×2 before reducing to 2×2; review the framing"
    assert pipe.image(result, "fitted").getchannel("A").tobytes() == bytes([0, 0, 255, 255])


@pytest.mark.parametrize(
    ("size", "block", "diagnostic"),
    [
        (4, 2, "Image not on an exact 2 px grid:"),
        (5, 2, "Non-integer factor 2.50:"),
    ],
)
def test_scene_fit_uses_block_majority_for_noisy_and_fractional_grids(tmp_path, size, block, diagnostic):
    pipe = Pipeline(tmp_path)
    green, blue, noise = (20, 140, 50, 255), (10, 90, 200, 255), (230, 50, 70, 255)
    source = Image.new("RGBA", (size, size), green)
    source.paste(blue, (block, 0, size, size))
    source.putpixel((1, 1), noise)
    result = pipe.run("scene_fit", {"targetSize": [2, 2], "alphaThreshold": None}, [("source", png(source))])
    assert result["status"] == "needs_review"
    assert result["report"] == {"sourceSize": [size, size], "cropRect": [0, 0, size, size], "targetSize": [2, 2], "method": "block_mode"}
    assert result["warnings"][0]["en"].startswith(diagnostic)
    assert list(pipe.image(result, "fitted").get_flattened_data()) == [green, blue, green, blue]


def test_single_column_layer_has_no_horizontal_interior_edges(tmp_path):
    pipe = Pipeline(tmp_path)
    layer = Image.new("RGBA", (1, 3), (80, 100, 120, 255))
    result = pipe.run("scene_layer_check", {"axes": {"x": True, "y": False}, "threshold": 1.5, "groundLineY": None, "zoom": 1},
                      [("source", png(layer))])
    assert result["status"] == "ok"
    axis = result["report"]["x"]
    assert [axis[k] for k in ("seamDelta", "interiorDelta", "seamP90", "interiorP90")] == [0, 0, 0, 0]
    assert pipe.image(result, "mosaic").tobytes() == Image.new("RGBA", (3, 3), (80, 100, 120, 255)).tobytes()
