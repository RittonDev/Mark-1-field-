import datetime as dt
import uuid
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.schemas.common import Ref
from app.schemas.onboarding import SkillOut
from app.schemas.records import WorkSchedule, WorkScheduleOut


class TechnicianOut(BaseModel):
    id: uuid.UUID
    name: str
    email: str
    phone: str | None
    job_title: str | None
    team: Ref | None
    home_city: str | None = None
    home_state: str | None = None
    coverage_area: str | None = None
    is_active: bool
    last_login_at: dt.datetime | None
    location_consent_at: dt.datetime | None
    must_change_password: bool
    created_at: dt.datetime
    avatar_url: str | None = None
    on_shift: bool = False
    open_tickets: int = 0
    # Perfil da homologação (quando o técnico entrou pela ficha).
    service_areas: list[str] = []
    skills: list[SkillOut] = []
    application_id: uuid.UUID | None = None
    # Região de atuação: a cidade onde mais atendeu (history) ou o endereço (home).
    base_city: str | None = None
    base_state: str | None = None
    base_source: Literal["history", "home"] | None = None
    base_visits: int = 0
    last_visit_at: dt.datetime | None = None
    # Ficha completa: endereço, jornada, serviços que faz e origem (Field Control).
    address_line: str | None = None
    address_district: str | None = None
    address_zip: str | None = None
    work_schedule: WorkScheduleOut | None = None
    services: list[Ref] = []
    legacy: dict[str, Any] | None = None


class TechnicianCreate(BaseModel):
    name: str = Field(min_length=3, max_length=160)
    email: EmailStr
    phone: str | None = Field(default=None, max_length=40)
    team_id: uuid.UUID | None = None
    job_title: str | None = Field(default=None, max_length=120)
    home_city: str | None = Field(default=None, max_length=120)
    home_state: str | None = Field(default=None, max_length=2)
    coverage_area: str | None = Field(default=None, max_length=1000)

    @field_validator("email")
    @classmethod
    def _lower(cls, v: str) -> str:
        return v.strip().lower()


class TechnicianUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=3, max_length=160)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=40)
    team_id: uuid.UUID | None = None
    job_title: str | None = Field(default=None, max_length=120)
    home_city: str | None = Field(default=None, max_length=120)
    home_state: str | None = Field(default=None, max_length=2)
    coverage_area: str | None = Field(default=None, max_length=1000)
    is_active: bool | None = None
    address_line: str | None = Field(default=None, max_length=255)
    address_district: str | None = Field(default=None, max_length=120)
    address_zip: str | None = Field(default=None, max_length=10)
    work_schedule: WorkSchedule | None = None
    service_type_ids: list[uuid.UUID] | None = Field(default=None, max_length=300)

    @field_validator("email")
    @classmethod
    def _lower(cls, v: str | None) -> str | None:
        return v.strip().lower() if v else v


class TemporaryPassword(BaseModel):
    technician: TechnicianOut
    # Mostrada uma única vez; o técnico troca no primeiro acesso ao app.
    temporary_password: str


class ImportRow(BaseModel):
    line: int
    name: str
    email: str
    phone: str | None
    team: str | None
    action: Literal["create", "update", "error"]
    errors: list[str] = []


class Credential(BaseModel):
    name: str
    email: str
    temporary_password: str


class ImportResult(BaseModel):
    dry_run: bool
    rows: list[ImportRow]
    created: int
    updated: int
    errors: int
    # Só na importação confirmada, e só nesta resposta: senhas provisórias dos novos.
    credentials: list[Credential] = []


class TechnicianSuggestion(BaseModel):
    id: uuid.UUID
    name: str
    phone: str | None
    home_city: str | None
    home_state: str | None
    team: Ref | None
    open_tickets: int
    on_shift: bool
    distance_km: float | None
    # Visitas a esta mesma loja (pelo histórico de OS).
    visits_at_location: int = 0
    last_visit_at_location: dt.datetime | None = None
    # Com horário informado: ocupado nele (outra OS) e quantas OS já tem no dia.
    busy: bool | None = None
    day_load: int | None = None
    score: float
    # Por que foi sugerido: "Mora em Santos", "A 4 km agora", "Livre no horário"...
    reasons: list[str]


class RegionCity(BaseModel):
    city: str
    total: int


class RegionState(BaseModel):
    state: str
    total: int
    cities: list[RegionCity]


class RegionRefresh(BaseModel):
    technicians: int
    history: int
    home: int
    none: int


class NearbyPoint(BaseModel):
    latitude: float
    longitude: float
    label: str


class NearbyTechnician(BaseModel):
    id: uuid.UUID
    name: str
    email: str
    phone: str | None
    is_active: bool
    avatar_url: str | None
    base_city: str | None
    base_state: str | None
    base_source: Literal["history", "home"] | None
    distance_km: float
    # De onde veio a menor distância: loja que já atendeu, endereço ou posição ao vivo.
    nearest_kind: Literal["store_history", "home", "live"]
    visits_at_location: int
    last_visit_at_location: dt.datetime | None
    visits_in_city: int
    total_visits: int
    last_visit_at: dt.datetime | None
    open_tickets: int
    on_shift: bool
    reasons: list[str]


class NearbyOut(BaseModel):
    point: NearbyPoint
    technicians: list[NearbyTechnician]
