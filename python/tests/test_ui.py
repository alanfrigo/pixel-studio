"""Cartão U3 (plan/07): guia e separação do template, recorte, folha de estados, transformações e foco, pelo protocolo real."""

from __future__ import annotations

from PIL import Image, ImageDraw

from test_operations import Pipeline, png

KEY = "#ff00ff"


def button(w: int = 32, h: int = 16, fill: tuple[int, int, int] = (90, 90, 104)) -> Image.Image:
    """Botão de metal: contorno escuro de 1 px, filete de cobre e miolo uniforme."""
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w - 1, h - 1], fill=(24, 24, 30, 255))
    d.rectangle([1, 1, w - 2, h - 2], fill=(184, 115, 51, 255))
    d.rectangle([2, 2, w - 3, h - 3], fill=fill + (255,))
    return img


def test_guia_do_template_e_proposta_de_separacao(tmp_path):
    p = Pipeline(tmp_path)
    cells = [
        {"localId": "continue", "rect": [4, 4, 48, 16], "kind": "piece"},
        {"localId": "health.track", "rect": [4, 28, 40, 8], "kind": "piece"},
        {"localId": "health.fill", "rect": [4, 40, 36, 4], "kind": "fill"},
        {"localId": "health.frame", "rect": [4, 48, 40, 8], "kind": "frame"},
    ]
    guide = p.run("ui_template_guide", {"size": [64, 64], "scale": 4, "backgroundKey": KEY, "cells": cells}, [])
    assert guide["status"] == "ok"
    g = p.image(guide, "guide")
    assert g.size == (256, 256)
    assert g.getpixel((0, 0))[:3] == (255, 0, 255)
    assert g.getpixel((4 * 4 + 8, 4 * 4 + 8))[:3] == (128, 128, 136)
    # Moldura: borda cinza e miolo na cor-chave (onde o preenchimento aparece).
    assert g.getpixel((4 * 4 + 1, 48 * 4 + 1))[:3] == (72, 72, 80)
    assert g.getpixel((24 * 4, 52 * 4))[:3] == (255, 0, 255)

    # Template pintado (já sem fundo): botão inteiro na célula, barra encostada na borda, célula vazia e transbordo.
    tpl = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    tpl.alpha_composite(button(44, 12), (6, 6))
    tpl.alpha_composite(button(40, 8), (4, 28))
    tpl.putpixel((60, 60), (255, 255, 255, 255))
    split = p.run("ui_template_split", {"cells": [{"localId": c["localId"], "rect": c["rect"]} for c in cells], "zoom": 2}, [("source", png(tpl))])
    assert split["status"] == "needs_review"
    props = {pr["localId"]: pr for pr in split["report"]["proposals"]}
    assert props["continue"]["rect"] == [6, 6, 44, 12] and props["continue"]["touchesCellEdge"] is False
    assert props["health.track"]["rect"] == [4, 28, 40, 8] and props["health.track"]["touchesCellEdge"] is True
    assert props["health.fill"]["rect"] is None
    assert split["report"]["spillPixels"] == 1
    texts = [w["en"] for w in split["warnings"]]
    assert any("health.fill is empty" in t for t in texts) and any("outside the declared cells" in t for t in texts)
    assert all(set(w) == {"pt-BR", "en"} for w in split["warnings"])
    assert p.image(split, "preview").size == (128, 128)

    # Miolo da moldura na cor-chave, cercado pelo anel: a limpeza global o torna transparente.
    framed = tpl.copy()
    ImageDraw.Draw(framed).rectangle([4, 48, 43, 55], fill=(255, 0, 255, 255), outline=(24, 24, 30, 255))
    cleaned = p.run("ui_template_split", {"cells": [{"localId": "health.frame", "rect": [4, 48, 40, 8]}], "zoom": 1, "backgroundKey": KEY}, [("source", png(framed))])
    out = p.image(cleaned, "cleaned")
    assert out.getpixel((20, 52))[3] == 0 and out.getpixel((4, 48))[3] == 255
    assert cleaned["report"]["keyPixelsCleared"] == 38 * 6


def test_recorte_explicito_e_cobertura_do_miolo_da_moldura(tmp_path):
    p = Pipeline(tmp_path)
    tpl = Image.new("RGBA", (40, 20), (0, 0, 0, 0))
    tpl.alpha_composite(button(16, 8), (2, 2))
    frame = Image.new("RGBA", (16, 8), (0, 0, 0, 0))
    ImageDraw.Draw(frame).rectangle([0, 0, 15, 7], outline=(24, 24, 30, 255))
    tpl.alpha_composite(frame, (20, 2))
    res = p.run(
        "ui_crop",
        {"crops": [{"key": "track", "rect": [2, 2, 16, 8], "emptyRect": None}, {"key": "frame", "rect": [20, 2, 16, 8], "emptyRect": [2, 2, 12, 4]}, {"key": "solid", "rect": [2, 2, 16, 8], "emptyRect": [2, 2, 12, 4]}]},
        [("source", png(tpl))],
    )
    crops = {c["key"]: c for c in res["report"]["crops"]}
    assert crops["frame"]["emptyCoverage"] == 0.0
    assert crops["solid"]["emptyCoverage"] == 1.0
    assert res["status"] == "needs_review"  # moldura opaca no miolo esconderia o preenchimento
    assert p.image(res, "crop", "track").tobytes() == button(16, 8).tobytes()

    bad = p.run("ui_crop", {"crops": [{"key": "out", "rect": [30, 2, 16, 8], "emptyRect": None}]}, [("source", png(tpl))])
    assert bad["status"] == "error" and bad["error"]["code"] == "geometry_mismatch"


def test_folha_de_estados_corrige_translacao_e_acusa_contorno_alterado(tmp_path):
    p = Pipeline(tmp_path)
    base = button()
    cells = [[4, 4, 32, 16], [40, 4, 32, 16], [4, 24, 32, 16], [40, 24, 32, 16]]
    guide = p.run("ui_state_guide", {"sheetSize": [76, 44], "scale": 3, "backgroundKey": KEY, "cells": cells}, [("source", png(base))])
    g = p.image(guide, "guide")
    assert g.size == (228, 132)
    assert g.getpixel((4 * 3 + 16 * 3, 4 * 3 + 8 * 3))[:3] == (90, 90, 104)  # célula 0 = estado-base aprovado
    assert g.getpixel((40 * 3, 4 * 3))[:3] == (150, 150, 158)  # moldura-guia das demais

    sheet = Image.new("RGBA", (76, 44), (0, 0, 0, 0))
    sheet.alpha_composite(base, (4, 4))
    sheet.alpha_composite(button(fill=(130, 130, 150)), (41, 4))  # hover deslocado 1 px: translação conhecida
    pressed = button(fill=(70, 70, 80))
    ImageDraw.Draw(pressed).rectangle([0, 0, 31, 15], outline=(250, 250, 250, 255))  # contorno trocado
    sheet.alpha_composite(pressed, (4, 24))
    res = p.run(
        "ui_state_sheet",
        {
            "cell": [32, 16],
            "cells": [{"state": "hover", "rect": cells[1]}, {"state": "pressed", "rect": cells[2]}, {"state": "disabled", "rect": cells[3]}],
            "nineSlice": {"left": 4, "right": 4, "top": 4, "bottom": 4},
            "contentPadding": {"left": 7, "right": 7, "top": 5, "bottom": 5},
            "searchPx": 2,
            "outlineTolerance": 0.2,
        },
        [("source", png(base)), ("candidate", png(sheet))],
    )
    assert res["status"] == "needs_review"
    states = {s["state"]: s for s in res["report"]["states"]}
    assert states["hover"]["found"] == "aligned" and states["hover"]["shift"] == [1, 0] and states["hover"]["passed"]
    assert p.image(res, "state", "hover").getpixel((16, 8))[:3] == (130, 130, 150)
    assert states["pressed"]["checks"]["outline"] is False and not states["pressed"]["passed"]
    assert states["disabled"]["found"] == "missing"
    assert res["report"]["allPassed"] is False
    assert any("outline changed" in w["en"] for w in res["warnings"])


def test_transformacoes_locais_preservam_o_contorno(tmp_path):
    p = Pipeline(tmp_path)
    base = button()
    palette = ["#18181e", "#5a5a68", "#828296", "#b87333", "#e6e6f0"]
    ramp = p.run("ui_state_transform", {"transform": {"kind": "ramp", "steps": 1}, "palette": palette, "keepBorderPx": 1}, [("source", png(base))])
    out = p.image(ramp, "state")
    assert out.getpixel((0, 0)) == base.getpixel((0, 0))  # contorno intacto
    assert out.getpixel((16, 8))[:3] == (130, 130, 150)  # miolo subiu um degrau da rampa
    assert ramp["report"]["changedPixels"] > 0

    hi = p.run("ui_state_transform", {"transform": {"kind": "highlight", "amount": 0.5}, "palette": [], "keepBorderPx": 1}, [("source", png(base))])
    assert p.image(hi, "state").getpixel((16, 8))[:3] == (172, 172, 180)

    marked = base.copy()
    marked.putpixel((10, 6), (255, 0, 0, 255))
    off = p.run("ui_state_transform", {"transform": {"kind": "offset", "dx": 0, "dy": 1}, "palette": [], "keepBorderPx": 2}, [("source", png(marked))])
    shifted = p.image(off, "state")
    assert shifted.getpixel((10, 7)) == (255, 0, 0, 255)  # miolo desceu 1 px
    assert shifted.getpixel((0, 0)) == marked.getpixel((0, 0)) and shifted.getpixel((1, 1)) == marked.getpixel((1, 1))

    no_palette = p.run("ui_state_transform", {"transform": {"kind": "ramp", "steps": -1}, "palette": [], "keepBorderPx": 1}, [("source", png(base))])
    assert no_palette["status"] == "error" and "palette" in no_palette["error"]["message"]["en"]


def test_overlay_de_foco_e_faixa_da_silhueta(tmp_path):
    p = Pipeline(tmp_path)
    res = p.run("ui_focus_overlay", {"color": "#ffd600", "widthPx": 1}, [("source", png(button()))])
    focus = p.image(res, "focus")
    assert focus.size == (32, 16)
    assert focus.getpixel((0, 0)) == (255, 214, 0, 255)
    assert focus.getpixel((16, 8))[3] == 0
    assert res["report"]["pixels"] == 2 * 32 + 2 * 14
