import datetime as dt
import uuid
from decimal import Decimal

from pydantic import BaseModel, Field, computed_field

from app.core.enums import QuoteStatus
from app.schemas.common import ORMModel, Ref
from app.schemas.expense import Money


def format_quote_code(number: int) -> str:
    return f"ORC-{number:06d}"


class QuoteItemIn(BaseModel):
    description: str = Field(min_length=1, max_length=300)
    quantity: Decimal = Field(gt=0, max_digits=12, decimal_places=3)
    unit: str = Field(default="un", max_length=20)
    unit_price: Decimal = Field(ge=0, max_digits=12, decimal_places=2)
    catalog_item_id: uuid.UUID | None = None


class QuoteItemOut(BaseModel):
    description: str
    quantity: Money
    unit: str
    unit_price: Money
    total: Money
    catalog_item_id: uuid.UUID | None = None


class QuoteIn(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    items: list[QuoteItemIn] = Field(min_length=1, max_length=100)
    discount: Decimal = Field(default=Decimal("0"), ge=0, max_digits=12, decimal_places=2)
    valid_until: dt.date | None = None
    notes: str | None = Field(default=None, max_length=5000)


class QuoteOut(ORMModel):
    id: uuid.UUID
    number: int
    ticket_id: uuid.UUID
    status: QuoteStatus
    title: str
    items: list[QuoteItemOut]
    subtotal: Money
    discount: Money
    total: Money
    valid_until: dt.date | None
    notes: str | None
    sent_at: dt.datetime | None
    decided_at: dt.datetime | None
    approver_name: str | None
    approver_document: str | None
    approver_role: str | None
    rejection_reason: str | None
    created_by: Ref | None
    created_at: dt.datetime
    updated_at: dt.datetime
    signature_url: str | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def code(self) -> str:
        return format_quote_code(self.number)


class QuoteSent(QuoteOut):
    # Só nesta resposta: o banco guarda apenas o hash do link.
    token: str


class PublicQuote(BaseModel):
    """O que o cliente vê pelo link (sem dados internos)."""

    code: str
    title: str
    status: QuoteStatus
    customer: str | None
    location: str | None
    ticket_code: str
    ticket_title: str
    items: list[QuoteItemOut]
    subtotal: Money
    discount: Money
    total: Money
    valid_until: dt.date | None
    notes: str | None
    sent_at: dt.datetime | None
    decided_at: dt.datetime | None
    approver_name: str | None
    rejection_reason: str | None


class QuoteApprove(BaseModel):
    name: str = Field(min_length=3, max_length=160)
    document: str | None = Field(default=None, max_length=20)
    role: str | None = Field(default=None, max_length=120)
    # Assinatura desenhada na tela (data URL PNG).
    signature: str = Field(min_length=30, max_length=2_000_000)
    accept: bool


class QuoteReject(BaseModel):
    name: str | None = Field(default=None, max_length=160)
    reason: str = Field(min_length=3, max_length=2000)


class CatalogItemIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    unit: str = Field(default="un", min_length=1, max_length=20)
    price: Decimal = Field(ge=0, max_digits=12, decimal_places=2)
    description: str | None = Field(default=None, max_length=2000)
    is_active: bool = True


class CatalogItemOut(ORMModel):
    id: uuid.UUID
    name: str
    unit: str
    price: Money
    description: str | None
    is_active: bool


class QuoteListRow(QuoteOut):
    ticket_code: str
    customer: str | None
