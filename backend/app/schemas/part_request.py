import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field

from app.core.enums import PartRequestStatus
from app.schemas.common import ORMModel, Ref
from app.schemas.expense import Money


class PartRequestIn(BaseModel):
    """Pedido de peça do técnico (também como operação offline `part_request`)."""

    description: str = Field(min_length=2, max_length=300)
    quantity: Decimal = Field(default=Decimal("1"), gt=0, max_digits=12, decimal_places=3)
    unit: str = Field(default="un", min_length=1, max_length=20)
    note: str | None = Field(default=None, max_length=2000)
    # Fotos já enviadas como anexo desta OS.
    attachment_ids: list[uuid.UUID] = Field(default_factory=list, max_length=10)
    # Id gerado no app para o pedido feito offline (reenviar não duplica).
    client_id: str | None = Field(default=None, max_length=64)


class PartRequestUpdate(BaseModel):
    """Gestão: muda a situação, liga ao orçamento montado ou responde ao técnico."""

    status: PartRequestStatus | None = None
    quote_id: uuid.UUID | None = None
    response_note: str | None = Field(default=None, max_length=2000)


class PartRequestAttachment(BaseModel):
    id: uuid.UUID
    url: str


class PartRequestOut(ORMModel):
    id: uuid.UUID
    ticket_id: uuid.UUID
    description: str
    quantity: Money
    unit: str
    note: str | None
    status: PartRequestStatus
    quote_id: uuid.UUID | None
    quote_code: str | None = None
    requested_by: Ref | None
    attachment_ids: list[uuid.UUID] = []
    # Links assinados das fotos (preenchidos para quem está lendo).
    attachments: list[PartRequestAttachment] = []
    response_note: str | None
    created_at: datetime
    updated_at: datetime
