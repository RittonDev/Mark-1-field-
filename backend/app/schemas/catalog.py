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
