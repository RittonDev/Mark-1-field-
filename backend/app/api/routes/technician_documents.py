"""Documentos do técnico (services/technician_documents.py; contrato da Entrega 2, §6.3 e §6.4).

App (só o técnico; tudo online, nada entra na fila offline): envia, substitui, edita e exclui os
próprios certificação, documento pessoal e currículo; toda rota responde o MyProfile inteiro (a
lista em MyProfile.documents, sem link) e o link de 30 min é pedido na hora. Até 30 envios por
hora.

Central (Técnicos): ver pede Visualizar (os anexos internos só com Editar, nem na lista sem ele);
enviar, substituir, editar e excluir pedem Editar. O arquivo sai por link assinado de 30 min, gerado
só nas respostas de quem pode ver (sem login no download).

Ficha da homologação já enviada (sem login, pelo upload_token de 2 h da resposta do envio): envia e
remove os arquivos dela enquanto está pendente, até 30 envios por hora por IP. A aprovação os passa
ao técnico (services/onboarding.py).

Depois do commit: os arquivos que saíram vão do disco e a central é avisada (profile.changed; o app,
pelo me.profile_changed, quando a central mexe no que ele mostra).
"""

import uuid
from typing import Annotated

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse

from app.api.deps import DB, access_user, require_roles
from app.api.files import FILE_MISSING
from app.core import permissions
from app.core.enums import UserRole
from app.models import User
from app.models.user_change import VIA_APP, VIA_CENTRAL, VIA_FICHA
from app.schemas.my_profile import MyProfile
from app.schemas.technician_document import (
    DocumentLinkOut,
    FichaDocumentOut,
    FichaDocumentRemove,
    TechDocumentOut,
    TechDocumentUpdate,
)
from app.services import login_guard, my_profile, storage, technicians, user_history
from app.services import technician_documents as svc
from app.services.errors import CodedError

router = APIRouter(tags=["technician-documents"])
# Arquivos da ficha da homologação já enviada (sem login, pelo upload_token): prefixo próprio, para
# não cair em /public/onboarding/{token}.
public = APIRouter(prefix="/public/onboarding-documents", tags=["onboarding"])

TechnicianUser = Annotated[User, Depends(require_roles(UserRole.TECHNICIAN))]
# A ficha do técnico: ver os documentos pede Técnicos em Visualizar (já mostra CPF e RG); mexer, e
# ver os anexos internos, em Editar.
TechniciansView = access_user("base.technicians")
TechniciansEdit = access_user("base.technicians", level="edit")

# Multipart (texto): os mesmos campos no app, na central e na ficha.
UploadField = Annotated[UploadFile | None, File()]
TextField = Annotated[str | None, Form()]


async def _limit(scope: str, key: str) -> None:
    """Até 30 envios por hora (por técnico no app; por IP na ficha): 429 com Retry-After."""
    try:
        await login_guard.hit(scope, key, svc.UPLOADS_PER_HOUR, svc.UPLOAD_WINDOW_SECONDS)
    except login_guard.RateLimited as exc:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            svc.TOO_MANY,
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc


async def _commit(db: DB, saved: svc.Saved) -> None:
    """Grava; não gravou, o arquivo novo sai do disco. Gravou, saem os que deixaram de ser usados
    (versões além de 3, o documento excluído)."""
    try:
        await db.commit()
    except BaseException:
        if saved.new_key:
            storage.delete(saved.new_key)
        raise
    svc.remove_files(saved.drop)


def _sees_internal(viewer: User) -> bool:
    """Anexo interno: só com Técnicos em Editar."""
    return permissions.of(viewer).can("base.technicians", "edit")


# ------------------------------------------------------------------ app do técnico


async def _app_done(db: DB, user: User, saved: svc.Saved) -> MyProfile:
    await _commit(db, saved)
    if saved.changes:
        await user_history.publish_changed(user, saved.changes, via=VIA_APP, actor=user)
    return await my_profile.profile(db, user)


@router.post("/me/profile/documents", response_model=MyProfile)
async def send_my_document(
    db: DB,
    user: TechnicianUser,
    file: UploadField = None,
    kind: TextField = None,
    title: TextField = None,
    expires_on: TextField = None,
    client_upload_id: TextField = None,
) -> MyProfile:
    """Multipart: `file` (PDF ou foto JPG/PNG/WebP, pelo conteúdo, até 10 MB), `kind`
    (certification, personal ou resume), `title` (2 a 80; o currículo é "Currículo"), `expires_on`
    (AAAA-MM-DD, só na certificação) e `client_upload_id` (UUID do app). O currículo com um atual
    troca o arquivo dele (o anterior vira versão). A mesma `client_upload_id` de novo não grava
    outro. Até 30 certificações e documentos pessoais (422 DOCUMENTS_LIMIT) e 30 envios por hora
    (429)."""
    await _limit(svc.APP_RATE_SCOPE, str(user.id))
    saved = await svc.add(
        db,
        svc.Owner(user=user),
        file,
        kind=kind,
        title=title,
        expires_on=expires_on,
        client_upload_id=client_upload_id,
        kinds=svc.TECHNICIAN_KINDS,
        actor=user,
        via=VIA_APP,
    )
    return await _app_done(db, user, saved)


@router.post("/me/profile/documents/{document_id}/replace", response_model=MyProfile)
async def replace_my_document(
    document_id: uuid.UUID,
    db: DB,
    user: TechnicianUser,
    file: UploadField = None,
    title: TextField = None,
    expires_on: TextField = None,
    client_upload_id: TextField = None,
) -> MyProfile:
    """Troca o arquivo (o anterior vira versão; ficam as 3 mais novas). `title` e `expires_on`
    ausentes mantêm; `expires_on` "" tira a validade. 404 DOCUMENT_NOT_FOUND quando não existe
    mais (ou não é dele)."""
    await _limit(svc.APP_RATE_SCOPE, str(user.id))
    saved = await svc.replace(
        db,
        svc.Owner(user=user),
        document_id,
        file,
        title=title,
        expires_on=expires_on,
        client_upload_id=client_upload_id,
        kinds=svc.TECHNICIAN_KINDS,
        actor=user,
        via=VIA_APP,
    )
    return await _app_done(db, user, saved)


@router.patch("/me/profile/documents/{document_id}", response_model=MyProfile)
async def edit_my_document(
    document_id: uuid.UUID, body: TechDocumentUpdate, db: DB, user: TechnicianUser
) -> MyProfile:
    """Título e validade (só o que vier; `expires_on` null tira). O tipo não muda."""
    saved = await svc.edit(
        db,
        svc.Owner(user=user),
        document_id,
        body,
        kinds=svc.TECHNICIAN_KINDS,
        actor=user,
        via=VIA_APP,
    )
    return await _app_done(db, user, saved)


@router.delete("/me/profile/documents/{document_id}", response_model=MyProfile)
async def delete_my_document(document_id: uuid.UUID, db: DB, user: TechnicianUser) -> MyProfile:
    """Exclui o documento e as versões (os arquivos saem do disco depois do commit)."""
    saved = await svc.remove(
        db,
        svc.Owner(user=user),
        document_id,
        kinds=svc.TECHNICIAN_KINDS,
        actor=user,
        via=VIA_APP,
    )
    return await _app_done(db, user, saved)


@router.get("/me/profile/documents/{document_id}/link", response_model=DocumentLinkOut)
async def my_document_link(document_id: uuid.UUID, db: DB, user: TechnicianUser) -> DocumentLinkOut:
    """O link assinado de 30 min do arquivo atual (foto abre na tela; PDF baixa)."""
    return await svc.link(db, user, document_id)


# ------------------------------------------------------------------ central


async def _central_commit(db: DB, technician: User, actor: User, saved: svc.Saved) -> None:
    await _commit(db, saved)
    if saved.changes:
        await user_history.publish_changed(technician, saved.changes, via=VIA_CENTRAL, actor=actor)


async def _central_done(db: DB, technician: User, actor: User, saved: svc.Saved) -> TechDocumentOut:
    """Grava, avisa e devolve o documento relido do banco (com as versões e os links)."""
    document = saved.document
    assert document is not None  # enviar, substituir e editar sempre devolvem o documento
    await _central_commit(db, technician, actor, saved)
    return await svc.one_document(db, document.id, actor)


@router.get("/technicians/{user_id}/documents", response_model=list[TechDocumentOut])
async def technician_documents(
    user_id: uuid.UUID, db: DB, viewer: TechniciansView
) -> list[TechDocumentOut]:
    """Os documentos atuais do técnico (certificações pela validade mais próxima, pessoais,
    currículo e, só com Técnicos Editar, os anexos internos), cada um com as versões (a mais nova
    primeiro) e os links de 30 min. 404 se não for técnico."""
    technician = await technicians.get_technician(db, user_id)
    return await svc.technician_documents(
        db, technician.id, viewer, internal=_sees_internal(viewer)
    )


@router.post(
    "/technicians/{user_id}/documents",
    response_model=TechDocumentOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_technician_document(
    user_id: uuid.UUID,
    response: Response,
    db: DB,
    actor: TechniciansEdit,
    file: UploadField = None,
    kind: TextField = None,
    title: TextField = None,
    expires_on: TextField = None,
    client_upload_id: TextField = None,
) -> TechDocumentOut:
    """Multipart como no app, com os quatro tipos (`internal`: anexo interno, sem validade). 201
    com o documento; 200 quando a `client_upload_id` repete ou o currículo trocou o arquivo do
    atual. Até 30 anexos internos (422 INTERNAL_LIMIT)."""
    technician = await technicians.get_technician(db, user_id)
    saved = await svc.add(
        db,
        svc.Owner(user=technician),
        file,
        kind=kind,
        title=title,
        expires_on=expires_on,
        client_upload_id=client_upload_id,
        kinds=svc.ALL_KINDS,
        actor=actor,
        via=VIA_CENTRAL,
    )
    if not saved.created:
        response.status_code = status.HTTP_200_OK
    return await _central_done(db, technician, actor, saved)


@router.post(
    "/technicians/{user_id}/documents/{document_id}/replace", response_model=TechDocumentOut
)
async def replace_technician_document(
    user_id: uuid.UUID,
    document_id: uuid.UUID,
    db: DB,
    actor: TechniciansEdit,
    file: UploadField = None,
    title: TextField = None,
    expires_on: TextField = None,
    client_upload_id: TextField = None,
) -> TechDocumentOut:
    """Troca o arquivo (o anterior vira versão). `title` e `expires_on` ausentes mantêm;
    `expires_on` "" tira a validade."""
    technician = await technicians.get_technician(db, user_id)
    saved = await svc.replace(
        db,
        svc.Owner(user=technician),
        document_id,
        file,
        title=title,
        expires_on=expires_on,
        client_upload_id=client_upload_id,
        kinds=svc.ALL_KINDS,
        actor=actor,
        via=VIA_CENTRAL,
    )
    return await _central_done(db, technician, actor, saved)


@router.patch("/technicians/{user_id}/documents/{document_id}", response_model=TechDocumentOut)
async def edit_technician_document(
    user_id: uuid.UUID,
    document_id: uuid.UUID,
    body: TechDocumentUpdate,
    db: DB,
    actor: TechniciansEdit,
) -> TechDocumentOut:
    """Título e validade (só o que vier; `expires_on` null tira). O tipo não muda."""
    technician = await technicians.get_technician(db, user_id)
    saved = await svc.edit(
        db,
        svc.Owner(user=technician),
        document_id,
        body,
        kinds=svc.ALL_KINDS,
        actor=actor,
        via=VIA_CENTRAL,
    )
    return await _central_done(db, technician, actor, saved)


@router.delete(
    "/technicians/{user_id}/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_technician_document(
    user_id: uuid.UUID, document_id: uuid.UUID, db: DB, actor: TechniciansEdit
) -> Response:
    """Exclui o documento e as versões (os arquivos saem do disco depois do commit)."""
    technician = await technicians.get_technician(db, user_id)
    saved = await svc.remove(
        db,
        svc.Owner(user=technician),
        document_id,
        kinds=svc.ALL_KINDS,
        actor=actor,
        via=VIA_CENTRAL,
    )
    await _central_commit(db, technician, actor, saved)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/technician-documents/{file_id}/download", response_model=None)
async def download_document(file_id: uuid.UUID, token: str, db: DB) -> FileResponse:
    """O arquivo (atual ou versão) pelo link assinado. Foto abre na tela; PDF baixa. Nada do que o
    navegador abrir daqui roda código (nosniff + CSP sandbox). 401 "Link expirado" / "Link
    inválido"; 404 DOCUMENT_NOT_FOUND ou FILE_MISSING."""
    svc.check_download_token(token, file_id)
    storage_key, content_type, file_name = await svc.file_for_download(db, file_id)
    try:
        path = storage.open_path(storage_key)
    except FileNotFoundError as exc:
        raise CodedError(FILE_MISSING, "FILE_MISSING", 404) from exc
    if not path.is_file():
        raise CodedError(FILE_MISSING, "FILE_MISSING", 404)
    inline = content_type.startswith("image/")
    return FileResponse(
        path,
        media_type=content_type,
        filename=file_name,
        content_disposition_type="inline" if inline else "attachment",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; sandbox",
        },
    )


# ------------------------------------------------------------------ ficha da homologação


def _ip(request: Request) -> str:
    return request.client.host if request.client else "sem-ip"


@public.post("", response_model=FichaDocumentOut, status_code=status.HTTP_201_CREATED)
async def send_ficha_document(
    request: Request,
    response: Response,
    db: DB,
    token: TextField = None,
    file: UploadField = None,
    kind: TextField = None,
    title: TextField = None,
    expires_on: TextField = None,
    client_upload_id: TextField = None,
) -> FichaDocumentOut:
    """Multipart: `token` (o upload_token do envio da ficha), `file`, `kind` (certification,
    personal ou resume), `title`, `expires_on` e `client_upload_id`. 201 com o arquivo; 200 quando
    a `client_upload_id` repete ou o currículo trocou o da ficha. 410 FICHA_UPLOAD_GONE (token
    vencido ou ficha que não existe mais), 409 APPLICATION_NOT_PENDING (já analisada), 422
    FICHA_DOCUMENTS_LIMIT (10 arquivos), 429 depois de 30 envios na hora do mesmo IP."""
    application = await svc.ficha_application(db, token)
    await _limit(svc.FICHA_RATE_SCOPE, _ip(request))
    saved = await svc.add(
        db,
        svc.Owner(application=application),
        file,
        kind=kind,
        title=title,
        expires_on=expires_on,
        client_upload_id=client_upload_id,
        kinds=svc.TECHNICIAN_KINDS,
        actor=None,
        via=VIA_FICHA,
    )
    document = saved.document
    assert document is not None
    out = svc.ficha_out(document)
    await _commit(db, saved)
    if not saved.created:
        response.status_code = status.HTTP_200_OK
    return out


@public.post("/{document_id}/remove", status_code=status.HTTP_204_NO_CONTENT)
async def remove_ficha_document(
    document_id: uuid.UUID, body: FichaDocumentRemove, db: DB
) -> Response:
    """Tira um arquivo da ficha do token, enquanto ela está pendente (410 e 409 como no envio; 404
    DOCUMENT_NOT_FOUND quando ele já saiu)."""
    application = await svc.ficha_application(db, body.token)
    saved = await svc.remove(
        db,
        svc.Owner(application=application),
        document_id,
        kinds=svc.TECHNICIAN_KINDS,
        actor=None,
        via=VIA_FICHA,
    )
    await _commit(db, saved)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
