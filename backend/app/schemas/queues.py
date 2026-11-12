"""Fila do analista ("Minha fila") e visão das filas da equipe."""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel

from app.core.enums import UserRole
from app.schemas.ticket import TicketListItem
from app.schemas.user import UserRef

QueueSection = Literal["in_field", "attention", "today", "waiting", "upcoming", "unscheduled", "done"]
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


class QueueCounts(BaseModel):
    open: int = 0
    attention: int = 0
    today: int = 0
    in_field: int = 0


class TeamQueue(QueueCounts):
    user: UserRef
    role: UserRole


class TeamQueues(BaseModel):
    queues: list[TeamQueue]
    unowned: QueueCounts
