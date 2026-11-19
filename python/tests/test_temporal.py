"""Estados e edição temporal (S3): quadros congelados, folha casada, espelho explícito e canvas."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageOps

from tests.test_animation import figure
from tests.test_operations import Pipeline, png

KEY = "#ff00ff"


@pytest.fixture
def pipe(tmp_path: Path) -> Pipeline:
    return Pipeline(tmp_path)


def atlas() -> bytes:
    """Atlas 64×32 com dois quadros de 32×32: boneco no chão e boneco 4 px acima (salto)."""
    img = Image.new("RGBA", (64, 32), (0, 0, 0, 0))
    figure(img, 16, 30, 20)
    figure(img, 32 + 18, 26, 20)
    return png(img)


def frames_recipe(sheet: dict | None = None, emit: bool = True) -> dict:
    return {
        "cell": [32, 32],
        "frames": [
            {"key": "a", "layers": [{"input": 0, "rect": [0, 0, 32, 32], "offset": [0, 0]}]},
            {"key": "b", "layers": [{"input": 0, "rect": [32, 0, 32, 32], "offset": [0, 0]}]},
        ],
        "sheet": sheet,
        "emitFrames": emit,
    }


def test_compose_recompoe_quadros_do_atlas_e_monta_folha_achatada(pipe: Pipeline) -> None:
    res = pipe.run("compose_frames", frames_recipe({"columns": 2, "rows": 1, "scale": 4, "flattenOnto": KEY}), [("layer", atlas())])
    assert res["status"] == "ok"
    a = pipe.image(res, "frame", "a").convert("RGBA")
    src = Image.open(pipe.workdir / "run1" / "in" / "0-layer.png").convert("RGBA")
    assert a.tobytes() == src.crop((0, 0, 32, 32)).tobytes()
    sheet = pipe.image(res, "sheet").convert("RGBA")
    assert sheet.size == (256, 128)
    assert sheet.getpixel((0, 0)) == (255, 0, 255, 255)  # fundo de cor-chave, sem alfa
    assert sheet.getchannel("A").getextrema() == (255, 255)
    assert [f["key"] for f in res["report"]["frames"]] == ["a", "b"]
    assert res["report"]["frames"][0]["rgbaSha256"] != res["report"]["frames"][1]["rgbaSha256"]


def test_compose_recusa_camada_fora_da_celula(pipe: Pipeline) -> None:
    recipe = frames_recipe()
    recipe["frames"][0]["layers"][0]["offset"] = [4, 0]
    res = pipe.run("compose_frames", recipe, [("layer", atlas())])
    assert res["status"] == "error" and res["error"]["code"] == "geometry_mismatch"


def originals() -> list[bytes]:
    out = []
    for foot, ground in [((16, 30)), ((18, 26))]:
        img = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
        figure(img, foot, ground, 20)
        out.append(png(img))
    return out


def test_folha_casada_assenta_cada_quadro_no_apoio_do_original_e_preserva_altura(pipe: Pipeline) -> None:
    # Folha 2×1 a 8× (512×256): o modelo deslocou os bonecos e desenhou o segundo MAIS ALTO (estado "aberto").
    sheet = Image.new("RGBA", (64, 32), (0, 0, 0, 0))
    figure(sheet, 10, 29, 20)
    figure(sheet, 32 + 22, 31, 26)
    big = sheet.resize((512, 256), Image.Resampling.NEAREST)
    recipe = {"columns": 2, "rows": 1, "frameIds": ["a", "b"], "cell": [32, 32], "alphaThreshold": 128, "scaleTolerance": 0.1}
    res = pipe.run("sheet_match", recipe, [("candidate", png(big)), *[("layer", o) for o in originals()]])
    assert res["report"]["scale"]["factor"] == pytest.approx(0.125)
    a = pipe.image(res, "frame", "a").convert("RGBA")
    b = pipe.image(res, "frame", "b").convert("RGBA")
    box_a, box_b = a.getchannel("A").getbbox(), b.getchannel("A").getbbox()
    assert box_a[3] == 30  # pé no chão do original a
    assert box_b[3] == 26  # pé 4 px acima, como no original b (salto preservado)
    assert box_b[3] - box_b[1] == 26  # altura nova mantida: não encolhe para a altura do original
    assert abs((box_a[0] + box_a[2]) / 2 - 16) <= 1


def test_espelho_explicito_e_medida_de_assimetria(pipe: Pipeline) -> None:
    sym = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    ImageDraw.Draw(sym).rectangle((4, 2, 11, 13), fill=(40, 90, 200, 255))
    asym = sym.copy()
    ImageDraw.Draw(asym).rectangle((0, 6, 3, 9), fill=(200, 160, 40, 255))  # escudo só de um lado
    res = pipe.run("mirror_frames", {"asymmetryThreshold": 0.08}, [("source", png(sym)), ("layer", png(asym))])
    assert res["report"]["asymmetric"] is False
    assert pipe.image(res, "mirrored", "1").convert("RGBA").tobytes() == ImageOps.mirror(asym).tobytes()
    res2 = pipe.run("mirror_frames", {"asymmetryThreshold": 0.08}, [("source", png(asym)), ("layer", png(asym))])
    assert res2["report"]["asymmetric"] is True and res2["report"]["asymmetry"] > 0.08


def test_canvas_amplia_sem_gerar_pixels_e_recusa_recorte_visivel(pipe: Pipeline) -> None:
    src = Image.open(__import__("io").BytesIO(originals()[0])).convert("RGBA")
    res = pipe.run("canvas_fit", {"size": [48, 40], "offset": [8, 4]}, [("source", png(src))])
    out = pipe.image(res, "fitted").convert("RGBA")
    assert out.size == (48, 40)
    assert out.crop((8, 4, 40, 36)).tobytes() == src.tobytes()
    # Reduzir cortando só transparência é aceito; cortar o boneco falha.
    ok = pipe.run("canvas_fit", {"size": [24, 32], "offset": [-4, 0]}, [("source", png(src))])
    assert ok["status"] in ("ok", "needs_review")
    bad = pipe.run("canvas_fit", {"size": [12, 32], "offset": [-4, 0]}, [("source", png(src))])
    assert bad["status"] == "error" and bad["error"]["code"] == "geometry_mismatch"


def test_escala_pela_largura_quando_o_modelo_nao_mantem_o_enquadramento(pipe: Pipeline) -> None:
    # Folha 1×1 a 8×, mas o modelo desenhou o sujeito 1,5× maior que o original (e mais alto, "aberto").
    big = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
    figure(big, 16, 31, 27, w=12)
    sheet = big.resize((256, 256), Image.Resampling.NEAREST)
    base = {"columns": 1, "rows": 1, "frameIds": ["a"], "cell": [32, 32], "alphaThreshold": 128, "scaleTolerance": 0.1}
    by_sheet = pipe.run("sheet_match", base, [("candidate", png(sheet)), ("layer", originals()[0])])
    by_width = pipe.run("sheet_match", {**base, "scaleBy": "width"}, [("candidate", png(sheet)), ("layer", originals()[0])])
    w_sheet = pipe.image(by_sheet, "frame", "a").getchannel("A").getbbox()
    w_width = pipe.image(by_width, "frame", "a").getchannel("A").getbbox()
    assert w_sheet[2] - w_sheet[0] == 12  # grade da folha: mantém o exagero do modelo
    assert w_width[2] - w_width[0] == 8  # largura: volta à largura do original
    assert by_width["report"]["scale"]["scaleBy"] == "width"


def test_quadros_novos_de_objeto_escalam_pela_largura_sem_encolher_a_tampa_aberta(pipe: Pipeline) -> None:
    from tests.test_animation import base_view, recipe, sheet

    # Base 8 px de largura, 24 de altura; a folha (2×1) tem o mesmo corpo e, no quadro b, a "tampa" erguida (30 px), tudo a 2×.
    folha = sheet(2, 1, 32, [(16, 2, 24), (16, 2, 30)], scale=2)
    by_height = pipe.run("animation_sheet", recipe(["a", "b"], 2, 1), [("candidate", folha), ("source", base_view())])
    by_width = pipe.run("animation_sheet", {**recipe(["a", "b"], 2, 1), "scaleBy": "width"}, [("candidate", folha), ("source", base_view())])
    assert by_width["report"]["scale"]["factor"] == pytest.approx(0.5)
    b = pipe.image(by_width, "frame", "b").getchannel("A").getbbox()
    assert b[3] - b[1] == 30  # 60 px a 2× → 30: a altura extra da tampa é preservada (pela altura, encolheria para ~27)
    assert by_height["report"]["scale"]["factor"] != by_width["report"]["scale"]["factor"]


def test_conteudo_atravessando_a_grade_gera_alerta(pipe: Pipeline) -> None:
    from tests.test_animation import base_view, recipe

    # 2×2 pedida, mas o "modelo" desenhou dois bonecos centralizados na altura, atravessando a linha do meio.
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    figure(img, 16, 46, 28)
    figure(img, 48, 46, 28)
    res = pipe.run("animation_sheet", recipe(["a", "b"], 2, 2), [("candidate", png(img)), ("source", base_view())])
    assert res["status"] == "needs_review"
    assert any("atravessa a divisão da grade" in w["pt-BR"] and "crosses the grid divisions" in w["en"] for w in res["warnings"])
