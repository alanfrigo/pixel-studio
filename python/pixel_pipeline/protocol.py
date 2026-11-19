"""Fronteira do protocolo v1 (plan/05 §entrada e saída; src/contracts/python-protocol.ts)."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import sys
import traceback
import warnings
from pathlib import Path
from typing import Any, Callable

import PIL
from PIL import Image

from pixel_pipeline import PROTOCOL_VERSION, __version__
from pixel_pipeline.i18n import tx

MAX_REQUEST_BYTES = 1 * 1024 * 1024

Json = dict[str, Any]
# Texto para a interface: string simples ou bilíngue `{"pt-BR", "en"}` (`tx()` em i18n.py).
Text = str | dict[str, str]


class PipelineError(Exception):
    """Falha esperada, convertida em resposta `status: error` com código estável.

    A mensagem pode ser bilíngue (`tx()`); `str(exc)` fica em português (logs).
    """

    def __init__(self, code: str, message: Text) -> None:
        super().__init__(message["pt-BR"] if isinstance(message, dict) else message)
        self.code = code
        self.message = message


def error_response(code: str, message: Text) -> Json:
    return {"protocolVersion": PROTOCOL_VERSION, "status": "error", "error": {"code": code, "message": message}}


def resolve_inside(workdir: Path, rel_path: str) -> Path:
    """Resolve um caminho relativo garantindo que não escapa da pasta de trabalho."""
    if not isinstance(rel_path, str) or rel_path.startswith("/") or "\\" in rel_path:
        raise PipelineError("invalid_request", tx(f"Caminho inválido: {rel_path!r}", f"Invalid path: {rel_path!r}"))
    resolved = (workdir / rel_path).resolve()
    if not resolved.is_relative_to(workdir.resolve()):
        raise PipelineError("invalid_request", tx(f"Caminho fora da pasta de trabalho: {rel_path!r}", f"Path outside the working folder: {rel_path!r}"))
    return resolved


def input_by_role(request: Json, workdir: Path, role: str) -> tuple[Json, Path]:
    matches = [i for i in request.get("inputs", []) if i.get("role") == role]
    if len(matches) != 1:
        raise PipelineError("invalid_request", tx(f"Operação exige exatamente uma entrada com papel {role!r}", f"Operation requires exactly one input with role {role!r}"))
    entry = matches[0]
    path = resolve_inside(workdir, entry.get("relPath", ""))
    if not path.is_file():
        raise PipelineError("invalid_request", tx(f"Entrada ausente: {entry.get('relPath')}", f"Missing input: {entry.get('relPath')}"))
    digest = sha256_file(path)
    if digest != entry.get("sha256"):
        raise PipelineError("invalid_request", tx(f"Hash da entrada {entry.get('relPath')} diverge do pedido", f"Hash of input {entry.get('relPath')} does not match the request"))
    return entry, path


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def rgba_sha256(image: Image.Image) -> str:
    """Hash dos pixels RGBA canônicos: RGB zerado onde alfa = 0, cabeçalho com dimensões."""
    if image.mode != "RGBA":
        raise ValueError("rgba_sha256 exige imagem RGBA")
    visible = image.getchannel("A").point(lambda a: 255 if a > 0 else 0)
    canonical = Image.composite(image, Image.new("RGBA", image.size, (0, 0, 0, 0)), visible)
    h = hashlib.sha256()
    h.update(b"RGBA8")
    h.update(image.width.to_bytes(4, "big"))
    h.update(image.height.to_bytes(4, "big"))
    h.update(canonical.tobytes())
    return h.hexdigest()


def apply_resource_limits() -> None:
    try:
        import resource
    except ImportError:  # pragma: no cover - Windows
        return
    memory_mb = int(os.environ.get("PIXEL_PIPELINE_MAX_MEMORY_MB", "1024"))
    cpu_seconds = int(os.environ.get("PIXEL_PIPELINE_MAX_CPU_SECONDS", "60"))
    resource.setrlimit(resource.RLIMIT_AS, (memory_mb * 1024 * 1024, memory_mb * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))


def operations() -> dict[str, Callable[[Json, Path], Json]]:
    from pixel_pipeline import operations as ops
    from pixel_pipeline.ingest import ingest_inspect

    return {
        "ingest_inspect": ingest_inspect,
        "slice_grid": ops.slice_grid,
        "remove_background_flood": ops.remove_background_flood,
        "crop_to_content": ops.crop_to_content,
        "make_thumbnail": ops.make_thumbnail,
        "fit_logical": ops.fit_logical,
        "encode_mask": ops.encode_mask,
        "unzoom": ops.unzoom,
        "apply_palette": ops.apply_palette,
        "compose_layers": ops.compose_layers,
        "composite_protected": ops.composite_protected,
        "inspect_mask": ops.inspect_mask,
        "inpaint_guide": ops.inpaint_guide,
        **_animation_operations(),
        **_world_operations(),
        **_temporal_operations(),
        **_scene_operations(),
        **_equipment_operations(),
        **_dialogue_operations(),
        **_ui_operations(),
    }


def _ui_operations() -> dict[str, Callable[[Json, Path], Json]]:
    """Cartão U3: kit de UI (`ui.py`)."""
    from pixel_pipeline import ui

    return {
        "ui_template_guide": ui.ui_template_guide,
        "ui_template_split": ui.ui_template_split,
        "ui_crop": ui.ui_crop,
        "ui_state_guide": ui.ui_state_guide,
        "ui_state_sheet": ui.ui_state_sheet,
        "ui_state_transform": ui.ui_state_transform,
        "ui_focus_overlay": ui.ui_focus_overlay,
    }


def _dialogue_operations() -> dict[str, Callable[[Json, Path], Json]]:
    """Cartão D1: retratos/visemes/fala (`dialogue.py`) e fonte bitmap (`font.py`)."""
    from pixel_pipeline import dialogue, font

    return {
        "portrait_check": dialogue.portrait_check,
        "viseme_guide": dialogue.viseme_guide,
        "expression_sheet": dialogue.expression_sheet,
        "expression_compare": dialogue.expression_compare,
        "speech_preview": dialogue.speech_preview,
        "font_guide": font.font_guide,
        "font_measure": font.font_measure,
        "font_render": font.font_render,
    }


def _equipment_operations() -> dict[str, Callable[[Json, Path], Json]]:
    """Cartão S2: módulo próprio (`equipment.py`)."""
    from pixel_pipeline import equipment

    return {
        "equipment_compose": equipment.equipment_compose,
        "equipment_extract": equipment.equipment_extract,
        "equipment_guide": equipment.equipment_guide,
        "equipment_region_hashes": equipment.equipment_region_hashes,
    }


def _scene_operations() -> dict[str, Callable[[Json, Path], Json]]:
    """Cartão T2: módulo próprio (`scenes.py`)."""
    from pixel_pipeline import scenes

    return {
        "scene_layer_check": scenes.scene_layer_check,
        "scene_compose": scenes.scene_compose,
        "scene_overlay": scenes.scene_overlay,
        "room_guide": scenes.room_guide,
        "room_cutout": scenes.room_cutout,
        "room_compose": scenes.room_compose,
        "scene_fit": scenes.scene_fit,
    }


def _temporal_operations() -> dict[str, Callable[[Json, Path], Json]]:
    """Cartão S3: módulo próprio (`temporal.py`)."""
    from pixel_pipeline import temporal

    return {
        "compose_frames": temporal.compose_frames,
        "sheet_match": temporal.sheet_match,
        "mirror_frames": temporal.mirror_frames,
        "canvas_fit": temporal.canvas_fit,
    }


def _world_operations() -> dict[str, Callable[[Json, Path], Json]]:
    """Cartão T1: módulo próprio (`world.py`)."""
    from pixel_pipeline import world

    return {
        "texture_seams": world.texture_seams,
        "corner_guides": world.corner_guides,
        "side_guides": world.side_guides,
        "tileset_seams": world.tileset_seams,
        "tile_edit_mask": world.tile_edit_mask,
        "iso_pieces": world.iso_pieces,
        "iso_check": world.iso_check,
    }


def _animation_operations() -> dict[str, Callable[[Json, Path], Json]]:
    """Cartão S1: módulo próprio (`animation.py`)."""
    from pixel_pipeline import animation

    return {"animation_sheet": animation.animation_sheet, "animation_contact_sheet": animation.animation_contact_sheet}


def handle(request: Any, workdir: Path) -> Json:
    if not isinstance(request, dict):
        raise PipelineError("invalid_request", tx("Pedido deve ser um objeto JSON", "Request must be a JSON object"))
    if request.get("protocolVersion") != PROTOCOL_VERSION:
        raise PipelineError(
            "unsupported_protocol",
            tx(f"Versão de protocolo {request.get('protocolVersion')!r} não suportada (este processador entende {PROTOCOL_VERSION})", f"Protocol version {request.get('protocolVersion')!r} not supported (this processor understands {PROTOCOL_VERSION})"),
        )
    operation = request.get("operation")
    handler = operations().get(operation)
    if handler is None:
        raise PipelineError("invalid_request", tx(f"Operação desconhecida: {operation!r}", f"Unknown operation: {operation!r}"))
    with warnings.catch_warnings():
        # Imagem maior que o limite de pixels vira erro, não aviso.
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        return handler(request, workdir)


def main(argv: list[str]) -> int:
    if argv[:1] == ["--version"]:
        print(json.dumps({"protocolVersion": PROTOCOL_VERSION, "pipeline": __version__, "pillow": PIL.__version__, "python": platform.python_version()}))
        return 0

    apply_resource_limits()
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    try:
        if len(raw) > MAX_REQUEST_BYTES:
            raise PipelineError("invalid_request", tx("Pedido maior que o limite do protocolo", "Request exceeds the protocol limit"))
        try:
            request = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise PipelineError("invalid_request", tx(f"JSON inválido: {exc.msg}", f"Invalid JSON: {exc.msg}")) from exc
        response = handle(request, Path.cwd())
    except PipelineError as exc:
        response = error_response(exc.code, exc.message)
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        response = error_response("limit_exceeded", tx(f"Imagem excede o limite de pixels: {exc}", f"Image exceeds the pixel limit: {exc}"))
    except MemoryError:
        response = error_response("limit_exceeded", tx("Memória insuficiente dentro do limite configurado", "Not enough memory within the configured limit"))
    except Exception as exc:  # noqa: BLE001 - fronteira do processo
        traceback.print_exc(file=sys.stderr)
        response = error_response("internal", f"{type(exc).__name__}: {exc}")
    sys.stdout.write(json.dumps(response, ensure_ascii=False))
    sys.stdout.flush()
    return 0
