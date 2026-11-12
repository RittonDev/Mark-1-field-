import uuid

from pydantic import BaseModel, Field

from app.core.enums import TicketPriority
from app.schemas.common import ORMModel, Ref


class CategoryOut(ORMModel):
    id: uuid.UUID
    name: str
    full_name: str
    description: str | None
    parent_id: uuid.UUID | None
    default_team_id: uuid.UUID | None
    default_team: Ref | None
    is_active: bool


class CategoryCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    description: str | None = None
    parent_id: uuid.UUID | None = None
    default_team_id: uuid.UUID | None = None


class CategoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    description: str | None = None
    parent_id: uuid.UUID | None = None
    default_team_id: uuid.UUID | None = None
    is_active: bool | None = None


class SlaPolicyOut(ORMModel):
    priority: TicketPriority
    response_minutes: int
    resolution_minutes: int


class SlaPolicyUpdate(BaseModel):
    response_minutes: int = Field(gt=0, le=60 * 24 * 60)
    resolution_minutes: int = Field(gt=0, le=60 * 24 * 120)


class ServiceTypeOut(ORMModel):
    """Tipo de serviço com a estimativa cadastrada e o que foi observado nas OS concluídas."""

    id: uuid.UUID
    name: str
    description: str | None
    estimated_minutes: int
    customer_id: uuid.UUID | None
    customer: Ref | None
    category_id: uuid.UUID | None
    is_active: bool
    observed_median_minutes: float | None = None
    observed_count: int = 0
    # Preenchido quando a mediana observada se afasta muito da estimativa (ver services.durations).
    suggested_minutes: int | None = None


class ServiceTypeCreate(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    description: str | None = None
    estimated_minutes: int = Field(gt=0, le=60 * 24 * 7)
    # Sem cliente: vale para todos. Com cliente: catálogo daquele cliente.
    customer_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None


class ServiceTypeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    description: str | None = None
    estimated_minutes: int | None = Field(default=None, gt=0, le=60 * 24 * 7)
    category_id: uuid.UUID | None = None
    is_active: bool | None = None
