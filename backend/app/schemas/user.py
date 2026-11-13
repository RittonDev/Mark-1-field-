import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

from app.core.enums import UserRole
from app.schemas.common import ORMModel, Ref


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


class UserCreate(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    email: EmailStr = Field(max_length=255)
    password: str = Field(min_length=8, max_length=128)
    role: UserRole = UserRole.ANALYST
    phone: str | None = Field(default=None, max_length=40)
    job_title: str | None = Field(default=None, max_length=120)
    team_id: uuid.UUID | None = None
    customer_id: uuid.UUID | None = None


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


class AssignableUser(BaseModel):
    """Analista disponível para atribuição, com carga atual."""

    id: uuid.UUID
    name: str
    role: UserRole
    team_id: uuid.UUID | None
    team_name: str | None
    open_tickets: int


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
