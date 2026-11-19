"""Cartão D1 (plan/07 §tipografia): gabarito de glyphs, medição da folha e texto de teste, pelo protocolo real."""

from __future__ import annotations

import pytest
from PIL import Image, ImageDraw, ImageFont
from PIL._util import DeferredError

from pixel_pipeline import font
from pixel_pipeline.protocol import handle

from test_operations import Pipeline, png

G = 8
CELL = [10, 14]
BASE = 11
GRID = {"columns": 8, "rows": 4, "cell": CELL, "baselineY": BASE, "padLeft": 1, "capHeight": G}
GHOST = (140, 140, 140, 255)


def guide(p: Pipeline, chars: str):
    res = p.run("font_guide", GRID | {"codepoints": [ord(c) for c in chars], "scale": 4}, [])
    assert res["status"] == "ok"
    return res


def inked(guide_1x: Image.Image, skip: str = "", chars: str = "", shift: int = 0) -> Image.Image:
    """Folha "desenhada": tinta branca onde o gabarito tem o fantasma; células de `skip` ficam vazias."""
    out = Image.new("RGBA", guide_1x.size, (0, 0, 0, 0))
    gp, op = guide_1x.load(), out.load()
    for y in range(guide_1x.height):
        for x in range(guide_1x.width):
            cell = (y // CELL[1]) * 8 + x // CELL[0]
            if gp[x, y] == GHOST and not (cell < len(chars) and chars[cell] in skip) and 0 <= y + shift < out.height:
                op[x, y + shift] = (255, 255, 255, 255)
    return out


def measure(p: Pipeline, sheet: Image.Image, chars: str, **over):
    recipe = GRID | {"codepoints": [ord(c) for c in chars], "alphaThreshold": 128, "tracking": 1, "snapBaseline": True, "keyColor": None} | over
    return p.run("font_measure", recipe, [("source", png(sheet))])


def test_gabarito_tem_fantasma_por_celula_inclusive_acentos(tmp_path):
    p = Pipeline(tmp_path)
    res = guide(p, "AÁãç—")
    one = p.image(res, "guide_1x")
    assert one.size == (CELL[0] * 8, CELL[1] * 4)
    assert p.image(res, "guide").size == (CELL[0] * 8 * 4, CELL[1] * 4 * 4)
    ghost_rows = lambda i: sorted({y for y in range(CELL[1]) for x in range(CELL[0]) if one.getpixel((i * CELL[0] + x, y)) == GHOST})  # noqa: E731
    # Á tem acento acima da altura de maiúscula; ç desce abaixo da baseline.
    assert min(ghost_rows(1)) < BASE - G <= min(ghost_rows(0))
    assert max(ghost_rows(3)) >= BASE


def test_medicao_lista_ausentes_alinha_baseline_e_mede_metricas(tmp_path):
    p = Pipeline(tmp_path)
    chars = "AHgçÁ.a"
    sheet = inked(p.image(guide(p, chars), "guide_1x"), skip="Á", chars=chars, shift=1)
    res = measure(p, sheet, chars)
    r = res["report"]
    assert r["missing"] == [ord("Á")]
    assert r["pageBaseline"] == BASE + 1 and r["declaredBaseline"] == BASE
    glyphs = {chr(g["codepoint"]): g for g in r["glyphs"]}
    assert set(glyphs) == set("AHgç.a")
    h = glyphs["H"]
    assert h["bearingX"] == 0 and h["bearingY"] == -h["rect"][3] and h["advanceX"] == h["rect"][2] + 1
    # Descendentes ficam abaixo da baseline; ponto apoia nela.
    assert glyphs["g"]["bearingY"] + glyphs["g"]["rect"][3] > 0 and glyphs["ç"]["bearingY"] + glyphs["ç"]["rect"][3] > 0
    assert glyphs["."]["bearingY"] == -glyphs["."]["rect"][3]
    texts = [w["en"] for w in res["warnings"]]
    assert any("missing on this sheet: Á" in t for t in texts) and any("baseline measured at 12" in t for t in texts)
    page = p.image(res, "page")
    hist = page.getchannel("A").histogram()
    assert sum(hist[1:255]) == 0


def test_texto_de_teste_em_1x_e_zoom_com_ausente_quebra_e_excesso(tmp_path):
    p = Pipeline(tmp_path)
    chars = "AçãoaPCrÁRVEInvetári,—"
    meas = measure(p, inked(p.image(guide(p, chars), "guide_1x")), chars)
    glyphs = [g | {"page": 0} for g in meas["report"]["glyphs"]]
    for g in glyphs:
        g.pop("cell"), g.pop("touchesEdge")
    asc = max(-g["bearingY"] for g in glyphs)
    desc = max(g["bearingY"] + g["rect"][3] for g in glyphs)
    metrics = {"ascent": asc, "descent": desc, "lineHeight": asc + desc + 1, "spaceAdvance": 4}
    page = png(p.image(meas, "page"))
    recipe = {"glyphs": glyphs, "metrics": metrics, "kerning": [], "texts": ["Ação, Poção, Coração — ÁRVORE", "Inventário"], "maxWidth": None, "zoom": 3, "color": None, "background": None}
    res = p.run("font_render", recipe, [("layer", page)])
    t0, t1 = res["report"]["texts"]
    # "O" maiúsculo não foi desenhado: listado como ausente, nunca trocado por "o" ou "0".
    assert {m["char"] for m in t0["missing"]} == {"O"}
    assert t1["missing"] == [] and t1["lines"] == 1
    one, big = p.image(res, "text", "1"), p.image(res, "text_zoom", "1")
    assert big.size == (one.width * 3, one.height * 3) and one.height == metrics["lineHeight"]
    assert any("missing glyph(s)" in w["en"] for w in res["warnings"])

    # Largura máxima: quebra por palavra; palavra maior que a largura acusa excesso.
    wrap = p.run("font_render", recipe | {"texts": ["Ação Ação Ação", "Inventário"], "maxWidth": 30}, [("layer", page)])
    w0, w1 = wrap["report"]["texts"]
    assert w0["wrapped"] and w0["lines"] == 3 and not w0["overflow"]
    assert w1["overflow"] and any("exceeds the 30 px width" in w["en"] for w in wrap["warnings"])


def test_miolo_da_letra_com_cor_chave_vira_fundo(tmp_path):
    """A remoção pela borda não alcança o miolo fechado do O: a medição limpa a matiz da chave."""
    p = Pipeline(tmp_path)
    sheet = Image.new("RGBA", (CELL[0] * 8, CELL[1] * 4), (0, 0, 0, 0))
    for x in range(1, 7):
        for y in range(3, 11):
            ring = x in (1, 6) or y in (3, 10)
            sheet.putpixel((x, y), (255, 255, 255, 255) if ring else (255, 0, 255, 255))
    raw = measure(p, sheet, "O")
    clean = measure(p, sheet, "O", keyColor="#ff00ff")
    assert raw["report"]["keyPixelsCleared"] == 0 and clean["report"]["keyPixelsCleared"] == 4 * 6
    page = p.image(clean, "page")
    assert page.getpixel((3, 5))[3] == 0 and page.getpixel((1, 5))[3] == 255


def test_guide_clips_to_cells_and_handles_tiny_cap_height(tmp_path):
    p = Pipeline(tmp_path)
    recipe = GRID | {
        "columns": 3, "rows": 1, "cell": [5, 5], "baselineY": 4, "padLeft": 4,
        "codepoints": [0x10FFFF, None, 32], "capHeight": 1, "scale": 2,
    }
    response = p.run("font_guide", recipe, [])
    assert response["status"] == "ok"
    sheet = p.image(response, "guide_1x")
    assert sheet.size == (15, 5)
    assert {(x, y) for y in range(5) for x in range(15) if sheet.getpixel((x, y)) == GHOST} == {(4, 3), (14, 3)}

    overfull = p.run("font_guide", recipe | {"columns": 2}, [])
    assert overfull["error"]["code"] == "invalid_request"
    assert overfull["error"]["message"]["en"] == "More glyphs than template cells"
    assert not (overfull["_dir"] / "out").exists()


def test_guide_uses_largest_supported_font_that_fits(tmp_path):
    p = Pipeline(tmp_path)
    response = p.run("font_guide", GRID | {
        "columns": 1, "rows": 1, "cell": [160, 160], "baselineY": 140, "capHeight": 130,
        "codepoints": [ord("H")], "scale": 1,
    }, [])
    sheet = p.image(response, "guide_1x")
    ghost_rows = [y for y in range(160) if any(sheet.getpixel((x, y)) == GHOST for x in range(160))]
    assert 85 <= len(ghost_rows) <= 100
    assert ghost_rows[-1] == 139


def test_bitmap_raster_when_sized_font_and_baseline_anchor_unavailable(monkeypatch):
    # Exercise a failing native rasterizer with Pillow's real bitmap fallback;
    # older font/drawing APIs reject a baseline anchor but can still draw.
    monkeypatch.setattr(ImageFont, "core", DeferredError.new(OSError("FreeType rasterizer unavailable")))
    bitmap_getbbox = ImageFont.ImageFont.getbbox
    draw_text = ImageDraw.ImageDraw.text

    def without_anchored_bbox(self, char, *args, **kwargs):
        if kwargs.get("anchor") == "ls":
            raise TypeError("baseline anchor unavailable")
        return bitmap_getbbox(self, char, *args, **kwargs)

    def without_anchored_text(self, xy, text, *args, **kwargs):
        if kwargs.get("anchor") == "ls":
            raise ValueError("baseline anchor unavailable")
        return draw_text(self, xy, text, *args, **kwargs)

    monkeypatch.setattr(ImageFont.ImageFont, "getbbox", without_anchored_bbox)
    monkeypatch.setattr(ImageDraw.ImageDraw, "text", without_anchored_text)
    bitmap = font._ghost_font.__wrapped__(8)
    assert isinstance(bitmap, ImageFont.ImageFont)
    left, top, rows = font._mask_rows(bitmap, "A")
    assert (left, top) == (0, 0)
    assert sum(any(row) for row in rows) >= 5
    assert any(not bit for row in rows if any(row) for bit in row)


def test_guide_draws_missing_glyph_fallbacks(tmp_path, monkeypatch):
    has_glyph = font._has_glyph

    def limited_coverage(cap, char):
        # Model an installed font missing these specific glyphs. The base A still uses its real raster.
        return char not in "Ā—–…\U0010ffff" and has_glyph(cap, char)

    monkeypatch.setattr(font, "_has_glyph", limited_coverage)
    chars = "AĀ—–…\U0010ffff"
    recipe = {
        "version": 1, "columns": 7, "rows": 1, "cell": [18, 17], "baselineY": 4,
        "padLeft": 1, "capHeight": 8, "codepoints": [ord(c) for c in chars] + [None], "scale": 2,
    }
    response = handle({"protocolVersion": 1, "operation": "font_guide", "recipe": recipe}, tmp_path)
    assert response["status"] == "ok"
    with Image.open(tmp_path / "out" / "guide-1x.png") as image:
        def ghost(index):
            return {(x, y) for y in range(17) for x in range(18) if image.getpixel((index * 18 + x, y)) == GHOST}

        assert ghost(0) and ghost(0) == ghost(1)  # Ā borrows A; macron has no configured pattern.
        assert ghost(2) == {(x, 1) for x in range(1, 9)}
        assert ghost(3) == {(x, 1) for x in range(1, 6)}
        assert ghost(4) == {(1, 3), (3, 3), (5, 3)}
        assert ghost(5) == {(x, y) for x in range(1, 7) for y in range(4) if x in (1, 6) or y == 3}
        assert ghost(6) == set()


@pytest.mark.parametrize("snap", [True, False])
def test_measure_diagnoses_baseline_outliers_and_ink_in_empty_cells(tmp_path, snap):
    p = Pipeline(tmp_path)
    sheet = Image.new("RGBA", (80, 56))
    # Four feet at rows 8, 10, 11, 11: the median is 11, with both small and large deviations.
    for x, top, bottom in [(0, 6, 8), (11, 2, 10), (21, 3, 11), (31, 3, 11)]:
        sheet.paste((245, 230, 60, 170), (x, top, x + 2, bottom))
    sheet.putpixel((40, 5), (255, 255, 255, 255))
    response = measure(p, sheet, "ABCD", snapBaseline=snap)
    assert response["status"] == "needs_review"
    report = response["report"]
    assert report["pageBaseline"] == 11 and report["capHeightMeasured"] == 8
    assert [g["bearingY"] for g in report["glyphs"]] == ([-2, -8, -8, -8] if snap else [-5, -9, -8, -8])
    assert report["snapped"] == ([{"codepoint": 65, "deltaPx": 3}, {"codepoint": 66, "deltaPx": 1}] if snap else [])
    assert report["glyphs"][0]["touchesEdge"] is True
    warnings = [warning["en"] for warning in response["warnings"]]
    assert any("Cell 5 should be empty but has ink" in warning for warning in warnings)
    assert any("Glyph A touches the cell edge" in warning for warning in warnings)
    assert any("Capital A is 2 px tall; the others are 8" in warning for warning in warnings)
    assert any("Glyph A was 3 px off the baseline; metric aligned" in warning for warning in warnings) is snap
    assert any("Glyph B off the baseline by 1 px" in warning for warning in warnings) is not snap
    page = p.image(response, "page")
    assert page.getpixel((0, 6)) == (245, 230, 60, 255) and page.getpixel((0, 8)) == (0, 0, 0, 0)


def test_measure_rejects_sheet_not_matching_grid(tmp_path):
    response = measure(Pipeline(tmp_path), Image.new("RGBA", (79, 56)), "A")
    assert response["error"]["code"] == "geometry_mismatch"
    assert response["error"]["message"]["en"] == "Sheet 79×56 differs from grid 80×56"
    assert not (response["_dir"] / "out").exists()


RENDER = {
    "glyphs": [{"codepoint": 65, "page": 0, "rect": [0, 0, 2, 1], "bearingX": 1, "bearingY": -1, "advanceX": 4}],
    "metrics": {"ascent": 2, "descent": 1, "lineHeight": 4, "spaceAdvance": 3},
    "kerning": [{"left": 65, "right": 65, "amount": -1}], "texts": ["AA\nA A"],
    "maxWidth": None, "zoom": 2, "color": "#f0a050", "background": "#102030",
}


def test_render_tints_mask_and_applies_kerning_on_integer_grid(tmp_path):
    p = Pipeline(tmp_path)
    atlas = Image.new("RGBA", (2, 1), (51, 102, 153, 255))
    atlas.putpixel((1, 0), (207, 8, 31, 128))
    response = p.run("font_render", RENDER, [("layer", png(atlas))])
    assert response["status"] == "ok"
    text, = response["report"]["texts"]
    assert (text["lineWidths"], text["lines"], text["missing"], text["height"]) == ([7, 11], 2, [], 8)
    one, zoom = p.image(response, "text"), p.image(response, "text_zoom")
    assert one.size == (11, 8)
    assert zoom.size == (22, 16)
    assert one.getpixel((0, 1)) == (16, 32, 48, 255)
    assert one.getpixel((2, 1)) == (128, 96, 64, 255)
    assert {(x, y) for y in range(8) for x in range(11) if one.getpixel((x, y)) == (240, 160, 80, 255)} == {
        (1, 1), (4, 1), (1, 5), (8, 5),
    }
    assert zoom.tobytes() == one.resize(zoom.size, Image.Resampling.NEAREST).tobytes()


@pytest.mark.parametrize(("has_page", "glyph_override", "code", "message"), [
    (False, {}, "invalid_request", "The test text needs at least one atlas page"),
    (True, {"page": 1}, "invalid_request", "Glyph U+0041 points to a missing page"),
    (True, {"rect": [1, 0, 2, 1]}, "geometry_mismatch", "Glyph U+0041 rectangle outside the page"),
])
def test_render_validates_referenced_atlas_pages_and_rectangles(tmp_path, has_page, glyph_override, code, message):
    recipe = RENDER | {"glyphs": [RENDER["glyphs"][0] | glyph_override]}
    inputs = [("layer", png(Image.new("RGBA", (2, 1))))] if has_page else []
    response = Pipeline(tmp_path).run("font_render", recipe, inputs)
    assert response["error"]["code"] == code
    assert response["error"]["message"]["en"] == message
    assert not (response["_dir"] / "out").exists()
