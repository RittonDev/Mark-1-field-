"""Fila do analista ("Minha fila") e visão das filas da equipe."""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.core.enums import UserRole
from app.core.permissions import QueueScope
from app.schemas.ticket import TicketListItem
from app.schemas.user import UserRef

QueueSection = Literal[
    "in_field", "attention", "today", "waiting", "upcoming", "unscheduled", "done"
]
ReasonTone = Literal["danger", "warning", "info"]


class QueueReason(BaseModel):
    code: str
    label: str
    tone: ReasonTone


class QueueItem(TicketListItem):
    section: QueueSection = "unscheduled"
    reasons: list[QueueReason] = []


class MyQueueCounts(BaseModel):
    """`open`: OS em aberto na fila; os demais são o tamanho de cada seção."""

    open: int = 0
    attention: int = 0
    in_field: int = 0
    today: int = 0
    waiting: int = 0
    upcoming: int = 0
    unscheduled: int = 0
    done: int = 0


class MyQueue(BaseModel):
    user: UserRef
    date: date
    generated_at: datetime
    counts: MyQueueCounts
    items: list[QueueItem]
    # Quantas OS a fila tem de verdade. Acima do limite da lista (500), `truncated` avisa que
    # ficaram de fora as menos urgentes (as em aberto de prazo mais apertado vêm primeiro).
    total: int = 0
    truncated: bool = False


class QueueCounts(BaseModel):
    open: int = 0
    attention: int = 0
    today: int = 0
    in_field: int = 0


class TeamQueue(QueueCounts):
    user: UserRef
    role: UserRole


class TeamQueues(BaseModel):
    # Com "Somente a própria fila", só a linha de quem pediu.
    queues: list[TeamQueue]
    # Sem analista, incluindo as OS de analista que saiu da gestão (desativado ou outro papel).
    # null quando a pessoa só vê a própria fila e não vê as sem analista.
    unowned: QueueCounts | None = None
    # Visibilidade de filas de quem pediu: "all" (todas) ou "own" (só a própria).
    scope: QueueScope = "all"
    # Soma das linhas devolvidas e da sem analista (quando vem).
    total: QueueCounts = Field(default_factory=QueueCounts)
