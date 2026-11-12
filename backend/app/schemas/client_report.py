"""Relatório público da OS concluída (o link que o cliente recebe e pode salvar em PDF)."""

from datetime import datetime

from pydantic import BaseModel

from app.core.enums import TicketStatus
from app.schemas.company import CompanyProfile


class PublicReportCustomer(BaseModel):
    name: str
    document: str | None = None
    email: str | None = None
    phone: str | None = None


class PublicReportLocation(BaseModel):
    name: str
    code: str | None = None
    address: str | None = None
    city: str | None = None
    state: str | None = None
    zip_code: str | None = None
    # Contato no local (ex.: gerente da loja), como aparece na OS.
    contact_name: str | None = None
    contact_phone: str | None = None


class PublicReportPerson(BaseModel):
    name: str


class PublicReportPhoto(BaseModel):
    url: str
    filename: str
    taken_at: datetime | None = None


class PublicReportFormItem(BaseModel):
    label: str
    # Tipo do campo (section, text, yes_no, photo...): "section" é título, sem resposta.
    type: str
    value: str | None = None
    photos: list[PublicReportPhoto] = []


class PublicReportForm(BaseModel):
    name: str
    completed_at: datetime | None = None
    items: list[PublicReportFormItem] = []


class PublicReportSignature(BaseModel):
    name: str | None = None
    role: str | None = None
    signed_at: datetime | None = None
    image_url: str | None = None


class PublicReportMilestone(BaseModel):
    at: datetime
    label: str


class PublicReport(BaseModel):
    code: str
    number: int | None = None
    title: str
    description: str
    status: TicketStatus
    status_label: str
    company_name: str
    # Dados da empresa (Configurações) para o cabeçalho e o rodapé.
    company: CompanyProfile | None = None
    customer: PublicReportCustomer | None = None
    location: PublicReportLocation | None = None
    service_address: str | None = None
    requester_name: str | None = None
    service_type: str | None = None
    technician: PublicReportPerson | None = None
    opened_at: datetime
    scheduled_start: datetime | None = None
    scheduled_end: datetime | None = None
    en_route_at: datetime | None = None
    arrived_at: datetime | None = None
    finished_at: datetime | None = None
    closed_at: datetime | None = None
    on_site_minutes: int | None = None
    # Prazo de chegada (4h nas capitais): quanto o técnico levou e se chegou no prazo.
    arrival_due_at: datetime | None = None
    arrival_minutes: int | None = None
    arrival_on_time: bool | None = None
    check_in_gps: bool = False
    resolution_notes: str | None = None
    forms: list[PublicReportForm] = []
    photos: list[PublicReportPhoto] = []
    signature: PublicReportSignature | None = None
    timeline: list[PublicReportMilestone] = []
    generated_at: datetime
