"""Técnicos favoritos por cidade (aba "Favoritos por cidade" e sugestões da OS)."""

import datetime as dt
import uuid

from pydantic import BaseModel, Field, ValidationInfo, field_validator
from pydantic_core import PydanticCustomError

from app.core.enums import OperationalStatus
from app.schemas.common import Ref

# Tamanho máximo da nota (do fixado) ou do motivo (do tirado da lista).
NOTE_MAX = 300


class FavoriteTechnician(BaseModel):
    id: uuid.UUID
    name: str
    email: str
    phone: str | None
    avatar_url: str | None
    is_active: bool
    # Situação na operação: Inativo e Bloqueado ficam fora do automático (o fixado continua).
    operational_status: OperationalStatus = OperationalStatus.ACTIVE
    on_shift: bool
    open_tickets: int
    base_city: str | None
    base_state: str | None
    # OS dele nas lojas da cidade dentro da janela (12 meses) e a última delas.
    visits: int
    last_visit_at: dt.datetime | None
    # Posição no ranking completo da cidade (null sem OS na janela).
    rank: int | None
    automatic: bool
    pinned: bool
    hidden: bool
    note: str | None
    # Quem fixou ou tirou por último, e quando (null para automático sem decisão manual).
    set_by: Ref | None
    set_at: dt.datetime | None


class FavoriteCity(BaseModel):
    state: str
    # Grafia atual das lojas (a mais usada na chave).
    city: str
    key: str
    # Lojas ativas na cidade.
    stores: int
    # OS distintas atendidas nas lojas da cidade dentro da janela (todos os técnicos).
    visits: int
    favorites: list[FavoriteTechnician]
    hidden_count: int
    # Quantos mais atenderam na janela sem ser favoritos nem tirados (a lista vem no detalhe).
    others_count: int


class FavoriteCityDetail(FavoriteCity):
    hidden: list[FavoriteTechnician]
    # Até 10, na ordem do ranking.
    others: list[FavoriteTechnician]


class FavoritesOut(BaseModel):
    window_days: int
    min_visits: int
    top: int
    max_pinned: int
    cities: list[FavoriteCity]


class FavoriteSet(BaseModel):
    """Fixar (favorite=true) ou tirar (favorite=false) o técnico dos favoritos da cidade.

    A UF chega aparada e em maiúsculas; o serviço confere o formato ("UF inválida")."""

    state: str
    city: str = Field(min_length=1, max_length=120)
    favorite: bool = True
    # Até NOTE_MAX caracteres (conferido em _note_size, com o rótulo da tela).
    note: str | None = Field(default=None, json_schema_extra={"maxLength": NOTE_MAX})
    # Só para o Desfazer de um tirado: grava tirado mesmo fora do top 3.
    hide: bool = False

    @field_validator("state", mode="before")
    @classmethod
    def _state(cls, value: object) -> object:
        return value.strip().upper() if isinstance(value, str) else value

    @field_validator("city", mode="before")
    @classmethod
    def _city(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("note", mode="before")
    @classmethod
    def _note(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value

    @field_validator("note")
    @classmethod
    def _note_size(cls, value: str | None, info: ValidationInfo) -> str | None:
        """O 422 de sempre (string_too_long), com o nome que a tela dá ao campo: a nota do fixado
        ou o motivo do tirado da lista (o rótulo geral de "note" é "Motivo")."""
        if value is not None and len(value) > NOTE_MAX:
            label = "Nota" if info.data.get("favorite", True) else "Motivo"
            raise PydanticCustomError(
                "string_too_long",
                "String should have at most {max_length} characters",
                {"max_length": NOTE_MAX, "label": label},
            )
        return value
