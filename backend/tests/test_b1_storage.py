"""Arquivos dos anexos: envio que falha não deixa arquivo pela metade no disco."""

import io
import uuid
from pathlib import Path

import pytest
from fastapi import UploadFile

from app.core.config import settings
from app.services import storage


def _files(root: Path) -> list[Path]:
    return [p.resolve() for p in root.rglob("*") if p.is_file()]


class _DroppedConnection(io.BytesIO):
    """O aparelho perdeu a rede no meio do envio."""

    def read(self, size: int | None = -1) -> bytes:
        raise OSError("conexão interrompida")


async def test_failed_upload_leaves_no_partial_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "MEDIA_ROOT", str(tmp_path))
    ticket_id = uuid.uuid4()

    monkeypatch.setattr(settings, "MAX_UPLOAD_MB", 0)
    big = UploadFile(file=io.BytesIO(b"%PDF-1.4 conteudo"), filename="orcamento.pdf")
    with pytest.raises(storage.UploadTooLarge):
        await storage.save_upload(ticket_id, big)
    assert _files(tmp_path) == []

    monkeypatch.setattr(settings, "MAX_UPLOAD_MB", 15)
    dropped = UploadFile(file=_DroppedConnection(), filename="foto.jpg")
    with pytest.raises(OSError, match="interrompida"):
        await storage.save_upload(ticket_id, dropped)
    assert _files(tmp_path) == []

    key, size = await storage.save_upload(
        ticket_id, UploadFile(file=io.BytesIO(b"ok"), filename="nota.txt")
    )
    assert size == 2 and _files(tmp_path) == [storage.open_path(key)]
    storage.delete(key)
    storage.delete(key)  # já apagado: sem erro
    assert _files(tmp_path) == []
