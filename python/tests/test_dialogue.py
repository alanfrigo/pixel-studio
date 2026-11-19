"""Cartão D1 (plan/07): retrato × personagem, folha de visemes, estabilidade do rosto e prévia de fala, pelo protocolo real."""

from __future__ import annotations

import pytest
from PIL import Image, ImageDraw

from test_operations import Pipeline, png

CELL = (24, 24)
FACE = [6, 4, 12, 12]
MOUTH = [9, 12, 6, 3]
VISEMES = ["rest", "ai", "e", "o", "u", "mbp", "fv", "cons"]


def portrait() -> Image.Image:
    """Busto sintético: ombros, cabeça, olhos e boca fechada."""
    img = Image.new("RGBA", CELL, (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([3, 18, 20, 23], fill=(40, 70, 160, 255))
    d.ellipse([6, 3, 17, 17], fill=(230, 180, 140, 255))
    d.rectangle([6, 2, 17, 5], fill=(90, 50, 30, 255))
    d.point([(9, 9), (14, 9)], fill=(20, 20, 28, 255))
    d.line([(10, 13), (13, 13)], fill=(120, 40, 40, 255))
    return img


def mouth(img: Image.Image, viseme: str) -> Image.Image:
    out = img.copy()
    d = ImageDraw.Draw(out)
    d.rectangle([MOUTH[0], MOUTH[1], MOUTH[0] + MOUTH[2] - 1, MOUTH[1] + MOUTH[3] - 1], fill=(230, 180, 140, 255))
    shapes = {
        "rest": [(10, 13, 13, 13)],
        "ai": [(10, 12, 13, 14)],
        "e": [(9, 13, 14, 13), (10, 12, 13, 12)],
        "o": [(11, 12, 12, 14)],
        "u": [(11, 13, 12, 13)],
        "mbp": [(10, 13, 13, 13), (10, 12, 13, 12)],
        "fv": [(10, 13, 13, 13), (11, 14, 12, 14)],
        "cons": [(10, 13, 13, 13), (10, 14, 13, 14)],
    }
    for x0, y0, x1, y1 in shapes[viseme]:
        d.rectangle([x0, y0, x1, y1], fill=(120, 40, 40, 255))
    return out


def sheet(cells: list[Image.Image]) -> Image.Image:
    out = Image.new("RGBA", (CELL[0] * 4, CELL[1] * 2), (0, 0, 0, 0))
    for i, c in enumerate(cells):
        out.alpha_composite(c, dest=((i % 4) * CELL[0], (i // 4) * CELL[1]))
    return out


def recipe(**over):
    base = {"columns": 4, "rows": 2, "cell": list(CELL), "frameIds": VISEMES, "restId": "rest", "faceRect": FACE, "mouthRect": MOUTH, "thresholds": {"outsideMouth": 0.02, "outsideFace": 0.05}, "zoom": 2}
    return base | over


def test_retrato_confere_paleta_escala_e_sugere_regioes(tmp_path):
    p = Pipeline(tmp_path)
    character = Image.new("RGBA", (16, 24), (0, 0, 0, 0))
    ImageDraw.Draw(character).rectangle([4, 2, 11, 22], fill=(230, 180, 140, 255))
    ImageDraw.Draw(character).rectangle([4, 14, 11, 22], fill=(40, 70, 160, 255))
    ok = p.run("portrait_check", {"zoom": 2}, [("source", png(portrait())), ("layer", png(character))])
    r = ok["report"]
    assert r["palette"]["nearReferenceRatio"] > 0.6
    assert r["scale"]["spriteHeightPx"] == 21 and r["scale"]["portraitHeightPx"] == 22
    s = r["suggested"]
    assert s["mouthRect"][1] > s["faceRect"][1] and s["faceAnchor"][0] < CELL[0]
    assert p.image(ok, "compare").height == CELL[1] * 2

    # Paleta estranha ao personagem: aviso bilíngue.
    alien = Image.new("RGBA", CELL, (0, 255, 0, 255))
    bad = p.run("portrait_check", {"zoom": 1}, [("source", png(alien)), ("layer", png(character))])
    assert bad["status"] == "needs_review"
    assert any("Paleta" in w["pt-BR"] and "Palette" in w["en"] for w in bad["warnings"])


def test_guia_repete_o_retrato_e_marca_a_boca(tmp_path):
    p = Pipeline(tmp_path)
    res = p.run("viseme_guide", {"columns": 4, "rows": 2, "cell": list(CELL), "mouthRect": MOUTH, "markColor": "#ff00c8", "flattenOnto": None, "scale": 4}, [("source", png(portrait()))])
    assert res["status"] == "ok"
    guide = p.image(res, "guide")
    assert guide.size == (CELL[0] * 4 * 4, CELL[1] * 2 * 4)
    one = p.image(res, "guide_1x")
    # Cada célula é o retrato inalterado (a marca só existe na guia ampliada).
    assert one.crop((CELL[0] * 3, CELL[1], CELL[0] * 4, CELL[1] * 2)).tobytes() == portrait().tobytes()
    assert guide.getpixel(((MOUTH[0] * 4) - 1, MOUTH[1] * 4 + 4))[:3] == (255, 0, 200)


def test_folha_estavel_passa_e_rosto_instavel_gera_aviso(tmp_path):
    p = Pipeline(tmp_path)
    base = portrait()
    good = sheet([mouth(base, v) for v in VISEMES])
    ok = p.run("expression_sheet", recipe(), [("source", png(good)), ("layer", png(base))])
    assert ok["status"] == "ok", ok.get("warnings")
    r = ok["report"]
    assert r["complete"] and r["maxOutsideMouth"] == 0 and r["outsideFace"] == 0
    assert [f["frameId"] for f in r["frames"]] == VISEMES
    assert r["frames"][1]["rect"] == [CELL[0], 0, *CELL] and r["frames"][1]["mouthChanged"] > 0

    # Olho deslocado no viseme "o" (fora da boca) e viseme "u" vazio.
    cells = [mouth(base, v) for v in VISEMES]
    ImageDraw.Draw(cells[3]).rectangle([0, 0, 5, 5], fill=(255, 255, 255, 255))
    cells[4] = Image.new("RGBA", CELL, (0, 0, 0, 0))
    bad = p.run("expression_sheet", recipe(), [("source", png(sheet(cells))), ("layer", png(base))])
    assert bad["status"] == "needs_review"
    frames = {f["frameId"]: f for f in bad["report"]["frames"]}
    assert frames["o"]["outsideMouth"] > 0.02 and frames["u"]["empty"] is True and bad["report"]["complete"] is False
    texts = [w["en"] for w in bad["warnings"]]
    assert any("Unstable face in viseme o" in t for t in texts) and any("Viseme u came back empty" in t for t in texts)

    # Identidade: repouso que muda o cabelo (fora do rosto) em relação ao retrato.
    drift = [mouth(base, v) for v in VISEMES]
    for c in drift:
        ImageDraw.Draw(c).rectangle([3, 18, 20, 23], fill=(200, 30, 30, 255))
    off = p.run("expression_sheet", recipe(), [("source", png(sheet(drift))), ("layer", png(base))])
    assert off["report"]["outsideFace"] > 0.05
    assert any("Unstable identity" in w["en"] for w in off["warnings"])


def test_comparar_expressoes_fora_da_boca(tmp_path):
    p = Pipeline(tmp_path)
    neutral = sheet([mouth(portrait(), v) for v in VISEMES])
    happy_base = portrait()
    ImageDraw.Draw(happy_base).point([(9, 8), (14, 8)], fill=(20, 20, 28, 255))
    happy = sheet([mouth(happy_base, v) for v in VISEMES])
    res = p.run("expression_compare", {"rectA": [0, 0, *CELL], "rectB": [0, 0, *CELL], "mouthRect": MOUTH, "zoom": 2}, [("source", png(neutral)), ("layer", png(happy))])
    assert res["report"]["changedPixels"] == 2
    assert p.image(res, "compare").size == (CELL[0] * 2 * 3 + 2 * 4, CELL[1] * 2)


def test_previa_de_fala_gif_e_tira_derivadas(tmp_path):
    p = Pipeline(tmp_path)
    atlas = sheet([mouth(portrait(), v) for v in VISEMES])
    frames = [{"rect": [CELL[0] * (i % 4), CELL[1] * (i // 4), *CELL], "durationMs": d} for i, d in [(1, 110), (5, 70), (0, 240)]]
    res = p.run("speech_preview", {"frames": frames, "zoom": 2, "stripMax": 16}, [("source", png(atlas))])
    assert res["status"] == "ok" and res["report"] == {"frames": 3, "totalMs": 420, "stripFrames": 3, "derivedPreview": True}
    gif_out = next(o for o in res["outputs"] if o["role"] == "gif")
    assert gif_out["mime"] == "image/gif"
    with Image.open(res["_dir"] / gif_out["relPath"]) as gif:
        assert gif.n_frames == 3 and gif.size == (CELL[0] * 2, CELL[1] * 2)
    assert p.image(res, "strip").size == (CELL[0] * 2 * 3 + 4, CELL[1] * 2)


def test_portrait_rejects_empty_image_and_compares_only_available_reference(tmp_path):
    pipe = Pipeline(tmp_path)
    empty = png(Image.new("RGBA", CELL))
    good = png(portrait())
    result = pipe.run("portrait_check", {"zoom": 2}, [("source", empty)])
    assert result["error"]["code"] == "invalid_request"
    assert result["error"]["message"]["en"] == "Portrait has no visible pixel"
    alone = pipe.run("portrait_check", {"zoom": 2}, [("source", good)])
    assert alone["report"]["palette"] is None and alone["report"]["scale"] is None
    assert pipe.image(alone, "compare").tobytes() == portrait().resize((48, 48), Image.Resampling.NEAREST).tobytes()
    blank_reference = pipe.run("portrait_check", {"zoom": 1}, [("source", good), ("layer", empty)])
    assert blank_reference["report"]["scale"] is None
    assert blank_reference["report"]["palette"]["referenceColors"] == 0
    assert blank_reference["report"]["palette"]["nearReferenceRatio"] == 0
    assert blank_reference["warnings"][-1]["en"] == "Palette drifts from the character: only 0% of pixels are close to the reference colors"


def test_viseme_guide_flatten_preserves_portrait_on_key_and_requires_cell_dimensions(tmp_path):
    pipe = Pipeline(tmp_path)
    img = Image.new("RGBA", (4, 4))
    img.putpixel((2, 2), (80, 100, 120, 255))
    recipe = {"columns": 2, "rows": 1, "cell": [4, 4], "mouthRect": [1, 2, 2, 2],
              "markColor": "#ffff00", "flattenOnto": "#ff00ff", "scale": 2}
    inputs = [("source", png(img))]
    result = pipe.run("viseme_guide", recipe, inputs)
    actual = pipe.image(result, "guide_1x")
    assert actual.size == (8, 4)
    assert actual.getpixel((0, 0)) == (255, 0, 255, 255)
    assert actual.getpixel((6, 2)) == (80, 100, 120, 255)
    assert actual.crop((0, 0, 4, 4)).tobytes() == actual.crop((4, 0, 8, 4)).tobytes()
    bad = pipe.run("viseme_guide", {**recipe, "cell": [4, 5]}, inputs)
    assert bad["error"]["code"] == "geometry_mismatch"
    assert bad["error"]["message"]["en"] == "Portrait 4×4 differs from cell 4×5"


@pytest.mark.parametrize(
    ("size", "reference_size", "frames", "code", "message"),
    [
        ((47, 24), None, ["rest"], "geometry_mismatch", "Sheet 47×24 differs from grid 48×24"),
        ((48, 24), (23, 24), ["rest"], "geometry_mismatch", "Portrait does not match the declared cell"),
        ((48, 24), None, ["rest", "ai", "e"], "invalid_request", "More visemes than grid cells"),
        ((48, 24), None, ["ai"], "invalid_request", "The rest viseme must be in the sheet"),
    ],
)
def test_expression_sheet_checks_grid_portrait_and_rest_viseme(tmp_path, size, reference_size, frames, code, message):
    opts = recipe(columns=2, rows=1, frameIds=frames)
    inputs = [("source", png(Image.new("RGBA", size)))]
    if reference_size is not None:
        inputs.append(("layer", png(Image.new("RGBA", reference_size))))
    result = Pipeline(tmp_path).run("expression_sheet", opts, inputs)
    assert result["error"]["code"] == code
    assert result["error"]["message"]["en"] == message


def test_expression_sheet_reports_unchanged_vowel_but_allows_resting_closed_consonant(tmp_path):
    pipe = Pipeline(tmp_path)
    img = Image.new("RGBA", (72, 24))
    for x in (0, 24, 48):
        img.paste(portrait(), (x, 0))
    result = pipe.run("expression_sheet", recipe(columns=3, rows=1, frameIds=["rest", "ai", "mbp"]), [("source", png(img))])
    assert result["status"] == "needs_review"
    assert result["report"]["outsideFace"] is None
    assert result["report"]["complete"] is True
    assert [frame["mouthChanged"] for frame in result["report"]["frames"][1:]] == [0, 0]
    assert [w["en"] for w in result["warnings"]] == ["Viseme ai has the same mouth as rest"]


def test_compare_and_speech_preview_reject_bad_cell_geometry(tmp_path):
    pipe = Pipeline(tmp_path)
    art = png(portrait())
    compare = pipe.run("expression_compare", {"rectA": [0, 0, 24, 24], "rectB": [0, 0, 23, 24], "mouthRect": MOUTH, "zoom": 1},
                       [("source", art), ("layer", art)])
    assert compare["error"]["code"] == "geometry_mismatch"
    assert compare["error"]["message"]["en"] == "The expressions have different cell sizes"
    speech = pipe.run("speech_preview", {"frames": [{"rect": [1, 0, 24, 24], "durationMs": 110}], "zoom": 2, "stripMax": 1},
                      [("source", art)])
    assert speech["error"]["code"] == "geometry_mismatch"
    assert speech["error"]["message"]["en"] == "Frame [1, 0, 24, 24] outside the atlas"
