"""Avaliação do cliente sobre um técnico numa OS concluída, registrada pela central
(services/technician_ratings.py; contrato da Entrega 2, §6.5 e §7).

Só a gestão vê: nada no app nem em /me/*, e fora do Elo. Uma por OS e técnico (o responsável ou um
auxiliar; quem saiu da OS e tem avaliação ainda é corrigido ou excluído).
"""

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core import text
from app.core.enums import RatingSource
from app.schemas.common import Ref

SCORE_MIN, SCORE_MAX = 1, 5
COMMENT_MAX = 1000
RATER_MAX = 120

SCORE_MESSAGE = "Escolha uma nota de 1 a 5"
LONG_TEXT = "No máximo {n} caracteres"


def clean_comment(value: str) -> str | None:
    """O comentário como se grava: cada linha sem controles e com os espaços colapsados, sem linhas
    em branco nas pontas. Vazio: None."""
    lines = [text.clean(line) for line in value.replace("\r\n", "\n").split("\n")]
    return "\n".join(lines).strip("\n") or None


class RatingIn(BaseModel):
    """PUT /tickets/{id}/ratings/{technician_id}: a nota inteira de 1 a 5, o comentário (até 1000) e
    quem avaliou no cliente (até 120). Vazio vira null."""

    model_config = ConfigDict(extra="forbid")

    score: int = Field(default=None, validate_default=True)
    comment: str | None = None
    rater_name: str | None = None

    @field_validator("score", mode="before")
    @classmethod
    def _score(cls, value: Any) -> int:
        # Só inteiro (não bool, não 4.5, não "4"): o que a tela manda.
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(SCORE_MESSAGE)
        if not SCORE_MIN <= value <= SCORE_MAX:
            raise ValueError(SCORE_MESSAGE)
        return value

    @field_validator("comment", mode="before")
    @classmethod
    def _comment(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        cleaned = clean_comment(value)
        if cleaned is not None and len(cleaned) > COMMENT_MAX:
            raise ValueError(LONG_TEXT.format(n=COMMENT_MAX))
        return cleaned

    @field_validator("rater_name", mode="before")
    @classmethod
    def _rater_name(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        cleaned = text.clean(value)
        if len(cleaned) > RATER_MAX:
            raise ValueError(LONG_TEXT.format(n=RATER_MAX))
        return cleaned or None


class RatingTicketOut(BaseModel):
    """A OS da avaliação (a ficha liga para ela)."""

    id: uuid.UUID
    code: str
    title: str
    # A loja (o nome do local).
    location: str | None
    resolved_at: datetime | None


class TechnicianRatingOut(BaseModel):
    id: uuid.UUID
    ticket: RatingTicketOut
    technician: Ref
    # 1 a 5.
    score: int
    comment: str | None
    # Quem avaliou, no cliente.
    rater_name: str | None
    source: RatingSource
    created_at: datetime
    created_by: Ref | None
    updated_at: datetime
    # None: nunca corrigida.
    updated_by: Ref | None


class TechnicianRatingsOut(BaseModel):
    """GET /technicians/{id}/ratings: a média com 1 casa (None sem avaliação) e a contagem de todas,
    e a página pedida (a mais nova primeiro)."""

    average: float | None
    count: int
    items: list[TechnicianRatingOut]


TicketRatingRole = Literal["assignee", "helper", "former"]


class TicketRatingLine(BaseModel):
    technician: Ref
    # O responsável, um auxiliar ou quem saiu da OS e tem avaliação.
    role: TicketRatingRole
    rating: TechnicianRatingOut | None


class TicketRatingsOut(BaseModel):
    """GET /tickets/{id}/ratings: os técnicos da OS (o responsável, os auxiliares e quem saiu com
    avaliação) e a avaliação de cada um."""

    # OS resolvida ou fechada: só ela recebe avaliação.
    concluded: bool
    technicians: list[TicketRatingLine]
