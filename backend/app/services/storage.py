"""Armazenamento de anexos em disco local.

A chave (`storage_key`) é relativa, então trocar por um bucket S3/R2 depois
exige só outra implementação de `save`/`open_path`, sem migrar o banco.
"""

import uuid
from pathlib import Path

from fastapi import UploadFile
from starlette.concurrency import run_in_threadpool

from app.core.config import settings

CHUNK = 1024 * 1024


class UploadTooLarge(Exception):
    pass


def _root() -> Path:
    return Path(settings.MEDIA_ROOT).resolve()


def _safe_name(filename: str) -> str:
    name = Path(filename or "arquivo").name
    keep = "".join(c if c.isalnum() or c in "._-" else "_" for c in name)
    return keep[-120:] or "arquivo"


async def save_upload(ticket_id: uuid.UUID, upload: UploadFile) -> tuple[str, int]:
    """Grava o arquivo e devolve (storage_key, tamanho em bytes)."""
    key = f"tickets/{ticket_id}/{uuid.uuid4().hex}_{_safe_name(upload.filename or '')}"
    dest = _root() / key
    await run_in_threadpool(dest.parent.mkdir, parents=True, exist_ok=True)
    limit = settings.MAX_UPLOAD_MB * 1024 * 1024
    size = 0
    with dest.open("wb") as fh:
        while chunk := await upload.read(CHUNK):
            size += len(chunk)
            if size > limit:
                fh.close()
                dest.unlink(missing_ok=True)
                raise UploadTooLarge(f"Arquivo maior que {settings.MAX_UPLOAD_MB} MB")
            await run_in_threadpool(fh.write, chunk)
    return key, size


def open_path(storage_key: str) -> Path:
    path = (_root() / storage_key).resolve()
    if _root() not in path.parents:
        raise FileNotFoundError(storage_key)
    return path


async def save_bytes(folder: str, extension: str, data: bytes) -> str:
    """Grava um arquivo já em memória (ex.: foto em base64) e devolve a storage_key."""
    key = f"{folder}/{uuid.uuid4().hex}.{extension}"
    dest = _root() / key
    await run_in_threadpool(dest.parent.mkdir, parents=True, exist_ok=True)
    await run_in_threadpool(dest.write_bytes, data)
    return key


def image_extension(data: bytes) -> str | None:
    """Tipo real da imagem pelo conteúdo (não pelo nome nem pelo que o navegador diz)."""
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


class InvalidImage(ValueError):
    pass


def decode_image_data_url(data_url: str, max_bytes: int = 2 * 1024 * 1024) -> tuple[bytes, str]:
    """Imagem em data URL (foto ou assinatura desenhada) → (bytes, extensão real)."""
    import base64
    import binascii

    header, _, payload = data_url.partition(",")
    if not header.startswith("data:image/") or ";base64" not in header:
        raise InvalidImage("Imagem inválida: envie JPG, PNG ou WebP")
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise InvalidImage("Imagem inválida") from exc
    if len(raw) > max_bytes:
        raise InvalidImage(f"Imagem maior que {max_bytes // (1024 * 1024)} MB")
    ext = image_extension(raw)
    if ext is None:
        raise InvalidImage("Imagem inválida: envie JPG, PNG ou WebP")
    return raw, ext
