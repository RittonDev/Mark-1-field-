"""Notas fiscais dos técnicos parceiros (opcionais).

O técnico emite a nota no portal da prefeitura e envia pelo app (aba Ganhos): número, emissão, valor,
competência (o mês do serviço), observação, o arquivo (PDF, XML ou foto, conferido pelo conteúdo) e
as OS que ela cobre (ticket_payouts.invoice_id: cada valor em no máximo uma nota). A central confere
em Pagamentos: conferir, desfazer a conferência ou recusar com motivo. A recusa é final e solta as
OS: o técnico apaga a nota e envia outra. Só o técnico apaga, e só enquanto a central não conferiu; a
central nunca apaga (documento fiscal).

A nota nunca trava pagamento. Sem push, tempo real ou histórico da OS. O técnico só vê as dele; quem
tem Pagamentos vê as de todos os técnicos (a nota é do técnico, não da OS: não segue a fila).
"""

import re
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from pathlib import PurePosixPath
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import UploadFile
from sqlalchemy import and_, case, func, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.enums import InvoiceStatus, PayoutStatus
from app.core.security import create_token
from app.db.base import utcnow
from app.models.invoice import TechnicianInvoice
from app.models.payout import TicketPayout
from app.models.ticket import Ticket
from app.models.user import User
from app.schemas.common import Ref
from app.schemas.invoice import (
    InvoiceList,
    InvoiceOut,
    InvoicePayoutCandidate,
    InvoicePayoutRef,
    InvoiceSummary,
    MyInvoiceOut,
)
from app.schemas.payout import PayoutInvoiceRef
from app.schemas.ticket import format_ticket_code
from app.services import storage
from app.services.errors import NotFound, WorkflowError
from app.services.payouts import CONCLUDED

# Limites (os mesmos de INVOICE_LIMITS em constants.ts).
INVOICE_MAX_MB = 10
LINK_MINUTES = 30
MAX_PAYOUTS = 200
PER_MONTH = 20
NUMBER_MAX = 30
NOTE_MAX = 500
MINE_LIMIT = 200
LIST_LIMIT = 500
CANDIDATES_LIMIT = 300

FIRST_DAY = date(2000, 1, 1)
CENT = Decimal("0.01")
# Numeric(12, 2): até 9.999.999.999,99.
MAX_AMOUNT = Decimal("10000000000")
# O que a nota pode ser (pelo conteúdo): PDF, XML ou foto. GIF não é foto de nota.
ALLOWED_TYPES = frozenset(
    {"application/pdf", "application/xml", "image/jpeg", "image/png", "image/webp"}
)

NO_FILE = "Escolha o arquivo da nota"
EMPTY_FILE = "O arquivo da nota está vazio"
BAD_TYPE = "Envie a nota em PDF, XML ou foto (JPG, PNG ou WebP)"
NO_NUMBER = "Informe o número da nota"
LONG_NUMBER = f"O número da nota tem no máximo {NUMBER_MAX} caracteres"
NO_ISSUE_DATE = "Informe a data de emissão"
BAD_ISSUE_DATE = "Data de emissão inválida (use AAAA-MM-DD)"
FUTURE_ISSUE_DATE = "A data de emissão não pode ser no futuro"
NO_AMOUNT = "Informe o valor da nota"
BAD_AMOUNT = "Valor inválido"
NOT_POSITIVE = "O valor da nota precisa ser maior que zero"
NO_COMPETENCE = "Informe a competência"
BAD_COMPETENCE = "Competência inválida (use AAAA-MM)"
FUTURE_COMPETENCE = "A competência não pode ser um mês que ainda não chegou"
LONG_NOTE = f"A observação tem no máximo {NOTE_MAX} caracteres"
TOO_MANY_PAYOUTS = f"Escolha até {MAX_PAYOUTS} OS por nota"
BAD_UPLOAD_ID = "Envio inválido: atualize o app e tente de novo"
NOT_YOURS = "Uma das OS escolhidas não é sua"
NOT_CONCLUDED = "A {code} ainda não foi concluída"
IN_OTHER_INVOICE = "A {code} já está na nota nº {number}"
REPEATED_NUMBER = "A nota nº {number} já foi enviada"
MONTH_FULL = (
    f"Limite de {PER_MONTH} notas por competência: apague as recusadas para enviar outra"
)
NOT_FOUND = "Nota fiscal não encontrada"
CHECKED_LOCKED = "A central já conferiu esta nota: ela não pode mais ser apagada"
REJECTED_FINAL = "Nota recusada: o técnico envia outra"
ALREADY_REJECTED = "Esta nota já foi recusada"
UNCHECK_FIRST = "Desfaça a conferência antes de recusar"
BAD_MONTH = "Mês inválido (use AAAA-MM)"

_MONTH_RE = re.compile(r"(\d{4})-(\d{2})")
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_AMOUNT_RE = re.compile(r"-?\d{1,20}(?:\.\d{1,20})?")


# --------------------------------------------------------------------------- datas e campos


def _today() -> date:
    """Hoje no fuso da operação."""
    return datetime.now(ZoneInfo(settings.TIMEZONE)).date()


def _month(raw: str, message: str) -> date:
    """ "AAAA-MM" → o dia 1 do mês (de 2000-01 a 2100-12)."""
    match = _MONTH_RE.fullmatch(raw)
    if match is None:
        raise WorkflowError(message)
    year, month = int(match[1]), int(match[2])
    if not (2000 <= year <= 2100 and 1 <= month <= 12):
        raise WorkflowError(message)
    return date(year, month, 1)


def parse_month(value: str | None) -> date | None:
    """O filtro `month` das listas ("AAAA-MM"). Vazio: None."""
    raw = (value or "").strip()
    return _month(raw, BAD_MONTH) if raw else None


def month_text(month: date) -> str:
    return f"{month.year:04d}-{month.month:02d}"


def _month_bounds(month: date) -> tuple[datetime, datetime]:
    """Início do mês e do mês seguinte no fuso da operação."""
    tz = ZoneInfo(settings.TIMEZONE)
    next_month = (month + timedelta(days=32)).replace(day=1)
    return (
        datetime.combine(month, time.min, tzinfo=tz),
        datetime.combine(next_month, time.min, tzinfo=tz),
    )


def number_key(number: str) -> str:
    """Chave para comparar números de nota: sem espaços, em maiúsculas e sem zeros à esquerda
    ("0001 234" e "1234" são a mesma nota)."""
    compact = "".join(number.split()).upper()
    return compact.lstrip("0") or "0"


@dataclass(frozen=True)
class InvoiceForm:
    """Os campos do envio já conferidos."""

    number: str
    issue_date: date
    amount: Decimal
    competence: date
    note: str | None
    payout_ids: list[uuid.UUID]
    client_upload_id: uuid.UUID | None


def _number(value: str | None) -> str:
    number = (value or "").strip()
    if not number:
        raise WorkflowError(NO_NUMBER)
    if len(number) > NUMBER_MAX:
        raise WorkflowError(LONG_NUMBER)
    return number


def _issue_date(value: str | None) -> date:
    raw = (value or "").strip()
    if not raw:
        raise WorkflowError(NO_ISSUE_DATE)
    if _DATE_RE.fullmatch(raw) is None:
        raise WorkflowError(BAD_ISSUE_DATE)
    try:
        issued = date.fromisoformat(raw)
    except ValueError as exc:
        raise WorkflowError(BAD_ISSUE_DATE) from exc
    if issued < FIRST_DAY:
        raise WorkflowError(BAD_ISSUE_DATE)
    if issued > _today():
        raise WorkflowError(FUTURE_ISSUE_DATE)
    return issued


def _amount(value: str | None) -> Decimal:
    """ "1234.56" (ponto e até 2 casas, como o app manda)."""
    raw = (value or "").strip()
    if not raw:
        raise WorkflowError(NO_AMOUNT)
    if _AMOUNT_RE.fullmatch(raw) is None:
        raise WorkflowError(BAD_AMOUNT)
    amount = Decimal(raw)
    if amount <= 0:
        raise WorkflowError(NOT_POSITIVE)
    if amount >= MAX_AMOUNT or amount != amount.quantize(CENT):
        raise WorkflowError(BAD_AMOUNT)
    return amount.quantize(CENT)


def _competence(value: str | None) -> date:
    raw = (value or "").strip()
    if not raw:
        raise WorkflowError(NO_COMPETENCE)
    month = _month(raw, BAD_COMPETENCE)
    if month > _today().replace(day=1):
        raise WorkflowError(FUTURE_COMPETENCE)
    return month


def _note(value: str | None) -> str | None:
    note = (value or "").strip()
    if len(note) > NOTE_MAX:
        raise WorkflowError(LONG_NOTE)
    return note or None


def _payout_ids(value: str | None) -> list[uuid.UUID]:
    """UUIDs separados por vírgula (sem repetir)."""
    parts = list(dict.fromkeys(p.strip() for p in (value or "").split(",") if p.strip()))
    if len(parts) > MAX_PAYOUTS:
        raise WorkflowError(TOO_MANY_PAYOUTS)
    try:
        return list(dict.fromkeys(uuid.UUID(p) for p in parts))
    except ValueError as exc:
        raise WorkflowError(NOT_YOURS) from exc


def _upload_id(value: str | None) -> uuid.UUID | None:
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        return uuid.UUID(raw)
    except ValueError as exc:
        raise WorkflowError(BAD_UPLOAD_ID) from exc


def read_form(
    *,
    number: str | None,
    issue_date: str | None,
    amount: str | None,
    competence: str | None,
    note: str | None = None,
    payout_ids: str | None = None,
    client_upload_id: str | None = None,
) -> InvoiceForm:
    """Os campos do multipart (texto), nesta ordem, com a mensagem de cada um (422)."""
    return InvoiceForm(
        number=_number(number),
        issue_date=_issue_date(issue_date),
        amount=_amount(amount),
        competence=_competence(competence),
        note=_note(note),
        payout_ids=_payout_ids(payout_ids),
        client_upload_id=_upload_id(client_upload_id),
    )


# --------------------------------------------------------------------------- envio (técnico)


async def _lock_technician(db: AsyncSession, technician_id: uuid.UUID) -> None:
    """Um envio por vez de cada técnico, até o fim da transação: o mesmo envio repetido (o app
    desiste da resposta e manda de novo), o limite do mês e o número repetido são conferidos lendo
    o banco antes de gravar."""
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"invoices:{technician_id}"},
    )


async def _lock_payouts(
    db: AsyncSession, technician_id: uuid.UUID, ids: list[uuid.UUID]
) -> list[TicketPayout]:
    """Os valores escolhidos, travados (FOR UPDATE): do técnico, com a OS concluída (ou já pagos)
    e sem outra nota."""
    if not ids:
        return []
    # Trava só as linhas dos valores; a leitura vem depois, já com as linhas travadas.
    await db.execute(
        select(TicketPayout.id).where(TicketPayout.id.in_(ids)).with_for_update()
    )
    rows = (
        await db.execute(
            select(TicketPayout, Ticket.number, Ticket.status)
            .join(Ticket, Ticket.id == TicketPayout.ticket_id)
            .where(TicketPayout.id.in_(ids))
            .execution_options(populate_existing=True)
        )
    ).all()
    found = {payout.id: (payout, number, status) for payout, number, status in rows}
    if len(found) != len(ids) or any(p.technician_id != technician_id for p, _, _ in rows):
        raise WorkflowError(NOT_YOURS)
    linked = {p.invoice_id for p, _, _ in rows if p.invoice_id is not None}
    numbers: dict[uuid.UUID, str] = {}
    if linked:
        numbers = {
            invoice_id: number
            for invoice_id, number in await db.execute(
                select(TechnicianInvoice.id, TechnicianInvoice.number).where(
                    TechnicianInvoice.id.in_(linked)
                )
            )
        }
    for payout_id in ids:
        payout, ticket_number, ticket_status = found[payout_id]
        code = format_ticket_code(ticket_number)
        if ticket_status not in CONCLUDED and payout.status != PayoutStatus.PAID:
            raise WorkflowError(NOT_CONCLUDED.format(code=code))
        if payout.invoice_id is not None:
            number = numbers.get(payout.invoice_id, "")
            raise WorkflowError(IN_OTHER_INVOICE.format(code=code, number=number))
    return [found[payout_id][0] for payout_id in ids]


async def _sniff(upload: UploadFile) -> str:
    """O tipo real pelo começo do arquivo (não pelo nome nem pelo que o aparelho declarou)."""
    head = await upload.read(1024)
    await upload.seek(0)
    if not head:
        raise WorkflowError(EMPTY_FILE)
    content_type = storage.sniff_document(head)
    if content_type not in ALLOWED_TYPES:
        raise WorkflowError(BAD_TYPE)
    return content_type


def _filename(upload: UploadFile) -> str:
    name = PurePosixPath((upload.filename or "").replace("\\", "/")).name.strip()
    return (name or "nota")[:255]


async def submit(
    db: AsyncSession,
    technician: User,
    upload: UploadFile | None,
    *,
    number: str | None,
    issue_date: str | None,
    amount: str | None,
    competence: str | None,
    note: str | None = None,
    payout_ids: str | None = None,
    client_upload_id: str | None = None,
) -> tuple[TechnicianInvoice, bool]:
    """Recebe a nota do técnico (os campos do multipart, em texto). Devolve (nota, criada).

    A mesma `client_upload_id` de novo devolve a nota já gravada, sem gravar nada (criada = False).
    Tudo no banco é conferido antes de gravar o arquivo; se a gravação no banco falhar depois, o
    arquivo sai do disco (a rota faz o mesmo se o commit falhar)."""
    if upload is None:
        raise WorkflowError(NO_FILE)
    form = read_form(
        number=number,
        issue_date=issue_date,
        amount=amount,
        competence=competence,
        note=note,
        payout_ids=payout_ids,
        client_upload_id=client_upload_id,
    )
    await _lock_technician(db, technician.id)
    if form.client_upload_id is not None:
        existing = await db.scalar(
            select(TechnicianInvoice).where(
                TechnicianInvoice.technician_id == technician.id,
                TechnicianInvoice.client_upload_id == form.client_upload_id,
            )
        )
        if existing is not None:
            return existing, False
    in_month = await db.scalar(
        select(func.count())
        .select_from(TechnicianInvoice)
        .where(
            TechnicianInvoice.technician_id == technician.id,
            TechnicianInvoice.competence == form.competence,
        )
    )
    if (in_month or 0) >= PER_MONTH:
        raise WorkflowError(MONTH_FULL)
    key = number_key(form.number)
    for other in await db.scalars(
        select(TechnicianInvoice.number).where(
            TechnicianInvoice.technician_id == technician.id,
            TechnicianInvoice.status != InvoiceStatus.REJECTED,
        )
    ):
        if number_key(other) == key:
            raise WorkflowError(REPEATED_NUMBER.format(number=other))
    payouts = await _lock_payouts(db, technician.id, form.payout_ids)
    content_type = await _sniff(upload)
    try:
        storage_key, size = await storage.save_upload_in(
            f"invoices/{technician.id}", upload, max_mb=INVOICE_MAX_MB
        )
    except storage.UploadTooLarge as exc:
        raise WorkflowError(str(exc)) from exc
    invoice = TechnicianInvoice(
        id=uuid.uuid4(),
        technician_id=technician.id,
        client_upload_id=form.client_upload_id,
        number=form.number,
        issue_date=form.issue_date,
        amount=form.amount,
        competence=form.competence,
        note=form.note,
        status=InvoiceStatus.PENDING,
        filename=_filename(upload),
        content_type=content_type,
        size_bytes=size,
        storage_key=storage_key,
    )
    try:
        db.add(invoice)
        await db.flush()  # a nota existe antes de os valores apontarem para ela
        for payout in payouts:
            payout.invoice_id = invoice.id
        await db.flush()
    except BaseException:
        storage.delete(storage_key)
        raise
    return invoice, True


async def _release(db: AsyncSession, invoice_id: uuid.UUID) -> None:
    """Solta as OS da nota (recusada ou apagada): os valores ficam livres para outra nota."""
    await db.execute(
        update(TicketPayout).where(TicketPayout.invoice_id == invoice_id).values(invoice_id=None)
    )


async def _locked(
    db: AsyncSession, invoice_id: uuid.UUID, *, technician_id: uuid.UUID | None = None
) -> TechnicianInvoice:
    """A nota travada (FOR UPDATE). Com `technician_id`, só a dele: a de outro técnico é 404."""
    stmt = select(TechnicianInvoice.id).where(TechnicianInvoice.id == invoice_id)
    if technician_id is not None:
        stmt = stmt.where(TechnicianInvoice.technician_id == technician_id)
    if await db.scalar(stmt.with_for_update()) is None:
        raise NotFound(NOT_FOUND)
    # Lida depois da trava (a leitura vê o que a outra transação gravou antes de soltar a linha).
    invoice = await db.scalar(
        select(TechnicianInvoice)
        .where(TechnicianInvoice.id == invoice_id)
        .execution_options(populate_existing=True)
    )
    if invoice is None:
        raise NotFound(NOT_FOUND)
    return invoice


async def delete_mine(db: AsyncSession, technician: User, invoice_id: uuid.UUID) -> str:
    """O técnico apaga a própria nota enquanto a central não conferiu (a recusada também). Devolve
    a storage_key: o arquivo só sai do disco depois do commit."""
    invoice = await _locked(db, invoice_id, technician_id=technician.id)
    if invoice.status == InvoiceStatus.CHECKED:
        raise WorkflowError(CHECKED_LOCKED)
    await _release(db, invoice.id)
    await db.delete(invoice)
    await db.flush()
    return invoice.storage_key


# --------------------------------------------------------------------------- conferência (central)


async def check(db: AsyncSession, invoice_id: uuid.UUID, actor: User) -> TechnicianInvoice:
    """Aguardando → conferida (quem e quando). Já conferida: nada muda. Recusada: 422."""
    invoice = await _locked(db, invoice_id)
    if invoice.status == InvoiceStatus.REJECTED:
        raise WorkflowError(REJECTED_FINAL)
    if invoice.status == InvoiceStatus.PENDING:
        invoice.status = InvoiceStatus.CHECKED
        invoice.reviewed_at = utcnow()
        invoice.reviewed_by = actor
        await db.flush()
    return invoice


async def uncheck(db: AsyncSession, invoice_id: uuid.UUID) -> TechnicianInvoice:
    """Conferida → aguardando (limpa quem e quando). Aguardando: nada muda. Recusada: 422."""
    invoice = await _locked(db, invoice_id)
    if invoice.status == InvoiceStatus.REJECTED:
        raise WorkflowError(REJECTED_FINAL)
    if invoice.status == InvoiceStatus.CHECKED:
        invoice.status = InvoiceStatus.PENDING
        invoice.reviewed_at = None
        invoice.reviewed_by = None
        await db.flush()
    return invoice


async def reject(
    db: AsyncSession, invoice_id: uuid.UUID, reason: str, actor: User
) -> TechnicianInvoice:
    """Só a que aguarda conferência: recusada com o motivo, e as OS ficam livres. É final (o
    técnico apaga e envia outra)."""
    invoice = await _locked(db, invoice_id)
    if invoice.status == InvoiceStatus.REJECTED:
        raise WorkflowError(ALREADY_REJECTED)
    if invoice.status == InvoiceStatus.CHECKED:
        raise WorkflowError(UNCHECK_FIRST)
    invoice.status = InvoiceStatus.REJECTED
    invoice.reject_reason = reason
    invoice.reviewed_at = utcnow()
    invoice.reviewed_by = actor
    await _release(db, invoice.id)
    await db.flush()
    return invoice


# --------------------------------------------------------------------------- respostas


def download_url(invoice_id: uuid.UUID, viewer: User) -> str:
    """Link assinado de 30 min para o arquivo (sub "invoice:{id}"; o uid diz quem pediu)."""
    token = create_token(
        f"invoice:{invoice_id}",
        "download",
        timedelta(minutes=LINK_MINUTES),
        {"uid": str(viewer.id)},
    )
    return f"{settings.API_PREFIX}/technician-invoices/{invoice_id}/download?token={token}"


def file_kind(content_type: str) -> str:
    if content_type == "application/pdf":
        return "pdf"
    if content_type == "application/xml":
        return "xml"
    return "image"


async def _payout_refs(
    db: AsyncSession, invoices: list[TechnicianInvoice]
) -> dict[uuid.UUID, list[InvoicePayoutRef]]:
    """As OS de cada nota, numa consulta só (só os valores do próprio técnico da nota)."""
    owners = {invoice.id: invoice.technician_id for invoice in invoices}
    refs: dict[uuid.UUID, list[InvoicePayoutRef]] = {invoice_id: [] for invoice_id in owners}
    if not owners:
        return refs
    rows = await db.execute(
        select(
            TicketPayout.invoice_id,
            TicketPayout.technician_id,
            TicketPayout.id,
            TicketPayout.amount,
            TicketPayout.status,
            Ticket.id,
            Ticket.number,
            Ticket.title,
            Ticket.status,
        )
        .join(Ticket, Ticket.id == TicketPayout.ticket_id)
        .where(TicketPayout.invoice_id.in_(list(owners)))
        .order_by(Ticket.number, TicketPayout.id)
    )
    for (
        invoice_id,
        technician_id,
        payout_id,
        amount,
        payout_status,
        ticket_id,
        number,
        title,
        ticket_status,
    ) in rows:
        if owners.get(invoice_id) != technician_id:
            continue
        refs[invoice_id].append(
            InvoicePayoutRef(
                payout_id=payout_id,
                ticket_id=ticket_id,
                code=format_ticket_code(number),
                title=title,
                amount=amount,
                status=payout_status,
                concluded=ticket_status in CONCLUDED,
            )
        )
    return refs


def _fields(
    invoice: TechnicianInvoice, refs: list[InvoicePayoutRef], viewer: User
) -> dict[str, Any]:
    return {
        "id": invoice.id,
        "number": invoice.number,
        "issue_date": invoice.issue_date,
        "amount": invoice.amount,
        "competence": month_text(invoice.competence),
        "note": invoice.note,
        "status": invoice.status,
        "reject_reason": invoice.reject_reason,
        "reviewed_at": invoice.reviewed_at,
        "filename": invoice.filename,
        "content_type": invoice.content_type,
        "size_bytes": invoice.size_bytes,
        "file_kind": file_kind(invoice.content_type),
        "download_url": download_url(invoice.id, viewer),
        "payouts": refs,
        "payouts_total": sum((ref.amount for ref in refs), Decimal("0")),
        "created_at": invoice.created_at,
    }


async def my_out(
    db: AsyncSession, invoices: list[TechnicianInvoice], viewer: User
) -> list[MyInvoiceOut]:
    """Para o técnico: sem o nome de quem conferiu."""
    refs = await _payout_refs(db, invoices)
    return [MyInvoiceOut(**_fields(i, refs[i.id], viewer)) for i in invoices]


async def central_out(
    db: AsyncSession, invoices: list[TechnicianInvoice], viewer: User
) -> list[InvoiceOut]:
    refs = await _payout_refs(db, invoices)
    return [
        InvoiceOut(
            **_fields(i, refs[i.id], viewer),
            technician=Ref(id=i.technician.id, name=i.technician.name),
            reviewed_by=Ref(id=i.reviewed_by.id, name=i.reviewed_by.name) if i.reviewed_by else None,
        )
        for i in invoices
    ]


# --------------------------------------------------------------------------- listas


async def my_invoices(db: AsyncSession, user: User, month: date | None) -> list[MyInvoiceOut]:
    """As notas do técnico (da competência ou todas), as mais novas primeiro."""
    stmt = select(TechnicianInvoice).where(TechnicianInvoice.technician_id == user.id)
    if month is not None:
        stmt = stmt.where(TechnicianInvoice.competence == month)
    invoices = list(
        await db.scalars(
            stmt.order_by(TechnicianInvoice.created_at.desc(), TechnicianInvoice.id).limit(
                MINE_LIMIT
            )
        )
    )
    return await my_out(db, invoices, user)


async def payout_candidates(
    db: AsyncSession, user: User, month: date
) -> list[InvoicePayoutCandidate]:
    """Os valores do técnico que podem entrar numa nota da competência: os do mês (OS concluída
    ou valor pago, com qualquer situação de nota) e os de meses anteriores ainda a receber, de OS
    concluída e sem nota. A data é a da conclusão (sem ela, a do lançamento), no fuso da operação.
    Primeiro os do mês, depois os anteriores, por data."""
    start, end = _month_bounds(month)
    when = func.coalesce(Ticket.resolved_at, TicketPayout.created_at)
    concluded = Ticket.status.in_(CONCLUDED)
    in_month = and_(when >= start, when < end)
    earlier = and_(
        when < start,
        TicketPayout.status == PayoutStatus.PENDING,
        concluded,
        TicketPayout.invoice_id.is_(None),
    )
    rows = await db.execute(
        select(
            TicketPayout.id,
            Ticket.id,
            Ticket.number,
            Ticket.title,
            TicketPayout.amount,
            TicketPayout.status,
            Ticket.resolved_at,
            when,
            TechnicianInvoice.id,
            TechnicianInvoice.number,
            TechnicianInvoice.status,
        )
        .join(Ticket, Ticket.id == TicketPayout.ticket_id)
        .outerjoin(
            TechnicianInvoice,
            and_(
                TechnicianInvoice.id == TicketPayout.invoice_id,
                TechnicianInvoice.technician_id == TicketPayout.technician_id,
            ),
        )
        .where(
            TicketPayout.technician_id == user.id,
            or_(concluded, TicketPayout.status == PayoutStatus.PAID),
            or_(in_month, earlier),
        )
        .order_by(case((in_month, 0), else_=1), when, TicketPayout.id)
        .limit(CANDIDATES_LIMIT)
    )
    out: list[InvoicePayoutCandidate] = []
    for (
        payout_id,
        ticket_id,
        number,
        title,
        amount,
        payout_status,
        resolved_at,
        at,
        invoice_id,
        invoice_number,
        invoice_status,
    ) in rows:
        invoice = None
        if invoice_id is not None:
            invoice = PayoutInvoiceRef(id=invoice_id, number=invoice_number, status=invoice_status)
        out.append(
            InvoicePayoutCandidate(
                payout_id=payout_id,
                ticket_id=ticket_id,
                code=format_ticket_code(number),
                title=title,
                amount=amount,
                status=payout_status,
                resolved_at=resolved_at,
                in_month=start <= at < end,
                invoice=invoice,
            )
        )
    return out


async def list_invoices(
    db: AsyncSession,
    viewer: User,
    *,
    technician_id: uuid.UUID | None = None,
    status: InvoiceStatus | None = None,
    month: date | None = None,
) -> InvoiceList:
    """Central (Pagamentos): as notas de todos os técnicos, as mais novas primeiro (até 500). O
    resumo usa só os filtros de técnico e mês (os contadores das abas); total_count, todos."""
    base: list[Any] = []
    if technician_id is not None:
        base.append(TechnicianInvoice.technician_id == technician_id)
    if month is not None:
        base.append(TechnicianInvoice.competence == month)
    conds = [*base]
    if status is not None:
        conds.append(TechnicianInvoice.status == status)
    invoices = list(
        await db.scalars(
            select(TechnicianInvoice)
            .where(*conds)
            .order_by(TechnicianInvoice.created_at.desc(), TechnicianInvoice.id)
            .limit(LIST_LIMIT)
        )
    )
    total = await db.scalar(select(func.count()).select_from(TechnicianInvoice).where(*conds))
    pending = TechnicianInvoice.status == InvoiceStatus.PENDING
    checked = TechnicianInvoice.status == InvoiceStatus.CHECKED
    rejected = TechnicianInvoice.status == InvoiceStatus.REJECTED
    n_pending, n_checked, n_rejected, pending_amount, checked_amount = (
        await db.execute(
            select(
                func.count().filter(pending),
                func.count().filter(checked),
                func.count().filter(rejected),
                func.coalesce(func.sum(TechnicianInvoice.amount).filter(pending), 0),
                func.coalesce(func.sum(TechnicianInvoice.amount).filter(checked), 0),
            )
            .select_from(TechnicianInvoice)
            .where(*base)
        )
    ).one()
    summary = InvoiceSummary(
        pending=n_pending,
        checked=n_checked,
        rejected=n_rejected,
        pending_amount=Decimal(pending_amount),
        checked_amount=Decimal(checked_amount),
    )
    return InvoiceList(
        items=await central_out(db, invoices, viewer), summary=summary, total_count=total or 0
    )
