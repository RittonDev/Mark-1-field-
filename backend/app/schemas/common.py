import uuid
from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict

T = TypeVar("T")


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int


class Ref(ORMModel):
    id: uuid.UUID
    name: str


class Message(BaseModel):
    detail: str


class TagOut(BaseModel):
    """Etiqueta (ex.: "Avulso", "Faturamento Matriz") com a cor de origem."""

    name: str
    color: str | None = None
