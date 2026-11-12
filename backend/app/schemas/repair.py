import datetime as dt
import uuid
from decimal import Decimal

from pydantic import BaseModel, Field, computed_field

from app.core.enums import RepairStatus
from app.schemas.common import ORMModel, Ref
from app.schemas.expense import Money

REPAIR_STATUS_LABEL: dict[str, str] = {
    "withdrawn": "Retirado no cliente",
    "received": "Recebido na Maxx",
    "sent_to_vendor": "Enviado à assistência",
    "vendor_quote": "Orçamento da assistência",
    "in_repair": "Em reparo",
    "ready_at_vendor": "Pronto na assistência",
    "back_in_stock": "De volta na Maxx",
    "delivered": "Entregue ao cliente",
    "unrepairable": "Sem conserto",
    "cancelled": "Cancelado",
}


class RepairIn(BaseModel):
    customer_id: uuid.UUID | None = None
    location_id: uuid.UUID | None = None
    ticket_id: uuid.UUID | None = None
    equipment_type: str = Field(default="Impressora", min_length=2, max_length=60)
    brand: str | None = Field(default=None, max_length=80)
    model: str | None = Field(default=None, max_length=120)
    serial_number: str | None = Field(default=None, max_length=120)
    asset_tag: str | None = Field(default=None, max_length=80)
    problem: str = Field(min_length=3, max_length=5000)
    accessories: str | None = Field(default=None, max_length=2000)
    vendor_name: str | None = Field(default=None, max_length=160)
    vendor_contact: str | None = Field(default=None, max_length=160)
    vendor_protocol: str | None = Field(default=None, max_length=80)
    vendor_quote_value: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    expected_return_date: dt.date | None = None
    notes: str | None = Field(default=None, max_length=5000)


class RepairStatusChange(BaseModel):
    to_status: RepairStatus
    note: str | None = Field(default=None, max_length=2000)
    vendor_quote_value: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    expected_return_date: dt.date | None = None


class RepairEventOut(ORMModel):
    id: uuid.UUID
    from_status: RepairStatus | None
    to_status: RepairStatus
    note: str | None
    actor: Ref | None
    created_at: dt.datetime


class RepairPhotoOut(BaseModel):
    id: uuid.UUID
    caption: str | None
    created_at: dt.datetime
    url: str


class RepairOut(BaseModel):
    id: uuid.UUID
    number: int
    status: RepairStatus
    status_changed_at: dt.datetime
    customer: Ref | None
    location: Ref | None
    ticket: Ref | None  # {id, name=código da OS}
    equipment_type: str
    brand: str | None
    model: str | None
    serial_number: str | None
    asset_tag: str | None
    problem: str
    accessories: str | None
    vendor_name: str | None
    vendor_contact: str | None
    vendor_protocol: str | None
    vendor_quote_value: Money | None
    expected_return_date: dt.date | None
    notes: str | None
    created_at: dt.datetime
    events: list[RepairEventOut] = []
    photos: list[RepairPhotoOut] = []
    allowed_next: list[RepairStatus] = []
    days_open: int = 0
    days_in_status: int = 0
    overdue: bool = False

    @computed_field  # type: ignore[prop-decorator]
    @property
    def code(self) -> str:
        return f"AE-{self.number:06d}"


class RepairSummary(BaseModel):
    by_status: dict[str, int]
    open_total: int
    overdue: int
