"""Valor de cada técnico por OS (técnicos parceiros, pagos por chamado)."""

import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field

from app.core.enums import PayoutStatus, TicketStatus
from app.schemas.common import ORMModel, Ref
from app.schemas.expense import Money


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


class MyEarnings(PayoutList):
    """Meus ganhos (app do técnico): os chamados e os reembolsos de custos extras."""

    reimbursement_to_receive: Money = Decimal("0")
    reimbursement_paid: Money = Decimal("0")


class PayoutIds(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=500)
