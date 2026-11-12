import uuid
from datetime import datetime
from typing import Annotated, Any

from pydantic import AfterValidator, BaseModel, Field

from app.core.documents import normalize_document
from app.core.enums import AssetType
from app.schemas.common import ORMModel, Ref, TagOut
from app.schemas.records import ContactIn, ContactOut

# CPF ou CNPJ (inclusive alfanumérico); aceita com ou sem pontuação, guarda limpo.
Document = Annotated[str | None, Field(max_length=20), AfterValidator(normalize_document)]


class TicketStats(BaseModel):
    """Histórico resumido, derivado das OS (não é digitado)."""

    open_tickets: int = 0
    total_tickets: int = 0
    last_ticket_at: datetime | None = None


class CustomerOut(ORMModel, TicketStats):
    id: uuid.UUID
    name: str
    tags: list[TagOut] = []
    document: str | None
    email: str | None
    phone: str | None
    notes: str | None
    is_active: bool
    created_at: datetime
    locations_count: int = 0
    # Ficha completa: todos os contatos, endereço da matriz, logo e origem (Field Control).
    contacts: list[ContactOut] = []
    address_line: str | None = None
    district: str | None = None
    city: str | None = None
    state: str | None = None
    zip_code: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    logo_url: str | None = None
    legacy: dict[str, Any] | None = None


class CustomerCreate(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    document: Document = None
    email: str | None = None
    phone: str | None = None
    notes: str | None = None
    contacts: list[ContactIn] | None = Field(default=None, max_length=50)
    address_line: str | None = Field(default=None, max_length=255)
    district: str | None = Field(default=None, max_length=120)
    city: str | None = Field(default=None, max_length=120)
    state: str | None = Field(default=None, max_length=2)
    zip_code: str | None = Field(default=None, max_length=10)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    logo_url: str | None = Field(default=None, max_length=1000)


class CustomerUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=200)
    document: Document = None
    email: str | None = None
    phone: str | None = None
    notes: str | None = None
    is_active: bool | None = None
    contacts: list[ContactIn] | None = Field(default=None, max_length=50)
    address_line: str | None = Field(default=None, max_length=255)
    district: str | None = Field(default=None, max_length=120)
    city: str | None = Field(default=None, max_length=120)
    state: str | None = Field(default=None, max_length=2)
    zip_code: str | None = Field(default=None, max_length=10)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    logo_url: str | None = Field(default=None, max_length=1000)


class LocationOut(ORMModel, TicketStats):
    id: uuid.UUID
    customer_id: uuid.UUID
    customer: Ref
    name: str
    code: str | None
    document: str | None
    address_line: str | None
    district: str | None
    city: str | None
    state: str | None
    zip_code: str | None
    latitude: float | None
    longitude: float | None
    contact_name: str | None
    contact_phone: str | None
    notes: str | None
    is_active: bool
    contacts: list[ContactOut] = []
    legacy: dict[str, Any] | None = None


class IntakeLastVisit(BaseModel):
    ticket_id: uuid.UUID
    code: str
    title: str
    at: datetime
    technician: str | None


class IntakeCustomer(BaseModel):
    """O cliente na abertura da OS: etiquetas, avaliação e movimento."""

    id: uuid.UUID
    name: str
    tags: list[TagOut] = []
    notes: str | None = None
    # Avaliação dos clientes (trazida do Field Control enquanto não há a nossa).
    rating_average: float | None = None
    rating_last: int | None = None
    total_tickets: int = 0
    open_tickets: int = 0
    # OS do cliente já agendadas nos próximos dias (`upcoming_days`).
    upcoming: int = 0


class IntakeLocation(BaseModel):
    """A loja na abertura da OS: endereço, contato, histórico e prazo de chegada."""

    id: uuid.UUID
    name: str
    code: str | None = None
    address_line: str | None = None
    district: str | None = None
    city: str | None = None
    state: str | None = None
    zip_code: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    contact_name: str | None = None
    contact_phone: str | None = None
    notes: str | None = None
    total_tickets: int = 0
    open_tickets: int = 0
    tickets_30d: int = 0
    last_visit: IntakeLastVisit | None = None
    is_capital: bool = False
    arrival_hours: int | None = None


class IntakeContext(BaseModel):
    upcoming_days: int
    customer: IntakeCustomer | None = None
    location: IntakeLocation | None = None


class LocationCreate(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    code: str | None = Field(default=None, max_length=40)
    document: Document = None
    address_line: str | None = None
    district: str | None = None
    city: str | None = None
    state: str | None = Field(default=None, max_length=2)
    zip_code: str | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    contact_name: str | None = None
    contact_phone: str | None = None
    notes: str | None = None
    contacts: list[ContactIn] | None = Field(default=None, max_length=50)


class LocationUpdate(LocationCreate):
    name: str | None = Field(default=None, min_length=2, max_length=200)  # type: ignore[assignment]
    is_active: bool | None = None


class AssetOut(ORMModel):
    id: uuid.UUID
    customer_id: uuid.UUID
    customer: Ref
    location_id: uuid.UUID | None
    location: Ref | None
    asset_type: AssetType
    name: str
    brand: str | None
    model: str | None
    serial_number: str | None
    asset_tag: str | None
    ip_address: str | None
    mac_address: str | None
    notes: str | None
    is_active: bool
    created_at: datetime


class AssetCreate(BaseModel):
    customer_id: uuid.UUID
    location_id: uuid.UUID | None = None
    asset_type: AssetType
    name: str = Field(min_length=2, max_length=200)
    brand: str | None = None
    model: str | None = None
    serial_number: str | None = None
    asset_tag: str | None = None
    ip_address: str | None = None
    mac_address: str | None = None
    notes: str | None = None


class AssetUpdate(BaseModel):
    location_id: uuid.UUID | None = None
    asset_type: AssetType | None = None
    name: str | None = Field(default=None, min_length=2, max_length=200)
    brand: str | None = None
    model: str | None = None
    serial_number: str | None = None
    asset_tag: str | None = None
    ip_address: str | None = None
    mac_address: str | None = None
    notes: str | None = None
    is_active: bool | None = None
