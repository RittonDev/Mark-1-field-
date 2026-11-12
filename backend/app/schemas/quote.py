import datetime as dt
import uuid
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, computed_field

from app.core.enums import QuoteStatus
from app.schemas.common import ORMModel, Ref
from app.schemas.company import CompanyProfile
from app.schemas.expense import Money


def format_quote_code(number: int) -> str:
    return f"ORC-{number:06d}"


# Produto (material), serviço (mão de obra) ou despesa (deslocamento, pedágio...).
QuoteItemKind = Literal["product", "service", "expense"]


class KindTotals(BaseModel):
    product: Money = Decimal("0")
    service: Money = Decimal("0")
    expense: Money = Decimal("0")


def totals_by_kind(items: "list[QuoteItemOut]") -> KindTotals:
    totals = {"product": Decimal("0"), "service": Decimal("0"), "expense": Decimal("0")}
    for item in items:
        totals[item.kind] += item.total
    return KindTotals(**totals)


class QuoteLink(BaseModel):
    """Link do cliente (pode ser copiado de novo a qualquer momento)."""

    token: str
    path: str
    url: str


class QuoteItemIn(BaseModel):
    description: str = Field(min_length=1, max_length=300)
    quantity: Decimal = Field(gt=0, max_digits=12, decimal_places=3)
    unit: str = Field(default="un", max_length=20)
    unit_price: Decimal = Field(ge=0, max_digits=12, decimal_places=2)
    catalog_item_id: uuid.UUID | None = None
    kind: QuoteItemKind = "product"


class QuoteItemOut(BaseModel):
    description: str
    quantity: Money
    unit: str
    unit_price: Money
    total: Money
    catalog_item_id: uuid.UUID | None = None
    # Itens antigos (antes do tipo) contam como produto.
    kind: QuoteItemKind = "product"


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
    # Matrícula de quem aprovou (opcional) e comentário do cliente para a empresa.
    approver_registration: str | None = None
    client_comment: str | None = None
    rejection_reason: str | None
    created_by: Ref | None
    created_at: dt.datetime
    updated_at: dt.datetime
    signature_url: str | None = None
    link: QuoteLink | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def code(self) -> str:
        return format_quote_code(self.number)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def totals_by_kind(self) -> KindTotals:
        return totals_by_kind(self.items)


class QuoteSent(QuoteOut):
    # Token do link do cliente (o mesmo de `link.token`; mantido por compatibilidade).
    token: str


class PublicQuoteCustomer(BaseModel):
    name: str
    document: str | None = None
    email: str | None = None
    phone: str | None = None


class PublicQuoteAddress(BaseModel):
    line: str | None = None
    district: str | None = None
    city: str | None = None
    state: str | None = None
    zip_code: str | None = None
    # Pronto para exibir: "Av. Kennedy, 700 - Jardim do Mar, São Bernardo do Campo - SP, 09726-252".
    full: str | None = None


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
    # Cabeçalho, cartões do cliente e do endereço, resumo e a resposta do cliente.
    company: CompanyProfile | None = None
    customer_info: PublicQuoteCustomer | None = None
    address: PublicQuoteAddress | None = None
    ticket_number: int | None = None
    issued_at: dt.datetime | None = None
    totals_by_kind: KindTotals = KindTotals()
    approver_registration: str | None = None
    client_comment: str | None = None
    signature_url: str | None = None


class QuoteApprove(BaseModel):
    name: str = Field(min_length=3, max_length=160)
    # Matrícula (opcional) e comentário para a empresa.
    registration: str | None = Field(default=None, max_length=40)
    comment: str | None = Field(default=None, max_length=2000)
    # Assinatura desenhada na tela (data URL PNG).
    signature: str = Field(min_length=30, max_length=2_000_000)
    accept: bool
    # Mantidos por compatibilidade (a tela atual não pede).
    document: str | None = Field(default=None, max_length=20)
    role: str | None = Field(default=None, max_length=120)


class QuoteReject(BaseModel):
    name: str | None = Field(default=None, max_length=160)
    reason: str = Field(min_length=3, max_length=2000)
    comment: str | None = Field(default=None, max_length=2000)


class CatalogItemIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    unit: str = Field(default="un", min_length=1, max_length=20)
    price: Decimal = Field(ge=0, max_digits=12, decimal_places=2)
    description: str | None = Field(default=None, max_length=2000)
    is_active: bool = True
    kind: QuoteItemKind = "product"


class CatalogItemOut(ORMModel):
    id: uuid.UUID
    name: str
    unit: str
    price: Money
    description: str | None
    is_active: bool
    kind: str = "product"


class QuoteListRow(QuoteOut):
    ticket_code: str
    customer: str | None
