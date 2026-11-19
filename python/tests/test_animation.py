"""Animação (S1): folha de uma rota genérica → quadros alinhados pelo apoio, e folha de contato."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from tests.test_operations import Pipeline, png

BODY = (40, 90, 200, 255)
OUTLINE = (20, 20, 28, 255)


@pytest.fixture
def pipe(tmp_path: Path) -> Pipeline:
    return Pipeline(tmp_path)


def figure(canvas: Image.Image, x: int, y: int, h: int, w: int = 8) -> None:
    """Boneco retangular com pé em (x, y): tronco de altura h e pés de 2 px."""
    d = ImageDraw.Draw(canvas)
    d.rectangle((x - w // 2, y - h, x + w // 2 - 1, y - 3), fill=BODY, outline=OUTLINE)
    d.rectangle((x - w // 2, y - 2, x - 1, y - 1), fill=OUTLINE)
    d.rectangle((x + 1, y - 2, x + w // 2 - 1, y - 1), fill=OUTLINE)


def base_view(cell: int = 32, foot: tuple[int, int] = (16, 30), h: int = 24) -> bytes:
    img = Image.new("RGBA", (cell, cell), (0, 0, 0, 0))
    figure(img, foot[0], foot[1], h)
    return png(img)


def sheet(cols: int, rows: int, region: int, placements: list[tuple[int, int, int] | None], scale: int = 1) -> bytes:
    """Folha com um boneco por região: (x do pé, folga até o fundo, altura) relativos à região."""
    img = Image.new("RGBA", (cols * region, rows * region), (0, 0, 0, 0))
    for i, p in enumerate(placements):
        if p is None:
            continue
        r, c = divmod(i, cols)
        fx, gap, h = p
        figure(img, c * region + fx, (r + 1) * region - gap, h)
    if scale > 1:
        img = img.resize((img.width * scale, img.height * scale), Image.Resampling.NEAREST)
    return png(img)


def recipe(frames: list[str], cols: int, rows: int, cell: int = 32, tolerance: float = 0.06, keep_x: bool = True) -> dict:
    return {"columns": cols, "rows": rows, "frameIds": frames, "cell": [cell, cell], "alphaThreshold": 128, "scaleTolerance": tolerance, "keepHorizontalOffsets": keep_x}


def alpha_box(im: Image.Image) -> tuple[int, int, int, int] | None:
    return im.getchannel("A").getbbox()


def test_quadros_assentam_no_apoio_da_base_sem_recentralizar(pipe: Pipeline) -> None:
    # O modelo desenhou os bonecos em posições diferentes dentro de cada região; o terceiro está pulando (folga 6).
    folha = sheet(2, 2, 40, [(12, 4, 24), (26, 4, 24), (20, 10, 24), (18, 4, 24)])
    res = pipe.run("animation_sheet", recipe(["a", "b", "c", "d"], 2, 2), [("candidate", folha), ("source", base_view())])
    assert res["status"] == "ok", res.get("warnings")
    boxes = {f: alpha_box(Pipeline.image(res, "frame", f)) for f in "abcd"}
    # Quadros no chão: pé na mesma linha da base (y = 30) e no mesmo x, qualquer que fosse a posição na região.
    base_box = alpha_box(Image.open(Path(res["_dir"]) / "in/1-source.png"))
    for f in "abd":
        assert boxes[f][3] == base_box[3]
    # O salto foi preservado: 6 px acima do chão (folga 10 contra a folga típica 4).
    assert boxes["c"][3] == base_box[3] - 6
    frames = {f["frameId"]: f for f in res["report"]["frames"]}
    assert frames["c"]["lift"] == 6
    # Deslocamento horizontal relativo também é movimento desenhado: preservado, não recentralizado.
    assert frames["a"]["shift"] < 0 < frames["b"]["shift"]
    assert res["report"]["scale"] == {"factor": 1.0, "resampled": False, "medianHeight": 24, "baseHeight": 24, "scaleBy": "height"}
    strip = Pipeline.image(res, "strip")
    assert strip.size == (128, 32)


def test_chao_por_linha_e_ciclo_no_lugar(pipe: Pipeline) -> None:
    # A segunda linha foi desenhada 3 px mais alta que a primeira (artefato do modelo, não movimento).
    folha = sheet(2, 2, 40, [(14, 4, 24), (24, 4, 24), (14, 7, 24), (24, 7, 24)])
    res = pipe.run("animation_sheet", recipe(["a", "b", "c", "d"], 2, 2, keep_x=False), [("candidate", folha), ("source", base_view())])
    frames = {f["frameId"]: f for f in res["report"]["frames"]}
    # Cada linha pisa no chão; ciclo no lugar: o pé de todos os quadros fica no x da base.
    assert [frames[f]["lift"] for f in "abcd"] == [0, 0, 0, 0]
    assert [frames[f]["shift"] for f in "abcd"] == [0, 0, 0, 0]
    boxes = [alpha_box(Pipeline.image(res, "frame", f)) for f in "abcd"]
    assert len({b[3] for b in boxes}) == 1 and len({b[0] for b in boxes}) == 1


def test_escala_comum_unica_e_avisada(pipe: Pipeline) -> None:
    # Folha ampliada 2× (o modelo desenhou maior): um único fator 0,5 para todos os quadros.
    folha = sheet(2, 1, 40, [(20, 4, 24), (20, 4, 20)], scale=2)
    res = pipe.run("animation_sheet", recipe(["a", "b"], 2, 1), [("candidate", folha), ("source", base_view())])
    assert res["status"] == "needs_review"
    assert any("redução comum" in w["pt-BR"] for w in res["warnings"])
    assert res["report"]["scale"]["resampled"] is True
    assert res["report"]["scale"]["factor"] == pytest.approx(24 / 44, abs=0.01)
    # A diferença de altura entre os quadros sobrevive (agachar não é corrigido para a altura da base).
    ha = alpha_box(Pipeline.image(res, "frame", "a"))
    hb = alpha_box(Pipeline.image(res, "frame", "b"))
    assert (ha[3] - ha[1]) > (hb[3] - hb[1])


def test_quadro_vazio_celula_sobrando_e_recorte_sao_relatados(pipe: Pipeline) -> None:
    # 3 quadros numa grade 2×2: o segundo veio vazio, e a quarta célula tem conteúdo sem quadro.
    folha = sheet(2, 2, 40, [(20, 4, 24), None, (20, 4, 24), (20, 4, 24)])
    res = pipe.run("animation_sheet", recipe(["a", "b", "c"], 2, 2), [("candidate", folha), ("source", base_view())])
    assert res["status"] == "needs_review"
    assert any("Quadro b veio vazio" in w["pt-BR"] and "Frame b came out empty" in w["en"] for w in res["warnings"])
    assert any("Célula 4" in w["pt-BR"] and "sobra" in w["pt-BR"] for w in res["warnings"])
    assert alpha_box(Pipeline.image(res, "frame", "b")) is None
    # Figura mais alta que a célula: os pixels de fora são contados, não esticados.
    alta = sheet(1, 1, 64, [(32, 2, 50)])
    res2 = pipe.run("animation_sheet", recipe(["x"], 1, 1, tolerance=0.5), [("candidate", alta), ("source", base_view(32, (16, 30), 30))])
    frame = res2["report"]["frames"][0]
    assert frame["clippedPixels"] > 0
    assert any("fora da célula" in w["pt-BR"] for w in res2["warnings"])


def test_geometria_invalida_falha_legivel(pipe: Pipeline) -> None:
    folha = sheet(2, 1, 40, [(20, 4, 24), (20, 4, 24)])
    res = pipe.run("animation_sheet", recipe(["a", "b"], 2, 1, cell=48), [("candidate", folha), ("source", base_view())])
    assert res["status"] == "error"
    assert res["error"]["code"] == "geometry_mismatch"
    vazio = png(Image.new("RGBA", (80, 40), (0, 0, 0, 0)))
    res2 = pipe.run("animation_sheet", recipe(["a", "b"], 2, 1), [("candidate", vazio), ("source", base_view())])
    assert res2["error"]["code"] == "unsupported_input"


def test_mesma_entrada_mesmos_bytes(pipe: Pipeline) -> None:
    folha = sheet(2, 2, 40, [(12, 4, 24), (26, 4, 24), (20, 10, 24), (18, 4, 24)])
    a = pipe.run("animation_sheet", recipe(["a", "b", "c", "d"], 2, 2), [("candidate", folha), ("source", base_view())])
    b = pipe.run("animation_sheet", recipe(["a", "b", "c", "d"], 2, 2), [("candidate", folha), ("source", base_view())])
    assert [o["sha256"] for o in a["outputs"]] == [o["sha256"] for o in b["outputs"]]


def test_folha_de_contato(pipe: Pipeline) -> None:
    frames = [base_view(), base_view(32, (14, 30), 20), base_view(32, (18, 28), 24)]
    res = pipe.run(
        "animation_contact_sheet",
        {"cell": [32, 32], "zoom": 3, "background": "#202024", "columns": 2, "gap": 4},
        [("layer", f) for f in frames],
    )
    assert res["status"] == "ok"
    sheet_img = Pipeline.image(res, "contact")
    assert sheet_img.size == (2 * 96 + 3 * 4, 2 * 96 + 3 * 4)
    assert sheet_img.getpixel((0, 0)) == (32, 32, 36, 255)
    bad = pipe.run("animation_contact_sheet", {"cell": [16, 16], "zoom": 2, "background": None, "columns": 2, "gap": 0}, [("layer", frames[0])])
    assert bad["error"]["code"] == "geometry_mismatch"
