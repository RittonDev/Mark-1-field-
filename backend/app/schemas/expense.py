import datetime as dt
import uuid
from decimal import Decimal
from typing import Annotated

from pydantic import BaseModel, Field, PlainSerializer

from app.core.enums import ExpenseKind, ExpenseStatus
from app.schemas.common import ORMModel, Ref

# Dinheiro guardado em NUMERIC (exato); no JSON vai como número para o front somar fácil.
Money = Annotated[Decimal, PlainSerializer(float, return_type=float, when_used="json")]

EXPENSE_KIND_LABEL: dict[str, str] = {
    "material": "Material",
    "km": "Km rodado",
    "toll": "Pedágio",
    "parking": "Estacionamento",
    "transport": "Transporte",
    "meal": "Alimentação",
    "other": "Outro",
}


class ExpenseIn(BaseModel):
    kind: ExpenseKind
    description: str = Field(min_length=2, max_length=200)
    quantity: Decimal = Field(gt=0, max_digits=12, decimal_places=3)
    # Vazio no km: usa o valor do km configurado.
    unit_value: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    technician_id: uuid.UUID | None = None
    status: ExpenseStatus = ExpenseStatus.PENDING
    notes: str | None = Field(default=None, max_length=2000)
    receipt_attachment_id: uuid.UUID | None = None


class ExpenseUpdate(BaseModel):
    kind: ExpenseKind | None = None
    description: str | None = Field(default=None, min_length=2, max_length=200)
    quantity: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=3)
    unit_value: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    technician_id: uuid.UUID | None = None
    status: ExpenseStatus | None = None
    notes: str | None = Field(default=None, max_length=2000)
    receipt_attachment_id: uuid.UUID | None = None


class ExpenseOut(ORMModel):
    id: uuid.UUID
    ticket_id: uuid.UUID
    kind: ExpenseKind
    description: str
    quantity: Money
    unit_value: Money
    total: Money
    technician: Ref | None
    status: ExpenseStatus
    paid_at: dt.datetime | None
    receipt_attachment_id: uuid.UUID | None
    notes: str | None
    created_by: Ref | None
    created_at: dt.datetime
    updated_at: dt.datetime


class ExpenseTicketRef(BaseModel):
    id: uuid.UUID
    code: str
    title: str
    customer: Ref | None


class ExpenseReportRow(ExpenseOut):
    ticket: ExpenseTicketRef


class TechnicianTotal(BaseModel):
    technician: Ref | None
    count: int
    total: Money
    to_pay: Money  # aprovados e ainda não reembolsados


class ExpenseReport(BaseModel):
    items: list[ExpenseReportRow]
    total: Money
    by_technician: list[TechnicianTotal]
    by_kind: dict[str, Money]


class MarkPaid(BaseModel):
    ids: list[uuid.UUID] = Field(min_length=1, max_length=500)


class ExpenseSettings(BaseModel):
    km_rate: Money = Field(ge=0, le=100)
