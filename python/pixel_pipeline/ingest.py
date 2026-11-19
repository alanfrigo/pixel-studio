"""Ingestão raster (plan/05 §receitas · ingestão).

Confere formato, dimensões, pixels, quadros e bytes ANTES de expandir; aplica a
orientação EXIF; converte perfil de cor e paleta/transparência para um derivado
de trabalho sRGB RGBA 8 bits com alfa direto. O original nunca é alterado.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

from pixel_pipeline import PROTOCOL_VERSION
from pixel_pipeline.protocol import PipelineError, input_by_role, rgba_sha256, sha256_file

Json = dict[str, Any]

EXIF_ORIENTATION = 0x0112


def _limits(request: Json) -> Json:
    recipe = request.get("recipe") or {}
    if recipe.get("version") != 1:
        raise PipelineError("invalid_request", "ingest_inspect exige recipe.version = 1")
    limits = recipe.get("limits") or {}
    required = ("maxBytes", "maxWidth", "maxHeight", "maxPixels", "maxFrames")
    if any(not isinstance(limits.get(k), int) or limits[k] <= 0 for k in required):
        raise PipelineError("invalid_request", f"Limites obrigatórios: {', '.join(required)}")
    return limits


def _to_rgba(image: Image.Image) -> Image.Image:
    mode = image.mode
    if mode in ("I;16", "I;16B", "I;16L", "I"):
        return image.convert("I").point(lambda v: v * (1 / 256)).convert("L").convert("RGBA")
    if mode == "F":
        return image.convert("L").convert("RGBA")
    # P/PA respeitam o índice transparente (tRNS); L/LA/RGB/RGBA/1/CMYK convertem diretamente.
    return image.convert("RGBA")


def _to_srgb(image: Image.Image, icc: bytes | None) -> tuple[Image.Image, bool]:
    """Converte para sRGB quando há perfil ICC embutido. Retorna (imagem RGBA, converteu?)."""
    if not icc:
        return _to_rgba(image), False
    try:
        source = ImageCms.ImageCmsProfile(io.BytesIO(icc))
    except (OSError, ImageCms.PyCMSError):
        # Perfil ilegível: segue sem conversão e o relatório avisa.
        return _to_rgba(image), False
    srgb = ImageCms.createProfile("sRGB")
    if image.mode == "CMYK":
        rgb = ImageCms.profileToProfile(image, source, srgb, outputMode="RGB")
        return rgb.convert("RGBA"), True
    rgba = _to_rgba(image)
    alpha = rgba.getchannel("A")
    rgb = ImageCms.profileToProfile(rgba.convert("RGB"), source, srgb, outputMode="RGB")
    rgb.putalpha(alpha)
    return rgb, True


def ingest_inspect(request: Json, workdir: Path) -> Json:
    limits = _limits(request)
    _, source = input_by_role(request, workdir, "source")

    size = source.stat().st_size
    if size > limits["maxBytes"]:
        raise PipelineError("limit_exceeded", f"Arquivo com {size} bytes excede o limite de {limits['maxBytes']}")

    Image.MAX_IMAGE_PIXELS = limits["maxPixels"]
    try:
        image = Image.open(source)
    except UnidentifiedImageError as exc:
        raise PipelineError("decode_failed", "Formato de imagem não reconhecido") from exc

    with image:
        fmt = image.format
        width, height = image.size
        if width > limits["maxWidth"] or height > limits["maxHeight"] or width * height > limits["maxPixels"]:
            raise PipelineError("limit_exceeded", f"Imagem {width}×{height} excede os limites de dimensão/pixels")
        frames = getattr(image, "n_frames", 1)
        if frames > limits["maxFrames"]:
            raise PipelineError("limit_exceeded", f"Imagem com {frames} quadros excede o limite de {limits['maxFrames']}")
        if frames > 1:
            raise PipelineError(
                "unsupported_input",
                f"Imagem animada com {frames} quadros: o importador estático aceita um quadro. "
                "Exporte os quadros como uma tira PNG e importe-a para fatiar.",
            )
        try:
            image.load()
        except (OSError, SyntaxError, ValueError) as exc:
            raise PipelineError("decode_failed", f"Não foi possível decodificar a imagem: {exc}") from exc

        original_mode = image.mode
        orientation = int(image.getexif().get(EXIF_ORIENTATION, 1))
        icc = image.info.get("icc_profile")
        oriented = ImageOps.exif_transpose(image) or image
        rgba, icc_converted = _to_srgb(oriented, icc)

    out_dir = workdir / "out"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / "normalized.png"
    # Parâmetros fixos de codificação: mesmos bytes + mesma receita → mesmos bytes de saída.
    rgba.save(out_path, format="PNG", compress_level=6, optimize=False)

    alpha_hist = rgba.getchannel("A").histogram()
    has_alpha = sum(alpha_hist[:255]) > 0
    partial_alpha = sum(alpha_hist[1:255]) > 0

    warnings: list[str] = []
    if icc and not icc_converted:
        warnings.append("Perfil ICC ilegível: cores mantidas sem conversão para sRGB")

    output = {
        "role": "normalized",
        "relPath": "out/normalized.png",
        "mime": "image/png",
        "width": rgba.width,
        "height": rgba.height,
        "sha256": sha256_file(out_path),
        "rgbaSha256": rgba_sha256(rgba),
    }
    report = {
        "format": fmt,
        "originalMode": original_mode,
        "sourceSize": [width, height],
        "size": [rgba.width, rgba.height],
        "exifOrientation": orientation,
        "iccConverted": icc_converted,
        "hasAlpha": has_alpha,
        "partialAlpha": partial_alpha,
        "frames": frames,
        "bytes": size,
    }
    if warnings:
        return {"protocolVersion": PROTOCOL_VERSION, "status": "needs_review", "outputs": [output], "report": report, "warnings": warnings}
    return {"protocolVersion": PROTOCOL_VERSION, "status": "ok", "outputs": [output], "report": report}
