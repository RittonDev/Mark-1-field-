"""Notas fiscais dos técnicos parceiros (services/invoices.py)."""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, StringConstraints

from app.core.enums import InvoiceStatus, PayoutStatus
from app.schemas.common import Ref
from app.schemas.expense import Money
from app.schemas.payout import PayoutInvoiceRef

# Tipo do arquivo pelo conteúdo: PDF, XML ou foto.
InvoiceFileKind = Literal["pdf", "xml", "image"]


class InvoicePayoutRef(BaseModel):
    """Uma OS da nota: o valor do técnico nela."""

    payout_id: uuid.UUID
    ticket_id: uuid.UUID
    code: str
    title: str
    amount: Money
    status: PayoutStatus
    # OS resolvida ou fechada.
    concluded: bool


class MyInvoiceOut(BaseModel):
    """A nota para o próprio técnico (app, aba Ganhos)."""

    id: uuid.UUID
    number: str
    issue_date: date
    amount: Money
    # "AAAA-MM": o mês do serviço.
    competence: str
    note: str | None
    status: InvoiceStatus
    reject_reason: str | None
    reviewed_at: datetime | None
    filename: str
    content_type: str
    size_bytes: int
    file_kind: InvoiceFileKind
    # Link assinado de 30 min (GET /technician-invoices/{id}/download?token=).
    download_url: str
    payouts: list[InvoicePayoutRef]
    payouts_total: Money
    created_at: datetime


class InvoiceOut(MyInvoiceOut):
    """A nota para a central (Pagamentos)."""

    technician: Ref
    reviewed_by: Ref | None


class InvoiceSummary(BaseModel):
    """Contagem e soma por situação, com os filtros de técnico e mês (sem o de situação)."""

    pending: int = 0
    checked: int = 0
    rejected: int = 0
    pending_amount: Money = Decimal("0")
    checked_amount: Money = Decimal("0")


class InvoiceList(BaseModel):
    items: list[InvoiceOut]
    summary: InvoiceSummary
    # Quantas notas batem com todos os filtros (a lista vem até o limite).
    total_count: int = 0


class InvoiceReject(BaseModel):
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=300)]


class InvoicePayoutCandidate(BaseModel):
    """Um valor do técnico que pode entrar na nota (GET /me/invoices/payouts)."""

    payout_id: uuid.UUID
    ticket_id: uuid.UUID
    code: str
    title: str
    amount: Money
    status: PayoutStatus
    resolved_at: datetime | None
    # Concluída (ou paga) no mês da competência; false = de um mês anterior, ainda a receber.
    in_month: bool
    # Já está numa nota (só as do mês aparecem assim).
    invoice: PayoutInvoiceRef | None
