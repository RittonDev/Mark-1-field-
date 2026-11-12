import datetime as dt
import uuid
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.schemas.common import Ref
from app.schemas.onboarding import SkillOut


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
