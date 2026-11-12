import datetime as dt
import uuid

from pydantic import BaseModel

from app.schemas.expense import Money


class CountRef(BaseModel):
    id: uuid.UUID | None
    name: str
    count: int


class DayNumbers(BaseModel):
    opened: int = 0  # chamados que entraram
    resolved: int = 0
    cancelled: int = 0
    unproductive: int = 0  # visitas improdutivas
    scheduled_end: int = 0  # ficaram agendados ao fim do dia
    backlog_end: int = 0  # em aberto ao fim do dia
    resolved_in_sla: int = 0
    # Regras de campo: chegadas no período e quantas dentro do prazo (4h nas capitais).
    arrivals: int = 0
    arrivals_on_time: int = 0
    arrival_on_time_pct: float | None = None  # sobre as chegadas com prazo
    avg_arrival_minutes: int | None = None  # do início do relógio até a chegada
    avg_onsite_minutes: int | None = None  # tempo em atendimento das OS resolvidas


class DailyReport(BaseModel):
    date: dt.date
    # Dia já fechado (passou da meia-noite) ou parcial (hoje, ainda em andamento).
    closed: bool
    numbers: DayNumbers
    previous: DayNumbers  # dia anterior, para comparar
    top_customer: CountRef | None
    customers: list[CountRef]  # mais chamados abertos no dia
    technicians: list[CountRef]  # mais OS resolvidas no dia
    unproductive_reasons: list[CountRef]


class DayPoint(BaseModel):
    date: dt.date
    opened: int
    resolved: int
    cancelled: int
    unproductive: int


class MonthlyReport(BaseModel):
    month: str  # AAAA-MM
    closed: bool
    numbers: DayNumbers
    previous: DayNumbers  # mês anterior
    days: list[DayPoint]
    top_customer: CountRef | None
    customers: list[CountRef]
    technicians: list[CountRef]
    unproductive_reasons: list[CountRef]
    expenses_total: Money
    quotes_approved_total: Money
