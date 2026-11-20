"""Valor de cada técnico por OS (técnicos parceiros, pagos por chamado)."""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field

from app.core.enums import InvoiceStatus, PayoutStatus, TicketStatus
from app.schemas.common import ORMModel, Ref
from app.schemas.expense import Money
from app.schemas.my_profile import PixInfo


class PayoutOut(ORMModel):
    id: uuid.UUID
    ticket_id: uuid.UUID
    technician: Ref
    amount: Money
    status: PayoutStatus
    note: str | None
    paid_at: datetime | None
    created_at: datetime


class MyPayout(BaseModel):
    """O que o técnico vê na OS dele: só o próprio valor."""

    amount: Money
    status: PayoutStatus
    paid_at: datetime | None


class PayoutIn(BaseModel):
    amount: Decimal = Field(ge=0, max_digits=12, decimal_places=2)
    note: str | None = Field(default=None, max_length=500)


class PayoutTicketRef(BaseModel):
    id: uuid.UUID
    code: str
    title: str
    status: TicketStatus
    customer: str | None
    location: str | None
    city: str | None
    resolved_at: datetime | None


class PayoutInvoiceRef(BaseModel):
    """A nota fiscal do técnico que cobre o valor (services/invoices.py)."""

    id: uuid.UUID
    number: str
    status: InvoiceStatus


class PayoutLine(BaseModel):
    id: uuid.UUID
    technician: Ref
    amount: Money
    status: PayoutStatus
    note: str | None
    paid_at: datetime | None
    # OS concluída (resolvida ou fechada) entra no "a pagar"; aberta ainda é previsão.
    concluded: bool
    # OS cancelada: o valor pendente não é previsão (só sai se a central decidir pagar).
    cancelled: bool = False
    ticket: PayoutTicketRef
    # Nota fiscal do técnico que cobre este valor (a recusada solta o valor: volta a null).
    invoice: PayoutInvoiceRef | None = None


class PayoutSummary(BaseModel):
    to_pay: Money = Decimal("0")
    expected: Money = Decimal("0")
    paid: Money = Decimal("0")
    # Pendente de OS cancelada (fora do "a pagar" e do "previsto").
    cancelled: Money = Decimal("0")


class PayoutList(BaseModel):
    items: list[PayoutLine]
    summary: PayoutSummary
    # Quantos valores batem com o filtro (a lista mostra até o limite; o resumo soma todos).
    total_count: int = 0


class PayoutBoard(PayoutList):
    """GET /payouts (central). Com with_pix=true, a chave PIX de cada técnico das linhas (e do
    filtro technician_id) que tem chave; sem ele, vazio."""

    pix: dict[uuid.UUID, PixInfo] = {}


class MyEarnings(PayoutList):
    """Meus ganhos (app do técnico): os chamados e os reembolsos de custos extras."""

    reimbursement_to_receive: Money = Decimal("0")
    reimbursement_paid: Money = Decimal("0")


class PayoutIds(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=500)


# --------------------------------------------------------------------------- faturamento do app

# Situação de um mês no Faturamento (services/payouts.month_state, nesta prioridade): "rejected",
# "empty" (mês sem OS), "in_progress", "partial", "no_invoice", "in_review", "to_pay",
# "paid_no_invoice" e "paid". A nota nunca trava o pagamento: "no_invoice" é só informativo.
EarningsMonthState = Literal[
    "empty",
    "in_progress",
    "no_invoice",
    "in_review",
    "rejected",
    "to_pay",
    "partial",
    "paid_no_invoice",
    "paid",
]


class EarningsBucket(BaseModel):
    """Quantos valores (OS) e a soma deles."""

    count: int = 0
    amount: Money = Decimal("0")


class EarningsRejection(BaseModel):
    """A recusa que ainda vale no mês: a nota recusada mais recente da competência, sem nota
    enviada depois da recusa."""

    invoice_id: uuid.UUID
    number: str
    reason: str | None
    rejected_at: datetime | None


class EarningsMonth(BaseModel):
    """Um mês de conclusão (OS aberta: o mês do lançamento do valor) no fuso da operação."""

    month: str  # "AAAA-MM"
    state: EarningsMonthState
    # Valores (OS) do mês; o pendente de OS cancelada não conta.
    count: int
    # to_pay + expected + paid: o "Valor total" do cartão.
    total: Money
    to_pay: EarningsBucket
    expected: EarningsBucket
    paid: EarningsBucket
    # Partes do a receber (sem nota do técnico, nota em conferência, nota conferida) e do pago.
    due_without_invoice: EarningsBucket
    due_in_review: EarningsBucket
    due_checked: EarningsBucket
    paid_without_invoice: EarningsBucket
    last_paid_at: datetime | None
    rejection: EarningsRejection | None
    # Notas do técnico com esta competência que não foram recusadas (aguardando conferência ou
    # conferidas). A nota pode cobrir OS de meses anteriores: o mês sem valores ("empty") com nota
    # aparece no app por aqui. Não muda a situação.
    invoices: int = 0


class EarningsTotals(BaseModel):
    """Valores das OS de todos os meses (não só os da janela); os reembolsos ficam à parte."""

    paid: Money
    to_pay: Money
    expected: Money
    # Parte de to_pay de meses anteriores à janela (já somada em to_pay).
    to_pay_older: Money
    last_paid_at: datetime | None
    # Reembolsos de custos extras: aprovados e ainda não pagos; já pagos (todos os meses).
    reimbursement_to_receive: Money
    reimbursement_paid: Money


class EarningsMonths(BaseModel):
    """GET /me/earnings/months: os meses da janela, o mais novo primeiro (também os vazios)."""

    since: str  # primeiro mês da janela, "AAAA-MM"
    until: str  # mês atual no fuso da operação
    totals: EarningsTotals
    months: list[EarningsMonth]
