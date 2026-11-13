import datetime as dt
from typing import Literal

from pydantic import BaseModel

from app.schemas.ticket import TicketListItem

ActivityState = Literal[
    "scheduled",  # agendada para o dia, ainda não começou
    "late",  # o horário agendado passou e o técnico não saiu
    "en_route",  # em deslocamento
    "in_progress",  # em atendimento
    "on_hold",  # pendente (cliente ou fornecedor/peça)
    "rescheduled",  # teve atividade no dia, mas a visita foi remarcada para outro dia
    "done",  # concluída no dia
    "pending",  # no dia por outro motivo (ex.: voltou para a fila)
]


class Activity(BaseModel):
    """Uma visita do dia: o previsto e o realizado na mesma linha (como no Field Control)."""

    ticket: TicketListItem
    state: ActivityState
    scheduled_start: dt.datetime | None
    scheduled_end: dt.datetime | None
    # 1º deslocamento ou atendimento no dia; para OS em campo desde antes, quando a etapa começou.
    started_at: dt.datetime | None
    arrived_at: dt.datetime | None  # 1º "Em atendimento" no dia
    finished_at: dt.datetime | None  # resolvida no dia
    start_delay_minutes: int | None  # início real - agendado (positivo = atrasou)
    start_has_gps: bool
    service_type_name: str | None
    estimated_minutes: int | None
    actual_minutes: int
    # Escopo da OS (o cartão do dia mostra a primeira linha, como no Field Control).
    description: str = ""
    # Feito offline: a hora que o aparelho marcou no botão (o envio chegou depois). O horário
    # acima é o do servidor; este é a evidência para o "Corrigir horários".
    started_declared_at: dt.datetime | None = None
    arrived_declared_at: dt.datetime | None = None
    # Distância (metros) do GPS do técnico até a loja na saída e no início do atendimento.
    start_distance_m: int | None = None
    arrival_distance_m: int | None = None
    # Visita improdutiva registrada no dia: quando e o motivo.
    unproductive_at: dt.datetime | None = None
    unproductive_reason: str | None = None


class DaySummary(BaseModel):
    total: int
    scheduled: int
    late: int
    en_route: int
    in_progress: int
    on_hold: int
    rescheduled: int
    done: int
    pending: int
    unassigned: int
    # Visitas improdutivas registradas no dia (a OS aparece com o motivo).
    unproductive: int = 0


class DayActivities(BaseModel):
    date: dt.date
    timezone: str
    is_today: bool
    summary: DaySummary
    activities: list[Activity]
