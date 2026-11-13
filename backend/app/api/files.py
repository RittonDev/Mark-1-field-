"""Resposta de arquivo guardado (fotos, assinaturas, avatar) com 404 claro quando ele sumiu.

Sem isto, um arquivo que não está mais no disco (volume trocado, backup restaurado sem a
pasta de mídia) vira 500 em vez de "Arquivo não encontrado".
"""

from fastapi import HTTPException, status
from fastapi.responses import FileResponse

from app.services import storage

FILE_MISSING = "Arquivo não encontrado"


def stored_file(storage_key: str) -> FileResponse:
    try:
        path = storage.open_path(storage_key)
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, FILE_MISSING) from exc
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, FILE_MISSING)
    return FileResponse(path)
