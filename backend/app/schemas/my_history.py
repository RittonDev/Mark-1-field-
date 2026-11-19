"""Histórico de atendimentos do técnico (GET /me/history, services/my_history.py): as OS concluídas
em que ele atuou, no recorte de campo (código, serviço, loja, cidade e data). Nunca vêm cliente,
endereço, contato, valores, etiquetas, SLA, analista, solicitante nem descrição."""

import datetime as dt
import uuid
from typing import Literal

from pydantic import BaseModel

HistoryRole = Literal["assignee", "helper"]


class HistoryItem(BaseModel):
    """Uma OS do histórico."""

    id: uuid.UUID
    code: str  # "OS-000123"
    service: str  # o tipo de serviço; sem tipo, o título da OS
    location_code: str | None
    location_name: str | None
    city: str | None
    state: str | None
    resolved_at: dt.datetime  # a conclusão
    month: str  # "2026-11": o mês da conclusão no fuso da operação (as seções da lista)
    role: HistoryRole  # responsável ou junto (outro técnico da visita)
    legacy: bool  # OS do sistema antigo (Field Control)


class HistoryMonthCount(BaseModel):
    month: str
    count: int


class MyHistoryPage(BaseModel):
    """Uma página, da OS mais recente para a mais antiga."""

    items: list[HistoryItem]
    # A próxima página (?cursor=); null no fim.
    next_cursor: str | None
    # Total de atendimentos (igual a MyStats.lifetime.services): só na primeira página.
    total: int | None
    # O total de cada mês desta página, mesmo quando o mês continua na próxima.
    months: list[HistoryMonthCount]
