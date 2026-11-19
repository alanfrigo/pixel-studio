"""Cartão D1 (plan/07 §tipografia): gabarito de glyphs, medição da folha e texto de teste, pelo protocolo real."""

from __future__ import annotations

from PIL import Image

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
