"""Notas fiscais dos técnicos parceiros (services/invoices.py).

Técnico (app, aba Ganhos): envia, lista e apaga as próprias notas; só online (nada entra na fila
offline). Central (Pagamentos): ver e baixar pede Pagamentos em Visualizar; conferir, desfazer e
recusar, em Editar. A central nunca apaga nota (documento fiscal). O arquivo sai por link assinado
de 30 min, gerado só nas respostas de quem pode ver a nota.
"""

import uuid
from typing import Annotated

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.api.deps import DB, access_user, require_roles
from app.api.files import FILE_MISSING
from app.core.enums import InvoiceStatus, UserRole
from app.core.security import InvalidToken, decode_token
from app.models import TechnicianInvoice, User
from app.schemas.invoice import (
    InvoiceList,
    InvoiceOut,
    InvoicePayoutCandidate,
    InvoiceReject,
    MyInvoiceOut,
)
from app.services import invoices as svc
from app.services import storage

router = APIRouter(tags=["invoices"])

TechnicianUser = Annotated[User, Depends(require_roles(UserRole.TECHNICIAN))]
# A nota é de Pagamentos: ver e baixar, ou conferir, desfazer e recusar.
InvoicesView = access_user("commercial.payouts")
InvoicesEdit = access_user("commercial.payouts", level="edit")


# ------------------------------------------------------------------ técnico


@router.get("/me/invoices", response_model=list[MyInvoiceOut])
async def my_invoices(db: DB, user: TechnicianUser, month: str | None = None) -> list[MyInvoiceOut]:
    """As notas do técnico. `month` (AAAA-MM) filtra pela competência; sem ele, todas (até 200).
    As mais novas primeiro."""
    return await svc.my_invoices(db, user, svc.parse_month(month))


@router.get("/me/invoices/payouts", response_model=list[InvoicePayoutCandidate])
async def my_invoice_payouts(
    db: DB, user: TechnicianUser, month: str
) -> list[InvoicePayoutCandidate]:
    """Os valores que podem entrar numa nota da competência `month` (AAAA-MM): os do mês, de OS
    concluída ou já pagos (com qualquer situação de nota), e os de meses anteriores ainda a
    receber e sem nota (`in_month` false). Até 300."""
    when = svc.parse_month(month)
    if when is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, svc.BAD_MONTH)
    return await svc.payout_candidates(db, user, when)


@router.post("/me/invoices", response_model=MyInvoiceOut, status_code=status.HTTP_201_CREATED)
async def send_invoice(
    response: Response,
    db: DB,
    user: TechnicianUser,
    file: Annotated[UploadFile | None, File()] = None,
    number: Annotated[str | None, Form()] = None,
    issue_date: Annotated[str | None, Form()] = None,
    amount: Annotated[str | None, Form()] = None,
    competence: Annotated[str | None, Form()] = None,
    note: Annotated[str | None, Form()] = None,
    payout_ids: Annotated[str | None, Form()] = None,
    client_upload_id: Annotated[str | None, Form()] = None,
) -> MyInvoiceOut:
    """Multipart: `file` (PDF, XML ou foto JPG/PNG/WebP, pelo conteúdo, até 10 MB), `number`,
    `issue_date` (AAAA-MM-DD), `amount` ("1234.56"), `competence` (AAAA-MM), `note`,
    `payout_ids` (UUIDs separados por vírgula) e `client_upload_id` (UUID do app). 201 com a
    nota; 200 com a mesma nota quando a `client_upload_id` repete (resposta perdida)."""
    invoice, created = await svc.submit(
        db,
        user,
        file,
        number=number,
        issue_date=issue_date,
        amount=amount,
        competence=competence,
        note=note,
        payout_ids=payout_ids,
        client_upload_id=client_upload_id,
    )
    if created:
        try:
            await db.commit()
        except BaseException:
            # Não gravou: o arquivo não fica sobrando no disco.
            storage.delete(invoice.storage_key)
            raise
    else:
        response.status_code = status.HTTP_200_OK
    return (await svc.my_out(db, [invoice], user))[0]


@router.delete("/me/invoices/{invoice_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_my_invoice(invoice_id: uuid.UUID, db: DB, user: TechnicianUser) -> Response:
    """Apaga a própria nota enquanto a central não conferiu (422 depois). A de outro técnico: 404.
    As OS ficam livres e o arquivo sai do disco depois do commit."""
    key = await svc.delete_mine(db, user, invoice_id)
    await db.commit()
    storage.delete(key)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ------------------------------------------------------------------ central


@router.get("/technician-invoices", response_model=InvoiceList)
async def list_invoices(
    db: DB,
    user: InvoicesView,
    technician_id: uuid.UUID | None = None,
    status_: Annotated[InvoiceStatus | None, Query(alias="status")] = None,
    month: str | None = None,
    # Até o maior INTEGER do Postgres (acima disso o banco recusaria o OFFSET).
    offset: Annotated[int, Query(ge=0, le=2_147_483_647)] = 0,
) -> InvoiceList:
    """As notas de todos os técnicos (não segue a fila: a nota é do técnico, não da OS), até 500
    por vez. `status=pending` vem na ordem da fila (as mais antigas primeiro); sem `status` e nas
    outras situações, as mais novas primeiro. `offset` pula as primeiras (as próximas páginas).
    `month` (AAAA-MM) é a competência. `summary` conta e soma por situação só com os filtros de
    técnico e mês; `total_count` usa todos (o total do filtro, sem o offset)."""
    return await svc.list_invoices(
        db,
        user,
        technician_id=technician_id,
        status=status_,
        month=svc.parse_month(month),
        offset=offset,
    )


@router.post("/technician-invoices/{invoice_id}/check", response_model=InvoiceOut)
async def check_invoice(invoice_id: uuid.UUID, db: DB, user: InvoicesEdit) -> InvoiceOut:
    """Conferida (quem e quando). Já conferida: como está. Recusada: 422."""
    invoice = await svc.check(db, invoice_id, user)
    await db.commit()
    return (await svc.central_out(db, [invoice], user))[0]


@router.post("/technician-invoices/{invoice_id}/uncheck", response_model=InvoiceOut)
async def uncheck_invoice(invoice_id: uuid.UUID, db: DB, user: InvoicesEdit) -> InvoiceOut:
    """Desfaz a conferência (volta a aguardar). Aguardando: como está. Recusada: 422."""
    invoice = await svc.uncheck(db, invoice_id)
    await db.commit()
    return (await svc.central_out(db, [invoice], user))[0]


@router.post("/technician-invoices/{invoice_id}/reject", response_model=InvoiceOut)
async def reject_invoice(
    invoice_id: uuid.UUID, body: InvoiceReject, db: DB, user: InvoicesEdit
) -> InvoiceOut:
    """Recusa a nota que aguarda conferência, com o motivo (3 a 300 caracteres), e solta as OS.
    É final: o técnico apaga e envia outra. Conferida ou já recusada: 422."""
    invoice = await svc.reject(db, invoice_id, body.reason, user)
    await db.commit()
    return (await svc.central_out(db, [invoice], user))[0]


@router.get("/technician-invoices/{invoice_id}/download", response_model=None)
async def download_invoice(invoice_id: uuid.UUID, token: str, db: DB) -> FileResponse:
    """O arquivo por link assinado (gerado nas listas). Foto abre na tela; PDF e XML baixam. Nada
    do que o navegador abrir daqui roda código (nosniff + CSP sandbox)."""
    try:
        payload = decode_token(token, "download")
    except InvalidToken as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Link expirado") from exc
    if payload.get("sub") != f"invoice:{invoice_id}":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Link inválido")
    row = (
        await db.execute(
            select(
                TechnicianInvoice.storage_key,
                TechnicianInvoice.content_type,
                TechnicianInvoice.filename,
            ).where(TechnicianInvoice.id == invoice_id)
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, svc.NOT_FOUND)
    storage_key, content_type, filename = row
    try:
        path = storage.open_path(storage_key)
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, FILE_MISSING) from exc
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, FILE_MISSING)
    inline = content_type.startswith("image/") and "svg" not in content_type
    return FileResponse(
        path,
        media_type=content_type,
        filename=filename,
        content_disposition_type="inline" if inline else "attachment",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; sandbox",
        },
    )
