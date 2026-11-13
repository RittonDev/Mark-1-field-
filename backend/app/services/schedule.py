"""Agenda dos técnicos: calendário e conflito de horário.

Conflito = a mesma pessoa (o responsável ou outro técnico da visita) com duas OS ativas cujos
horários se sobrepõem. Ao agendar pela web (analista/gestor), a API recusa com 409
SCHEDULE_CONFLICT; quem agenda vê as OS em choque e pode confirmar mesmo assim
(allow_conflict), por exemplo duas visitas curtas no mesmo prédio. O calendário marca os
conflitos que já existem.
"""

import uuid
from datetime import datetime, timedelta

from sqlalchemy import ColumnElement, func, or_, select, union
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import TicketStatus
from app.models import Location, Ticket, User
from app.models.ticket import ticket_helpers
from app.schemas.schedule import CalendarEvent, CalendarFilters, ConflictItem
from app.schemas.ticket import format_ticket_code
from app.services.errors import ScheduleConflict

# Visita sem fim nem estimativa ocupa 1 hora na agenda.
DEFAULT_VISIT_MINUTES = 60

# Estados em que a OS ainda ocupa a agenda do técnico.
OCCUPYING = frozenset(
    {
        TicketStatus.NEW,
        TicketStatus.TRIAGE,
        TicketStatus.ASSIGNED,
        TicketStatus.SCHEDULED,
        TicketStatus.EN_ROUTE,
        TicketStatus.IN_PROGRESS,
        TicketStatus.ON_HOLD_CUSTOMER,
        TicketStatus.ON_HOLD_VENDOR,
        TicketStatus.REOPENED,
    }
)


def visit_end(start: datetime, end: datetime | None, estimated_minutes: int | None) -> datetime:
    if end is not None:
        return end
    return start + timedelta(minutes=estimated_minutes or DEFAULT_VISIT_MINUTES)


def _end_expr() -> ColumnElement[datetime]:
    minutes = func.coalesce(Ticket.estimated_minutes, DEFAULT_VISIT_MINUTES)
    return func.coalesce(
        Ticket.scheduled_end, Ticket.scheduled_start + func.make_interval(0, 0, 0, 0, 0, minutes)
    )


def works_on(user_id: uuid.UUID) -> ColumnElement[bool]:
    """OS em que a pessoa trabalha: responsável ou outro técnico da visita."""
    return or_(
        Ticket.assignee_id == user_id,
        Ticket.id.in_(
            select(ticket_helpers.c.ticket_id).where(ticket_helpers.c.user_id == user_id)
        ),
    )


def _occupied(
    start: datetime, end: datetime, exclude_id: uuid.UUID | None
) -> list[ColumnElement[bool]]:
    """OS que ainda ocupam a agenda e cujo horário se sobrepõe a [start, end)."""
    conds = [
        Ticket.status.in_(OCCUPYING),
        Ticket.scheduled_start.is_not(None),
        Ticket.scheduled_start < end,
        _end_expr() > start,
    ]
    if exclude_id is not None:
        conds.append(Ticket.id != exclude_id)
    return conds


async def find_conflicts(
    db: AsyncSession,
    *,
    assignee_id: uuid.UUID,
    start: datetime,
    end: datetime,
    exclude_id: uuid.UUID | None = None,
) -> list[Ticket]:
    stmt = select(Ticket).where(works_on(assignee_id), *_occupied(start, end, exclude_id))
    return list(await db.scalars(stmt.order_by(Ticket.scheduled_start)))


async def busy_people(
    db: AsyncSession,
    people: list[uuid.UUID],
    *,
    start: datetime,
    end: datetime,
    exclude_id: uuid.UUID | None = None,
) -> set[uuid.UUID]:
    """Quem, entre `people`, já tem OS no horário (como responsável ou outro técnico da visita).
    Uma consulta para todos: a sugestão de técnicos olha a base inteira."""
    if not people:
        return set()
    overlapping = _occupied(start, end, exclude_id)
    as_assignee = select(Ticket.assignee_id).where(Ticket.assignee_id.in_(people), *overlapping)
    as_helper = (
        select(ticket_helpers.c.user_id)
        .join(Ticket, Ticket.id == ticket_helpers.c.ticket_id)
        .where(ticket_helpers.c.user_id.in_(people), *overlapping)
    )
    return set(await db.scalars(union(as_assignee, as_helper)))


def conflict_item(t: Ticket, who: str | None = None) -> ConflictItem:
    assert t.scheduled_start is not None
    return ConflictItem(
        who=who,
        id=t.id,
        code=format_ticket_code(t.number),
        title=t.title,
        customer=t.customer.name if t.customer else None,
        location=t.location.name if t.location else None,
        start=t.scheduled_start,
        end=visit_end(t.scheduled_start, t.scheduled_end, t.estimated_minutes),
    )


async def preview_conflicts(
    db: AsyncSession,
    people: list[uuid.UUID],
    *,
    start: datetime,
    end: datetime,
    exclude_id: uuid.UUID | None = None,
) -> list[ConflictItem]:
    """Prévia antes de agendar: o que cada pessoa da visita já tem no horário (com o nome)."""
    if not people:
        return []
    names = {
        u.id: u.name for u in await db.scalars(select(User).where(User.id.in_(people)))
    }
    items: list[ConflictItem] = []
    for person_id in people:
        clashes = await find_conflicts(
            db, assignee_id=person_id, start=start, end=end, exclude_id=exclude_id
        )
        items.extend(conflict_item(t, names.get(person_id)) for t in clashes)
    return items


async def check_slot(
    db: AsyncSession,
    actor: User,
    *,
    assignee_id: uuid.UUID | None,
    start: datetime | None,
    end: datetime | None,
    estimated_minutes: int | None,
    status: TicketStatus,
    exclude_id: uuid.UUID | None,
    allow: bool,
    helper_ids: list[uuid.UUID] | tuple[uuid.UUID, ...] = (),
) -> None:
    """Barra o agendamento que choca com outra OS de quem vai à visita (responsável e outros
    técnicos). Só vale para quem agenda (a gestão): o app do técnico sincroniza offline e não
    pode travar por isso."""
    if allow or not actor.can_manage_tickets:
        return
    if start is None or status not in OCCUPYING:
        return
    people = [p for p in dict.fromkeys([assignee_id, *helper_ids]) if p is not None]
    finish = visit_end(start, end, estimated_minutes)
    names: list[str] = []
    items: list[dict] = []
    for person_id in people:
        clashes = await find_conflicts(
            db, assignee_id=person_id, start=start, end=finish, exclude_id=exclude_id
        )
        if not clashes:
            continue
        person = await db.get(User, person_id)
        name = person.name if person else "O técnico"
        names.append(name)
        items.extend(conflict_item(t, name).model_dump(mode="json") for t in clashes)
    if not items:
        return
    if len(names) == 1:
        message = f"{names[0]} já tem {len(items)} OS neste horário."
    else:
        message = f"{', '.join(names[:-1])} e {names[-1]} já têm OS neste horário."
    raise ScheduleConflict(message, items)


async def calendar(
    db: AsyncSession, start: datetime, end: datetime, f: CalendarFilters
) -> list[CalendarEvent]:
    stmt = select(Ticket).where(
        Ticket.scheduled_start.is_not(None),
        Ticket.scheduled_start < end,
        _end_expr() > start,
        Ticket.status != TicketStatus.CANCELLED,
    )
    if f.assignee_ids:
        # A agenda de cada técnico inclui as visitas em que ele vai junto.
        clauses = [
            Ticket.assignee_id.in_(f.assignee_ids),
            Ticket.id.in_(
                select(ticket_helpers.c.ticket_id).where(
                    ticket_helpers.c.user_id.in_(f.assignee_ids)
                )
            ),
        ]
        if f.unassigned:
            clauses.append(Ticket.assignee_id.is_(None))
        stmt = stmt.where(or_(*clauses))
    elif f.unassigned:
        stmt = stmt.where(Ticket.assignee_id.is_(None))
    if f.team_id:
        stmt = stmt.where(Ticket.team_id == f.team_id)
    if f.customer_id:
        stmt = stmt.where(Ticket.customer_id == f.customer_id)
    if f.location_id:
        stmt = stmt.where(Ticket.location_id == f.location_id)
    if f.city:
        stmt = stmt.where(
            Ticket.location_id.in_(
                select(Location.id).where(func.lower(Location.city) == f.city.strip().lower())
            )
        )
    if f.statuses:
        stmt = stmt.where(Ticket.status.in_(f.statuses))
    tickets = list(await db.scalars(stmt.order_by(Ticket.scheduled_start)))

    # Conflitos entre as OS do período, por pessoa: o responsável e os outros técnicos da visita
    # (só as OS que ainda ocupam a agenda). Ao salvar, a API barra o mesmo choque.
    clashes: dict[uuid.UUID, set[uuid.UUID]] = {t.id: set() for t in tickets}
    by_person: dict[uuid.UUID, list[tuple[datetime, datetime, Ticket]]] = {}
    for t in tickets:
        if t.status not in OCCUPYING:
            continue
        assert t.scheduled_start is not None
        span = (
            t.scheduled_start,
            visit_end(t.scheduled_start, t.scheduled_end, t.estimated_minutes),
        )
        people = {h.id for h in t.helpers}
        if t.assignee_id is not None:
            people.add(t.assignee_id)
        for person_id in people:
            by_person.setdefault(person_id, []).append((*span, t))
    for spans in by_person.values():
        for i, (s1, e1, t1) in enumerate(spans):
            for s2, e2, t2 in spans[i + 1 :]:
                if s2 >= e1:
                    break  # ordenado pelo início: os próximos começam depois
                if s1 < e2:
                    clashes[t1.id].add(t2.id)
                    clashes[t2.id].add(t1.id)

    out = []
    for t in tickets:
        assert t.scheduled_start is not None
        out.append(
            CalendarEvent(
                id=t.id,
                code=format_ticket_code(t.number),
                title=t.title,
                status=t.status,
                priority=t.priority,
                start=t.scheduled_start,
                end=visit_end(t.scheduled_start, t.scheduled_end, t.estimated_minutes),
                end_is_estimated=t.scheduled_end is None,
                assignee={"id": t.assignee.id, "name": t.assignee.name} if t.assignee else None,
                helpers=[{"id": h.id, "name": h.name} for h in t.helpers],
                team={"id": t.team.id, "name": t.team.name} if t.team else None,
                customer={"id": t.customer.id, "name": t.customer.name} if t.customer else None,
                location={
                    "id": t.location.id,
                    "name": t.location.name,
                    "city": t.location.city,
                }
                if t.location
                else None,
                service_type=t.service_type.name if t.service_type else None,
                conflict_with=sorted(clashes[t.id], key=str),
            )
        )
    return out


async def ensure_no_conflict(db: AsyncSession, ticket: Ticket, actor: User, allow: bool) -> None:
    """Depois de mudar responsável ou horário de uma OS existente."""
    await check_slot(
        db,
        actor,
        assignee_id=ticket.assignee_id,
        start=ticket.scheduled_start,
        end=ticket.scheduled_end,
        estimated_minutes=ticket.estimated_minutes,
        status=ticket.status,
        exclude_id=ticket.id,
        allow=allow,
        helper_ids=[h.id for h in ticket.helpers],
    )
