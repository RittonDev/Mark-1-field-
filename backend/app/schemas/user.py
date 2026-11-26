import uuid
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, EmailStr, Field

from app.core.enums import OperationalStatus, UserRole
from app.schemas.access import EffectiveAccessOut, UserAccessIn
from app.schemas.common import ORMModel, Ref


class UnavailabilityPeriodOut(BaseModel):
    """Um período de indisponibilidade do técnico (services/unavailability.py): os dois dias
    inclusive, sem motivo (LGPD)."""

    id: str
    start: date
    end: date


class UserRef(ORMModel):
    id: uuid.UUID
    name: str
    email: str
    role: UserRole
    # Desativado não entra no app (a OS dele precisa ser reatribuída).
    is_active: bool = True


class UserOut(ORMModel):
    id: uuid.UUID
    name: str
    email: str
    phone: str | None
    role: UserRole
    job_title: str | None
    team_id: uuid.UUID | None
    team: Ref | None
    # Usuário do cliente: a empresa (o portal mostra as solicitações de todas as lojas dela).
    customer_id: uuid.UUID | None = None
    customer: Ref | None = None
    is_active: bool
    last_login_at: datetime | None
    location_consent_at: datetime | None = None
    must_change_password: bool = False
    created_at: datetime
    # Perfil de acesso (só supervisor e analista) e os ajustes da pessoa por cima dele.
    access_profile_id: uuid.UUID | None = None
    access_profile: Ref | None = None
    # Só o que foi ajustado: {"items"?: {tela: nível}, "queue_scope"?: "own" | "all",
    # "queue_unowned"?: bool} (o formato de AccessOverrides, sem as chaves vazias).
    access_overrides: dict[str, Any] | None = None
    # Acesso efetivo (telas e filas); null para técnico e cliente.
    access: EffectiveAccessOut | None = Field(default=None, validation_alias="access_summary")


class UserCreate(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    email: EmailStr = Field(max_length=255)
    password: str = Field(min_length=8, max_length=128)
    role: UserRole = UserRole.ANALYST
    phone: str | None = Field(default=None, max_length=40)
    job_title: str | None = Field(default=None, max_length=120)
    team_id: uuid.UUID | None = None
    customer_id: uuid.UUID | None = None
    # Só supervisor e analista; sem ele, o perfil padrão do papel.
    access: UserAccessIn | None = None


class UserUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    email: EmailStr | None = Field(default=None, max_length=255)
    password: str | None = Field(default=None, min_length=8, max_length=128)
    role: UserRole | None = None
    phone: str | None = Field(default=None, max_length=40)
    job_title: str | None = Field(default=None, max_length=120)
    team_id: uuid.UUID | None = None
    customer_id: uuid.UUID | None = None
    is_active: bool | None = None
    # Perfil e ajustes de acesso (só supervisor e analista).
    access: UserAccessIn | None = None


class AssignableUser(BaseModel):
    """Quem pode ser escolhido na OS (só com acesso ao app), com a carga atual. Técnico Inativo ou
    Bloqueado vem com a situação e o motivo (a web mostra e não deixa escolher); os períodos de
    indisponibilidade que não terminaram vêm para a web avisar quando a visita cai num deles."""

    id: uuid.UUID
    name: str
    role: UserRole
    team_id: uuid.UUID | None
    team_name: str | None
    open_tickets: int
    operational_status: OperationalStatus = OperationalStatus.ACTIVE
    # Só fora de Ativo.
    operational_reason: str | None = None
    unavailability: list[UnavailabilityPeriodOut] = []


class TeamOut(ORMModel):
    id: uuid.UUID
    name: str
    description: str | None
    is_active: bool


class TeamCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    description: str | None = None


class TeamUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    description: str | None = None
    is_active: bool | None = None
