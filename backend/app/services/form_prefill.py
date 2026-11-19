"""Resposta automática dos formulários: a pergunta ligada a um dado da OS já vem preenchida.

A fonte de cada pergunta fica no próprio campo (`FormField.prefill`). O valor acompanha a OS (loja,
técnico, agenda) enquanto o formulário não é concluído e a pergunta não tem resposta; a conclusão
grava o valor nas respostas (services/forms.py, `complete`) e, dali em diante, trocar o técnico ou
remarcar a visita não muda nada. O técnico pode corrigir; pergunta sem fonte continua sendo dele.

Só dados que o técnico já vê na OS: nada de nº do chamado do cliente, CNPJ, contato ou valores.

Data da visita: a do atendimento em curso, não a da primeira chegada (a OS pausada, a improdutiva e
a reaberta voltam ao local em outro dia). Ao vivo: em atendimento, o dia em que o trecho atual
começou; antes da primeira chegada, o da agenda; fora de atendimento depois de uma chegada, nada (a
data seria a de uma ida anterior). Na conclusão do formulário, o momento que `visit_moment` apura.

Importa só modelos e schemas: services/tickets.py e services/forms.py usam sem ciclo.
"""

from collections.abc import Iterable, Mapping
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.enums import TicketEventType, TicketStatus
from app.db.base import utcnow
from app.models import Ticket, TicketEvent
from app.schemas.forms import FormField, prefill_types
from app.schemas.ticket import format_ticket_code


def _clean(value: Any) -> str | None:
    text = " ".join(str(value).split()) if value is not None else ""
    return text or None


def _city(city: Any, state: Any) -> str | None:
    """Cidade e UF ("Cidade-UF"); sem a UF, só a cidade."""
    name, uf = _clean(city), _clean(state)
    if name is None:
        return None
    return f"{name}-{uf.upper()}" if uf else name


def _address(ticket: Ticket) -> str | None:
    """O endereço do atendimento; sem ele, o da loja ("rua, bairro, cidade-UF")."""
    own = _clean(ticket.service_address)
    if own:
        return own
    loc = ticket.location
    if loc is None:
        return None
    parts = [_clean(loc.address_line), _clean(loc.district), _city(loc.city, loc.state)]
    return ", ".join(p for p in parts if p) or None


def _live_visit(ticket: Ticket) -> datetime | None:
    """A data da visita ao vivo: em atendimento, o início do trecho atual (a OS migrada do Field
    Control em atendimento não tem esse início: vale a chegada, que é a do atendimento em curso);
    antes da primeira chegada, a agenda; fora de atendimento depois de uma chegada, nada."""
    if ticket.status == TicketStatus.IN_PROGRESS:
        return ticket.work_started_at or ticket.arrived_at
    if ticket.arrived_at is None:
        return ticket.scheduled_start
    return None


async def visit_moment(db: AsyncSession, ticket: Ticket) -> datetime:
    """O momento da visita na conclusão do formulário: o início do atendimento em curso; fora dele,
    a última entrada em atendimento depois da última reabertura (a mesma visita que o relatório do
    cliente mostra); sem nenhuma, agora. Em atendimento, sem consulta."""
    if ticket.work_started_at is not None:
        return ticket.work_started_at
    last = (
        await db.execute(
            select(TicketEvent.to_value, TicketEvent.created_at)
            .where(
                TicketEvent.ticket_id == ticket.id,
                TicketEvent.event_type == TicketEventType.STATUS_CHANGED,
                TicketEvent.to_value.in_(
                    (TicketStatus.IN_PROGRESS.value, TicketStatus.REOPENED.value)
                ),
            )
            .order_by(TicketEvent.created_at.desc())
            .limit(1)
        )
    ).first()
    if last is not None and last.to_value == TicketStatus.IN_PROGRESS.value:
        return last.created_at
    return utcnow()


def _visit_day(ticket: Ticket, *, final: bool, visit_at: datetime | None) -> date | None:
    """Dia (no fuso da operação) da visita: ao vivo, o de `_live_visit`; na conclusão, o de
    `visit_at` (sem ele, hoje)."""
    moment = (visit_at or utcnow()) if final else _live_visit(ticket)
    if moment is None:
        return None
    return moment.astimezone(ZoneInfo(settings.TIMEZONE)).date()


def _value(
    ticket: Ticket, source: str, field_type: str, *, final: bool, visit_at: datetime | None
) -> Any:
    if source == "location_name":
        return _clean(ticket.location.name) if ticket.location else None
    if source == "location_code":
        return _clean(ticket.location.code) if ticket.location else None
    if source == "customer":
        return _clean(ticket.customer.name) if ticket.customer else None
    if source == "address":
        return _address(ticket)
    if source == "city":
        return _city(ticket.location.city, ticket.location.state) if ticket.location else None
    if source == "ticket_code":
        return format_ticket_code(ticket.number) if ticket.number else None
    if source == "technician":
        return _clean(ticket.assignee.name) if ticket.assignee else None
    if source == "service_type":
        return _clean(ticket.service_type.name) if ticket.service_type else None
    if source == "visit_date":
        day = _visit_day(ticket, final=final, visit_at=visit_at)
        if day is None:
            return None
        return day.isoformat() if field_type == "date" else day.strftime("%d/%m/%Y")
    return None


def _attr(field: FormField | Mapping[str, Any], name: str) -> Any:
    return field.get(name) if isinstance(field, Mapping) else getattr(field, name, None)


def _answered(value: Any) -> bool:
    return value is not None and value != "" and value != []


def prefill_for(
    ticket: Ticket,
    fields: Iterable[FormField | Mapping[str, Any]],
    answers: Mapping[str, Any] | None,
    *,
    final: bool = False,
    visit_at: datetime | None = None,
) -> dict[str, Any]:
    """{campo: valor} das perguntas com resposta automática e ainda sem resposta. Valor vazio
    (a OS sem loja, sem técnico, sem agenda) não entra. `final`: na conclusão do formulário, com
    a data da visita tirada de `visit_at` (o momento que `visit_moment` apurou; sem ele, hoje)."""
    answers = answers or {}
    out: dict[str, Any] = {}
    for field in fields:
        source = _attr(field, "prefill")
        field_type = _attr(field, "type")
        field_id = _attr(field, "id")
        if not source or not field_id or field_type not in prefill_types(source):
            continue
        if _answered(answers.get(field_id)):
            continue
        value = _value(ticket, source, field_type, final=final, visit_at=visit_at)
        if value is not None and value != "":
            out[field_id] = value
    return out
