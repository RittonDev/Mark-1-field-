import uuid
from decimal import Decimal

from pydantic import BaseModel, Field

from app.core.enums import Responsibility, TicketPriority, ViolationScope
from app.schemas.common import ORMModel, Ref
from app.schemas.expense import Money


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
    technician_fee: Money | None = None
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
    # Quanto o técnico parceiro recebe por uma OS deste tipo (padrão ao colocar o técnico).
    technician_fee: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    # Sem cliente: vale para todos. Com cliente: catálogo daquele cliente.
    customer_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None


class ServiceTypeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    description: str | None = None
    estimated_minutes: int | None = Field(default=None, gt=0, le=60 * 24 * 7)
    technician_fee: Decimal | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    category_id: uuid.UUID | None = None
    is_active: bool | None = None


class ViolationReasonOut(ORMModel):
    id: uuid.UUID
    name: str
    description: str | None
    applies_to: ViolationScope
    responsibility: Responsibility
    is_active: bool


class ViolationReasonCreate(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    description: str | None = None
    applies_to: ViolationScope = ViolationScope.BOTH
    responsibility: Responsibility


class ViolationReasonUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    description: str | None = None
    applies_to: ViolationScope | None = None
    responsibility: Responsibility | None = None
    is_active: bool | None = None


class UnproductiveReasonOut(ORMModel):
    id: uuid.UUID
    name: str
    description: str | None
    responsibility: Responsibility
    is_active: bool


class UnproductiveReasonCreate(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    description: str | None = None
    responsibility: Responsibility


class UnproductiveReasonUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    description: str | None = None
    responsibility: Responsibility | None = None
    is_active: bool | None = None
